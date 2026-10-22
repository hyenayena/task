import {closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, writeFileSync, constants} from 'node:fs';
import path from 'node:path';

export const TASKS_DIR = 'tasks';
export const AUTO_PREFIX = 'TASK';

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The id ends at the first underscore, so ids have none.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 80;
const FILE_RE = /^([A-Za-z0-9][A-Za-z0-9-]{0,31})_([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const AUTO_RE = new RegExp(`^${AUTO_PREFIX}-([0-9]{1,9})$`);
const READ_MAX = 256 * 1024;

export type Task = {project: string; id: string; name: string; file: string};

export const isProject = (v: unknown): v is string => typeof v === 'string' && PROJECT_RE.test(v) && v !== '.' && v !== '..';

export function checkProject(v: string | undefined): string {
	if (!isProject(v)) throw new Error('Invalid project name');
	return v;
}

export function checkName(v: string | undefined): string {
	if (v === undefined || v.length > NAME_MAX || !NAME_RE.test(v)) {
		throw new Error('The task name must be kebab-case: lowercase letters and digits joined by "-" (e.g. create-new-module)');
	}
	return v;
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

export function template(p: {project: string; id: string; name: string; date: string}): string {
	return [
		`# ${p.id} ${titleOf(p.name)}`,
		'',
		`Project: ${p.project}`,
		`Created: ${p.date}`,
		'',
		'## Request',
		'',
		'<!-- What the user asked for; their own words where they matter. -->',
		'',
		'## Similar tasks',
		'',
		'<!-- Found with "task search": which ones, and what was taken from them. -->',
		'',
		'## Plan',
		'',
		'## Outcome',
		'',
		'<!-- Written by the documentator when the work on the task is done. -->',
		'',
		'### Conclusion',
		'',
		'### Specifics',
		'',
		'### Asked by the user',
		'',
		'### Changes and why',
		'',
	].join('\n');
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
