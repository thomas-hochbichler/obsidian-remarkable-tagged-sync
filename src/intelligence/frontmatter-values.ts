/**
 * One frontmatter property of a page note, read and written line by line: a Value Slot's target
 * (spec §5.3). Like `src/frontmatter.ts`, no YAML round trip and no `processFrontMatter` -- every line
 * this does not own stays byte for byte, comments and odd spacing included.
 *
 * Forms read: `key: value`, `key: "quoted"`, `key: [a, b]`, and a block list (`key:` then `  - a`).
 * Written: a scalar on one line, a list as a block list, which is how Obsidian writes lists.
 */

export type PropertyValue = string | string[];

const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function unquote(raw: string): string {
	const text = raw.trim();
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
	return text;
}

function quote(value: string): string {
	return /^[\s\-?:,[\]{}#&*!|>'"%@`]|[:#]\s|\s$/.test(value) || value === "" ? JSON.stringify(value) : value;
}

/** Where `key` sits in the block: its line, and how many list lines follow it. */
function locate(lines: readonly string[], key: string): { at: number; span: number } | null {
	const at = lines.findIndex((line) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(line));
	if (at === -1) return null;
	let span = 1;
	while (at + span < lines.length && /^\s+-\s/.test(lines[at + span])) span++;
	return { at, span };
}

export function readProperty(content: string, key: string): PropertyValue | null {
	const block = BLOCK.exec(content);
	if (!block) return null;
	const lines = block[1].split(/\r?\n/);
	const found = locate(lines, key);
	if (found === null) return null;
	const inline = lines[found.at].slice(lines[found.at].indexOf(":") + 1).trim();
	if (found.span > 1) return lines.slice(found.at + 1, found.at + found.span).map((line) => unquote(line.replace(/^\s+-\s/, "")));
	if (inline.startsWith("[") && inline.endsWith("]")) {
		const body = inline.slice(1, -1).trim();
		return body === "" ? [] : body.split(",").map(unquote);
	}
	return inline === "" ? null : unquote(inline);
}

/** Writes `key`, replacing its lines where they are; null removes it. A note without a block gets one. */
export function writeProperty(content: string, key: string, value: PropertyValue | null): string {
	const rendered = value === null ? [] : Array.isArray(value) ? [`${key}:`, ...value.map((entry) => `  - ${quote(entry)}`)] : [`${key}: ${quote(value)}`];
	const block = BLOCK.exec(content);
	if (!block) return rendered.length === 0 ? content : `---\n${rendered.join("\n")}\n---\n${content}`;
	const lines = block[1].split(/\r?\n/);
	const found = locate(lines, key);
	if (found === null) lines.push(...rendered);
	else lines.splice(found.at, found.span, ...rendered);
	return `---\n${lines.join("\n")}\n---\n${content.slice(block[0].length)}`;
}
