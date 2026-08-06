import { measureDeviceText } from "./device-font";
import type { RmText } from "./rm-parser";

/**
 * Where the device puts each line of a page's typed text, in device pixels from the page top.
 *
 * This exists because a scene-tree node's placement is only half stored: `anchor_origin_x` gives the
 * x, and the y is the laid-out line position of the character `anchor_id` names. So laying the text
 * out is not a drawing concern that happens to be shared -- it is how handwriting gets placed at all.
 */

/**
 * Advance from one line of a paragraph to the next, and the extra gap a new paragraph adds before
 * its first line. Measured off the device's own export with `pdftotext -bbox`, converted at
 * 1404px / 445pt: a wrapped line advances 14.4pt = 45.4px, while paragraph to paragraph is
 * 22.0pt = 69.4px.
 *
 * 69.4 is the number two earlier measurements found independently (rmc's source settled on 69.5
 * "after finding 69.5", and a cross-correlation fit against a device image also gave 69.5) -- they
 * had it as the *line* height, which is right only while every paragraph is a single line.
 */
const PARAGRAPH_GAP_PX = 24.0;
const LEADING_PX: Record<number, number> = {
	1: 45.5, // plain
	3: 58.1, // heading: 18.4pt
	4: 45.5, // list item, same leading as plain
};
const DEFAULT_LEADING_PX = 45.5;

/**
 * What a heading paragraph adds above itself, beyond the uniform gap.
 *
 * Left unmodelled while nothing needed it -- no anchored page carries a heading, so it could not move
 * ink. Drawing the text is what needs it: without this, the one corpus page that has a heading draws
 * it, and everything below it, about a line too high. Measured baseline-to-baseline on the device's
 * export of that page, and it still moves no ink: code 3 appears on exactly one page, which has none.
 */
const HEADING_EXTRA_SPACE_PX = 34.4;

/**
 * Where the first line sits below the text box's own top. Fitted against a device image by
 * cross-correlating ink-per-row profiles, and verified on all six anchored corpus pages.
 *
 * Not the paragraph gap: 45.5 + 24.0 = 69.5 is the paragraph-to-paragraph advance, and that is the
 * number the fit and rmc both landed on, so a page of single-line paragraphs lays out exactly as the
 * verified model did before wrapping existed.
 */
const TEXT_TOP_PX = 62;

/** A list item's whole paragraph is indented, continuation lines included, so it wraps against less width. */
export const LIST_INDENT_PX = 48.0;
/** Where a list item's bullet is drawn, measured from the text box's own left edge. */
export const LIST_MARKER_OFFSET_PX = 19.9;
const LIST_STYLE = 4;
const HEADING_STYLE = 3;

/** Style codes seen on the corpus. 2 and 6 also occur and are not identified; they fall back to plain. */
const PLAIN_STYLE = 1;

/**
 * The style entry that applies to a page's very first paragraph. Every other paragraph's entry is
 * keyed by the id of the character before its first -- the newline that ended the paragraph above --
 * and the first paragraph has no such character, so the device uses this sentinel instead.
 */
const FIRST_PARAGRAPH_STYLE_KEY = "0:0";

/** The two faces the device draws with: a sans for everything, a serif for a heading paragraph. */
export type TextFace = "plain" | "heading";

export function faceOf(style: number): TextFace {
	return style === HEADING_STYLE ? "heading" : "plain";
}

export interface LaidOutLine {
	text: string;
	/** Left edge, in the same frame as stroke points -- the text box's x, plus any list indent. */
	xPx: number;
	/** The line's own y, in device pixels from the page top. */
	yPx: number;
	style: number;
	/** Whether this line opens its paragraph -- which is where a list item's bullet is drawn. */
	firstLine: boolean;
}

export interface TextLayout {
	lines: LaidOutLine[];
	/** Character id -> the y of the line that character sits on. This is what places anchored ink. */
	yOfChar: Map<string, number>;
	/** The first line's y, where an anchor that names no character resolves to. */
	topY: number;
	/** Just past the last line, where the bottom sentinel resolves to. */
	bottomY: number;
}

/**
 * Measures a string's width in device pixels, in the face the device draws that style with. The
 * default is `device-font.ts`; tests inject their own so a break can be stated rather than computed.
 */
export type MeasureText = (text: string, face: TextFace) => number;

/** Every character of the live text in document order, with the id the device knows it by. */
function liveCharacters(text: RmText): { id: string; char: string }[] {
	const characters: { id: string; char: string }[] = [];
	for (const run of text.runs) {
		// A tombstoned run's ids still exist but its characters occupy no line.
		if (run.deleted > 0) continue;
		const [part1, part2] = run.id.split(":").map(Number);
		for (let i = 0; i < run.text.length; i++) characters.push({ id: `${part1}:${part2 + i}`, char: run.text[i] });
	}
	return characters;
}

/**
 * The points a line may break at, in order: after a space, and after a `/` inside a run that has no
 * space in it. The `/` is not a refinement -- `Obsidian_Sync_Plugin-6f1217bc`'s only paragraph is a
 * single 108-character URL, and the device breaks it after `.../1vaoces/`. A space-only rule leaves
 * that paragraph one unbreakable word and runs it off the page.
 */
