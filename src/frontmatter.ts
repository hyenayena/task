export type Field = {key: string; value: string; list?: boolean};

type Entry = Field & {from: number; to: number};
type Front = {lines: string[]; close: number; entries: Entry[]; eol: string};

const KEY_LINE = /^([^\s#:'"-][^:]*?):(?:[ \t]+(.*))?$/;
const NEEDS_QUOTES = /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #|[:\s]$/;
const KEYWORDS = /^(?:true|false|yes|no|on|off|null|~)$/i;

const bare = (line: string): string => line.replace(/\r$/, '');
const isFence = (line: string | undefined): boolean => line !== undefined && bare(line).trimEnd() === '---';
const isEnd = (line: string): boolean => ['---', '...'].includes(bare(line).trimEnd());
const isContinuation = (line: string): boolean => /^[ \t]+\S/.test(bare(line)) || /^-(?:\s|$)/.test(bare(line));
const sameKey = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export const yamlValue = (v: string): string => (v === '' || NEEDS_QUOTES.test(v) || KEYWORDS.test(v) ? JSON.stringify(v) : v);

function unquote(raw: string): string {
	const v = raw.trim();
	if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
		try {
			const s: unknown = JSON.parse(v);
			if (typeof s === 'string') return s;
		} catch {
		}
		return v.slice(1, -1);
	}
	if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
	return v;
}

function frontOf(text: string): Front | undefined {
	const lines = text.split('\n');
	if (!isFence(lines[0])) return undefined;
	const close = lines.findIndex((l, i) => i > 0 && isEnd(l));
	if (close < 0) return undefined;
	const entries: Entry[] = [];
	for (let i = 1; i < close; i++) {
		const m = KEY_LINE.exec(bare(lines[i]!));
		if (!m) continue;
		let to = i + 1;
		while (to < close && isContinuation(lines[to]!)) to++;
		const inline = (m[2] ?? '').trim();
		const items = lines.slice(i + 1, to).map(l => unquote(bare(l).trim().replace(/^-\s*/, ''))).filter(Boolean);
		const list = inline === '' && items.length > 0;
		entries.push({key: (m[1] as string).trim(), value: list ? items.join(', ') : unquote(inline), ...(list && {list}), from: i, to});
		i = to - 1;
	}
	return {lines, close, entries, eol: lines[0]!.endsWith('\r') ? '\r' : ''};
}

export const fieldsOf = (text: string): Field[] => (frontOf(text)?.entries ?? []).map(({from: _from, to: _to, ...field}) => field);

export const fieldOf = (text: string, key: string): string | undefined => fieldsOf(text).find(f => sameKey(f.key, key))?.value;

export function withField(text: string, key: string, value: string): string {
	const front = frontOf(text);
	if (!front) return render([{key, value}], text);
	const {lines, eol} = front;
	const entry = front.entries.find(e => sameKey(e.key, key));
	if (entry) lines.splice(entry.from, entry.to - entry.from, `${entry.key}: ${yamlValue(value)}${eol}`);
	else lines.splice(front.close, 0, `${key}: ${yamlValue(value)}${eol}`);
	return lines.join('\n');
}

export function withoutField(text: string, key: string): string {
	const front = frontOf(text);
	const entry = front?.entries.find(e => sameKey(e.key, key));
	if (!front || !entry) return text;
	front.lines.splice(entry.from, entry.to - entry.from);
	return front.lines.join('\n');
}

export const bodyStart = (text: string): number => {
	const front = frontOf(text);
	return front ? front.close + 1 : 0;
};

export function bodyOf(text: string): string {
	const front = frontOf(text);
	const body = front ? front.lines.slice(front.close + 1).join('\n') : text;
	return body.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

export function withBody(text: string, body: string): string {
	const front = frontOf(text);
	if (!front) return `${body.trim()}\n`;
	return [...front.lines.slice(0, front.close + 1), front.eol, `${body.trim()}${front.eol}`, ''].join('\n');
}

export function render(fields: Field[], body: string): string {
	const props = fields.map(f => `${f.key}: ${yamlValue(f.value)}`);
	const rest = body.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
	return ['---', ...props, '---', '', ...(rest === '' ? [] : [rest, ''])].join('\n');
}
