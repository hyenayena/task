import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import type {CommandContext, Logger, StyledBlock} from '../../../src/api.js';
import {plainLines, renderStyled} from '../src/kit.js';
import {createTaskCommand} from '../src/commands.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'task-gaps-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
const md = path.join(tmp, 'md', 'projects');
const noopLog: Logger = {error() {}, warn() {}, info() {}, debug() {}, child: () => noopLog, addRedactor() {}};
const command = createTaskCommand({md, isolated: () => [], log: noopLog, now: () => new Date('2026-10-23T12:00:00Z')});
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const capture = async (...args: string[]): Promise<StyledBlock[]> => {
	const blocks: StyledBlock[] = [];
	await command.run(args, {print: () => assert.fail('plain print'), printStyled: b => void blocks.push(...b), clear() {}, exit() {}} satisfies CommandContext);
	return blocks;
};
const dir = path.join(md, 'gap', 'tasks');
mkdirSync(dir, {recursive: true});
writeFileSync(path.join(dir, 'G-1_alpha.md'), '---\nstatus: todo\n---\n\nAlpha login thing\n');
writeFileSync(path.join(dir, 'G-2_beta.md'), `---\nstatus: done\nNote: x${ESC}[31mred${ESC}]0;t${BEL}y\n---\n\nBeta login ${ESC}[2Jwipe\n`);

describe('styled output gaps', () => {
	it('search plain form is the old line format, byte for byte', async () => {
		const lines = plainLines(await capture('search', 'login')).join('\n').split('\n');
		assert.match(lines[0]!, /^Tasks matching login \(2 of 2 tasks, best first\):$/);
		const rest = lines.slice(1);
		const heads = rest.filter(l => /^\d+\./.test(l));
		assert.equal(heads.length, 2);
		heads.forEach((l, i) => assert.match(l, new RegExp(`^${i + 1}\\. gap/G-[12] {2}.+ {2}\\[(todo|done)\\] {2}\\(score [\\d.]+\\)$`)));
		assert.equal(rest.filter(l => /^ {3}\S+G-[12]_(alpha|beta)\.md$/.test(l)).length, 2);
		assert.ok(rest.every(l => /^(\d+\. | {3})/.test(l)));
		assert.equal(lines.some(l => l === ''), false);
	});

	it('untrusted task content never reaches plain or rendered output as escapes', async () => {
		for (const args of [['list', 'gap'], ['show', 'gap', 'G-2'], ['search', 'login']]) {
			const blocks = await capture(...args);
			const plain = plainLines(blocks).join('\n');
			assert.equal(plain.includes(ESC) || plain.includes(BEL), false, args.join(' '));
			for (const color of [true, false]) {
				const out = renderStyled(blocks, 60, {color}).replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
				assert.equal(out.includes(ESC) || out.includes(BEL), false, args.join(' '));
			}
		}
	});
});
