import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import type {CommandContext, Logger} from '../../../src/api.js';
import {createTaskCommand} from '../src/commands.js';
import plugin, {depsFor} from '../src/index.js';
import {rank, summaryOf, words} from '../src/search.js';
import {yamlValue} from '../src/frontmatter.js';
import {checkFieldKey, checkFieldValue, checkStatus, checkTitle, descriptionOf, extraFields, fieldOf, fieldsOf, formFields, listTasks, nameIn, nextAutoId, parseFileName, slugOf, statusOf, type Task, template, withDescription, withField, withoutField, withStatus} from '../src/tasks.js';
import type {FormField, FormValue} from '../src/ui/kit.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
const md = path.join(tmp, 'md', 'projects');
// What the project module reports as isolated; its state format is its own business.
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
		assert.equal(text, '---\nname: Create new module\nproject: web\ncreated: 2026-10-23\nstatus: new\nPriority: high\n---\n\nMake it\n');
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
		assert.equal(rank(docs, 'login oauth', 'api')[0]?.task.id, 'TECH-2');
		assert.equal(rank(docs, 'login oauth', 'web')[0]?.task.id, 'TECH-1');
	});

	it('matches word forms and summarises with the conclusion', () => {
		const [hit] = rank(docs, 'footers');
		assert.equal(hit?.task.id, 'TECH-3');
		assert.equal(rank(docs, 'login', 'web')[0]?.summary, 'Use the auth module.');
		assert.equal(summaryOf('## Request\n<!-- c -->\nDo it.\n'), 'Do it.');
		assert.equal(summaryOf('---\nstatus: new\n---\n\n# Heading\nFirst line.\n'), 'First line.');
		assert.deepEqual(rank(docs, 'database'), []);
		assert.throws(() => rank(docs, 'the a'), /Give words/);
		assert.deepEqual(words('Нова Таска, TECH-1!'), ['нова', 'таска', 'tech']);
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
		await assert.rejects(run('new', 'web', 'Add', 'login'), /web is not isolated; run "project isolate web" first/);
		isolate('web');
		const auto = await run('new', 'web', 'Add', 'login');
		assert.equal(auto, path.join(md, 'web', 'tasks', 'TASK-1_add-login.md'));
		assert.equal(readFileSync(auto, 'utf8'), '---\nname: Add login\nproject: web\ncreated: 2026-10-23\nstatus: new\n---\n\nAdd login\n');
		assert.equal(await run('new', 'web', '--name', 'fix-footer', 'The', 'footer', 'overlaps'), path.join(md, 'web', 'tasks', 'TASK-2_fix-footer.md'));
		const tech = await run('new', 'web', '--id', 'TECH-12345', '--name', 'create-new-module', '--status', 'review', '--', '--odd', 'description');
		assert.equal(tech, path.join(md, 'web', 'tasks', 'TECH-12345_create-new-module.md'));
		assert.match(readFileSync(tech, 'utf8'), /\nstatus: review\n---\n\n--odd description\n$/);
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

	it('lists tasks of all projects or one, with status and description', async () => {
		isolate('api');
		await run('new', 'api', '--id', 'TECH-7', '--name', 'add-login-endpoint', 'OAuth login for the API');
		const all = await run('list');
		assert.match(all, /^api\/TECH-7 +new +OAuth login for the API +\S+TECH-7_add-login-endpoint\.md$/m);
		assert.match(all, /^web\/TASK-1 +new +Add login/m);
		assert.doesNotMatch(await run('list', 'api'), /web\//);
		assert.match(await run('list', 'none'), /No tasks in/);
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
		assert.match(await run('search', 'database'), /No similar tasks among \d+/);
		await assert.rejects(run('search', '--project', 'web'), /Usage: task search/);
	});

	it('shows and sets the status; setting needs an isolated project', async () => {
		isolate('web');
		assert.equal(await run('status', 'web', 'TASK-2'), 'web/TASK-2: new');
		assert.equal(await run('status', 'web', 'task-2', 'in-progress'), 'web/TASK-2: new -> in-progress');
		assert.equal(await run('status', 'web', 'TASK-2'), 'web/TASK-2: in-progress');
		assert.equal(await run('status', 'web', 'TASK-2', 'in-progress'), 'web/TASK-2: in-progress (unchanged)');
		const file = path.join(md, 'web', 'tasks', 'TASK-2_fix-footer.md');
		const text = readFileSync(file, 'utf8');
		assert.match(text, /\nstatus: in-progress\n/);
		assert.equal(text.match(/^status:/gm)?.length, 1, 'one status line');
		assert.match(await run('list', 'web'), /^web\/TASK-2 +in-progress +The footer overlaps/m);
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
		assert.match(await run('show', 'web', 'OLD-2'), /^web\/OLD-2 {2}Empty\nFile: \S+OLD-2_empty\.md\nstatus: done\nMissing: description/);
		assert.equal(await run('set', 'web', 'OLD-2', 'description', 'Keep', 'the', 'old', 'one'), 'web/OLD-2: description = Keep the old one (added)');
		assert.equal(readFileSync(path.join(md, 'web', 'tasks', 'OLD-2_empty.md'), 'utf8'), '---\nstatus: done\n---\n\nKeep the old one\n');
		assert.equal(await run('set', 'web', 'TASK-1', 'Priority', 'high'), 'web/TASK-1: Priority = high (added)');
		assert.equal(await run('set', 'web', 'TASK-1', 'priority', 'low'), 'web/TASK-1: priority = low');
		assert.equal(await run('set', 'web', 'TASK-1', 'Priority', 'low'), 'web/TASK-1: Priority = low (unchanged)');
		assert.equal(await run('set', 'web', 'TASK-1', 'STATUS', 'review'), 'web/TASK-1: status = review');
		const shown = await run('show', 'web', 'task-1');
		assert.match(shown, /\nstatus: review\nPriority: low\n\nAdd login\n/);
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
		assert.match(await run(), /^Usage:\n {2}task list/);
		await assert.rejects(run('nope'), /Unknown subcommand: nope/);
		assert.equal(depsFor('/data/task').md, '/data/md/projects');
		assert.deepEqual(depsFor(path.join(tmp, 'nowhere', 'task')).isolated(), [], 'no project state: nothing isolated');
		const commands = await plugin({dataDir: path.join(tmp, 'task'), log: noopLog, events: {emit() {}, on: () => () => {}}});
		assert.deepEqual(commands.map(c => c.name), ['task']);
		assert.ok(!existsSync(path.join(tmp, 'task')), 'loading writes nothing');
		assert.equal(listTasks(md).length, 5);
	});
});

describe('task form', () => {
	type Press = {button: string; edit?: (values: FormValue[]) => FormValue[]};
	// Drives the form without a terminal: the mounted element is core's Form, whose props are pressed directly.
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
			['project=web', 'id=TASK-3', 'name=', 'status=new', 'description='],
		);
		assert.match(r.errors[0]!, /The description must not be empty/);
		const file = path.join(md, 'web', 'tasks', 'TASK-3_ship-the-task-form.md');
		assert.deepEqual(r.printed, [`Created web/TASK-3: ${file}`]);
		assert.equal(readFileSync(file, 'utf8'), '---\nname: Ship the task form\nproject: web\ncreated: 2026-10-23\nstatus: new\nPriority: high\n---\n\nShip the task form\n');
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
			['Project=web', 'ID=TASK-3', 'Status=new', 'Description=Ship the task form', 'Priority=high'],
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
		const r = await formRun(['edit', 'web', 'TASK-3'], [{button: 'save', edit: setValue('status', 'review')}]);
		assert.deepEqual(
			r.seen[0]!.map(v => `${v.label}=${v.value}`),
			['Project=web', 'ID=TASK-3', 'Status=new', 'Description=Ship the form. (5 lines: edit the file)'],
		);
		assert.equal(readFileSync(file, 'utf8'), before.replace('status: new', 'status: review'));
	});

	it('the form refuses built-in and repeated field names', async () => {
		const {taskForm} = await import('../src/ui/task-form.js');
		isolate('web');
		let validate!: (label: string, values: FormValue[]) => string | undefined;
		const el = taskForm({close() {}}, {
			title: 't', project: 'web', id: 'X-1', isNew: false, status: 'new', description: 'd', fields: [{key: 'Owner', value: 'me'}],
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
		const file = await run('new', 'names', '--name', '"Fix', 'Login', 'bug"', '--status', 'review', 'The', 'login', 'fails');
		assert.equal(file, path.join(md, 'names', 'tasks', 'TASK-1_fix-login-bug.md'));
		assert.equal(readFileSync(file, 'utf8'), '---\nname: Fix Login bug\nproject: names\ncreated: 2026-10-23\nstatus: review\n---\n\nThe login fails\n');
		assert.match(await run('show', 'names', 'TASK-1'), /^names\/TASK-1  Fix Login bug\n/);
		assert.match(await run('search', 'login'), /names\/TASK-1  Fix Login bug  \(score/);
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
