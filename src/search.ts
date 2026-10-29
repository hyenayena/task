import {bodyOf, bodyStart, fieldOf} from './frontmatter.js';
import type {Task} from './tasks.js';

/** A line of the file (1-based, as editors and Read count them) where the query matched. */
export type Line = {line: number; text: string};
export type Hit = {task: Task; score: number; summary: string; lines: Line[]};
export type RankOptions = {project?: string; limit?: number};

/** One part of a query: a task id (or label, or number), a word, or a quoted phrase that must appear. */
export type Unit =
	| {kind: 'id'; project?: string; id: string; words: string[]}
	| {kind: 'word'; word: string}
	| {kind: 'phrase'; text: string};

const WORD_RE = /[\p{L}\p{N}]+/gu;
// web/TASK-12, TASK-12 or 12; a token without a digit is a plain word.
const ID_TOKEN = /^(?:([A-Za-z0-9][A-Za-z0-9._-]*)\/)?([A-Za-z0-9][A-Za-z0-9-]*)$/;
const EDGE_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const PER_WORD_MAX = 3;
const PREFIX_MIN = 4;
const TYPO_MIN = 5;
const TYPO_TWO_MIN = 8;
const ID_EXACT = 100;
const ID_NUMBER = 30;
const PHRASE_IN_NAME = 6;
const PHRASE_IN_TEXT = 3;
const QUERY_IN_NAME = 4;
const QUERY_IN_TEXT = 2;
const SAME_PROJECT_BOOST = 1.5;
// Hits under this share of the best score are noise next to it.
const RELEVANT_SHARE = 0.2;
const SUMMARY_MAX = 160;
const LINE_MAX = 160;
const LINES_MAX = 2;
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'are', 'was', 'not', 'a', 'an', 'to', 'of', 'in', 'on', 'is', 'it', 'be', 'by', 'or', 'as', 'at']);

export function words(text: string): string[] {
	return (text.toLowerCase().match(WORD_RE) ?? []).filter(w => w.length >= 2 && !STOP.has(w));
}

const normal = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

// "module" finds "modules" and the other way round, without a stemmer.
const related = (a: string, b: string): boolean =>
	a.length >= PREFIX_MIN && b.length >= PREFIX_MIN && (a.startsWith(b) || b.startsWith(a));

/** Edit distance with swaps of neighbours (optimal string alignment); k + 1 once it exceeds k. */
export function distance(a: string, b: string, k: number): number {
	if (Math.abs(a.length - b.length) > k) return k + 1;
	let before: number[] = [];
	let prev = Array.from({length: b.length + 1}, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		let low = i;
		for (let j = 1; j <= b.length; j++) {
			let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, before[j - 2]! + 1);
			cur.push(v);
			low = Math.min(low, v);
		}
		if (low > k) return k + 1;
		before = prev;
		prev = cur;
	}
	return prev[b.length]!;
}

export function parseQuery(raw: string): Unit[] {
	const parts = raw.split('"');
	if (parts.length % 2 === 0) throw new Error('A phrase has no closing quote, e.g. "login page"');
	const units: Unit[] = [];
	const seen = new Set<string>();
	const add = (key: string, unit: Unit): void => {
		if (seen.has(key)) return;
		seen.add(key);
		units.push(unit);
	};
	parts.forEach((part, i) => {
		if (i % 2 === 1) {
			const text = normal(part);
			if (text !== '') add(`"${text}`, {kind: 'phrase', text});
			return;
		}
		for (const raw of part.split(/\s+/)) {
			const token = raw.replace(EDGE_PUNCT, '');
			const m = ID_TOKEN.exec(token);
			// oauth2 or ipv6 are words; TECH-1 and web/TECH-1 name a task or nothing. A bare number may also be text (429).
			const number = /^\d+$/.test(token);
			if (m && /\d/.test(m[2]!) && (m[1] !== undefined || m[2]!.includes('-') || number)) {
				add(`#${token.toLowerCase()}`, {kind: 'id', ...(m[1] !== undefined && {project: m[1].toLowerCase()}), id: m[2]!.toLowerCase(), words: number ? words(token) : []});
				continue;
			}
			for (const word of words(token)) add(word, {kind: 'word', word});
		}
	});
	if (units.length === 0) throw new Error('Give words to search for');
	return units;
}

function idScore(unit: Extract<Unit, {kind: 'id'}>, task: Task): number {
	if (unit.project !== undefined && unit.project !== task.project.toLowerCase()) return 0;
	const id = task.id.toLowerCase();
	if (unit.id === id) return ID_EXACT;
	if (unit.project === undefined && /^\d+$/.test(unit.id)) {
		const n = /(\d+)$/.exec(id);
		if (n && Number(n[1]) === Number(unit.id)) return ID_NUMBER;
	}
	return 0;
}

function counts(list: string[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const w of list) m.set(w, (m.get(w) ?? 0) + 1);
	return m;
}

/** Word matching for one query: exact, by prefix, or with a typo. Typo checks are cached across files. */
function matcher() {
	const typos = new Map<string, boolean>();
	const typo = (q: string, w: string): boolean => {
		if (q.length < TYPO_MIN || w.length < TYPO_MIN) return false;
		const key = `${q} ${w}`;
		let hit = typos.get(key);
		if (hit === undefined) {
			const k = Math.min(q.length, w.length) >= TYPO_TWO_MIN ? 2 : 1;
			hit = distance(q, w, k) <= k;
			typos.set(key, hit);
		}
		return hit;
	};
	const matches = (q: string, w: string): boolean => q === w || related(q, w) || typo(q, w);
	const weight = (q: string, field: Map<string, number>): number => {
		const exact = field.get(q) ?? 0;
		if (exact > 0) return Math.min(exact, PER_WORD_MAX);
		let near = 0;
		for (const [w, n] of field) if (related(q, w)) near += n;
		if (near > 0) return Math.min(near, PER_WORD_MAX) / 2;
		let close = 0;
		for (const [w, n] of field) if (typo(q, w)) close += n;
		return Math.min(close, PER_WORD_MAX) / 3;
	};
	return {matches, weight};
}

