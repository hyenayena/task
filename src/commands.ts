import {lstatSync, mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import type {Command, CommandContext, Logger, Subcommand} from '../../../src/api.js';
import {noopLog} from './log.js';
import {rank} from './search.js';
import {
	checkDescription,
	checkFieldKey,
	checkFieldValue,
	checkId,
	allowedStatuses,
	checkProject,
	checkStatus,
	checkStatuses,
	checkTitle,
	checkType,
	createTaskFile,
	DEFAULT_STATUSES,
	descriptionOf,
	type Field,
	firstStatus,
	isAllowedStatus,
	fieldOf,
	fieldsOf,
	formFields,
	isOneLine,
	isExtraKey,
	isEpicText,
	listTasks,
	nameIn,
	nextAutoId,
	parentOf,
	readStatuses,
	readTask,
	REQUIRED_FIELDS,
	rewriteTask,
	slugOf,
	statusesFile,
	statusOf,
	ARCHIVED_STATUS,
	type Task,
	tasksDir,
	template,
	titleOf,
	TASK_TYPES,
	typeOf,
	withDescription,
	withField,
	withoutField,
	withStatus,
	writeStatuses,
} from './tasks.js';
import type {TaskFormAction, TaskFormValues} from './ui/task-form.js';

export type TaskDeps = {
	md: string;
	isolated: () => string[];
	log?: Logger;
	now?: () => Date;
};

const NEW_USAGE = 'task new [project] [--id <id>] [--name <name>] [--status <status>] [--type task|epic] [--parent <epic-id>] [description…]';
const STATUS_USAGE = 'task status <project> <id> [status]';
const STATUSES_USAGE = 'task statuses <project>';
const SET_STATUSES_USAGE = 'task set-statuses <project> <status…>';
const SHOW_USAGE = 'task show <project> <id>';
const EDIT_USAGE = 'task edit <project> <id>';
const SET_USAGE = 'task set <project> <id> <field> <value…>';
const UNSET_USAGE = 'task unset <project> <id> <field>';
const DELETE_USAGE = 'task delete <project> <id>';
const LIST_USAGE = 'task list [project] [--all]';
const SEARCH_USAGE = 'task search [--project <project>] [--status <status>] [--limit <n>] <query>…';
const LINE = 'task list | new | show | edit | set | unset | status | statuses | set-statuses | delete | search (task help for details)';
const USAGE = 'task <subcommand>';
const SEARCH_FILES_MAX = 5000;
const SEARCH_LIMIT = 10;
const SEARCH_LIMIT_MAX = 50;
const LIST_TEXT_MAX = 60;

const PROJECT = {name: 'project', description: 'A project in the docs hub'};
const ID = {name: 'id', description: 'The task id (TASK-1); case does not matter'};

const SUBCOMMANDS: Subcommand[] = [
	{
		name: 'list',
		aliases: ['ls'],
		usage: LIST_USAGE,
		description: 'List tasks, of every project or of one',
		args: [{name: 'project', description: 'Only the tasks of this project'}],
		options: [{name: '--all', description: `Also the archived ones (status ${ARCHIVED_STATUS})`}],
		agent: 'safe',
	},
	{
		name: 'new',
		usage: NEW_USAGE,
		description: 'Create a task (without a description: fill it in a form)',
		args: [
			{name: 'project', description: 'The project; required with a description'},
			{name: 'description', description: 'The text of the task: the rest of the line'},
		],
		options: [
			{name: '--id', value: '<id>', description: 'The id (default: the next TASK-<n>)'},
			{name: '--name', value: '<name>', description: 'The name (default: the first words of the description)'},
			{name: '--status', value: '<status>', description: "One of the project's statuses (default: the first)"},
			{name: '--type', value: '<type>', description: 'task (default) or epic: an epic groups tasks'},
			{name: '--parent', value: '<epic-id>', description: 'The epic this task belongs to (same project)'},
		],
		notes: [
			'A name with spaces goes in quotes: --name "Fix login bug"; the file name is its kebab-case form (fix-login-bug)',
			'Without a description, in the app: opens a form to fill it',
			'Epics: one level; only a task has a parent, and it must be an epic of the same project',
		],
		agent: 'safe',
	},
	{name: 'show', usage: SHOW_USAGE, description: "Show a task's fields and file", args: [PROJECT, ID], agent: 'safe'},
	{name: 'edit', usage: EDIT_USAGE, description: 'Edit a task in a form (in the app)', args: [PROJECT, ID], agent: 'deny'},
	{
		name: 'set',
		usage: SET_USAGE,
		description: 'Set a field of a task: status, description or any other',
		args: [PROJECT, ID, {name: 'field', description: 'The field name'}, {name: 'value', description: 'The value: the rest of the line'}],
		notes: [
			'type epic|task: an epic groups tasks; it cannot have a parent',
			'parent <epic-id>: put the task under an epic of the same project',
			'An epic lists its tasks in "task show"; the list is never stored',
		],
		agent: 'safe',
	},
	{
		name: 'unset',
		usage: UNSET_USAGE,
		description: 'Remove a field you added, the parent or the type (status and description are required)',
		args: [PROJECT, ID, {name: 'field', description: 'The field name'}],
		agent: 'safe',
	},
	{
		name: 'status',
		usage: STATUS_USAGE,
		description: "Show the status of a task, or set it to one of the project's statuses",
		args: [PROJECT, ID, {name: 'status', description: 'The new status'}],
		agent: 'safe',
	},
	{name: 'statuses', usage: STATUSES_USAGE, description: 'The statuses a task of the project may have', args: [PROJECT], agent: 'safe'},
	{
		name: 'set-statuses',
		usage: SET_STATUSES_USAGE,
		description: "Set the project's own list of statuses, in order",
		args: [PROJECT, {name: 'status', description: 'A status; a new task gets the first'}],
		notes: [`Default: ${DEFAULT_STATUSES.join(', ')}; ${ARCHIVED_STATUS} is always allowed`],
		agent: 'confirm',
	},
	{
		name: 'delete',
		aliases: ['rm'],
		usage: DELETE_USAGE,
		description: 'Delete a task file',
		args: [PROJECT, ID],
		notes: ['An epic with tasks is refused; unset their parent first'],
		agent: 'confirm',
	},
	{
		name: 'search',
		usage: SEARCH_USAGE,
		description: 'Find tasks in every project (archived too) by id, name or text',
		args: [{name: 'query', description: 'An id, words, or a "quoted phrase"'}],
		options: [
			{name: '--project', value: '<project>', description: 'Put the tasks of this project first'},
			{name: '--status', value: '<status>', description: 'Only tasks with this status'},
			{name: '--limit', value: '<n>', description: `At most this many results (default ${SEARCH_LIMIT}, up to ${SEARCH_LIMIT_MAX})`},
		],
		notes: [
			'By id: web/TASK-1, TASK-1 or 1',
			'Words match the name and text; word forms and typos count less; "quoted phrases" must appear',
			'Shows the matching lines (L<n>)',
		],
		agent: 'safe',
	},
];

const NOTES = [
	'Every task has an id (unique in its project), a status and a description',
	'The file starts with its properties ("key: value" lines between "---" lines, as in Obsidian)',
	'The description is the Markdown after them',
	'A task with "type: epic" is an epic; its tasks name it in "parent"',
	'Tasks are created and changed only in isolated projects ("project isolate <name>")',
];

const label = (t: Task): string => `${t.project}/${t.id}`;

const nameOf = (t: Task, text: string | undefined): string => (text === undefined ? undefined : nameIn(text)) ?? titleOf(t.name);

const firstLineOf = (description: string): string =>
	description
		.split('\n')
		.map(l => l.trim().replace(/^#+\s*/, ''))
		.find(l => l !== '') ?? '';

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

type NewSpec = {project?: string; id?: string; name?: string; status?: string; type?: string; parent?: string; description?: string};

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
		else if (arg === '--type') spec.type = checkType(value);
		else if (arg === '--parent') spec.parent = checkId(value);
		else throw new Error(`Unknown option ${arg.slice(0, 32)}. Usage: ${NEW_USAGE}`);
	}
	const words = args.slice(i).join(' ').trim();
	if (words !== '') spec.description = words;
	return spec;
}

const sameKey = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function checkExtraKey(key: string, taken: string[]): string {
	checkFieldKey(key);
	if (!isExtraKey(key)) throw new Error(`${key} is a built-in field`);
	if (taken.some(t => sameKey(t, key))) throw new Error(`${key} is already there`);
	return key;
}

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

	const info = (t: Task): {status: string; text: string; epic: boolean; parent: string | undefined} => {
		const text = readTask(t.file);
		if (text === undefined) return {status: '?', text: nameOf(t, undefined), epic: false, parent: undefined};
		return {
			status: statusOf(text) || '-',
			text: cut(firstLineOf(descriptionOf(text)) || nameOf(t, text), LIST_TEXT_MAX),
			epic: isEpicText(text),
			parent: parentOf(text),
		};
	};

	const ordered = <R extends {task: Task; epic: boolean; parent: string | undefined}>(found: R[], shown: R[]): {row: R; indent: string; flag: string}[] => {
		const key = (project: string, id: string): string => `${project}/${id.toLowerCase()}`;
		const byId = new Map(found.map(r => [key(r.task.project, r.task.id), r]));
		const visible = new Set(shown);
		const kids = new Map<R, R[]>();
		const top: {row: R; flag: string}[] = [];
		for (const r of shown) {
			if (r.epic || r.parent === undefined) {
				top.push({row: r, flag: ''});
				continue;
			}
			const p = byId.get(key(r.task.project, r.parent));
			let flag: string;
			if (p === undefined) flag = `(parent ${r.parent} missing)`;
			else if (!p.epic) flag = `(parent ${label(p.task)} is not an epic)`;
			else if (!visible.has(p)) flag = `(epic ${label(p.task)} is archived)`;
			else {
				kids.set(p, [...(kids.get(p) ?? []), r]);
				continue;
			}
			top.push({row: r, flag});
		}
		return top.flatMap(t => [{...t, indent: ''}, ...(kids.get(t.row) ?? []).map(k => ({row: k, indent: '  ', flag: ''}))]);
	};

	const list = (args: string[]): string => {
		const all = args.includes('--all');
		const rest = args.filter(a => a !== '--all');
		if (rest.length > 1 || rest.some(a => a.startsWith('--'))) throw new Error(`Usage: ${LIST_USAGE}`);
		const project = rest[0] === undefined ? undefined : checkProject(rest[0]);
		const where = project === undefined ? deps.md : tasksDir(deps.md, project);
		const found = listTasks(deps.md, project).map(t => ({task: t, ...info(t)}));
		if (found.length === 0) return `No tasks in ${where}`;
		const shown = all ? found : found.filter(r => r.status !== ARCHIVED_STATUS);
		const hidden = found.length - shown.length;
		const note = hidden > 0 ? `${hidden} archived hidden (task list${project === undefined ? '' : ` ${project}`} --all)` : '';
		if (shown.length === 0) return `No open tasks in ${where}; ${note}`;
		const lines = ordered(found, shown);
		const width = Math.max(...lines.map(l => l.indent.length + label(l.row.task).length));
		const sw = Math.max(...shown.map(r => r.status.length));
		const rows = lines.map(
			({row: r, indent, flag}) =>
				`${(indent + label(r.task)).padEnd(width)}  ${r.status.padEnd(sw)}  ${r.epic ? '[epic] ' : ''}${r.text}${flag === '' ? '' : `  ${flag}`}  ${r.task.file}`,
		);
		return [...rows, ...(note === '' ? [] : [note])].join('\n');
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

	type Entry = {task: Task; text: string};

	const tasksWithText = (project: string): Entry[] =>
		listTasks(deps.md, project).flatMap(task => {
			const text = readTask(task.file);
			return text === undefined ? [] : [{task, text}];
		});

	const childrenOf = (project: string, epicId: string, entries: Entry[] = tasksWithText(project)): Entry[] =>
		entries.filter(e => {
			const parent = parentOf(e.text);
			return parent !== undefined && sameKey(parent, epicId);
		});

	const resolveParent = (project: string, raw: string): Task => {
		const id = checkId(raw.trim());
		const epic = listTasks(deps.md, project).find(t => sameKey(t.id, id));
		if (!epic) throw new Error(`${project} has no task ${id} to be the parent; "task list ${project}" lists them`);
		const text = readTask(epic.file);
		if (text === undefined || !isEpicText(text)) throw new Error(`${label(epic)} is not an epic (make it one with "task set ${project} ${epic.id} type epic")`);
		return epic;
	};

	const hasTasksError = (epic: Task, kids: Entry[]): Error =>
		new Error(`${label(epic)} has tasks: ${kids.map(k => label(k.task)).join(', ')}; unset their parent first ("task unset ${epic.project} <id> parent")`);

	const hasParentError = (task: Task, parent: string): Error =>
		new Error(`${label(task)} has parent ${parent}; unset it first ("task unset ${task.project} ${task.id} parent")`);

	const checkRelation = (task: Task | undefined, project: string, type: string, parent: string | undefined): string | undefined => {
		if (type === 'epic' && parent !== undefined) throw new Error(`${task ? label(task) : 'An epic'} is an epic; an epic has no parent`);
		const resolved = parent === undefined ? undefined : resolveParent(project, parent);
		if (task && resolved && sameKey(resolved.id, task.id)) throw new Error(`${label(task)} cannot be its own parent`);
		if (task && type !== 'epic' && isEpicText(textOf(task))) {
			const kids = childrenOf(project, task.id);
			if (kids.length > 0) throw hasTasksError(task, kids);
		}
		return resolved?.id;
	};

	const allowedText = (project: string): string => allowedStatuses(readStatuses(deps.md, project)).join(', ');

	const checkAllowed = (project: string, raw: string | undefined, current?: string): string => {
		const value = checkStatus(raw);
		if (value === current || isAllowedStatus(readStatuses(deps.md, project), value)) return value;
		throw new Error(`${value} is not a status of ${project}; use one of: ${allowedText(project)} ("${STATUSES_USAGE}")`);
	};

	const offListNote = (project: string, status: string | undefined): string | undefined =>
		status === undefined || status === '' || isAllowedStatus(readStatuses(deps.md, project), status)
			? undefined
			: `not a status of ${project} (${allowedText(project)})`;

	const status = (project: string, rawId: string, next: string | undefined): string => {
		const task = findTask(project, rawId);
		if (next === undefined) {
			const current = statusOf(textOf(task));
			if (current === undefined || current === '') return `${label(task)}: no status (set one with "${STATUS_USAGE}")`;
			const note = offListNote(project, current);
			return `${label(task)}: ${current}${note === undefined ? '' : ` (${note})`}`;
		}
		const value = checkAllowed(project, next);
		requireIsolated(project);
		let before: string | undefined;
		rewriteTask(task.file, text => {
			before = statusOf(text);
			return withStatus(text, value);
		});
		log.info('task status set', {status: value});
		return before === value ? `${label(task)}: ${value} (unchanged)` : `${label(task)}: ${before || 'no status'} -> ${value}`;
	};

	const create = (p: {project: string; id?: string; name?: string; status?: string; type?: string; parent?: string; description: string; fields?: Field[]}): {task: Task; file: string} => {
		requireIsolated(p.project);
		const existing = listTasks(deps.md, p.project);
		const id = p.id === undefined ? nextAutoId(existing) : checkId(p.id);
		const clash = existing.find(t => t.id.toLowerCase() === id.toLowerCase());
		if (clash) throw new Error(`${p.project} already has task ${id}: ${clash.file}`);
		const type = p.type === undefined ? 'task' : checkType(p.type);
		const parent = checkRelation(undefined, p.project, type, p.parent);
		const description = checkDescription(p.description);
		const taskStatus = p.status === undefined ? firstStatus(readStatuses(deps.md, p.project)) : checkAllowed(p.project, p.status);
		const title = p.name === undefined ? titleOf(slugOf(description) || 'task') : checkTitle(p.name);
		const name = slugOf(title) || slugOf(description) || 'task';
		const fields = checkExtras(p.fields ?? []);
		const dir = tasksDir(deps.md, p.project);
		mkdirSync(dir, {recursive: true});
		const file = path.join(dir, `${id}_${name}.md`);
		createTaskFile(file, template({project: p.project, title, date: now().toISOString().slice(0, 10), status: taskStatus, type, ...(parent !== undefined && {parent}), description, fields}));
		log.info('task created', {auto: p.id === undefined, fields: fields.length, epic: type === 'epic', child: parent !== undefined});
		return {task: {project: p.project, id, name, file}, file};
	};

	const statusCounts = (project: string, kids: Entry[]): string => {
		const order = allowedStatuses(readStatuses(deps.md, project));
		const counts = new Map<string, number>();
		for (const k of kids) {
			const s = statusOf(k.text) || '-';
			counts.set(s, (counts.get(s) ?? 0) + 1);
		}
		const rankOf = (s: string): number => (order.includes(s) ? order.indexOf(s) : order.length);
		return [...counts.keys()]
			.sort((a, b) => rankOf(a) - rankOf(b))
			.map(s => `${s} ${counts.get(s)}`)
			.join(', ');
	};

	const relationLines = (task: Task, text: string): string[] => {
		const {project, id} = task;
		const entries = tasksWithText(project);
		const kids = childrenOf(project, id, entries);
		const parent = parentOf(text);
		const rawType = fieldOf(text, 'type')?.trim() ?? '';
		const out: string[] = [];
		if (rawType !== '' && !TASK_TYPES.includes(rawType.toLowerCase())) out.push(`Type ${rawType} is not task or epic`);
		if (isEpicText(text)) {
			if (parent !== undefined) out.push(`An epic has no parent; remove it with "task unset ${project} ${id} parent"`);
			if (kids.length === 0) out.push(`Tasks: none (add one with "task set ${project} <id> parent ${id}")`);
			else {
				out.push(`Tasks (${kids.length}):`, ...kids.map(k => `  ${label(k.task)}  ${statusOf(k.text) || '-'}  ${nameOf(k.task, k.text)}`));
				out.push(`By status: ${statusCounts(project, kids)}`);
			}
			return out;
		}
		if (parent !== undefined) {
			const epic = entries.find(e => sameKey(e.task.id, parent));
			const fix = `; fix it with "task set ${project} ${id} parent <epic-id>" or "task unset ${project} ${id} parent"`;
			if (epic === undefined) out.push(`Parent ${parent} is missing${fix}`);
			else if (!isEpicText(epic.text)) out.push(`Parent ${label(epic.task)} is not an epic${fix}`);
			else out.push(`Parent: ${label(epic.task)}  ${nameOf(epic.task, epic.text)}`);
		}
		if (kids.length > 0) out.push(`${kids.length} task${kids.length === 1 ? ' names' : 's name'} it as parent but it is not an epic`);
		return out;
	};

	const show = (project: string, rawId: string): string => {
		const task = findTask(project, rawId);
		const text = textOf(task);
		const fields = fieldsOf(text);
		const description = descriptionOf(text);
		const missing = [...REQUIRED_FIELDS.filter(k => !fields.some(f => sameKey(f.key, k))), ...(description === '' ? ['description'] : [])];
		const current = statusOf(text);
		const note = offListNote(project, current);
		return [
			`${label(task)}  ${nameOf(task, text)}`,
			`File: ${task.file}`,
			...fields.map(f => `${f.key}: ${f.value}`),
			...(note === undefined ? [] : [`Status ${current} is ${note}; set one with "${STATUS_USAGE}"`]),
			...relationLines(task, text),
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

	const setType = (task: Task, rawValue: string): string => {
		const value = checkType(rawValue);
		const text = textOf(task);
		const before = typeOf(text);
		const hadLine = fieldOf(text, 'type') !== undefined;
		const parent = parentOf(text);
		if (value === 'epic' && parent !== undefined) throw hasParentError(task, parent);
		checkRelation(task, task.project, value, undefined);
		requireIsolated(task.project);
		rewriteTask(task.file, t => (value === 'epic' ? withField(t, 'type', 'epic') : withoutField(t, 'type')));
		log.info('task field set', {required: true, added: !hadLine});
		return `${label(task)}: type = ${value}${before === value ? ' (unchanged)' : !hadLine && value === 'epic' ? ' (added)' : ''}`;
	};

	const setParent = (task: Task, rawValue: string): string => {
		const text = textOf(task);
		const parent = checkRelation(task, task.project, typeOf(text), rawValue.trim()) as string;
		requireIsolated(task.project);
		const before = parentOf(text);
		rewriteTask(task.file, t => withField(t, 'parent', parent));
		log.info('task field set', {required: true, added: before === undefined});
		return `${label(task)}: parent = ${parent}${before === undefined ? ' (added)' : sameKey(before, parent) ? ' (unchanged)' : ''}`;
	};

	const set = (project: string, rawId: string, rawKey: string, rawValue: string): string => {
		const task = findTask(project, rawId);
		if (sameKey(rawKey, 'description')) return setDescription(task, rawValue);
		if (sameKey(rawKey, 'type')) return setType(task, rawValue);
		if (sameKey(rawKey, 'parent')) return setParent(task, rawValue);
		let key: string;
		let value: string;
		if (sameKey(rawKey, 'status')) [key, value] = ['status', checkAllowed(project, rawValue.trim())];
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
		if (sameKey(rawKey, 'type')) {
			requireIsolated(project);
			if (fieldOf(textOf(task), 'type') === undefined) throw new Error(`${label(task)} has no field type`);
			checkRelation(task, project, 'task', undefined);
			rewriteTask(task.file, text => withoutField(text, 'type'));
			log.info('task field removed');
			return `${label(task)}: removed type (now a task)`;
		}
		const key = sameKey(rawKey, 'parent') ? 'parent' : checkFieldKey(rawKey);
		requireIsolated(project);
		if (fieldOf(textOf(task), key) === undefined) throw new Error(`${label(task)} has no field ${key}`);
		rewriteTask(task.file, text => withoutField(text, key));
		log.info('task field removed');
		return `${label(task)}: removed ${key}`;
	};

	const statuses = (project: string): string => {
		const s = readStatuses(deps.md, project);
		const where = s.own ? statusesFile(deps.md, project) : `the default; set its own with "${SET_STATUSES_USAGE}"`;
		return `Statuses of ${project} (${where}): ${allowedStatuses(s).join(', ')}`;
	};

	const setStatuses = (project: string, values: string[]): string => {
		const list = checkStatuses(values);
		requireIsolated(project);
		const before = readStatuses(deps.md, project);
		writeStatuses(deps.md, project, list);
		log.info('task statuses set', {count: list.length});
		const after = {list, own: true};
		const off = listTasks(deps.md, project).flatMap(t => {
			const text = readTask(t.file);
			const current = text === undefined ? undefined : statusOf(text);
			return current === undefined || current === '' || isAllowedStatus(after, current) ? [] : [`${label(t)} (${current})`];
		});
		return [
			`Statuses of ${project}: ${allowedStatuses(before).join(', ')} -> ${allowedStatuses(after).join(', ')}`,
			...(off.length === 0 ? [] : [`${off.length} task${off.length === 1 ? ' has a status' : 's have statuses'} outside the list: ${off.join(', ')}`]),
		].join('\n');
	};

	const remove = (project: string, rawId: string): string => {
		const task = findTask(project, rawId);
		requireIsolated(project);
		if (!lstatSync(task.file).isFile()) throw new Error(`${task.file} is not a regular file`);
		if (isEpicText(textOf(task))) {
			const kids = childrenOf(project, task.id);
			if (kids.length > 0) throw hasTasksError(task, kids);
		}
		rmSync(task.file);
		log.info('task deleted');
		return `Deleted ${label(task)} (${task.file})`;
	};

	const update = (task: Task, values: TaskFormValues, withNewDescription: boolean): void => {
		const taskStatus = checkAllowed(task.project, values.status, statusOf(textOf(task)));
		const type = values.type.trim() === '' ? 'task' : checkType(values.type);
		const parent = checkRelation(task, task.project, type, values.parent.trim() === '' ? undefined : values.parent.trim());
		const description = withNewDescription ? checkDescription(values.description) : undefined;
		const fields = checkExtras(values.fields);
		rewriteTask(task.file, text => {
			let next = withStatus(text, taskStatus);
			next = type === 'epic' ? withField(next, 'type', 'epic') : withoutField(next, 'type');
			next = parent === undefined ? withoutField(next, 'parent') : withField(next, 'parent', parent);
			if (description !== undefined) next = withDescription(next, description);
			for (const old of formFields(text)) if (!fields.some(f => sameKey(f.key, old.key))) next = withoutField(next, old.key);
			for (const f of fields) next = withField(next, f.key, f.value);
			return next;
		});
		log.info('task edited', {fields: fields.length});
	};

	const search = (args: string[]): string => {
		let project: string | undefined;
		let wanted: string | undefined;
		let limit = SEARCH_LIMIT;
		const rest: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i] as string;
			if (arg === '--') {
				rest.push(...args.slice(i + 1));
				break;
			}
			if (arg === '--project') project = checkProject(args[++i]);
			else if (arg === '--status') wanted = checkStatus(args[++i]);
			else if (arg === '--limit') {
				const n = Number(args[++i]);
				if (!Number.isInteger(n) || n < 1 || n > SEARCH_LIMIT_MAX) throw new Error(`--limit is a number from 1 to ${SEARCH_LIMIT_MAX}`);
				limit = n;
			} else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg.slice(0, 32)}. Usage: ${SEARCH_USAGE}`);
			else rest.push(arg);
		}
		if (rest.length === 0) throw new Error(`Usage: ${SEARCH_USAGE}`);
		const query = rest.join(' ');
		const texts = listTasks(deps.md)
			.slice(0, SEARCH_FILES_MAX)
			.flatMap(task => {
				const text = readTask(task.file);
				return text === undefined ? [] : [{task, text}];
			})
			.filter(t => wanted === undefined || statusOf(t.text) === wanted);
		const hits = rank(texts, query, {...(project !== undefined && {project}), limit});
		log.info('task search', {tasks: texts.length, hits: hits.length});
		const among = `${texts.length} task${texts.length === 1 ? '' : 's'}${wanted === undefined ? '' : ` with status ${wanted}`}`;
		const shownQuery = cut(query, LIST_TEXT_MAX);
		if (hits.length === 0) return `No tasks match ${shownQuery} among ${among}.`;
		const lines = [`Tasks matching ${shownQuery} (${hits.length} of ${among}, best first):`];
		const textOfHit = new Map(texts.map(t => [t.task, t.text]));
		hits.forEach((h, i) => {
			const text = textOfHit.get(h.task);
			const state = (text === undefined ? undefined : statusOf(text)) || '-';
			lines.push(`${i + 1}. ${label(h.task)}  ${nameOf(h.task, text)}  [${state}]  (score ${h.score})`, `   ${h.task.file}`);
			if (h.summary !== '') lines.push(`   ${h.summary}`);
			for (const l of h.lines) lines.push(`   L${l.line}: ${l.text}`);
		});
		return lines.join('\n');
	};

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
				status: (text && statusOf(text)) || preset.status || firstStatus(readStatuses(deps.md, project)),
				statusHint: `one of: ${allowedText(project)}`,
				type: (text && typeOf(text)) || preset.type || 'task',
				typeHint: 'task or epic',
				parent: (text && parentOf(text)) || preset.parent || '',
				parentHint: `id of an epic in ${project} (empty: none)`,
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
						...(values.type.trim() !== '' && {type: values.type}),
						...(values.parent.trim() !== '' && {parent: values.parent.trim()}),
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
		description: 'Task files in project docs: fill and edit them, search them',
		usage: USAGE,
		args: [{name: 'subcommand', description: 'What to do; see the subcommands'}],
		notes: NOTES,
		agent: 'safe',
		subcommands: SUBCOMMANDS,
		async run(args, ctx) {
			const [sub, ...rest] = args;
			switch (sub) {
				case undefined:
				case 'help':
					return ctx.showHelp ? ctx.showHelp() : ctx.print(USAGE);
				case 'list':
				case 'ls':
					ctx.print(list(rest));
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
				case 'statuses':
					exactly(rest, 1, STATUSES_USAGE);
					ctx.print(statuses(checkProject(rest[0])));
					return;
				case 'set-statuses':
					if (rest.length < 2) throw new Error(`Usage: ${SET_STATUSES_USAGE}`);
					ctx.print(setStatuses(checkProject(rest[0]), rest.slice(1)));
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
					throw new Error(`Unknown subcommand: ${sub.slice(0, 64)}. Usage: ${LINE}`);
			}
		},
	};
}
