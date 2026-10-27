import {lstatSync, mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import type {Command, CommandContext, Logger} from '../../../src/api.js';
import {noopLog} from './log.js';
import {rank} from './search.js';
import {
	checkDescription,
	checkFieldKey,
	checkFieldValue,
	checkId,
	checkProject,
	checkStatus,
	checkTitle,
	createTaskFile,
	descriptionOf,
	DEFAULT_STATUS,
	type Field,
	fieldOf,
	fieldsOf,
	formFields,
	isOneLine,
	isExtraKey,
	listTasks,
	nameIn,
	nextAutoId,
	readTask,
	REQUIRED_FIELDS,
	rewriteTask,
	slugOf,
	statusOf,
	SUGGESTED_STATUSES,
	type Task,
	tasksDir,
	template,
	titleOf,
	withDescription,
	withField,
	withoutField,
	withStatus,
} from './tasks.js';
import type {TaskFormAction, TaskFormValues} from './ui/task-form.js';

export type TaskDeps = {
	/** The hub's projects dir, <YENA_DATA>/md/projects. */
	md: string;
	/** The isolated projects of the work session (the project module's). */
	isolated: () => string[];
	log?: Logger;
	now?: () => Date;
};

const NEW_USAGE = 'task new [<project>] [--id <id>] [--name <name>] [--status <status>] [<description…>]';
const STATUS_USAGE = 'task status <project> <id> [<status>]';
const SHOW_USAGE = 'task show <project> <id>';
const EDIT_USAGE = 'task edit <project> <id>';
const SET_USAGE = 'task set <project> <id> <field> <value…>';
const UNSET_USAGE = 'task unset <project> <id> <field>';
const DELETE_USAGE = 'task delete <project> <id>';
const SEARCH_USAGE = 'task search [--project <project>] <words>…';
const USAGE = 'task list | new | show | edit | set | unset | status | delete | search (task help for details)';
const SEARCH_FILES_MAX = 5000;
const LIST_TEXT_MAX = 60;

const HELP = [
	'Usage:',
	'  task list [<project>]                       List tasks, of every project or of one',
	`  ${NEW_USAGE}`,
	'                                              With a description: create the task (the id defaults to the next',
	'                                              TASK-<n>, the name to the first words of the description).',
	'                                              A name with spaces goes in quotes: --name "Fix login bug";',
	'                                              the file name is its kebab-case form (fix-login-bug).',
	'                                              Without one, in the app: open a form to fill it',
	`  ${SHOW_USAGE.padEnd(44)}Show the task's fields and file`,
	`  ${EDIT_USAGE.padEnd(44)}Edit the task in a form (in the app)`,
	`  ${SET_USAGE.padEnd(44)}Set a field: status, description or any other`,
	`  ${UNSET_USAGE.padEnd(44)}Remove a field you added (status and description are required)`,
	`  ${STATUS_USAGE.padEnd(44)}Show the status, or set it (one kebab-case word:`,
	`  ${''.padEnd(44)}${SUGGESTED_STATUSES.join(', ')}…)`,
	`  ${DELETE_USAGE.padEnd(44)}Delete the task file`,
	`  ${SEARCH_USAGE.padEnd(44)}Find similar tasks in every project (that project first)`,
	'Every task has an id (unique in its project), a status and a description. The file starts with its',
	'properties ("key: value" lines between "---" lines, as in Obsidian); the description is the Markdown after them.',
	'Tasks are created and changed only in isolated projects ("project isolate <name>").',
].join('\n');

const label = (t: Task): string => `${t.project}/${t.id}`;

/** The name property; a task without one falls back to its file name. */
const nameOf = (t: Task, text: string | undefined): string => (text === undefined ? undefined : nameIn(text)) ?? titleOf(t.name);

/** The first text line of the description, without Markdown heading marks. */
const firstLineOf = (description: string): string =>
	description
		.split('\n')
		.map(l => l.trim().replace(/^#+\s*/, ''))
		.find(l => l !== '') ?? '';

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

type NewSpec = {project?: string; id?: string; name?: string; status?: string; description?: string};

/**
 * One option value: a single word, or words from one starting with `"` to one ending with it.
 * The console splits lines on whitespace and knows no quotes, so they are joined here.
 */
function readQuoted(args: string[], at: number): {value: string; last: number} {
	const first = args[at];
	if (first === undefined) throw new Error(`--name needs a value. Usage: ${NEW_USAGE}`);
	if (!first.startsWith('"')) return {value: first, last: at};
	for (let j = at; j < args.length; j++) {
		const word = args[j] as string;
		if ((j > at || word.length > 1) && word.endsWith('"')) {
			return {value: args.slice(at, j + 1).join(' ').slice(1, -1), last: j};
		}
	}
	throw new Error('The name has no closing quote, e.g. --name "Fix login bug"');
}

function parseNew(args: string[]): NewSpec {
	const spec: NewSpec = {};
	let i = 0;
	if (args[0] !== undefined && !args[0].startsWith('--')) spec.project = checkProject(args[i++]);
	for (; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === '--') {
			i++;
			break;
		}
		if (!arg.startsWith('--')) break;
		if (arg === '--name') {
			const quoted = readQuoted(args, i + 1);
			spec.name = checkTitle(quoted.value);
			i = quoted.last;
			continue;
		}
		const value = args[++i];
		if (value === undefined) throw new Error(`${arg} needs a value. Usage: ${NEW_USAGE}`);
		if (arg === '--id') spec.id = checkId(value);
		else if (arg === '--status') spec.status = checkStatus(value);
		else throw new Error(`Unknown option ${arg.slice(0, 32)}. Usage: ${NEW_USAGE}`);
	}
	const words = args.slice(i).join(' ').trim();
	if (words !== '') spec.description = words;
	return spec;
}

const sameKey = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A field a user or a model adds: not a built-in one, not given twice. */
function checkExtraKey(key: string, taken: string[]): string {
	checkFieldKey(key);
	if (!isExtraKey(key)) throw new Error(`${key} is a built-in field`);
	if (taken.some(t => sameKey(t, key))) throw new Error(`${key} is already there`);
	return key;
}

/** The added fields with a value, checked; an empty value drops the field. */
function checkExtras(fields: Field[]): Field[] {
	const out: Field[] = [];
	for (const f of fields) {
		if (f.value.trim() === '') continue;
		const key = checkExtraKey(f.key, out.map(o => o.key));
		out.push({key, value: checkFieldValue(f.value, `The value of ${key}`)});
	}
	return out;
}

const canShowForm = (ctx: CommandContext): boolean => ctx.mount !== undefined && !ctx.headless && ctx.signal === undefined;

const discussMessage = (name: string, file: string): string =>
	`Let's discuss task ${name} (${file}). Read it, ask me what is unclear and suggest what to add or change; change the task only after I agree.`;

export function createTaskCommand(deps: TaskDeps): Command {
	const log = deps.log ?? noopLog;
	const now = deps.now ?? (() => new Date());

	const info = (t: Task): {status: string; text: string} => {
		const text = readTask(t.file);
		if (text === undefined) return {status: '?', text: nameOf(t, undefined)};
		return {status: statusOf(text) || '-', text: cut(firstLineOf(descriptionOf(text)) || nameOf(t, text), LIST_TEXT_MAX)};
	};

	const list = (project?: string): string => {
		const tasks = listTasks(deps.md, project);
		if (tasks.length === 0) return project === undefined ? `No tasks in ${deps.md}` : `No tasks in ${tasksDir(deps.md, project)}`;
		const width = Math.max(...tasks.map(t => label(t).length));
		const rows = tasks.map(info);
		const sw = Math.max(...rows.map(r => r.status.length));
		return tasks.map((t, i) => `${label(t).padEnd(width)}  ${rows[i]!.status.padEnd(sw)}  ${rows[i]!.text}  ${t.file}`).join('\n');
	};

	const requireIsolated = (project: string) => {
		if (!deps.isolated().includes(project)) {
			throw new Error(`${project} is not isolated; run "project isolate ${project}" first`);
		}
	};

	const findTask = (project: string, rawId: string | undefined): Task => {
		const id = checkId(rawId ?? '');
		const task = listTasks(deps.md, project).find(t => t.id.toLowerCase() === id.toLowerCase());
		if (!task) throw new Error(`${project} has no task ${id}; "task list ${project}" lists them`);
		return task;
	};

	const textOf = (task: Task): string => {
		const text = readTask(task.file);
		if (text === undefined) throw new Error(`Cannot read ${task.file}`);
		return text;
	};

	const status = (project: string, rawId: string, next: string | undefined): string => {
		const task = findTask(project, rawId);
		if (next === undefined) {
			const current = statusOf(textOf(task));
			return current === undefined || current === '' ? `${label(task)}: no status (set one with "${STATUS_USAGE}")` : `${label(task)}: ${current}`;
		}
		const value = checkStatus(next);
		requireIsolated(project);
		let before: string | undefined;
		rewriteTask(task.file, text => {
			before = statusOf(text);
			return withStatus(text, value);
		});
		log.info('task status set', {status: value});
		return before === value ? `${label(task)}: ${value} (unchanged)` : `${label(task)}: ${before || 'no status'} -> ${value}`;
	};

	const create = (p: {project: string; id?: string; name?: string; status?: string; description: string; fields?: Field[]}): {task: Task; file: string} => {
		requireIsolated(p.project);
		const existing = listTasks(deps.md, p.project);
		const id = p.id === undefined ? nextAutoId(existing) : checkId(p.id);
		const clash = existing.find(t => t.id.toLowerCase() === id.toLowerCase());
		if (clash) throw new Error(`${p.project} already has task ${id}: ${clash.file}`);
		const description = checkDescription(p.description);
		const taskStatus = checkStatus(p.status ?? DEFAULT_STATUS);
		const title = p.name === undefined ? titleOf(slugOf(description) || 'task') : checkTitle(p.name);
		const name = slugOf(title) || slugOf(description) || 'task';
		const fields = checkExtras(p.fields ?? []);
		const dir = tasksDir(deps.md, p.project);
		mkdirSync(dir, {recursive: true});
		const file = path.join(dir, `${id}_${name}.md`);
		createTaskFile(file, template({project: p.project, title, date: now().toISOString().slice(0, 10), status: taskStatus, description, fields}));
		log.info('task created', {auto: p.id === undefined, fields: fields.length});
		return {task: {project: p.project, id, name, file}, file};
	};

	const show = (project: string, rawId: string): string => {
		const task = findTask(project, rawId);
		const text = textOf(task);
		const fields = fieldsOf(text);
		const description = descriptionOf(text);
		const missing = [...REQUIRED_FIELDS.filter(k => !fields.some(f => sameKey(f.key, k))), ...(description === '' ? ['description'] : [])];
		return [
			`${label(task)}  ${nameOf(task, text)}`,
			`File: ${task.file}`,
			...fields.map(f => `${f.key}: ${f.value}`),
			...(missing.length > 0 ? [`Missing: ${missing.join(', ')} (set with "${SET_USAGE}")`] : []),
			...(description === '' ? [] : ['', description]),
		].join('\n');
	};

	const setDescription = (task: Task, rawValue: string): string => {
		const value = checkDescription(rawValue);
		requireIsolated(task.project);
		let before = '';
		rewriteTask(task.file, text => {
			before = descriptionOf(text);
			return withDescription(text, value);
		});
		log.info('task field set', {required: true, added: before === ''});
		return `${label(task)}: description = ${value}${before === '' ? ' (added)' : before === value ? ' (unchanged)' : ''}`;
	};

	const set = (project: string, rawId: string, rawKey: string, rawValue: string): string => {
		const task = findTask(project, rawId);
		if (sameKey(rawKey, 'description')) return setDescription(task, rawValue);
		let key: string;
		let value: string;
		if (sameKey(rawKey, 'status')) [key, value] = ['status', checkStatus(rawValue.trim())];
		else [key, value] = [checkFieldKey(rawKey), checkFieldValue(rawValue)];
		requireIsolated(project);
		let before: string | undefined;
		rewriteTask(task.file, text => {
			before = fieldOf(text, key);
			return withField(text, key, value);
		});
		log.info('task field set', {required: !isExtraKey(key), added: before === undefined});
		return `${label(task)}: ${key} = ${value}${before === undefined ? ' (added)' : before === value ? ' (unchanged)' : ''}`;
	};

	const unset = (project: string, rawId: string, rawKey: string): string => {
		const task = findTask(project, rawId);
		if ([...REQUIRED_FIELDS, 'description'].some(k => sameKey(k, rawKey))) throw new Error(`Every task needs ${rawKey.toLowerCase()}; change it with "${SET_USAGE}"`);
		const key = checkFieldKey(rawKey);
		requireIsolated(project);
		if (fieldOf(textOf(task), key) === undefined) throw new Error(`${label(task)} has no field ${key}`);
		rewriteTask(task.file, text => withoutField(text, key));
		log.info('task field removed');
		return `${label(task)}: removed ${key}`;
	};

	const remove = (project: string, rawId: string): string => {
		const task = findTask(project, rawId);
		requireIsolated(project);
		if (!lstatSync(task.file).isFile()) throw new Error(`${task.file} is not a regular file`);
		rmSync(task.file);
		log.info('task deleted');
		return `Deleted ${label(task)} (${task.file})`;
	};

	// `withNewDescription` false: the form showed the description read-only (several lines are more than its field holds).
	const update = (task: Task, values: TaskFormValues, withNewDescription: boolean): void => {
		const taskStatus = checkStatus(values.status);
		const description = withNewDescription ? checkDescription(values.description) : undefined;
		const fields = checkExtras(values.fields);
		rewriteTask(task.file, text => {
			let next = withStatus(text, taskStatus);
			if (description !== undefined) next = withDescription(next, description);
			for (const old of formFields(text)) if (!fields.some(f => sameKey(f.key, old.key))) next = withoutField(next, old.key);
			for (const f of fields) next = withField(next, f.key, f.value);
			return next;
		});
		log.info('task edited', {fields: fields.length});
	};

	const search = (args: string[]): string => {
		let project: string | undefined;
		const rest: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === '--project') {
				project = checkProject(args[++i]);
			} else rest.push(args[i] as string);
		}
		if (rest.length === 0) throw new Error(`Usage: ${SEARCH_USAGE}`);
		const tasks = listTasks(deps.md).slice(0, SEARCH_FILES_MAX);
		const texts = tasks.flatMap(task => {
			const text = readTask(task.file);
			return text === undefined ? [] : [{task, text}];
		});
		const hits = rank(texts, rest.join(' '), project);
		log.info('task search', {tasks: texts.length, hits: hits.length});
		if (hits.length === 0) return `No similar tasks among ${texts.length}.`;
		const lines = [`Similar tasks (${hits.length} of ${texts.length}, best first):`];
		const textOfHit = new Map(texts.map(t => [t.task, t.text]));
		hits.forEach((h, i) => {
			lines.push(`${i + 1}. ${label(h.task)}  ${nameOf(h.task, textOfHit.get(h.task))}  (score ${h.score})`, `   ${h.task.file}`);
			if (h.summary !== '') lines.push(`   ${h.summary}`);
		});
		return lines.join('\n');
	};

	// The form in the console panel; "Save and discuss" then sends the task to the open chat ("claude send").
	const openForm = async (ctx: CommandContext, project: string, existing: Task | undefined, preset: NewSpec): Promise<void> => {
		requireIsolated(project);
		const ui = await import('./ui/task-form.js');
		const text = existing ? textOf(existing) : undefined;
		const body = text === undefined ? undefined : descriptionOf(text);
		const editableDescription = body === undefined || body === '' || isOneLine(body);
		let saved: {task: Task; action: TaskFormAction} | undefined;
		let host: unknown;
		await ctx.mount!(control => {
			host = control.host;
			return ui.taskForm(control, {
				title: existing ? `Edit task · ${label(existing)}` : `New task · ${project}`,
				project,
				id: existing?.id ?? preset.id ?? nextAutoId(listTasks(deps.md, project)),
				isNew: existing === undefined,
				status: (text && statusOf(text)) || preset.status || DEFAULT_STATUS,
				description: editableDescription ? body || preset.description || '' : `${cut(firstLineOf(body ?? ''), LIST_TEXT_MAX)} (${(body ?? '').split('\n').length} lines: edit the file)`,
				descriptionReadOnly: !editableDescription,
				fields: text ? formFields(text) : [],
				namePlaceholder: preset.name ?? 'spaces allowed; the file name is its kebab-case form; default: the first words of the description',
				validateKey: (key, taken) => {
					try {
						checkExtraKey(key, taken);
						return undefined;
					} catch (error) {
						return (error as Error).message;
					}
				},
				save: values => {
					if (existing) {
						update(existing, values, editableDescription);
						saved = {task: existing, action: 'save'};
						return;
					}
					const name = values.name || preset.name;
					const made = create({
						project,
						...(values.id !== '' && {id: values.id}),
						...(name && {name}),
						status: values.status,
						description: values.description,
						fields: values.fields,
					});
					saved = {task: made.task, action: 'save'};
				},
				onDone: action => {
					if (saved) saved.action = action;
				},
			});
		}, {target: 'panel'});
		if (!saved) {
			ctx.print(existing ? `${label(existing)} not changed.` : 'No task created.');
			return;
		}
		ctx.print(`${existing ? 'Saved' : 'Created'} ${label(saved.task)}: ${saved.task.file}`);
		if (saved.action !== 'discuss') return;
		const message = discussMessage(label(saved.task), saved.task.file);
		const runLine = (host as {runLine?: unknown} | undefined)?.runLine;
		const sent = typeof runLine === 'function' && runLine.call(host, `claude send ${message}`) === true;
		log.info('task discuss', {sent});
		if (!sent) ctx.print(`No chat to discuss it in (the claude module is missing). Ask the assistant: ${message}`);
	};

	const newTask = async (args: string[], ctx: CommandContext): Promise<void> => {
		const spec = parseNew(args);
		if (spec.description !== undefined) {
			if (spec.project === undefined) throw new Error(`Usage: ${NEW_USAGE}`);
			ctx.print(create({...spec, project: spec.project, description: spec.description}).file);
			return;
		}
		if (!canShowForm(ctx)) throw new Error(`A task needs a description. Usage: ${NEW_USAGE} (without a description it opens a form, in the app only)`);
		let project = spec.project;
		if (project === undefined) {
			const isolated = deps.isolated();
			if (isolated.length === 0) throw new Error('No project is isolated; run "project isolate <name>" first');
			if (isolated.length === 1) project = isolated[0];
			else {
				const ui = await import('./ui/task-form.js');
				await ctx.mount!(control => ui.projectPicker(control, isolated, picked => void (project = picked)), {target: 'panel'});
				if (project === undefined) return;
			}
		}
		await openForm(ctx, checkProject(project), undefined, spec);
	};

	const edit = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length !== 2) throw new Error(`Usage: ${EDIT_USAGE}`);
		const project = checkProject(args[0]);
		const task = findTask(project, args[1]);
		if (!canShowForm(ctx)) throw new Error(`"task edit" opens a form in the app; change fields with "${SET_USAGE}" and "${UNSET_USAGE}"`);
		await openForm(ctx, project, task, {});
	};

	const exactly = (rest: string[], n: number, usage: string) => {
		if (rest.length !== n) throw new Error(`Usage: ${usage}`);
	};

	return {
		name: 'task',
		description: 'Task files in project docs: fill and edit them, search for similar tasks',
		usage: USAGE,
		agent: 'safe',
		subcommands: [
			{name: 'list', aliases: ['ls'], usage: 'task list [<project>]', description: 'List tasks', agent: 'safe'},
			{name: 'new', usage: NEW_USAGE, description: 'Create a task (without a description: fill it in a form)', agent: 'safe'},
			{name: 'show', usage: SHOW_USAGE, description: "Show a task's fields and file", agent: 'safe'},
			{name: 'edit', usage: EDIT_USAGE, description: 'Edit a task in a form', agent: 'deny'},
			{name: 'set', usage: SET_USAGE, description: 'Set a field of a task', agent: 'safe'},
			{name: 'unset', usage: UNSET_USAGE, description: 'Remove an added field of a task', agent: 'safe'},
			{name: 'status', usage: STATUS_USAGE, description: 'Show or set the status of a task', agent: 'safe'},
			{name: 'delete', aliases: ['rm'], usage: DELETE_USAGE, description: 'Delete a task file', agent: 'confirm'},
			{name: 'search', usage: SEARCH_USAGE, description: 'Find similar tasks', agent: 'safe'},
			{name: 'help', usage: 'task help', description: 'Show the usage', agent: 'safe'},
		],
		async run(args, ctx) {
			const [sub, ...rest] = args;
			switch (sub) {
				case undefined:
				case 'help':
					ctx.print(HELP);
					return;
				case 'list':
				case 'ls':
					if (rest.length > 1) throw new Error('Usage: task list [<project>]');
					ctx.print(list(rest[0] === undefined ? undefined : checkProject(rest[0])));
					return;
				case 'new':
					return newTask(rest, ctx);
				case 'show':
					exactly(rest, 2, SHOW_USAGE);
					ctx.print(show(checkProject(rest[0]), rest[1] as string));
					return;
				case 'edit':
					return edit(rest, ctx);
				case 'set':
					if (rest.length < 4) throw new Error(`Usage: ${SET_USAGE}`);
					ctx.print(set(checkProject(rest[0]), rest[1] as string, rest[2] as string, rest.slice(3).join(' ')));
					return;
				case 'unset':
					exactly(rest, 3, UNSET_USAGE);
					ctx.print(unset(checkProject(rest[0]), rest[1] as string, rest[2] as string));
					return;
				case 'status':
					if (rest.length < 2 || rest.length > 3) throw new Error(`Usage: ${STATUS_USAGE}`);
					ctx.print(status(checkProject(rest[0]), rest[1] as string, rest[2]));
					return;
				case 'delete':
				case 'rm':
					exactly(rest, 2, DELETE_USAGE);
					ctx.print(remove(checkProject(rest[0]), rest[1] as string));
					return;
				case 'search':
					ctx.print(search(rest));
					return;
				default:
					throw new Error(`Unknown subcommand: ${sub.slice(0, 64)}. Usage: ${USAGE}`);
			}
		},
	};
}
