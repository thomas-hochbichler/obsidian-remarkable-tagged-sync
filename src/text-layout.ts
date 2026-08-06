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
 * Where the first line sits below the text box's own top. Fitted against a device image by
 * cross-correlating ink-per-row profiles, and verified on all six anchored corpus pages.
 *
 * Not the paragraph gap: 45.5 + 24.0 = 69.5 is the paragraph-to-paragraph advance, and that is the
 * number the fit and rmc both landed on, so a page of single-line paragraphs lays out exactly as the
 * verified model did before wrapping existed.
 */
const TEXT_TOP_PX = 62;

/** A list item's whole paragraph is indented, continuation lines included, so it wraps against less width. */
const LIST_INDENT_PX = 48.0;
const LIST_STYLE = 4;

/** Style codes seen on the corpus. 2 and 6 also occur and are not identified; they fall back to plain. */
const PLAIN_STYLE = 1;

export interface LaidOutLine {
	text: string;
	/** Left edge, in the same frame as stroke points -- the text box's x, plus any list indent. */
	xPx: number;
	/** The line's own y, in device pixels from the page top. */
	yPx: number;
	style: number;
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
 * Measures a string's width in device pixels. Supplied by a caller that knows the font; when it is
 * absent, no line is ever broken -- see `layoutText`.
 */
export type MeasureText = (text: string) => number;

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

/** Greedy word wrap, as the device does it. Returns the paragraph unbroken when it cannot be measured. */
function breakIntoLines(paragraph: string, widthPx: number, measure: MeasureText | undefined): string[] {
	if (!measure || paragraph === "") return [paragraph];
	const lines: string[] = [];
	let line = "";
	for (const word of paragraph.split(" ")) {
		const candidate = line === "" ? word : `${line} ${word}`;
		if (line !== "" && measure(candidate) > widthPx) {
			lines.push(line);
			line = word;
		} else {
			line = candidate;
		}
	}
	lines.push(line);
	return lines;
}

/**
 * Lays the page's typed text out into lines, and records where every character ended up.
 *
 * **Without a `measure`, no paragraph is ever broken.** That is deliberate rather than a stub: the
 * device's own font is not known from the `.rm` alone (the document's `.content` carries `fontName`,
 * `textScale` and `lineHeight`, which this parser never sees), and two corpus pages demonstrably
 * need different font widths. Guessing a font would break lines in the wrong places, and a wrong
 * break moves every following line -- and every node anchored to it -- by a whole line height.
 * Not breaking is the honest approximation, and it is exact for every page whose paragraphs fit on
 * one line, which is every anchored page in the corpus.
 */
export function layoutText(text: RmText, measure?: MeasureText): TextLayout {
	const characters = liveCharacters(text);
	const lines: LaidOutLine[] = [];
	const yOfChar = new Map<string, number>();

	let y = text.posY + TEXT_TOP_PX;
	let paragraphStart = 0;
	let runningStyle = text.styles.get("0:0") ?? PLAIN_STYLE;

	/** Lays one paragraph out and returns the y of its last line, which its newline shares. */
	const flushParagraph = (endExclusive: number): number => {
		const startId = characters[paragraphStart]?.id;
		// A style entry sets the style from its paragraph onward, until another entry changes it.
		const own = startId !== undefined ? text.styles.get(startId) : undefined;
		if (own !== undefined) runningStyle = own;
		const style = runningStyle;

		const indent = style === LIST_STYLE ? LIST_INDENT_PX : 0;
		const leading = LEADING_PX[style] ?? DEFAULT_LEADING_PX;
		const paragraph = characters.slice(paragraphStart, endExclusive).map((c) => c.char).join("");

		let offset = 0;
		let lastLineY = y;
		for (const lineText of breakIntoLines(paragraph, text.width - indent, measure)) {
			lines.push({ text: lineText, xPx: text.posX + indent, yPx: y, style });
			for (let i = 0; i < lineText.length && paragraphStart + offset + i < endExclusive; i++) {
				yOfChar.set(characters[paragraphStart + offset + i].id, y);
			}
			offset += lineText.length + 1; // the space the break consumed
			lastLineY = y;
			y += leading;
		}
		// The paragraph's last line already advanced by one leading; a new paragraph adds the gap.
		y += PARAGRAPH_GAP_PX;
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

	return { lines, yOfChar, topY: text.posY + TEXT_TOP_PX, bottomY: y };
}

/**
 * The device's two anchor ids that name no character: a node pinned to the top of the text, and one
 * pinned below the end of it. Truncated to 32 bits, as this parser reads every CRDT id -- the full
 * values are 0xfffffffffffe and 0xffffffffffff.
 */
export const SENTINEL_ANCHOR_TOP = "0:4294967294";
export const SENTINEL_ANCHOR_BOTTOM = "0:4294967295";
