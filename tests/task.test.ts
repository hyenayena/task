import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import type {CommandContext, Logger, StyledBlock} from '../../../src/api.js';
import {plainLines, renderStyled} from '../src/kit.js';
import {createTaskCommand} from '../src/commands.js';
import plugin, {depsFor} from '../src/index.js';
import {distance, parseQuery, rank, summaryOf, words} from '../src/search.js';
import {yamlValue} from '../src/frontmatter.js';
import {checkFieldKey, checkFieldValue, checkStatus, checkTitle, descriptionOf, extraFields, fieldOf, fieldsOf, formFields, listTasks, nameIn, nextAutoId, parseFileName, slugOf, statusOf, type Task, template, withDescription, withField, withoutField, withStatus} from '../src/tasks.js';
import type {FormField, FormValue} from '../src/ui/kit.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
const md = path.join(tmp, 'md', 'projects');
let isolatedNow: string[] = [];
const isolate = (...names: string[]) => void (isolatedNow = names);

const noopLog: Logger = {error() {}, warn() {}, info() {}, debug() {}, child: () => noopLog, addRedactor() {}};
const command = createTaskCommand({md, isolated: () => isolatedNow, log: noopLog, now: () => new Date('2026-10-23T12:00:00Z')});
const run = async (...args: string[]): Promise<string> => {
	const printed: string[] = [];
	const ctx: CommandContext = {print: t => void printed.push(t), clear() {}, exit() {}};
	await command.run(args, ctx);
	return printed.join('\n');
};

describe('task names', () => {
	it('parses <id>_<kebab-name>.md only', () => {
		assert.deepEqual(parseFileName('TECH-12345_create-new-module.md'), {id: 'TECH-12345', name: 'create-new-module'});
		for (const bad of ['TECH-1.md', 'TECH_1_x.md', 'TECH-1_Create.md', 'TECH-1_x.txt', '_x.md', 'TECH-1_a--b.md']) {
			assert.equal(parseFileName(bad), undefined, bad);
		}
		assert.equal(checkTitle('  Fix login bug '), 'Fix login bug');
		assert.throws(() => checkTitle('a\nb'), /one line/);
		assert.throws(() => checkTitle('x'.repeat(81)), /longer than 80/);
	});

	it('numbers automatic tasks after the highest TASK-<n>', () => {
		const t = (id: string): Task => ({project: 'p', id, name: 'x', file: ''});
		assert.equal(nextAutoId([]), 'TASK-1');
		assert.equal(nextAutoId([t('TASK-2'), t('TASK-10'), t('TECH-99')]), 'TASK-11');
	});

	it('the template is the properties, then the description as the body', () => {
		const text = template({project: 'web', title: 'Create new module', date: '2026-10-23', description: 'Make it', fields: [{key: 'Priority', value: 'high'}]});
		assert.equal(text, '---\nname: Create new module\nproject: web\ncreated: 2026-10-23\nstatus: todo\nPriority: high\n---\n\nMake it\n');
	});
});

describe('search ranking', () => {
	const task = (project: string, id: string, name: string): Task => ({project, id, name, file: `/${project}/${id}_${name}.md`});
	const docs = [
		{task: task('web', 'TECH-1', 'add-login-page'), text: '# TECH-1 Add login page\n## Request\nLogin form with OAuth.\n### Conclusion\nUse the auth module.\n'},
		{task: task('api', 'TECH-2', 'add-login-endpoint'), text: '# TECH-2 Add login endpoint\n## Request\nOAuth login for the API.\n'},
		{task: task('web', 'TECH-3', 'fix-footer'), text: '# TECH-3 Fix footer\n## Request\nFooter overlaps.\n'},
	];

	it('ranks by matched words and boosts the given project', () => {
		const all = rank(docs, 'login oauth');
		assert.deepEqual(all.map(h => h.task.id).sort(), ['TECH-1', 'TECH-2']);
		assert.equal(rank(docs, 'login oauth', {project: 'api'})[0]?.task.id, 'TECH-2');
		assert.equal(rank(docs, 'login oauth', {project: 'web'})[0]?.task.id, 'TECH-1');
	});

	it('matches word forms and summarises with the conclusion', () => {
		const [hit] = rank(docs, 'footers');
		assert.equal(hit?.task.id, 'TECH-3');
		assert.equal(rank(docs, 'login', {project: 'web'})[0]?.summary, 'Use the auth module.');
		assert.equal(summaryOf('## Request\n<!-- c -->\nDo it.\n'), 'Do it.');
		assert.equal(summaryOf('---\nstatus: new\n---\n\n# Heading\nFirst line.\n'), 'First line.');
		assert.deepEqual(rank(docs, 'database'), []);
		assert.throws(() => rank(docs, 'the a'), /Give words/);
		assert.deepEqual(words('Нова Таска, TECH-1!'), ['нова', 'таска', 'tech']);
	});

	it('finds a task by id, label or number before any word match', () => {
		assert.deepEqual(rank(docs, 'tech-2').map(h => h.task.id), ['TECH-2']);
		assert.deepEqual(rank(docs, 'web/TECH-3').map(h => h.task.id), ['TECH-3']);
		assert.deepEqual(rank(docs, 'api/TECH-3').map(h => h.task.id), [], 'the label names another project');
		assert.equal(rank(docs, '3')[0]?.task.id, 'TECH-3');
		assert.deepEqual(rank(docs, 'TECH-9'), [], 'an unknown id does not fall back to its words');
		assert.deepEqual(parseQuery('oauth2'), [{kind: 'word', word: 'oauth2'}]);
		assert.equal(rank(docs, 'TECH-1 footer')[0]?.task.id, 'TECH-1');
	});

	it('tolerates typos, at less weight than exact words', () => {
		assert.equal(rank(docs, 'overlpas')[0]?.task.id, 'TECH-3');
		assert.equal(rank(docs, 'endpiont')[0]?.task.id, 'TECH-2');
		assert.deepEqual(rank(docs, 'fotr'), [], 'short words need an exact match or a prefix');
		assert.equal(distance('endpoint', 'endpiont', 2), 1);
		assert.equal(distance('kitten', 'sitting', 2), 3);
		assert.equal(distance('abc', 'abcdef', 1), 2);
	});

	it('requires quoted phrases and drops weak hits', () => {
		assert.deepEqual(rank(docs, '"login page"').map(h => h.task.id), ['TECH-1']);
		assert.deepEqual(rank(docs, 'oauth "fix footer"').map(h => h.task.id), ['TECH-3']);
		assert.throws(() => rank(docs, '"login page'), /no closing quote/);
		assert.deepEqual(parseQuery('web/TASK-1 Login "a  B" login'), [
			{kind: 'id', project: 'web', id: 'task-1', words: []},
			{kind: 'word', word: 'login'},
			{kind: 'phrase', text: 'a b'},
		]);
		const weak = [...docs, {task: task('web', 'TECH-4', 'misc'), text: '# TECH-4 Misc\nlogin\n'}];
		const ids = rank(weak, 'login oauth endpoint api').map(h => h.task.id);
		assert.equal(ids[0], 'TECH-2');
		assert.ok(!ids.includes('TECH-4'), ids.join());
	});

	it('shows the matching lines with their line numbers, not the summary again', () => {
		const text = '---\nstatus: done\n---\n\n# TECH-5 Cache\n\nSpeed up pages.\n\n## Plan\nAdd a redis cache.\nNothing else.\n';
		const [hit] = rank([{task: task('web', 'TECH-5', 'cache'), text}], 'redis speed');
		assert.equal(hit?.summary, 'Speed up pages.');
		assert.deepEqual(hit?.lines, [{line: 10, text: 'Add a redis cache.'}]);
		assert.equal(rank(docs, 'login', {limit: 1}).length, 1);
	});
});

