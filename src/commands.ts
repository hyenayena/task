import {mkdirSync} from 'node:fs';
import path from 'node:path';
import type {Command, Logger} from '../../../src/api.js';
import {noopLog} from './log.js';
import {rank} from './search.js';
import {
	checkId,
	checkName,
	checkProject,
	checkStatus,
	createTaskFile,
	listTasks,
	nextAutoId,
	readTask,
	rewriteTask,
	statusOf,
	SUGGESTED_STATUSES,
	type Task,
	tasksDir,
	template,
	titleOf,
	withStatus,
} from './tasks.js';

export type TaskDeps = {
	/** The hub's projects dir, <YENA_DATA>/md/projects. */
	md: string;
	/** The isolated projects of the work session (the project module's). */
	isolated: () => string[];
	log?: Logger;
	now?: () => Date;
};

const USAGE = 'task list [<project>] | new <project> <name> [<id>] | status <project> <id> [<status>] | search [--project <project>] <words>…';
const STATUS_USAGE = 'task status <project> <id> [<status>]';
const SEARCH_USAGE = 'task search [--project <project>] <words>…';
const SEARCH_FILES_MAX = 5000;

const HELP = [
	`Usage: ${USAGE}`,
	'  list [<project>]                            List task files, of every project or of one',
	'  new <project> <name> [<id>]                 Create md/projects/<project>/tasks/<id>_<name>.md from the template;',
	'                                              <name> is kebab-case, <id> e.g. TECH-12345 (default: the next TASK-<n>)',
	'  status <project> <id> [<status>]            Show the task\'s status, or set it (one kebab-case word:',
	`                                              ${SUGGESTED_STATUSES.join(', ')}…)`,
	'  search [--project <project>] <words>…       Find similar tasks in every project (that project first)',
	'Tasks are created and their status changed only in isolated projects ("project isolate <name>").',
].join('\n');

const label = (t: Task): string => `${t.project}/${t.id}`;

export function createTaskCommand(deps: TaskDeps): Command {
	const log = deps.log ?? noopLog;
	const now = deps.now ?? (() => new Date());

	const list = (project?: string): string => {
		const tasks = listTasks(deps.md, project);
		if (tasks.length === 0) return project === undefined ? `No tasks in ${deps.md}` : `No tasks in ${tasksDir(deps.md, project)}`;
		const width = Math.max(...tasks.map(t => label(t).length));
		const statuses = tasks.map(t => statusLabel(t));
		const sw = Math.max(...statuses.map(x => x.length));
		return tasks.map((t, i) => `${label(t).padEnd(width)}  ${statuses[i]!.padEnd(sw)}  ${titleOf(t.name)}  ${t.file}`).join('\n');
	};

	const requireIsolated = (project: string) => {
		if (!deps.isolated().includes(project)) {
			throw new Error(`${project} is not isolated; run "project isolate ${project}" first`);
		}
	};

	const statusLabel = (t: Task): string => {
		const text = readTask(t.file);
		return text === undefined ? '?' : (statusOf(text) || '-');
	};

	const findTask = (project: string, rawId: string): Task => {
		const id = checkId(rawId);
		const task = listTasks(deps.md, project).find(t => t.id.toLowerCase() === id.toLowerCase());
		if (!task) throw new Error(`${project} has no task ${id}; "task list ${project}" lists them`);
		return task;
	};

	const status = (project: string, rawId: string, next: string | undefined): string => {
		const task = findTask(project, rawId);
		if (next === undefined) {
			const text = readTask(task.file);
			if (text === undefined) throw new Error(`Cannot read ${task.file}`);
			const current = statusOf(text);
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

	const create = (project: string, name: string, rawId: string | undefined): string => {
		requireIsolated(project);
		const existing = listTasks(deps.md, project);
		const id = rawId === undefined ? nextAutoId(existing) : checkId(rawId);
		const clash = existing.find(t => t.id.toLowerCase() === id.toLowerCase());
		if (clash) throw new Error(`${project} already has task ${id}: ${clash.file}`);
		const dir = tasksDir(deps.md, project);
		mkdirSync(dir, {recursive: true});
		const file = path.join(dir, `${id}_${name}.md`);
		createTaskFile(file, template({project, id, name, date: now().toISOString().slice(0, 10)}));
		log.info('task created', {auto: rawId === undefined});
		return file;
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
		hits.forEach((h, i) => {
			lines.push(`${i + 1}. ${label(h.task)}  ${titleOf(h.task.name)}  (score ${h.score})`, `   ${h.task.file}`);
			if (h.summary !== '') lines.push(`   ${h.summary}`);
		});
		return lines.join('\n');
	};

	return {
		name: 'task',
		description: 'Task files in project docs and search for similar tasks',
		usage: USAGE,
		agent: 'safe',
		subcommands: [
			{name: 'list', aliases: ['ls'], usage: 'task list [<project>]', description: 'List task files', agent: 'safe'},
			{name: 'new', usage: 'task new <project> <name> [<id>]', description: 'Create a task file from the template', agent: 'safe'},
			{name: 'status', usage: STATUS_USAGE, description: 'Show or set the status of a task', agent: 'safe'},
			{name: 'search', usage: SEARCH_USAGE, description: 'Find similar tasks', agent: 'safe'},
			{name: 'help', usage: 'task help', description: 'Show the usage', agent: 'safe'},
		],
		run(args, ctx) {
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
					if (rest.length < 2 || rest.length > 3) throw new Error('Usage: task new <project> <name> [<id>]');
					ctx.print(create(checkProject(rest[0]), checkName(rest[1]), rest[2]));
					return;
				case 'status':
					if (rest.length < 2 || rest.length > 3) throw new Error(`Usage: ${STATUS_USAGE}`);
					ctx.print(status(checkProject(rest[0]), rest[1] as string, rest[2]));
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
