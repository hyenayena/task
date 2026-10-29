import {closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync, constants} from 'node:fs';
import path from 'node:path';
import {isProjectName} from './deps/project.js';
import {bodyOf, type Field, fieldOf, fieldsOf, render, withBody, withField, withoutField} from './frontmatter.js';

export {type Field, fieldOf, fieldsOf, withField, withoutField} from './frontmatter.js';

export const TASKS_DIR = 'tasks';
export const AUTO_PREFIX = 'TASK';

// The id ends at the first underscore, so ids have none.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
const NAME_MAX = 80;
const FILE_RE = /^([A-Za-z0-9][A-Za-z0-9-]{0,31})_([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const AUTO_RE = new RegExp(`^${AUTO_PREFIX}-([0-9]{1,9})$`);
const READ_MAX = 256 * 1024;
// One kebab-case word: todo, in-progress, review, done…
const STATUS_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STATUS_MAX = 32;
const STATUSES_MAX = 20;
/** `task list` hides tasks with this status; `task list --all` and `task search` still show them. Allowed in every project. */
export const ARCHIVED_STATUS = 'archived';
/** The statuses of a project without its own list. */
export const DEFAULT_STATUSES = ['todo', 'in-progress', 'done'];
/** A project's own list, in its tasks folder; the name has no "_", so it is never taken for a task. */
export const STATUSES_FILE = 'statuses.md';

export type Task = {project: string; id: string; name: string; file: string};

export const isProject = isProjectName;

export function checkProject(v: string | undefined): string {
	if (!isProject(v)) throw new Error('Invalid project name');
	return v;
}

/** The task name as people write it: one line, spaces allowed; the file name is its kebab-case form. */
export function checkTitle(v: string | undefined): string {
	const title = checkFieldValue(v, 'The task name');
	if (title.length > NAME_MAX) throw new Error(`The task name is longer than ${NAME_MAX} characters`);
	return title;
}

export function checkId(v: string): string {
	if (!ID_RE.test(v)) throw new Error('The task number may hold letters, digits and "-" (e.g. TECH-12345)');
	return v;
}

export const tasksDir = (md: string, project: string): string => path.join(md, project, TASKS_DIR);

export function parseFileName(file: string): {id: string; name: string} | undefined {
	const m = FILE_RE.exec(file);
	return m ? {id: m[1] as string, name: m[2] as string} : undefined;
}

// Real folders and files only: a symlink could point the search outside the docs.
function realEntries(dir: string, kind: 'dir' | 'file'): string[] {
	try {
		return readdirSync(dir, {withFileTypes: true})
			.filter(e => (kind === 'dir' ? e.isDirectory() : e.isFile()))
			.map(e => e.name)
			.sort();
	} catch {
		return [];
	}
}

export function listTasks(md: string, project?: string): Task[] {
	const projects = project === undefined ? realEntries(md, 'dir').filter(isProject) : [project];
	const out: Task[] = [];
	for (const p of projects) {
		const dir = tasksDir(md, p);
		for (const file of realEntries(dir, 'file')) {
			const parsed = parseFileName(file);
			if (parsed) out.push({project: p, ...parsed, file: path.join(dir, file)});
		}
	}
	return out;
}

export function nextAutoId(tasks: Task[]): string {
	let max = 0;
	for (const t of tasks) {
		const m = AUTO_RE.exec(t.id);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `${AUTO_PREFIX}-${max + 1}`;
}

export const titleOf = (name: string): string => {
	const words = name.split('-').join(' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
};

export function template(p: {project: string; title: string; date: string; description: string; status?: string; fields?: Field[]}): string {
	return render(
		[
			{key: 'name', value: p.title},
			{key: 'project', value: p.project},
			{key: 'created', value: p.date},
			{key: 'status', value: p.status ?? (DEFAULT_STATUSES[0] as string)},
			...(p.fields ?? []),
		],
		p.description,
	);
}

/** Exclusive create: an existing file is never overwritten. */
export function createTaskFile(file: string, text: string): void {
	try {
		writeFileSync(file, text, {flag: 'wx', mode: 0o644});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${file} already exists`);
		throw new Error(`Cannot create ${file}: ${(error as NodeJS.ErrnoException).code ?? 'write failed'}`);
	}
}

/** At most READ_MAX bytes of a regular file, never through a symlink; undefined when unreadable. */
export function readTask(file: string): string | undefined {
	let fd: number | undefined;
	try {
		if (!lstatSync(file).isFile()) return undefined;
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		const size = Math.min(fstatSync(fd).size, READ_MAX);
		const buf = Buffer.alloc(size);
		const n = readSync(fd, buf, 0, size, 0);
		return buf.subarray(0, n).toString('utf8');
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function checkStatus(v: string | undefined): string {
	if (v === undefined || v.length > STATUS_MAX || !STATUS_RE.test(v)) {
		throw new Error(`The status is one kebab-case word, e.g. ${[...DEFAULT_STATUSES, ARCHIVED_STATUS].join(', ')}`);
	}
	return v;
}

/** The statuses a project's tasks may have: its list (its own or the default) and archived. */
export type Statuses = {list: string[]; own: boolean};

export const allowedStatuses = (s: Statuses): string[] => (s.list.includes(ARCHIVED_STATUS) ? s.list : [...s.list, ARCHIVED_STATUS]);

export const isAllowedStatus = (s: Statuses, status: string): boolean => allowedStatuses(s).includes(status);

/** The status of a new task: the first of the list that is not archived. */
export const firstStatus = (s: Statuses): string => s.list.find(x => x !== ARCHIVED_STATUS) as string;

/** A list to keep: kebab-case words, no repeats, at least one besides archived. */
export function checkStatuses(values: string[]): string[] {
	const list = values.map(v => checkStatus(v));
	const repeated = list.find((v, i) => list.indexOf(v) !== i);
	if (repeated !== undefined) throw new Error(`${repeated} is in the list twice`);
	if (list.length > STATUSES_MAX) throw new Error(`A project has at most ${STATUSES_MAX} statuses`);
	if (!list.some(v => v !== ARCHIVED_STATUS)) throw new Error(`The list needs a status besides ${ARCHIVED_STATUS}`);
	return list;
}

export const statusesFile = (md: string, project: string): string => path.join(tasksDir(md, project), STATUSES_FILE);

const STATUS_ITEM_RE = /^[-*+]\s+(\S.*?)\s*$/;

/** The list items ("- todo") of a statuses file; headings and other lines are notes for people. */
export function parseStatuses(text: string): string[] {
	const items = text.split('\n').flatMap(line => {
		const m = STATUS_ITEM_RE.exec(line.trim());
		return m ? [(m[1] as string).slice(0, 64)] : [];
	});
	return checkStatuses(items);
}

export const renderStatuses = (project: string, list: string[]): string =>
	[
		`# Task statuses of ${project}`,
		'',
		`One per list item, in order; a new task gets the first. ${ARCHIVED_STATUS} is always allowed.`,
		'',
		...list.map(s => `- ${s}`),
		'',
	].join('\n');

/** The project's own list, or the default when it has none. */
export function readStatuses(md: string, project: string): Statuses {
	const file = statusesFile(md, project);
	try {
		lstatSync(file);
	} catch {
		return {list: DEFAULT_STATUSES, own: false};
	}
	const text = readTask(file);
	if (text === undefined) throw new Error(`Cannot read ${file}`);
	try {
		return {list: parseStatuses(text), own: true};
	} catch (error) {
		throw new Error(`${file}: ${(error as Error).message} (fix the file or run "task set-statuses ${project} <status…>")`);
	}
}

export function writeStatuses(md: string, project: string, list: string[]): void {
	mkdirSync(tasksDir(md, project), {recursive: true});
	const file = statusesFile(md, project);
	let mode = 0o644;
	try {
		const st = lstatSync(file);
		if (!st.isFile()) throw new Error(`${file} is not a regular file`);
		mode = st.mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	replaceFile(file, renderStatuses(project, list), mode);
}

export const statusOf = (text: string): string | undefined => fieldOf(text, 'status');

export const withStatus = (text: string, status: string): string => withField(text, 'status', status);

/** The name as people wrote it; the file name holds only its kebab-case form. */
export const nameIn = (text: string): string | undefined => fieldOf(text, 'name') || undefined;

/** The description is the Markdown body after the properties. */
export const descriptionOf = bodyOf;

export const withDescription = withBody;

/**
 * Replaces a task file in one step: written next to it and renamed over it, never through a symlink.
 * Larger files than a search reads are refused rather than cut.
 */
export function rewriteTask(file: string, change: (text: string) => string): void {
	const st = lstatSync(file);
	if (!st.isFile()) throw new Error(`${file} is not a regular file`);
	if (st.size > READ_MAX) throw new Error(`${file} is larger than ${READ_MAX / 1024} KiB`);
	const text = readTask(file);
	if (text === undefined) throw new Error(`Cannot read ${file}`);
	replaceFile(file, change(text), st.mode & 0o777);
}

function replaceFile(file: string, text: string, mode: number): void {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
	try {
		writeFileSync(tmp, text, {flag: 'wx', mode});
		renameSync(tmp, file);
	} catch (error) {
		rmSync(tmp, {force: true});
		throw new Error(`Cannot write ${file}: ${(error as NodeJS.ErrnoException).code ?? 'write failed'}`);
	}
}

const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/;
const VALUE_MAX = 1000;
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]');
/** Written by the command itself; never set or removed by hand. */
export const FIXED_FIELDS = ['project', 'created'];
/** Every task has them. */
export const REQUIRED_FIELDS = ['status'];
// The name goes with the file name; the description is the body, not a property.
const NAME_FIELDS = ['id', 'name'];
const BODY_FIELDS = ['description'];

const isIn = (key: string, list: string[]): boolean => list.some(k => k.toLowerCase() === key.toLowerCase());
export const isExtraKey = (key: string): boolean => !isIn(key, [...FIXED_FIELDS, ...REQUIRED_FIELDS, ...NAME_FIELDS, ...BODY_FIELDS]);

/** The properties a user or a model added (everything but name, project, created and status). */
export const extraFields = (text: string): Field[] => fieldsOf(text).filter(f => isExtraKey(f.key));

/**
 * The added properties a one-line form can edit and write back unchanged. Lists and keys written
 * elsewhere (e.g. "due date" from Obsidian) are left out, so saving the form never touches them.
 */
export const formFields = (text: string): Field[] =>
	extraFields(text).filter(f => !f.list && FIELD_KEY_RE.test(f.key) && f.value !== '' && !CONTROL.test(f.value) && f.value.length <= VALUE_MAX);

/** A description the form's one-line field can hold. */
export const isOneLine = (text: string): boolean => text !== '' && !CONTROL.test(text) && text.length <= VALUE_MAX;

export function checkFieldKey(v: string | undefined): string {
	if (v === undefined || !FIELD_KEY_RE.test(v)) throw new Error('A field name starts with a letter and holds letters, digits and "-", up to 32 characters (e.g. Priority)');
	if (isIn(v, FIXED_FIELDS)) throw new Error(`${v} is set when the task is created and cannot be changed`);
	if (isIn(v, NAME_FIELDS)) throw new Error(`${v} is part of the file name and cannot be changed`);
	return v;
}

/** One line of text: trimmed, not empty, at most VALUE_MAX characters, no control characters. */
export function checkFieldValue(v: string | undefined, what = 'The value'): string {
	const value = (v ?? '').trim();
	if (value === '') throw new Error(`${what} must not be empty`);
	if (CONTROL.test(value)) throw new Error(`${what} must be one line without control characters`);
	if (value.length > VALUE_MAX) throw new Error(`${what} is longer than ${VALUE_MAX} characters`);
	return value;
}

export const checkDescription = (v: string | undefined): string => checkFieldValue(v, 'The description');

/** The kebab-case form of a text for a file name: its first latin words, or "" when it has none. */
export function slugOf(text: string): string {
	const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
	const out: string[] = [];
	for (const w of words.slice(0, 6)) {
		if ([...out, w].join('-').length > 50) break;
		out.push(w);
	}
	return out.join('-');
}