/** The first line of text under the Conclusion heading, else the first text line of the description. */
export function summaryOf(text: string): string {
	const lines = bodyOf(text).split('\n');
	const isText = (t: string): boolean => t !== '' && !t.startsWith('#') && !t.startsWith('<!--');
	const at = lines.findIndex(l => /^#{1,6}\s+Conclusion$/i.test(l.trim()));
	let s = '';
	if (at >= 0) {
		for (const l of lines.slice(at + 1)) {
			const t = l.trim();
			if (t.startsWith('#')) break;
			if (isText(t)) {
				s = t;
				break;
			}
		}
	}
	if (s === '') s = lines.map(l => l.trim()).find(isText) ?? '';
	return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s;
}

const cutLine = (t: string): string => (t.length > LINE_MAX ? `${t.slice(0, LINE_MAX)}…` : t);

/** The body lines with most of the matched words and phrases, in file order; the summary is not repeated. */
function linesOf(text: string, found: string[], phrases: string[], summary: string, matches: (q: string, w: string) => boolean): Line[] {
	const all = text.split('\n');
	const scored: Array<Line & {n: number}> = [];
	for (let i = bodyStart(text); i < all.length; i++) {
		const t = all[i]!.trim();
		if (t === '' || t === summary || (summary.endsWith('…') && t.startsWith(summary.slice(0, -1)))) continue;
		const lineWords = new Set(words(t));
		let n = 0;
		for (const q of found) if ([...lineWords].some(w => matches(q, w))) n++;
		const low = normal(t);
		for (const p of phrases) if (low.includes(p)) n += 2;
		if (n > 0) scored.push({line: i + 1, text: cutLine(t), n});
	}
	return scored
		.sort((a, b) => b.n - a.n || a.line - b.line)
		.slice(0, LINES_MAX)
		.sort((a, b) => a.line - b.line)
		.map(({line, text: t}) => ({line, text: t}));
}

/**
 * Ranks tasks by the query: an exact id or label wins outright, a bare number finds the id with that
 * number; words in the id and name weigh most, then headings, then the whole file, with word forms and
 * typos at lower weight; quoted phrases must appear. Tasks of `project` get a boost, since routine work
 * repeats most within a project.
 */
export function rank(tasks: {task: Task; text: string}[], query: string, opts: RankOptions = {}): Hit[] {
	const units = parseQuery(query);
	const {matches, weight} = matcher();
	const whole = units.length >= 2 && units.every(u => u.kind === 'word') ? normal(query) : undefined;
	const scored: Array<{task: Task; text: string; score: number; found: string[]; phrases: string[]}> = [];
	for (const {task, text} of tasks) {
		const nameText = `${task.id} ${task.name.replace(/-/g, ' ')} ${fieldOf(text, 'name') ?? ''}`;
		const name = counts([...new Set(words(nameText))]);
		const headings = counts(words(text.split('\n').filter(l => l.trimStart().startsWith('#')).join(' ')));
		const body = counts(words(text));
		const lowName = normal(nameText);
		const lowText = normal(text);
		const wordScore = (w: string): number => 3 * weight(w, name) + 2 * weight(w, headings) + weight(w, body);
		const found: string[] = [];
		const phrases: string[] = [];
		let score = 0;
		let matched = 0;
		let missing = false;
		for (const u of units) {
			let s = 0;
			if (u.kind === 'phrase') {
				if (lowName.includes(u.text)) s = PHRASE_IN_NAME;
				else if (lowText.includes(u.text)) s = PHRASE_IN_TEXT;
				else {
					missing = true;
					break;
				}
				phrases.push(u.text);
			} else if (u.kind === 'id') {
				s = idScore(u, task);
				if (s === 0) {
					for (const w of u.words) {
						const ws = wordScore(w);
						if (ws > 0) found.push(w);
						s += ws;
					}
				}
			} else {
				s = wordScore(u.word);
				if (s > 0) found.push(u.word);
			}
			if (s > 0) matched++;
			score += s;
		}
		if (missing || score === 0) continue;
		if (whole !== undefined) score += lowName.includes(whole) ? QUERY_IN_NAME : lowText.includes(whole) ? QUERY_IN_TEXT : 0;
		// Matching more of the query beats repeating one part of it.
		score *= matched / units.length;
		if (opts.project !== undefined && task.project === opts.project) score *= SAME_PROJECT_BOOST;
		scored.push({task, text, score, found, phrases});
	}
	scored.sort((a, b) => b.score - a.score || (a.task.file < b.task.file ? -1 : 1));
	const floor = (scored[0]?.score ?? 0) * RELEVANT_SHARE;
	return scored
		.filter(s => s.score >= floor)
		.slice(0, opts.limit ?? 10)
		.map(s => {
			const summary = summaryOf(s.text);
			return {task: s.task, score: Math.round(s.score * 10) / 10, summary, lines: linesOf(s.text, s.found, s.phrases, summary, matches)};
		});
}
