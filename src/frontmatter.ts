/**
 * Properties at the top of a Markdown file, as Obsidian writes them: a "---" line, "key: value"
 * lines, a closing "---" line; everything after it is the body. Only the YAML this needs is read:
 * plain and quoted one-line values, and lists under a key ("- a" lines), shown joined with ", ".
 */

// `list`: the value is a YAML list, shown joined with ", ".
export type Field = {key: string; value: string; list?: boolean};

type Entry = Field & {from: number; to: number};
type Front = {lines: string[]; close: number; entries: Entry[]; eol: string};

const KEY_LINE = /^([^\s#:'"-][^:]*?):(?:[ \t]+(.*))?$/;
const NEEDS_QUOTES = /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #|[:\s]$/;
// Plain words YAML reads as booleans or null.
const KEYWORDS = /^(?:true|false|yes|no|on|off|null|~)$/i;

const bare = (line: string): string => line.replace(/\r$/, '');
const isFence = (line: string | undefined): boolean => line !== undefined && bare(line).trimEnd() === '---';
const isEnd = (line: string): boolean => ['---', '...'].includes(bare(line).trimEnd());
const isContinuation = (line: string): boolean => /^[ \t]+\S/.test(bare(line)) || /^-(?:\s|$)/.test(bare(line));
const sameKey = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A value written so that YAML reads it back as the same string. */
export const yamlValue = (v: string): string => (v === '' || NEEDS_QUOTES.test(v) || KEYWORDS.test(v) ? JSON.stringify(v) : v);

function unquote(raw: string): string {
	const v = raw.trim();
	if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
		try {
			const s: unknown = JSON.parse(v);
			if (typeof s === 'string') return s;
		} catch {
			// YAML escapes JSON does not know; the text between the quotes is close enough.
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

/** The properties in file order; none when the file does not start with them. */
export const fieldsOf = (text: string): Field[] => (frontOf(text)?.entries ?? []).map(({from: _from, to: _to, ...field}) => field);

export const fieldOf = (text: string, key: string): string | undefined => fieldsOf(text).find(f => sameKey(f.key, key))?.value;

/** The text with the property set: in place (keeping the file's spelling of the key), or added last. */
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

/** The index of the first line after the properties (0 when the file has none). */
export const bodyStart = (text: string): number => {
	const front = frontOf(text);
	return front ? front.close + 1 : 0;
};

/** Everything after the properties, without the blank lines around it. */
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