describe('properties', () => {
	const text = '---\nname: X\nproject: web\ncreated: 2026-01-01\nstatus: new\nPriority: high\ntags:\n  - a\n  - "b c"\n---\n\nDo it.\n\nOwner: not a field\n';

	it('reads the lines between the "---" lines only, in order', () => {
		assert.deepEqual(fieldsOf(text).map(f => f.key), ['name', 'project', 'created', 'status', 'Priority', 'tags']);
		assert.equal(fieldOf(text, 'priority'), 'high');
		assert.equal(fieldOf(text, 'Owner'), undefined);
		assert.deepEqual(extraFields(text), [{key: 'Priority', value: 'high'}, {key: 'tags', value: 'a, b c', list: true}]);
		assert.deepEqual(formFields(text), [{key: 'Priority', value: 'high'}], 'lists stay out of the form');
		assert.equal(descriptionOf(text), 'Do it.\n\nOwner: not a field');
		assert.deepEqual(fieldsOf('# No properties\nStatus: new\n'), []);
		assert.deepEqual(fieldsOf('---\nstatus: new\n'), [], 'no closing line');
	});

	it('sets in place, appends last, removes a key with its list', () => {
		assert.match(withField(text, 'PRIORITY', 'low'), /\nPriority: low\ntags:/);
		assert.match(withField(text, 'Owner', 'me'), /\n {2}- "b c"\nOwner: me\n---\n\nDo it\.\n\nOwner: not a field\n$/);
		assert.equal(withField(text, 'tags', 'x'), text.replace('tags:\n  - a\n  - "b c"\n', 'tags: x\n'));
		assert.equal(withoutField(text, 'priority'), text.replace('Priority: high\n', ''));
		assert.equal(withoutField(text, 'tags'), text.replace('tags:\n  - a\n  - "b c"\n', ''));
		assert.equal(withoutField(text, 'Owner'), text);
		assert.equal(withField('Just a body\n', 'status', 'new'), '---\nstatus: new\n---\n\nJust a body\n');
		assert.equal(withStatus('---\r\nStatus: a\r\n---\r\nBody', 'b'), '---\r\nStatus: b\r\n---\r\nBody');
	});

	it('quotes values YAML would read otherwise, and reads quoted ones back', () => {
		const odd = ['a: b', '#tag', 'yes', '- item', 'say "hi"', ' padded', ''];
		for (const v of odd) assert.equal(fieldOf(withField(text, 'Note', v), 'note'), v, v);
		assert.equal(yamlValue('plain words'), 'plain words');
		assert.equal(yamlValue('2026-10-27'), '2026-10-27');
		assert.equal(yamlValue('a: b'), '"a: b"');
		assert.equal(fieldOf("---\nnote: 'it''s'\n---\n", 'note'), "it's");
	});

	it('replaces the body and keeps the properties', () => {
		assert.equal(withDescription(text, 'New text'), text.replace('Do it.\n\nOwner: not a field\n', 'New text\n'));
		assert.equal(descriptionOf('---\nstatus: new\n---\n'), '');
		assert.equal(nameIn(text), 'X');
	});
	it('checks names and values', () => {
		assert.equal(checkFieldKey('Due-date'), 'Due-date');
		assert.throws(() => checkFieldKey('due date'), /field name/);
		assert.throws(() => checkFieldKey('created'), /set when the task is created/);
		assert.throws(() => checkFieldKey('Name'), /part of the file name/);
		assert.throws(() => checkFieldValue('  '), /must not be empty/);
		assert.throws(() => checkFieldValue('a\nb'), /one line/);
		assert.throws(() => checkFieldValue('x'.repeat(1001)), /longer than 1000/);
		assert.equal(slugOf('Fix the login redirect, after logout!'), 'fix-the-login-redirect-after-logout');
		assert.equal(slugOf('Виправити логін'), '');
	});
});

