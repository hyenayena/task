import type {Task} from './tasks.js';

export type Hit = {task: Task; score: number; summary: string};

const WORD_RE = /[\p{L}\p{N}]+/gu;
const PER_WORD_MAX = 3;
const PREFIX_MIN = 4;
const SAME_PROJECT_BOOST = 1.5;
const SUMMARY_MAX = 160;
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'are', 'was', 'not', 'a', 'an', 'to', 'of', 'in', 'on', 'is', 'it', 'be', 'by', 'or', 'as', 'at']);

export function words(text: string): string[] {
	return (text.toLowerCase().match(WORD_RE) ?? []).filter(w => w.length >= 2 && !STOP.has(w));
}

// "module" finds "modules" and the other way round, without a stemmer.
const related = (a: string, b: string): boolean =>
	a.length >= PREFIX_MIN && b.length >= PREFIX_MIN && (a.startsWith(b) || b.startsWith(a));

function counts(list: string[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const w of list) m.set(w, (m.get(w) ?? 0) + 1);
	return m;
}

function weight(query: string, field: Map<string, number>): number {
	let exact = field.get(query) ?? 0;
	let near = 0;
	if (exact === 0) for (const [w, n] of field) if (related(query, w)) near += n;
	exact = Math.min(exact, PER_WORD_MAX);
	return exact + Math.min(near, PER_WORD_MAX) / 2;
}

/** The first line of text under the Conclusion heading, else under Request. */
export function summaryOf(text: string): string {
	const lines = text.split('\n');
	const pick = (heading: RegExp): string | undefined => {
		const at = lines.findIndex(l => heading.test(l.trim()));
		if (at < 0) return undefined;
		for (const l of lines.slice(at + 1)) {
			const t = l.trim();
			if (t.startsWith('#')) return undefined;
			if (t !== '' && !t.startsWith('<!--')) return t;
		}
		return undefined;
	};
	const s = pick(/^###?\s+Conclusion$/i) ?? pick(/^##\s+Request$/i) ?? '';
	return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s;
}

/**
 * Ranks tasks by the query words: the file name weighs most, then headings, then the body.
 * Tasks of `project` get a boost, since routine work repeats most within a project.
 */
export function rank(tasks: {task: Task; text: string}[], query: string, project?: string, limit = 10): Hit[] {
	const q = [...new Set(words(query))];
	if (q.length === 0) throw new Error('Give words to search for');
	const hits: Hit[] = [];
	for (const {task, text} of tasks) {
		const name = counts(words(`${task.id} ${task.name}`));
		const headings = counts(words(text.split('\n').filter(l => l.trimStart().startsWith('#')).join(' ')));
		const body = counts(words(text));
		let score = 0;
		let matched = 0;
		for (const w of q) {
			const s = 3 * weight(w, name) + 2 * weight(w, headings) + weight(w, body);
			if (s > 0) matched++;
			score += s;
		}
		if (score === 0) continue;
		// Matching more of the query words beats repeating one of them.
		score *= matched / q.length;
		if (project !== undefined && task.project === project) score *= SAME_PROJECT_BOOST;
		hits.push({task, score: Math.round(score * 10) / 10, summary: summaryOf(text)});
	}
	return hits
		.sort((a, b) => b.score - a.score || (a.task.file < b.task.file ? -1 : 1))
		.slice(0, limit);
}
