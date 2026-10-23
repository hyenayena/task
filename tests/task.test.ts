import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import type {CommandContext, Logger} from '../../../src/api.js';
import {createTaskCommand} from '../src/commands.js';
import plugin, {depsFor} from '../src/index.js';
import {rank, summaryOf, words} from '../src/search.js';
import {checkName, listTasks, nextAutoId, parseFileName, type Task, template} from '../src/tasks.js';

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
		assert.throws(() => checkName('Create_Module'), /kebab-case/);
	});

	it('numbers automatic tasks after the highest TASK-<n>', () => {
		const t = (id: string): Task => ({project: 'p', id, name: 'x', file: ''});
		assert.equal(nextAutoId([]), 'TASK-1');
		assert.equal(nextAutoId([t('TASK-2'), t('TASK-10'), t('TECH-99')]), 'TASK-11');
	});

	it('the template has the sections the documentator fills', () => {
		const text = template({project: 'web', id: 'TECH-1', name: 'create-new-module', date: '2026-10-23'});
		assert.match(text, /^# TECH-1 Create new module\n/);
		for (const h of ['## Request', '## Similar tasks', '## Plan', '### Conclusion', '### Specifics', '### Asked by the user', '### Changes and why']) {
			assert.ok(text.includes(`\n${h}\n`), h);
		}
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
		assert.deepEqual(rank(docs, 'database'), []);
		assert.throws(() => rank(docs, 'the a'), /Give words/);
		assert.deepEqual(words('Нова Таска, TECH-1!'), ['нова', 'таска', 'tech']);
	});
});

describe('task command', () => {
	it('creates tasks only in isolated projects', async () => {
		isolate();
		await assert.rejects(run('new', 'web', 'add-login'), /web is not isolated; run "project isolate web" first/);
		isolate('web');
		const auto = await run('new', 'web', 'add-login');
		assert.equal(auto, path.join(md, 'web', 'tasks', 'TASK-1_add-login.md'));
		assert.match(readFileSync(auto, 'utf8'), /^# TASK-1 Add login\n\nProject: web\nCreated: 2026-10-23\n/);
		assert.equal(await run('new', 'web', 'fix-footer'), path.join(md, 'web', 'tasks', 'TASK-2_fix-footer.md'));
		assert.equal(await run('new', 'web', 'create-new-module', 'TECH-12345'), path.join(md, 'web', 'tasks', 'TECH-12345_create-new-module.md'));
	});

	it('refuses a taken number and bad input', async () => {
		await assert.rejects(run('new', 'web', 'other', 'tech-12345'), /already has task tech-12345/);
		await assert.rejects(run('new', 'web', 'Bad_Name'), /kebab-case/);
		await assert.rejects(run('new', 'web', 'x', 'A_B'), /task number/);
		await assert.rejects(run('new', '../web', 'x'), /Invalid project name/);
		await assert.rejects(run('new', 'web'), /Usage: task new/);
	});

	it('lists tasks of all projects or one', async () => {
		isolate('api');
		await run('new', 'api', 'add-login-endpoint', 'TECH-7');
		const all = await run('list');
		assert.match(all, /^api\/TECH-7 +Add login endpoint +\S+TECH-7_add-login-endpoint\.md$/m);
		assert.match(all, /^web\/TASK-1 +Add login/m);
		assert.doesNotMatch(await run('list', 'api'), /web\//);
		assert.match(await run('list', 'none'), /No tasks in/);
	});

	it('searches every project, skipping symlinked files', async () => {
		const file = path.join(md, 'web', 'tasks', 'TASK-1_add-login.md');
		writeFileSync(file, readFileSync(file, 'utf8').replace('### Conclusion\n', '### Conclusion\nReuse the OAuth client.\n'));
		writeFileSync(path.join(tmp, 'secret.md'), 'login login login');
		symlinkSync(path.join(tmp, 'secret.md'), path.join(md, 'web', 'tasks', 'TASK-9_leak-login.md'));
		const out = await run('search', '--project', 'api', 'login');
		assert.match(out, /^1\. api\/TECH-7 /m);
		assert.match(out, /^2\. web\/TASK-1 [\s\S]*Reuse the OAuth client\./m);
		assert.doesNotMatch(out, /TASK-9/);
		assert.match(await run('search', 'database'), /No similar tasks among \d+/);
		await assert.rejects(run('search', '--project', 'web'), /Usage: task search/);
	});

	it('help, unknown subcommands and the plugin', async () => {
		assert.match(await run(), /^Usage: task list/);
		await assert.rejects(run('nope'), /Unknown subcommand: nope/);
		assert.equal(depsFor('/data/task').md, '/data/md/projects');
		assert.deepEqual(depsFor(path.join(tmp, 'nowhere', 'task')).isolated(), [], 'no project state: nothing isolated');
		const commands = await plugin({dataDir: path.join(tmp, 'task'), log: noopLog, events: {emit() {}, on: () => () => {}}});
		assert.deepEqual(commands.map(c => c.name), ['task']);
		assert.ok(!existsSync(path.join(tmp, 'task')), 'loading writes nothing');
		assert.equal(listTasks(md).length, 4);
	});
});