describe('task command', () => {
	it('creates tasks only in isolated projects, with a description', async () => {
		isolate();
		const saved = process.env.CLAUDECODE;
		try {
			delete process.env.CLAUDECODE;
			await assert.rejects(run('new', 'web', 'Add', 'login'), /web is not isolated; run "project isolate web" first$/);
			process.env.CLAUDECODE = '1';
			await assert.rejects(run('new', 'web', 'Add', 'login'), /first \(a yena run from the chat's Bash cannot see the work session/);
		} finally {
			if (saved === undefined) delete process.env.CLAUDECODE;
			else process.env.CLAUDECODE = saved;
		}
		isolate('web');
		const auto = await run('new', 'web', 'Add', 'login');
		assert.equal(auto, path.join(md, 'web', 'tasks', 'TASK-1_add-login.md'));
		assert.equal(readFileSync(auto, 'utf8'), '---\nname: Add login\nproject: web\ncreated: 2026-10-23\nstatus: todo\n---\n\nAdd login\n');
		assert.equal(await run('new', 'web', '--name', 'fix-footer', 'The', 'footer', 'overlaps'), path.join(md, 'web', 'tasks', 'TASK-2_fix-footer.md'));
		const tech = await run('new', 'web', '--id', 'TECH-12345', '--name', 'create-new-module', '--status', 'done', '--', '--odd', 'description');
		assert.equal(tech, path.join(md, 'web', 'tasks', 'TECH-12345_create-new-module.md'));
		assert.match(readFileSync(tech, 'utf8'), /\nstatus: done\n---\n\n--odd description\n$/);
	});

	it('refuses a taken number, a missing description and bad input', async () => {
		await assert.rejects(run('new', 'web', '--id', 'tech-12345', 'other'), /already has task tech-12345/);
		await assert.rejects(run('new', 'web', '--name', '"Fix', 'login', 'x'), /no closing quote/);
		await assert.rejects(run('new', 'web', '--id', 'A_B', 'x'), /task number/);
		await assert.rejects(run('new', 'web', '--status', 'Done!', 'x'), /one kebab-case word/);
		await assert.rejects(run('new', 'web', '--color', 'red', 'x'), /Unknown option --color/);
		await assert.rejects(run('new', 'web', '--id'), /--id needs a value/);
		await assert.rejects(run('new', '../web', 'x'), /Invalid project name/);
		await assert.rejects(run('new', 'web'), /A task needs a description/, 'no form without the app');
		await assert.rejects(run('new', '--id', 'X-1', 'words'), /Usage: task new/);
	});

	it('lists the tasks of one project: bare id, status and name; the project is required', async () => {
		isolate('api');
		await run('new', 'api', '--id', 'TECH-7', '--name', 'add-login-endpoint', 'OAuth login for the API');
		const one = await run('list', 'api');
		assert.match(one, /^TECH-7 +todo +add-login-endpoint$/m);
		assert.doesNotMatch(one, /web|\.md|OAuth/);
		assert.match(await run('list', 'web'), /^TASK-1 +todo +\S/m);
		assert.match(await run('list', 'none'), /No tasks in/);
		await assert.rejects(run('list'), /Usage: task list <project> \[--all\]/);
		await assert.rejects(run('list', '--all'), /Usage: task list <project>/);
		await assert.rejects(run('list', 'api', 'web'), /Usage: task list <project>/);
	});

	it('searches every project, skipping symlinked files', async () => {
		const file = path.join(md, 'web', 'tasks', 'TASK-1_add-login.md');
		writeFileSync(file, `${readFileSync(file, 'utf8')}\n### Conclusion\nReuse the OAuth client.\n`);
		writeFileSync(path.join(tmp, 'secret.md'), 'login login login');
		symlinkSync(path.join(tmp, 'secret.md'), path.join(md, 'web', 'tasks', 'TASK-9_leak-login.md'));
		const out = await run('search', '--project', 'api', 'login');
		assert.match(out, /^1\. api\/TECH-7 /m);
		assert.match(out, /^2\. web\/TASK-1 [\s\S]*Reuse the OAuth client\./m);
		assert.doesNotMatch(out, /TASK-9/);
		assert.match(await run('search', 'database'), /No tasks match database among \d+ tasks\./);
		await assert.rejects(run('search', '--project', 'web'), /Usage: task search/);
	});

	it('shows and sets the status; setting needs an isolated project', async () => {
		isolate('web');
		assert.equal(await run('status', 'web', 'TASK-2'), 'web/TASK-2: todo');
		assert.equal(await run('status', 'web', 'task-2', 'in-progress'), 'web/TASK-2: todo -> in-progress');
		assert.equal(await run('status', 'web', 'TASK-2'), 'web/TASK-2: in-progress');
		assert.equal(await run('status', 'web', 'TASK-2', 'in-progress'), 'web/TASK-2: in-progress (unchanged)');
		const file = path.join(md, 'web', 'tasks', 'TASK-2_fix-footer.md');
		const text = readFileSync(file, 'utf8');
		assert.match(text, /\nstatus: in-progress\n/);
		assert.equal(text.match(/^status:/gm)?.length, 1, 'one status line');
		assert.match(await run('list', 'web'), /^TASK-2 +in-progress +\S/m);
		isolate();
		await assert.rejects(run('status', 'web', 'TASK-2', 'done'), /web is not isolated/);
		assert.equal(await run('status', 'web', 'TASK-2'), 'web/TASK-2: in-progress', 'reading works without isolation');
		isolate('web');
		await assert.rejects(run('status', 'web', 'TASK-404'), /web has no task TASK-404/);
		await assert.rejects(run('status', 'web', 'TASK-2', 'Done!'), /one kebab-case word/);
		await assert.rejects(run('status', 'web'), /Usage: task status/);
		await assert.rejects(run('status', 'web', 'TASK-9', 'done'), /not a regular file|has no task/);
	});

	it('gives a task without properties a status, in new properties at the top', async () => {
		isolate('web');
		const file = path.join(md, 'web', 'tasks', 'OLD-1_legacy.md');
		writeFileSync(file, '# Legacy\n\nstatus: not this one\n');
		assert.match(await run('status', 'web', 'OLD-1'), /web\/OLD-1: no status/);
		assert.equal(await run('status', 'web', 'OLD-1', 'done'), 'web/OLD-1: no status -> done');
		assert.equal(readFileSync(file, 'utf8'), '---\nstatus: done\n---\n\n# Legacy\n\nstatus: not this one\n');
		assert.equal(statusOf('# X\nstatus: body\n'), undefined);
		assert.throws(() => checkStatus('x'.repeat(33)), /kebab-case/);
	});

	it('shows, sets and removes fields; status and description stay required', async () => {
		isolate('web');
		writeFileSync(path.join(md, 'web', 'tasks', 'OLD-2_empty.md'), '---\nstatus: done\n---\n');
		assert.match(await run('show', 'web', 'OLD-2'), /^web\/OLD-2 {2}Empty\nFile: \S+OLD-2_empty\.md\nstatus: {2}done\nMissing: description/);
		assert.equal(await run('set', 'web', 'OLD-2', 'description', 'Keep', 'the', 'old', 'one'), 'web/OLD-2: description = Keep the old one (added)');
		assert.equal(readFileSync(path.join(md, 'web', 'tasks', 'OLD-2_empty.md'), 'utf8'), '---\nstatus: done\n---\n\nKeep the old one\n');
		assert.equal(await run('set', 'web', 'TASK-1', 'Priority', 'high'), 'web/TASK-1: Priority = high (added)');
		assert.equal(await run('set', 'web', 'TASK-1', 'priority', 'low'), 'web/TASK-1: priority = low');
		assert.equal(await run('set', 'web', 'TASK-1', 'Priority', 'low'), 'web/TASK-1: Priority = low (unchanged)');
		assert.equal(await run('set', 'web', 'TASK-1', 'STATUS', 'done'), 'web/TASK-1: status = done');
		const shown = await run('show', 'web', 'task-1');
		assert.match(shown, /\nstatus: {2}done\nPriority: {2}low\n\nAdd login\n/);
		assert.doesNotMatch(shown, /Missing/);
		await assert.rejects(run('set', 'web', 'TASK-1', 'Created', 'x'), /set when the task is created/);
		await assert.rejects(run('set', 'web', 'TASK-1', 'name', 'x'), /part of the file name/);
		await assert.rejects(run('set', 'web', 'TASK-1', 'status', 'Not ok'), /one kebab-case word/);
		await assert.rejects(run('set', 'web', 'TASK-1', 'Priority'), /Usage: task set/);
		await assert.rejects(run('unset', 'web', 'TASK-1', 'description'), /Every task needs description/);
		await assert.rejects(run('unset', 'web', 'TASK-1', 'Owner'), /has no field Owner/);
		assert.equal(await run('unset', 'web', 'TASK-1', 'priority'), 'web/TASK-1: removed priority');
		assert.doesNotMatch(readFileSync(path.join(md, 'web', 'tasks', 'TASK-1_add-login.md'), 'utf8'), /Priority/);
		isolate();
		await assert.rejects(run('set', 'web', 'TASK-1', 'Owner', 'me'), /web is not isolated/);
		await assert.rejects(run('unset', 'web', 'TASK-1', 'Owner'), /web is not isolated/);
	});

	it('deletes a task in an isolated project', async () => {
		const file = path.join(md, 'web', 'tasks', 'TECH-12345_create-new-module.md');
		isolate();
		await assert.rejects(run('delete', 'web', 'TECH-12345'), /web is not isolated/);
		isolate('web');
		assert.equal(await run('rm', 'web', 'tech-12345'), `Deleted web/TECH-12345 (${file})`);
		assert.ok(!existsSync(file));
		await assert.rejects(run('delete', 'web', 'TECH-12345'), /has no task/);
		await assert.rejects(run('delete', 'web'), /Usage: task delete/);
	});

	it('help, unknown subcommands and the plugin', async () => {
		assert.equal(await run(), 'task <subcommand>');
		let shown = 0;
		await command.run(['help'], {print() {}, clear() {}, exit() {}, showHelp: () => void shown++});
		assert.equal(shown, 1);
		await assert.rejects(run('nope'), /Unknown subcommand: nope/);
		assert.equal(depsFor('/data/task').md, '/data/md/projects');
		assert.deepEqual(depsFor(path.join(tmp, 'nowhere', 'task')).isolated(), [], 'no project state: nothing isolated');
		const commands = await plugin({dataDir: path.join(tmp, 'task'), log: noopLog, events: {emit() {}, on: () => () => {}}});
		assert.deepEqual(commands.map(c => c.name), ['task']);
		assert.ok(!existsSync(path.join(tmp, 'task')), 'loading writes nothing');
		assert.equal(listTasks(md).length, 5);
	});
});

type Press = {button: string; edit?: (values: FormValue[]) => FormValue[]};
const formRun = async (args: string[], presses: Press[], opts: {runLine?: (line: string) => boolean} = {}) => {
	const printed: string[] = [];
	const lines: string[] = [];
	const errors: (string | undefined)[] = [];
	const titles: string[] = [];
	const seen: FormValue[][] = [];
	const ctx: CommandContext = {
		print: t => void printed.push(t),
		clear() {},
		exit() {},
		mount: async (build, options) => {
			assert.equal(options?.target, 'panel');
			let closed = false;
			const host = {runLine: opts.runLine ?? ((line: string) => (lines.push(line), true))};
			const el = build({close: () => void (closed = true), host: host as never}) as {props: Record<string, unknown>};
			if (typeof el.props.onPick === 'function') {
				(el.props.close as () => void)();
				(el.props.onPick as (id: string) => void)((el.props.items as {id: string}[])[1]!.id);
				return;
			}
			const props = el.props as {title: string; fields: FormField[]; onButton: (id: string, v: FormValue[]) => string | undefined};
			titles.push(props.title);
			let values: FormValue[] = props.fields.map(f => ({id: f.id, label: f.label, value: f.value}));
			seen.push(values);
			for (const p of presses) {
				if (closed) break;
				if (p.edit) values = p.edit(values);
				try {
					errors.push(props.onButton(p.button, values));
				} catch (error) {
					errors.push((error as Error).message);
				}
			}
		},
	};
	await command.run(args, ctx);
	return {printed, lines, errors, titles, seen};
};
const setValue = (id: string, value: string) => (values: FormValue[]) => values.map(v => (v.id === id ? {...v, value} : v));
const addField = (key: string, value: string) => (values: FormValue[]) => [...values, {id: `added:${values.length}`, label: key, value}];

describe('task form', () => {
	it('new: fills a task, shows the save error, then saves and discusses it in the chat', async () => {
		isolate('web');
		const r = await formRun(
			['new'],
			[
				{button: 'save'},
				{button: 'discuss', edit: v => addField('Priority', 'high')(setValue('description', 'Ship the task form')(v))},
			],
		);
		assert.deepEqual(r.titles, ['New task · web']);
		assert.deepEqual(
			r.seen[0]!.map(v => `${v.id}=${v.value}`),
			['project=web', 'id=TASK-3', 'name=', 'status=todo', 'type=task', 'parent=', 'description='],
		);
		assert.match(r.errors[0]!, /The description must not be empty/);
		const file = path.join(md, 'web', 'tasks', 'TASK-3_ship-the-task-form.md');
		assert.deepEqual(r.printed, [`Created web/TASK-3: ${file}`]);
		assert.equal(readFileSync(file, 'utf8'), '---\nname: Ship the task form\nproject: web\ncreated: 2026-10-23\nstatus: todo\nPriority: high\n---\n\nShip the task form\n');
		assert.equal(r.lines.length, 1);
		assert.match(r.lines[0]!, /^claude send Let's discuss task web\/TASK-3 \(\S+TASK-3_ship-the-task-form\.md\)\./);
	});

	it('new: picks among several isolated projects; cancel creates nothing; without claude it says how to discuss', async () => {
		isolate('api', 'web');
		const cancelled = await formRun(['new', '--id', 'API-1'], [{button: 'cancel'}]);
		assert.deepEqual(cancelled.titles, ['New task · web']);
		assert.equal(cancelled.seen[0]!.find(v => v.id === 'id')!.value, 'API-1');
		assert.deepEqual(cancelled.printed, ['No task created.']);
		const r = await formRun(['new', 'api'], [{button: 'discuss', edit: setValue('description', 'Rate limits')}], {runLine: () => false});
		assert.match(r.printed[0]!, /^Created api\/TASK-1: /);
		assert.match(r.printed[1]!, /^No chat to discuss it in \(the claude module is missing\)\. Ask the assistant: Let's discuss task api\/TASK-1/);
		isolate();
		await assert.rejects(formRun(['new'], []), /No project is isolated/);
	});

	it('edit: changes status, description and fields, drops emptied ones', async () => {
		isolate('web');
		const file = path.join(md, 'web', 'tasks', 'TASK-3_ship-the-task-form.md');
		const r = await formRun(
			['edit', 'web', 'task-3'],
			[
				{button: 'save', edit: setValue('status', 'Bad status')},
				{
					button: 'save',
					edit: v => addField('Owner', 'me')(setValue('extra:0', '')(setValue('description', 'Ship the form')(setValue('status', 'in-progress')(v)))),
				},
			],
		);
		assert.deepEqual(r.titles, ['Edit task · web/TASK-3']);
		assert.deepEqual(
			r.seen[0]!.map(v => `${v.label}=${v.value}`),
			['Project=web', 'ID=TASK-3', 'Status=todo', 'Type=task', 'Parent=', 'Description=Ship the task form', 'Priority=high'],
		);
		assert.match(r.errors[0]!, /one kebab-case word/);
		assert.deepEqual(r.printed, [`Saved web/TASK-3: ${file}`]);
		assert.deepEqual(r.lines, []);
		assert.equal(readFileSync(file, 'utf8'), '---\nname: Ship the task form\nproject: web\ncreated: 2026-10-23\nstatus: in-progress\nOwner: me\n---\n\nShip the form\n');
		await assert.rejects(run('edit', 'web', 'TASK-3'), /opens a form in the app/);
		await assert.rejects(run('edit', 'web', 'TASK-404'), /has no task/);
	});

	it('edit: keeps a description of several lines and properties the form cannot hold', async () => {
		isolate('web');
		const file = path.join(md, 'web', 'tasks', 'TASK-3_ship-the-task-form.md');
		const before = '---\nname: Ship the task form\nstatus: new\ntags:\n  - ui\ndue date: friday\n---\n\nShip the form.\n\n## Plan\n\nStep one.\n';
		writeFileSync(file, before);
		const r = await formRun(['edit', 'web', 'TASK-3'], [{button: 'save', edit: setValue('status', 'done')}]);
		assert.deepEqual(
			r.seen[0]!.map(v => `${v.label}=${v.value}`),
			['Project=web', 'ID=TASK-3', 'Status=new', 'Type=task', 'Parent=', 'Description=Ship the form. (5 lines: edit the file)'],
		);
		assert.equal(readFileSync(file, 'utf8'), before.replace('status: new', 'status: done'));
	});

	it('the form refuses built-in and repeated field names', async () => {
		const {taskForm} = await import('../src/ui/task-form.js');
		isolate('web');
		let validate!: (label: string, values: FormValue[]) => string | undefined;
		const el = taskForm({close() {}}, {
			title: 't', project: 'web', id: 'X-1', isNew: false, status: 'new', type: 'task', parent: '', description: 'd', fields: [{key: 'Owner', value: 'me'}],
			save() {}, onDone() {},
			validateKey: (key, taken) => (taken.includes(key) ? 'taken' : undefined),
		}) as {props: {add: {validate: typeof validate}}};
		validate = el.props.add.validate;
		assert.equal(validate('Owner', [{id: 'extra:0', label: 'Owner', value: 'me'}]), 'taken');
		assert.equal(validate('Due', []), undefined);
	});
});

describe('task names with spaces', () => {
	it('keeps the name in the properties and its kebab-case form in the file name', async () => {
		isolate('names');
		const file = await run('new', 'names', '--name', '"Fix', 'Login', 'bug"', '--status', 'done', 'The', 'login', 'fails');
		assert.equal(file, path.join(md, 'names', 'tasks', 'TASK-1_fix-login-bug.md'));
		assert.equal(readFileSync(file, 'utf8'), '---\nname: Fix Login bug\nproject: names\ncreated: 2026-10-23\nstatus: done\n---\n\nThe login fails\n');
		assert.match(await run('show', 'names', 'TASK-1'), /^names\/TASK-1  Fix Login bug\n/);
		assert.match(await run('search', 'login'), /names\/TASK-1  Fix Login bug  \[done\]  \(score/);
		assert.equal(await run('new', 'names', '--name', 'Single', 'x'), path.join(md, 'names', 'tasks', 'TASK-2_single.md'));
		assert.equal(await run('new', 'names', '--name', '"Quoted"', 'x'), path.join(md, 'names', 'tasks', 'TASK-3_quoted.md'));
	});

	it('names the file from the description when the name has no latin words', async () => {
		const file = await run('new', 'names', '--name', '"Виправити', 'логін"', 'Fix', 'the', 'login');
		assert.equal(file, path.join(md, 'names', 'tasks', 'TASK-4_fix-the-login.md'));
		assert.match(readFileSync(file, 'utf8'), /^---\nname: Виправити логін\n/);
		assert.equal(await run('new', 'names', '--name', '"Тест"', 'Тест'), path.join(md, 'names', 'tasks', 'TASK-5_task.md'));
	});

	it('shows the file name when a task has no name property', async () => {
		writeFileSync(path.join(md, 'names', 'tasks', 'OLD-1_legacy-task.md'), '---\nstatus: done\n---\n\nOlder task.\n');
		assert.match(await run('show', 'names', 'OLD-1'), /^names\/OLD-1 {2}Legacy task\n/);
	});
});

describe('archived tasks', () => {
	it('hides archived tasks from list unless --all, and says how many are hidden', async () => {
		isolate('arch');
		await run('new', 'arch', 'Open', 'work');
		await run('new', 'arch', '--status', 'archived', 'Old', 'work', 'on', 'caching');
		const open = await run('list', 'arch');
		assert.match(open, /^TASK-1 +todo +Open work/m);
		assert.doesNotMatch(open, /TASK-2/);
		assert.match(open, /^1 archived hidden \(task list arch --all\)$/m);
		const all = await run('list', 'arch', '--all');
		assert.match(all, /^TASK-2 +archived +Old work/m);
		assert.doesNotMatch(all, /hidden/);
		await run('status', 'arch', 'TASK-1', 'archived');
		assert.match(await run('list', 'arch'), /^No open tasks in \S+; 2 archived hidden \(task list arch --all\)$/);
		await assert.rejects(run('list', 'arch', '--every'), /Usage: task list/);
	});

	it('search finds archived tasks, filters by status and shows the matching lines', async () => {
		const out = await run('search', '--project', 'arch', 'cachng');
		assert.match(out, /^Tasks matching cachng \(1 of \d+ tasks, best first\):\n1\. arch\/TASK-2  Old work on caching  \[archived\]  \(score [\d.]+\)\n {3}\S+TASK-2_old-work-on-caching\.md\n {3}Old work on caching$/);
		assert.match(await run('search', '--status', 'todo', 'caching'), /^No tasks match caching among \d+ tasks with status todo\.$/);
		assert.match(await run('search', 'arch/task-1'), /^1\. arch\/TASK-1 /m);
		await assert.rejects(run('search', '--limit', '0', 'x'), /--limit is a number from 1 to 50/);
		await assert.rejects(run('search', '--status', 'Bad!', 'x'), /one kebab-case word/);
		await assert.rejects(run('search', '--color', 'x'), /Unknown option --color/);
	});
});

describe('project statuses', () => {
	it('uses the default list until the project sets its own; archived is always allowed', async () => {
		isolate('flow');
		assert.equal(await run('statuses', 'flow'), 'Statuses of flow (the default; set its own with "task set-statuses <project> <status…>"): todo, in-progress, done, archived');
		const file = await run('new', 'flow', 'First', 'task');
		assert.match(readFileSync(file, 'utf8'), /\nstatus: todo\n/);
		await assert.rejects(run('new', 'flow', '--status', 'review', 'x'), /review is not a status of flow; use one of: todo, in-progress, done, archived/);
		await assert.rejects(run('status', 'flow', 'TASK-1', 'review'), /not a status of flow/);
		await assert.rejects(run('set', 'flow', 'TASK-1', 'status', 'blocked'), /not a status of flow/);
		assert.equal(await run('status', 'flow', 'TASK-1', 'archived'), 'flow/TASK-1: todo -> archived');
	});

	it('sets the list in an isolated project, reports tasks outside it and refuses a bad list', async () => {
		isolate();
		await assert.rejects(run('set-statuses', 'flow', 'new', 'done'), /flow is not isolated/);
		isolate('flow');
		await run('status', 'flow', 'TASK-1', 'in-progress');
		assert.equal(
			await run('set-statuses', 'flow', 'new', 'review', 'done'),
			'Statuses of flow: todo, in-progress, done, archived -> new, review, done, archived\n1 task has a status outside the list: flow/TASK-1 (in-progress)',
		);
		const listFile = path.join(md, 'flow', 'tasks', 'statuses.md');
		assert.equal(readFileSync(listFile, 'utf8'), '# Task statuses of flow\n\nOne per list item, in order; a new task gets the first. archived is always allowed.\n\n- new\n- review\n- done\n');
		assert.match(await run('statuses', 'flow'), /^Statuses of flow \(\S+statuses\.md\): new, review, done, archived$/);
		assert.match(readFileSync(await run('new', 'flow', 'Second'), 'utf8'), /\nstatus: new\n/);
		assert.equal(await run('status', 'flow', 'TASK-1'), 'flow/TASK-1: in-progress (not a status of flow (new, review, done, archived))');
		assert.match(await run('show', 'flow', 'TASK-1'), /\nStatus in-progress is not a status of flow \(new, review, done, archived\); set one with/);
		assert.deepEqual(listTasks(md, 'flow').map(t => t.id), ['TASK-1', 'TASK-2'], 'the list file is not a task');
		await assert.rejects(run('set-statuses', 'flow', 'a', 'a'), /a is in the list twice/);
		await assert.rejects(run('set-statuses', 'flow', 'archived'), /needs a status besides archived/);
		await assert.rejects(run('set-statuses', 'flow', 'Bad!'), /one kebab-case word/);
		await assert.rejects(run('set-statuses', 'flow'), /Usage: task set-statuses/);
	});

	it('reads a hand-edited list and names the file when it is broken', async () => {
		const listFile = path.join(md, 'flow', 'tasks', 'statuses.md');
		writeFileSync(listFile, '# Ours\n\nSome notes.\n\n* backlog\n+ doing\n- shipped\n');
		assert.match(await run('statuses', 'flow'), /: backlog, doing, shipped, archived$/);
		writeFileSync(listFile, '- Not ok\n');
		await assert.rejects(run('status', 'flow', 'TASK-1', 'done'), /statuses\.md: The status is one kebab-case word.*task set-statuses flow/);
		writeFileSync(listFile, 'no items\n');
		await assert.rejects(run('statuses', 'flow'), /needs a status besides archived/);
		rmSync(listFile);
	});

	it('the form keeps a status the list dropped but refuses a new one outside it', async () => {
		isolate('flow');
		const r = await formRun(['edit', 'flow', 'TASK-1'], [{button: 'save', edit: setValue('description', 'Changed')}]);
		assert.deepEqual(r.errors, [undefined]);
		assert.match(readFileSync(listTasks(md, 'flow')[0]!.file, 'utf8'), /\nstatus: in-progress\n[\s\S]*\nChanged\n$/);
		await run('set-statuses', 'flow', 'todo', 'done');
		const bad = await formRun(['edit', 'flow', 'TASK-2'], [{button: 'save', edit: setValue('status', 'review')}, {button: 'cancel'}]);
		assert.match(bad.errors.join('\n'), /review is not a status of flow/);
	});

	it('the statuses commands are documented and the assistant may not change the list unasked', () => {
		assert.equal(command.subcommands?.find(s => s.name === 'set-statuses')?.usage, 'task set-statuses <project> <status…>');
		assert.equal(command.subcommands?.find(s => s.name === 'set-statuses')?.agent, 'confirm');
		assert.equal(command.subcommands?.find(s => s.name === 'statuses')?.agent, 'safe');
		assert.deepEqual(Object.fromEntries((command.subcommands ?? []).map(s => [s.name, s.agent])), {
			list: 'safe', new: 'safe', show: 'safe', edit: 'deny', set: 'safe', unset: 'safe', status: 'safe',
			statuses: 'safe', 'set-statuses': 'confirm', delete: 'confirm', search: 'safe',
		});
		assert.equal(command.agent, 'safe');
	});
});

describe('epics', () => {
	const epFile = (name: string) => path.join(md, 'ep', 'tasks', name);

	it('new: writes type and parent after the status and refuses bad relations', async () => {
		isolate('ep');
		const epic = await run('new', 'ep', '--id', 'E-1', '--type', 'epic', 'Login', 'epic');
		assert.equal(readFileSync(epic, 'utf8'), '---\nname: Login epic\nproject: ep\ncreated: 2026-10-23\nstatus: todo\ntype: epic\n---\n\nLogin epic\n');
		const child = await run('new', 'ep', '--id', 'T-1', '--parent', 'e-1', 'Login', 'form');
		assert.match(readFileSync(child, 'utf8'), /\nstatus: todo\nparent: E-1\n---\n/);
		await assert.rejects(run('new', 'ep', '--type', 'epic', '--parent', 'E-1', 'x'), /An epic is an epic; an epic has no parent/);
		await assert.rejects(run('new', 'ep', '--parent', 'E-404', 'x'), /ep has no task E-404 to be the parent; "task list ep" lists them/);
		await assert.rejects(run('new', 'ep', '--parent', 'T-1', 'x'), /ep\/T-1 is not an epic \(make it one with "task set ep T-1 type epic"\)/);
		await assert.rejects(run('new', 'ep', '--parent', 'ep/E-1', 'x'), /task number may hold/);
		await assert.rejects(run('new', 'ep', '--type', 'story', 'x'), /The type is task or epic/);
		assert.deepEqual(listTasks(md, 'ep').map(t => t.id), ['E-1', 'T-1']);
		assert.equal(
			template({project: 'ep', title: 'X', date: '2026-10-23', description: 'd', type: 'epic', parent: 'E-1', fields: [{key: 'Priority', value: 'high'}]}),
			'---\nname: X\nproject: ep\ncreated: 2026-10-23\nstatus: todo\ntype: epic\nparent: E-1\nPriority: high\n---\n\nd\n',
		);
	});

	it('set and unset: type and parent, with the refusals', async () => {
		isolate('ep');
		await run('new', 'ep', '--id', 'T-2', 'Signup', 'page');
		const t2 = epFile('T-2_signup-page.md');
		assert.equal(await run('set', 'ep', 'T-2', 'type', 'Epic'), 'ep/T-2: type = epic (added)');
		assert.match(readFileSync(t2, 'utf8'), /\nstatus: todo\ntype: epic\n/);
		assert.equal(await run('set', 'ep', 'T-2', 'type', 'task'), 'ep/T-2: type = task');
		assert.doesNotMatch(readFileSync(t2, 'utf8'), /type:/);
		assert.equal(await run('set', 'ep', 'T-2', 'type', 'task'), 'ep/T-2: type = task (unchanged)');
		await assert.rejects(run('set', 'ep', 'T-2', 'type', 'story'), /The type is task or epic/);
		await assert.rejects(run('set', 'ep', 'E-1', 'type', 'task'), /ep\/E-1 has tasks: ep\/T-1; unset their parent first \("task unset ep <id> parent"\)/);
		await assert.rejects(run('set', 'ep', 'T-1', 'type', 'epic'), /ep\/T-1 has parent E-1; unset it first \("task unset ep T-1 parent"\)/);
		await assert.rejects(run('set', 'ep', 'E-1', 'parent', 'T-1'), /ep\/E-1 is an epic; an epic has no parent/);
		await assert.rejects(run('set', 'ep', 'T-2', 'parent', 'T-1'), /ep\/T-1 is not an epic/);
		await assert.rejects(run('set', 'ep', 'T-2', 'parent', 'ep/E-1'), /task number may hold/);
		assert.equal(await run('set', 'ep', 'T-2', 'parent', 'e-1'), 'ep/T-2: parent = E-1 (added)');
		assert.equal(await run('set', 'ep', 'T-2', 'parent', 'E-1'), 'ep/T-2: parent = E-1 (unchanged)');
		await assert.rejects(run('unset', 'ep', 'E-1', 'type'), /ep\/E-1 has tasks: ep\/T-1, ep\/T-2/);
		assert.equal(await run('unset', 'ep', 'T-2', 'parent'), 'ep/T-2: removed parent');
		await assert.rejects(run('unset', 'ep', 'T-2', 'parent'), /ep\/T-2 has no field parent/);
		await assert.rejects(run('unset', 'ep', 'T-2', 'type'), /ep\/T-2 has no field type/);
		await run('new', 'ep', '--id', 'E-2', '--type', 'epic', 'Second', 'epic');
		assert.equal(await run('unset', 'ep', 'E-2', 'type'), 'ep/E-2: removed type (now a task)');
		assert.doesNotMatch(readFileSync(epFile('E-2_second-epic.md'), 'utf8'), /type:/);
		isolate();
		await assert.rejects(run('set', 'ep', 'T-2', 'type', 'epic'), /ep is not isolated/);
		await assert.rejects(run('set', 'ep', 'T-2', 'parent', 'E-1'), /ep is not isolated/);
	});

	it('show: the tasks of an epic with status counts, the parent of a task, and hand-edit flags', async () => {
		isolate('ep');
		await run('set', 'ep', 'T-2', 'parent', 'E-1');
		await run('status', 'ep', 'T-2', 'in-progress');
		const epic = await run('show', 'ep', 'E-1');
		assert.match(epic, /\ntype: {2}epic\nTasks \(2\):\n {2}ep\/T-1 {2}todo {2}Login form\n {2}ep\/T-2 {2}in-progress {2}Signup page\nBy status: todo 1, in-progress 1\n\nLogin epic$/);
		assert.match(await run('show', 'ep', 'T-1'), /\nparent: {2}E-1\nParent: ep\/E-1 {2}Login epic\n/);
		assert.doesNotMatch(await run('show', 'ep', 'E-2'), /Parent|Tasks/);
		writeFileSync(epFile('D-1_dangling.md'), '---\nstatus: todo\nparent: NOPE-1\n---\n\nDangling\n');
		writeFileSync(epFile('D-2_under-task.md'), '---\nstatus: todo\nparent: E-2\n---\n\nUnder a task\n');
		writeFileSync(epFile('E-3_bad-epic.md'), '---\nstatus: todo\ntype: Epic\nparent: NOPE-2\n---\n\nBad epic\n');
		writeFileSync(epFile('S-1_story.md'), '---\nstatus: todo\ntype: story\n---\n\nA story\n');
		assert.match(await run('show', 'ep', 'D-1'), /\nParent NOPE-1 is missing; fix it with "task set ep D-1 parent <epic-id>" or "task unset ep D-1 parent"\n/);
		assert.match(await run('show', 'ep', 'D-2'), /\nParent ep\/E-2 is not an epic; fix it with/);
		assert.match(await run('show', 'ep', 'E-2'), /\n1 task names it as parent but it is not an epic\n/);
		const bad = await run('show', 'ep', 'E-3');
		assert.match(bad, /\nAn epic has no parent; remove it with "task unset ep E-3 parent"\n/);
		assert.match(bad, /\nTasks: none \(add one with "task set ep <id> parent E-3"\)\n/);
		assert.match(await run('show', 'ep', 'S-1'), /\nType story is not task or epic\n/);
	});

	it('list: tasks under their epic, epics marked, dangling and archived flags', async () => {
		const out = await run('list', 'ep');
		assert.match(out, /^\[epic\] E-1 +todo +Login epic\n {2}T-1 +todo +Login form\n {2}T-2 +in-progress +Signup page$/m);
		assert.match(out, /^D-1 +todo +Dangling {2}\(parent NOPE-1 missing\)$/m);
		assert.match(out, /^D-2 +todo +Under task {2}\(parent E-2 is not an epic\)$/m);
		assert.match(out, /^\[epic\] E-3 +todo +Bad epic$/m);
		assert.deepEqual(out.split('\n').map(l => l.replace('[epic] ', '').trim().split(/ +/)[0]), ['D-1', 'D-2', 'E-1', 'T-1', 'T-2', 'E-2', 'E-3', 'S-1']);
		await run('status', 'ep', 'T-2', 'archived');
		const hiddenChild = await run('list', 'ep');
		assert.doesNotMatch(hiddenChild, /T-2/);
		assert.match(hiddenChild, /^1 archived hidden \(task list ep --all\)$/m);
		await run('status', 'ep', 'E-1', 'archived');
		const hiddenEpic = await run('list', 'ep');
		assert.match(hiddenEpic, /^T-1 +todo +Login form {2}\(epic E-1 is archived\)$/m);
		assert.match(hiddenEpic, /^2 archived hidden/m);
		assert.match(await run('list', 'ep', '--all'), /^\[epic\] E-1 +archived +Login epic\n {2}T-1 +todo +Login form\n {2}T-2 +archived +Signup page$/m);
		await run('status', 'ep', 'E-1', 'todo');
	});

	it('the form: Type and Parent rows, built-in names refused, relation errors keep the form open', async () => {
		isolate('ep');
		assert.deepEqual(extraFields('---\nstatus: todo\ntype: epic\nparent: E-1\nOwner: me\n---\n'), [{key: 'Owner', value: 'me'}]);
		for (const key of ['Type', 'parent']) {
			const builtIn = await formRun(['edit', 'ep', 'E-2'], [{button: 'save', edit: addField(key, 'E-1')}, {button: 'cancel'}]);
			assert.match(builtIn.errors[0]!, new RegExp(`${key} is a built-in field`));
		}
		const made = await formRun(['edit', 'ep', 'E-2'], [{button: 'save', edit: setValue('type', 'epic')}]);
		assert.ok(made.seen[0]!.some(v => v.label === 'Type' && v.value === 'task'));
		assert.ok(made.seen[0]!.some(v => v.label === 'Parent' && v.value === ''));
		assert.match(readFileSync(epFile('E-2_second-epic.md'), 'utf8'), /\nstatus: todo\ntype: epic\n---/);
		const refused = await formRun(['edit', 'ep', 'E-2'], [{button: 'save', edit: setValue('parent', 'E-1')}, {button: 'cancel'}]);
		assert.match(refused.errors[0]!, /ep\/E-2 is an epic; an epic has no parent/);
		assert.deepEqual(refused.printed, ['ep/E-2 not changed.']);
		const kids = await formRun(['edit', 'ep', 'E-1'], [{button: 'save', edit: setValue('type', 'task')}, {button: 'cancel'}]);
		assert.match(kids.errors[0]!, /ep\/E-1 has tasks: ep\/T-1, ep\/T-2/);
		const created = await formRun(['new', 'ep', '--parent', 'E-2'], [{button: 'save', edit: setValue('description', 'Child from the form')}]);
		assert.ok(created.seen[0]!.some(v => v.id === 'parent' && v.value === 'E-2'));
		const file = listTasks(md, 'ep').find(t => t.name === 'child-from-the-form')!.file;
		assert.match(readFileSync(file, 'utf8'), /\nstatus: todo\nparent: E-2\n---/);
	});

	it('delete: an epic with tasks is refused until their parent is unset', async () => {
		isolate('ep');
		await assert.rejects(run('delete', 'ep', 'E-1'), /ep\/E-1 has tasks: ep\/T-1, ep\/T-2; unset their parent first/);
		await run('unset', 'ep', 'T-1', 'parent');
		await run('unset', 'ep', 'T-2', 'parent');
		assert.match(await run('rm', 'ep', 'E-1'), /^Deleted ep\/E-1 /);
	});

	it('help documents the new options', () => {
		const sub = command.subcommands?.find(s => s.name === 'new');
		assert.deepEqual(sub?.options?.map(o => o.name), ['--id', '--name', '--status', '--type', '--parent']);
		assert.match(sub?.usage ?? '', /\[--type task\|epic\] \[--parent <epic-id>\]/);
	});
});

describe('epics: hand edits and several projects', () => {
	const file = (project: string, name: string) => path.join(md, project, 'tasks', name);
	const put = (project: string, name: string, text: string) => {
		mkdirSync(path.join(md, project, 'tasks'), {recursive: true});
		writeFileSync(file(project, name), text);
	};

	it('keys and values of a hand edit match without regard to case', async () => {
		isolate('ca');
		put('ca', 'E-1_big.md', '---\nStatus: todo\nTYPE: EPIC\n---\n\nBig\n');
		put('ca', 'T-1_kid.md', '---\nstatus: todo\nPARENT: e-1\n---\n\nKid\n');
		assert.match(await run('show', 'ca', 'E-1'), /\nTasks \(1\):\n {2}ca\/T-1 {2}todo {2}Kid\nBy status: todo 1\n/);
		assert.match(await run('show', 'ca', 'T-1'), /\nParent: ca\/E-1 {2}Big\n/);
		assert.match(await run('list', 'ca'), /^\[epic\] E-1 +todo +Big\n {2}T-1 +todo +Kid$/m);
		await assert.rejects(run('set', 'ca', 'E-1', 'type', 'task'), /ca\/E-1 has tasks: ca\/T-1/);
		await assert.rejects(run('delete', 'ca', 'E-1'), /ca\/E-1 has tasks: ca\/T-1/);
		assert.equal(await run('set', 'ca', 'T-1', 'parent', 'E-1'), 'ca/T-1: parent = E-1 (unchanged)');
		const text = readFileSync(file('ca', 'T-1_kid.md'), 'utf8');
		assert.equal(text.match(/parent:/gi)?.length, 1);
		assert.match(text, /\nPARENT: E-1\n/);
		assert.equal(await run('unset', 'ca', 'T-1', 'PARENT'), 'ca/T-1: removed parent');
		assert.doesNotMatch(readFileSync(file('ca', 'T-1_kid.md'), 'utf8'), /parent/i);
		assert.equal(await run('unset', 'ca', 'E-1', 'Type'), 'ca/E-1: removed type (now a task)');
	});

	it('a parent never resolves across projects', async () => {
		isolate('pa', 'pb');
		await run('new', 'pa', '--id', 'E-1', '--type', 'epic', 'Alpha', 'epic');
		await run('new', 'pb', '--id', 'T-1', 'Beta', 'task');
		await assert.rejects(run('set', 'pb', 'T-1', 'parent', 'E-1'), /pb has no task E-1 to be the parent/);
		await assert.rejects(run('new', 'pb', '--parent', 'E-1', 'x'), /pb has no task E-1/);
		put('pb', 'T-2_stray.md', '---\nstatus: todo\nparent: E-1\n---\n\nStray\n');
		assert.match(await run('show', 'pb', 'T-2'), /\nParent E-1 is missing;/);
		assert.doesNotMatch(await run('show', 'pa', 'E-1'), /T-2/);
		assert.match(await run('list', 'pb'), /^T-2 +todo +Stray {2}\(parent E-1 missing\)/m);
		await run('new', 'pb', '--id', 'E-1', '--type', 'epic', 'Beta', 'epic');
		assert.match(await run('show', 'pb', 'E-1'), /\nTasks \(1\):\n {2}pb\/T-2 /);
		assert.doesNotMatch(await run('show', 'pa', 'E-1'), /Tasks \(/);
		await run('delete', 'pa', 'E-1');
	});

	it('list of each project: epics, children and orphans stay with their own project', async () => {
		isolate('pa', 'pb');
		await run('new', 'pa', '--id', 'E-9', '--type', 'epic', 'Nine');
		await run('new', 'pa', '--id', 'A-1', '--parent', 'e-9', 'Child a');
		await run('new', 'pb', '--id', 'B-1', '--parent', 'E-1', 'Child b');
		put('pa', 'O-1_orphan.md', '---\nstatus: todo\nparent: E-1\n---\n\nOrphan\n');
		const ids = (out: string) => out.split('\n').map(l => l.replace('[epic] ', '').trim().split(/ +/)[0]);
		const pa = await run('list', 'pa');
		const pb = await run('list', 'pb');
		assert.equal(ids(pa).indexOf('A-1'), ids(pa).indexOf('E-9') + 1);
		assert.equal(ids(pb).indexOf('B-1'), ids(pb).indexOf('E-1') + 1);
		assert.match(pa, /^O-1 +todo +Orphan {2}\(parent E-1 missing\)$/m);
		assert.doesNotMatch(pb, /O-1/);
	});

	it('search and the plain task flow are unaffected', async () => {
		isolate('pa');
		await run('new', 'pa', '--id', 'P-1', 'Plain', 'searchable', 'thing');
		assert.doesNotMatch(readFileSync(file('pa', 'P-1_plain-searchable-thing.md'), 'utf8'), /type:|parent:/);
		assert.match(await run('search', '--project', 'pa', 'searchable'), /pa\/P-1/);
		assert.match(await run('show', 'pa', 'P-1'), /^(?!.*(Parent|Tasks))/s);
	});
});

describe('styled output', () => {
	const runStyled = async (...args: string[]): Promise<{blocks: StyledBlock[]; human: string[]; plain: string}> => {
		const blocks: StyledBlock[] = [];
		const ctx: CommandContext = {print: () => assert.fail('printed plain text'), printStyled: b => void blocks.push(...b), clear() {}, exit() {}};
		await command.run(args, ctx);
		const human = renderStyled(blocks, 80, {color: false}).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
		return {blocks, human: human.split('\n'), plain: plainLines(blocks).join('\n')};
	};
	const write = (name: string, text: string) => {
		const dir = path.join(md, 'sty', 'tasks');
		mkdirSync(dir, {recursive: true});
		writeFileSync(path.join(dir, name), text);
	};

	it('list: a head, a rule and aligned columns within the width; plain has neither', async () => {
		write('E-1_login-epic.md', `---\nstatus: todo\ntype: epic\n---\n\nLogin epic ${'with words '.repeat(10)}\n`);
		write('T-1_login-form.md', '---\nstatus: in-progress\nparent: E-1\n---\n\nLogin form\n');
		write('T-2_dangling.md', '---\nstatus: done\nparent: NOPE-1\n---\n\nDangling\n');
		const {human, plain} = await runStyled('list', 'sty');
		const [head, line, ...rows] = human;
		assert.match(head!, /^Task +Status +Name\s*$/);
		assert.match(line!, /^─+$/);
		assert.ok(line!.length <= 80);
		const at = head!.indexOf('Status');
		const name = head!.indexOf('Name');
		for (const r of rows) {
			assert.match(r.slice(at), /^(todo|in-progress|done) /, r);
			assert.match(r.slice(name), /^\S/, r);
			assert.doesNotMatch(r, /\.md/, r);
		}
		assert.ok(rows.some(r => r.includes('(parent NOPE-1 missing)')));
		assert.doesNotMatch(plain, /─|^Task +Status/m);
		assert.equal(plain, await run('list', 'sty'));
		assert.match(plain, /^\[epic\] E-1 {2}todo {2}Login epic$/m);
		assert.match(plain, /^ {2}T-1 {2}in-progress {2}Login form$/m);
		assert.match(plain, /^T-2 {2}done {2}Dangling {2}\(parent NOPE-1 missing\)$/m);
	});

	it('show: the title row, then a rule; tasks of an epic aligned', async () => {
		const {human, plain} = await runStyled('show', 'sty', 'E-1');
		assert.equal(human[0], 'sty/E-1  Login epic');
		assert.match(human[1]!, /^─{80}$/);
		assert.ok(human.includes('Tasks (1):'));
		assert.doesNotMatch(plain, /─/);
		assert.equal(plain, await run('show', 'sty', 'E-1'));
	});

	it('search: the plain form is unchanged and hits are spaced only for people', async () => {
		const {human, plain} = await runStyled('search', 'login');
		assert.equal(plain, await run('search', 'login'));
		assert.match(plain, /^Tasks matching login \(\d+ of \d+ tasks, best first\):\n1\. \S+ {2}.+ {2}\[\S+\] {2}\(score [\d.]+\)\n {3}\//);
		assert.doesNotMatch(plain, /\n\n/);
		assert.ok(human.includes(''));
	});

	it('confirmations keep their plain wording; new prints only the path', async () => {
		isolate('sty');
		const made = await runStyled('new', 'sty', '--id', 'N-1', 'Styled', 'new');
		assert.match(made.human[0]!, /^Created \S+N-1_styled-new\.md$/);
		assert.match(made.plain, /^\S+N-1_styled-new\.md$/);
		const changed = await runStyled('status', 'sty', 'N-1', 'done');
		assert.equal(changed.plain, 'sty/N-1: todo -> done');
		assert.deepEqual(changed.blocks, [{kind: 'line', spans: [{text: 'sty/N-1', bold: true}, ': todo -> ', {text: 'done', tone: 'ok'}]}]);
		assert.equal((await runStyled('set', 'sty', 'N-1', 'Priority', 'high')).plain, 'sty/N-1: Priority = high (added)');
		assert.equal((await runStyled('unset', 'sty', 'N-1', 'Priority')).plain, 'sty/N-1: removed Priority');
		assert.match((await runStyled('statuses', 'sty')).plain, /^Statuses of sty \(the default; .+\): todo, in-progress, done, archived$/);
		assert.match((await runStyled('delete', 'sty', 'N-1')).plain, /^Deleted sty\/N-1 \(\S+N-1_styled-new\.md\)$/);
		isolate();
	});
});
