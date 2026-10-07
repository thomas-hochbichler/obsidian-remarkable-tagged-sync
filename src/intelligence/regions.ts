/**
 * A Region is the section of a page note under a Slot's template heading, up to the next heading of
 * the same or a higher level. There are no markers in the note (users found them confusing), so the
 * heading is the only anchor -- and writing must preserve every line it does not own: the parser
 * skips prose, callouts, blank lines and sub-headings, and ops touch item lines one by one.
 */

import type { ItemFormat } from "./item-format";
import { matchItems } from "./matcher";
import type { ListOp, NoteItem } from "./merge";

export interface Heading {
	level: number;
	text: string;
}

export interface Region {
	/** Line index of the heading. */
	heading: number;
	/** First line after the heading. */
	start: number;
	/** One past the region's last line. */
	end: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[(.)\]\s+)?(.*\S)\s*$/;
export const PROPOSAL_CALLOUT = /^>\s*\[!todo\]\s*\d+ proposals?\b/;

/** Every heading outside fenced code, with its line index. */
export function headings(lines: readonly string[]): (Heading & { line: number })[] {
	const out: (Heading & { line: number })[] = [];
	let fenced = false;
	lines.forEach((line, index) => {
		if (FENCE.test(line)) fenced = !fenced;
		if (fenced) return;
		const match = HEADING.exec(line);
		if (match) out.push({ level: match[1].length, text: match[2], line: index });
	});
	return out;
}

function regionAt(lines: readonly string[], all: (Heading & { line: number })[], at: number): Region {
	const own = all[at];
	const next = all.slice(at + 1).find((h) => h.level <= own.level);
	return { heading: own.line, start: own.line + 1, end: next ? next.line : lines.length };
}

/**
 * The region under `heading`. When the heading was renamed, the heading of the same level whose items
 * best match the base's is taken instead; null when neither finds one -- nothing is written then.
 */
export function findRegion(lines: readonly string[], heading: Heading, format: ItemFormat, baseTexts: readonly string[] = []): Region | null {
	const all = headings(lines);
	const exact = all.findIndex((h) => h.level === heading.level && h.text === heading.text);
	if (exact !== -1) return regionAt(lines, all, exact);
	if (baseTexts.length === 0) return null;
	let best: { at: number; score: number } | null = null;
	all.forEach((h, at) => {
		if (h.level !== heading.level) return;
		const items = parseRegion(lines, regionAt(lines, all, at), format);
		const score = matchItems(items, baseTexts.map((text, i) => ({ id: String(i), text }))).lineToBase.filter((id) => id !== null).length;
		if (score > 0 && (best === null || score > best.score)) best = { at, score };
	});
	return best === null ? null : regionAt(lines, all, (best as { at: number }).at);
}

/** The region's item lines in order, each with its line index. A list line the format cannot read is still an item: its whole text is the text. */
export function parseRegion(lines: readonly string[], region: Region, format: ItemFormat): (NoteItem & { line: number })[] {
	const out: (NoteItem & { line: number })[] = [];
	for (let line = region.start; line < region.end; line++) {
		if (HEADING.test(lines[line])) continue;
		const parsed = format.parse(lines[line]);
		if (parsed) {
			out.push({ text: parsed.text, fields: parsed.fields, checkbox: parsed.checkbox, line });
			continue;
		}
		const loose = LIST_LINE.exec(lines[line]);
		if (loose) out.push({ text: loose[2], fields: {}, checkbox: loose[1] ?? null, line });
	}
	return out;
}

/** Applies merge ops to the note's lines. `items` is the parse the ops were computed against. */
export function applyListOps(lines: readonly string[], region: Region, items: readonly (NoteItem & { line: number })[], ops: readonly ListOp[], format: ItemFormat): string[] {
	const out = [...lines];
	const removed = new Set<number>();
	for (const op of ops) {
		if (op.kind === "update") {
			const at = items[op.line].line;
			const trailing = format.parse(out[at])?.trailing ?? "";
			const indent = /^\s*/.exec(out[at])![0];
			out[at] = indent + format.render({ text: op.text, fields: op.fields, checkbox: items[op.line].checkbox ?? " ", trailing });
		} else if (op.kind === "tick") {
			out[items[op.line].line] = out[items[op.line].line].replace(/\[.\]/, "[x]");
		} else if (op.kind === "remove") {
			removed.add(items[op.line].line);
		}
	}
	const inserts = ops.flatMap((op) => (op.kind === "insert" ? [format.render({ text: op.text, fields: op.fields, checkbox: op.done ? "x" : " " })] : []));
	const after = items.length > 0 ? items[items.length - 1].line + 1 : insertionPoint(out, region);
	const result: string[] = [];
	out.forEach((line, index) => {
		if (index === after) result.push(...inserts);
		if (!removed.has(index)) result.push(line);
	});
	if (after === out.length) result.push(...inserts);
	return result;
}

/** Right under the heading, past a proposal callout; blank lines between heading and content stay above. */
function insertionPoint(lines: readonly string[], region: Region): number {
	let at = region.start;
	while (at < region.end && PROPOSAL_CALLOUT.test(lines[at])) at++;
	let end = region.end;
	while (end > at && lines[end - 1].trim() === "") end--;
	return end;
}

/** Replaces a Text region's body, keeping a proposal callout and one blank line before the next heading. */
export function writeTextRegion(lines: readonly string[], region: Region, text: string): string[] {
	let start = region.start;
	while (start < region.end && PROPOSAL_CALLOUT.test(lines[start])) start++;
	const trailingBlank = region.end < lines.length && region.end > start && lines[region.end - 1].trim() === "" ? [""] : [];
	return [...lines.slice(0, start), ...text.split("\n"), ...trailingBlank, ...lines.slice(region.end)];
}

/** The region's body as the user sees it, without the proposal callout: what a Text merge compares. */
export function readTextRegion(lines: readonly string[], region: Region): string {
	return lines
		.slice(region.start, region.end)
		.filter((line) => !PROPOSAL_CALLOUT.test(line))
		.join("\n")
		.trim();
}

/** Sets, updates or removes the `> [!todo] N proposals — [Review](link)` line right under the heading. */
export function setProposalCallout(lines: readonly string[], region: Region, count: number, link: string): string[] {
	const out = [...lines];
	const has = region.start < region.end && PROPOSAL_CALLOUT.test(out[region.start]);
	const callout = `> [!todo] ${count} ${count === 1 ? "proposal" : "proposals"} — [Review](${link})`;
	if (count === 0) {
		if (has) out.splice(region.start, 1);
	} else if (has) {
		out[region.start] = callout;
	} else {
		out.splice(region.start, 0, callout);
	}
	return out;
}