function breakChunks(paragraph: string): string[] {
	const chunks: string[] = [];
	for (const word of paragraph.split(" ")) {
		if (chunks.length > 0) chunks.push(" ");
		const parts = word.split("/");
		for (let i = 0; i < parts.length; i++) chunks.push(i < parts.length - 1 ? `${parts[i]}/` : parts[i]);
	}
	return chunks.filter((chunk) => chunk !== "");
}

/**
 * Greedy wrap, as the device does it: a trailing space never counts against the width.
 *
 * A line carries both what is drawn and how many of the paragraph's characters it consumed -- they
 * differ by the trailing spaces, and the difference is what keeps `yOfChar` aligned with the text.
 */
function breakIntoLines(
	paragraph: string,
	widthPx: number,
	face: TextFace,
	measure: MeasureText,
): { text: string; length: number }[] {
	if (paragraph === "") return [{ text: "", length: 0 }];
	const lines: { text: string; length: number }[] = [];
	let line = "";
	for (const chunk of breakChunks(paragraph)) {
		if (chunk === " ") {
			line += " ";
			continue;
		}
		const candidate = line + chunk;
		if (line.trimEnd() !== "" && measure(candidate.trimEnd(), face) > widthPx) {
			lines.push({ text: line.trimEnd(), length: line.length });
			line = chunk;
		} else {
			line = candidate;
		}
	}
	lines.push({ text: line.trimEnd(), length: line.length });
	return lines;
}

/**
 * Lays the page's typed text out into lines, and records where every character ended up.
 *
 * Line breaking uses the device's own advance widths (`device-font.ts`), which reproduce every break
 * the corpus's two wrapping pages make. That matters beyond the drawing: a wrong break moves every
 * following line -- and every node anchored to one -- by a whole line height.
 */
export function layoutText(text: RmText, measure: MeasureText = measureDeviceText): TextLayout {
	const characters = liveCharacters(text);
	const lines: LaidOutLine[] = [];
	const yOfChar = new Map<string, number>();

	let y = text.posY + TEXT_TOP_PX;
	let paragraphStart = 0;
	/**
	 * What the bottom sentinel resolves to: the last line's own slot, mirroring the top sentinel's
	 * first line. Measured on both pages that carry one -- the block below `6f1217bc`'s URL lands
	 * within 3px of the device this way, and a full paragraph advance below the last line put it 45px
	 * too low the moment that URL started wrapping onto a second line.
	 */
	let bottomY = y;

	/** Lays one paragraph out and returns the y of its last line, which its newline shares. */
	const flushParagraph = (endExclusive: number): number => {
		// An entry is keyed by the character *before* the paragraph's first -- the newline that ended
		// the paragraph above -- and the first paragraph by a sentinel. A paragraph with no entry of
		// its own is plain: the style does not run on, which the device's export confirms twice over
		// (a plain paragraph follows a heading, and a list item follows a list item that carries one).
		const key = paragraphStart === 0 ? FIRST_PARAGRAPH_STYLE_KEY : characters[paragraphStart - 1].id;
		const style = text.styles.get(key) ?? PLAIN_STYLE;

		const indent = style === LIST_STYLE ? LIST_INDENT_PX : 0;
		const leading = LEADING_PX[style] ?? DEFAULT_LEADING_PX;
		const paragraph = characters.slice(paragraphStart, endExclusive).map((c) => c.char).join("");

		// A paragraph's own leading and gap carry it down from the one above -- so a heading's larger
		// leading opens the space above the heading, not below it. For a page of plain paragraphs this
		// is the same arithmetic as before, which is why the six anchored pages cannot move.
		if (paragraphStart > 0) y += leading + PARAGRAPH_GAP_PX + (style === HEADING_STYLE ? HEADING_EXTRA_SPACE_PX : 0);

		let offset = 0;
		let lastLineY = y;
		const wrapped = breakIntoLines(paragraph, text.width - indent, faceOf(style), measure);
		for (const [index, line] of wrapped.entries()) {
			if (index > 0) y += leading;
			lines.push({ text: line.text, xPx: text.posX + indent, yPx: y, style, firstLine: index === 0 });
			for (let i = 0; i < line.length && paragraphStart + offset + i < endExclusive; i++) {
				yOfChar.set(characters[paragraphStart + offset + i].id, y);
			}
			offset += line.length;
			lastLineY = y;
		}
		bottomY = lastLineY;
		return lastLineY;
	};

	for (let i = 0; i < characters.length; i++) {
		if (characters[i].char !== "\n") continue;
		// The newline belongs to the paragraph it ends and shares that paragraph's last line -- which
		// matters, because on the corpus's anchored pages it is usually the newline an anchor names.
		yOfChar.set(characters[i].id, flushParagraph(i));
		paragraphStart = i + 1;
	}
	if (paragraphStart < characters.length) flushParagraph(characters.length);

	return { lines, yOfChar, topY: text.posY + TEXT_TOP_PX, bottomY };
}

/**
 * The device's two anchor ids that name no character: a node pinned to the top of the text, and one
 * pinned below the end of it. Truncated to 32 bits, as this parser reads every CRDT id -- the full
 * values are 0xfffffffffffe and 0xffffffffffff.
 */
export const SENTINEL_ANCHOR_TOP = "0:4294967294";
export const SENTINEL_ANCHOR_BOTTOM = "0:4294967295";
