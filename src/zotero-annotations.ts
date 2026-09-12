/**
 * A digest entry as a Zotero annotation: spec §3.2, and nothing else.
 *
 * Pure arithmetic over one entry and the page it sits on, split out from the re-sync policy next
 * door because it is the half that is *checkable* -- every rule here is a number or a string that a
 * test can state outright, and every one of them is a rule Zotero's data layer or its reader will
 * enforce on us whether or not we noticed it.
 *
 * The frame is the one thing to keep straight. Our rectangles are the source page's own PDF points
 * with the PDF's bottom-left origin (see `DigestPage.source`), which is exactly what Zotero stores --
 * so nothing here flips an axis. What it does do is fit them to what a *reader* can show: Zotero
 * paints a rectangle, and a rectangle of zero height or one past the page edge paints nothing.
 */

import type { DigestHighlight, DigestNote, DigestPage, DigestPageSource } from "./digest-builder";
import type { PdfRect } from "./pdf-text";
import { DEFAULT_ANNOTATION_COLOR, type NewAnnotation, type ZoteroAnnotationType } from "./zotero-client";

/**
 * Zotero's own eight highlight colours, as its reader offers them.
 *
 * A colour off this list is not refused -- the data layer takes any `#rrggbb` -- but it is invisible
 * in the reader's colour filter and in its sidebar grouping, which is most of what a colour is *for*
 * in Zotero. The reMarkable's colours are others, so every one of ours is put into the band of one of
 * these ({@link zoteroColor}) rather than carried across exactly.
 */
export const ZOTERO_COLORS = [
	{ hex: "#ffd400", r: 255, g: 212, b: 0 },
	{ hex: "#ff6666", r: 255, g: 102, b: 102 },
	{ hex: "#5fb236", r: 95, g: 178, b: 54 },
	{ hex: "#2ea8e5", r: 46, g: 168, b: 229 },
	{ hex: "#a28ae5", r: 162, g: 138, b: 229 },
	{ hex: "#e56eee", r: 229, g: 110, b: 238 },
	{ hex: "#f19837", r: 241, g: 152, b: 55 },
	{ hex: "#aaaaaa", r: 170, g: 170, b: 170 },
] as const;

/**
 * The side of the square a sticky note is drawn in, in points.
 *
 * Zotero's own stickies are this size -- `[72,600,94,622]` in the live sample -- and the size is not
 * cosmetic: the reader draws the note's icon at the rectangle's top-left and the rectangle is what a
 * click has to land in. Our own note rectangles cannot be used as they are, for two reasons the
 * fixture proved rather than suggested: a single horizontal stroke is a box of **zero height**, and
 * margin ink sits **past the page edge** (x ≈ 743 pt on a 612 pt page) because the device's canvas is
 * wider than the paper it shows. Both paint nothing at all.
 */
const STICKY_SIZE_PT = 22;

/** Zotero's `annotationPosition` fits in 65000 characters; three decimals is well inside it and past any reader's precision. */
function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/** Our rectangle as Zotero's `[x1, y1, x2, y2]` -- same frame, same origin, so only the shape changes. */
function asZoteroRect(rect: PdfRect): number[] {
	return [round(rect.x), round(rect.y), round(rect.x + rect.width), round(rect.y + rect.height)];
}

/** `annotationPosition`: a JSON **string**, which is what Zotero's data layer requires -- an object is rejected. */
export function annotationPosition(pageIndex: number, rects: PdfRect[]): string {
	return JSON.stringify({ pageIndex, rects: rects.map(asZoteroRect) });
}

/** The box around every run, which is what the sort index measures from. */
export function unionOf(rects: PdfRect[]): PdfRect | null {
	if (rects.length === 0) return null;
	const x = Math.min(...rects.map((rect) => rect.x));
	const y = Math.min(...rects.map((rect) => rect.y));
	const right = Math.max(...rects.map((rect) => rect.x + rect.width));
	const top = Math.max(...rects.map((rect) => rect.y + rect.height));
	return { x, y, width: right - x, height: top - y };
}

/**
 * `annotationSortIndex`, the field Zotero sorts its sidebar by and the one it will not accept a
 * document without: `PPPPP|CCCCCC|TTTTT`, zero-padded, page then character offset then distance from
 * the page top.
 *
 * The middle field is the character offset in the page's text, which the reader computes from its own
 * text layer. Ours is **always zero**: we do not have the reader's character index and inventing one
 * would sort our annotations by a number that means nothing, in among the user's own where the error
 * would show. With zero, ours sort by page and by height, which is reading order for everything but
 * two annotations that start on the same line -- and those two are a tie, not a mistake.
 *
 * Clamped because the format is fixed-width: a rectangle above the page top or below its bottom would
 * otherwise produce a negative number or a sixth digit, and Zotero rejects the whole annotation.
 */
export function sortIndex(pageIndex: number, heightPt: number, rect: PdfRect | null): string {
	const fromTop = rect === null ? 0 : Math.round(heightPt - (rect.y + rect.height));
	const clamp = (value: number, digits: number) => String(Math.min(Math.max(Math.round(value), 0), 10 ** digits - 1)).padStart(digits, "0");
	return `${clamp(pageIndex, 5)}|${"0".repeat(6)}|${clamp(fromTop, 5)}`;
}

/**
 * The hue each of Zotero's chromatic colours owns, as the upper edge of its band in degrees, in the
 * order the bands run round the circle. Grey is not a band: it is what a colour with no hue gets.
 *
 * The edges are where the measured device colours (`zotero-annotations.test.ts`, *the colour*) say
 * the eye puts them. Two are not midpoints on purpose: blue runs to 245° because every blue a
 * reMarkable records is a royal blue (227-231°) while Zotero's is an azure (200°), and yellow starts
 * at 40° so that the Paper Pro's amber shader stays with the yellows it sits next to on the device.
 */
const HUE_BANDS: readonly { upTo: number; hex: string }[] = [
	{ upTo: 15, hex: "#ff6666" }, // red
	{ upTo: 40, hex: "#f19837" }, // orange
	{ upTo: 75, hex: "#ffd400" }, // yellow
	{ upTo: 165, hex: "#5fb236" }, // green
	{ upTo: 245, hex: "#2ea8e5" }, // blue
	{ upTo: 275, hex: "#a28ae5" }, // purple
	{ upTo: 340, hex: "#e56eee" }, // magenta
	{ upTo: 360, hex: "#ff6666" }, // red again
];
const ZOTERO_GRAY = "#aaaaaa";

/**
 * Below this spread between the strongest and weakest channel a colour has no hue worth the name:
 * the Paper Pro's grey highlighter is 1, its black shader 5, and the palest colour any device records
 * (the palette's pink, 255/192/203) is 63.
 */
const GREY_CHROMA = 32;

/**
 * The one of {@link ZOTERO_COLORS} the reader drew with, as lowercase hex: the colour whose hue band
 * the device colour falls in, or grey for a colour with no hue.
 *
 * Not the nearest in RGB. Every highlighter colour a device records is pastel -- the Paper Pro's
 * yellow is 255/237/117, its green 172/255/133 -- and by squared distance a pastel is nearer to
 * Zotero's grey than to its own saturated namesake, which turned green and orange highlights grey
 * and the yellow one orange. A colour's name is its hue; lightness is what the highlighter's
 * translucency adds, and Zotero's reader adds its own.
 *
 * A highlight the device recorded without a colour, and every pen mark, is Zotero's default yellow:
 * the colour is not known to be anything else, and `#ffd400` is what Zotero itself fills in.
 */
export function zoteroColor(color: { r: number; g: number; b: number } | null): string {
	if (color === null) return DEFAULT_ANNOTATION_COLOR;
	const { r, g, b } = color;
	const max = Math.max(r, g, b);
	const chroma = max - Math.min(r, g, b);
	if (chroma < GREY_CHROMA) return ZOTERO_GRAY;
	const sector = max === r ? (g - b) / chroma : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
	const hue = (sector * 60 + 360) % 360;
	return HUE_BANDS.find((band) => hue < band.upTo)?.hex ?? ZOTERO_GRAY;
}

/**
 * The words the reader marked, and never the sentence around them.
 *
 * The digest quotes a highlight *in context* (F3) -- the marked words plus the sentence they sit in --
 * because that is what makes the note readable. In Zotero the annotation already sits on the page it
 * came from, so the sentence is not context there: it is a claim that the reader marked words they
 * did not, printed in the sidebar next to the page that shows they did not.
 *
 * The fallback is the device's own recorded text, which is exactly what `sentence` holds when
 * `marked` is empty -- the F4 soft fail puts it there and nothing else.
 */
export function markedText(highlight: DigestHighlight): string {
	return highlight.marked.length > 0 ? highlight.marked.join(" ") : highlight.sentence;
}

/**
 * A sticky's rectangle: a {@link STICKY_SIZE_PT} square at the top-left of the ink, kept on the page.
 *
 * Not the ink's own box. See {@link STICKY_SIZE_PT}: that box is routinely flat or off the paper, and
 * either way Zotero's reader draws nothing. The top-left corner is where the reader started writing,
 * and it is the corner Zotero itself anchors a note's icon to.
 */
export function stickyRect(rect: PdfRect, page: DigestPageSource): PdfRect {
	const top = rect.y + rect.height;
	const x = Math.min(Math.max(rect.x, 0), Math.max(page.widthPt - STICKY_SIZE_PT, 0));
	const y = Math.min(Math.max(top - STICKY_SIZE_PT, 0), Math.max(page.heightPt - STICKY_SIZE_PT, 0));
	return { x, y, width: STICKY_SIZE_PT, height: STICKY_SIZE_PT };
}

/** What a margin note anchored to a highlight adds to that highlight's comment. */
export function commentOf(notes: DigestNote[]): string {
	// Blank line between two notes: they were written at different moments and are two remarks, and
	// Zotero's comment box renders plain text.
	return notes
		.map((note) => note.text.trim())
		.filter((text) => text !== "")
		.join("\n\n");
}

/** One digest highlight as the annotation it becomes. */
export function highlightAnnotation(highlight: DigestHighlight, page: DigestPage, source: DigestPageSource, parentKey: string): NewAnnotation | null {
	// No rectangles is no position, and `annotationPosition` is not optional. Such an entry is in the
	// vault note either way -- this only means Zotero cannot be told where on the page it was.
	if (highlight.rects.length === 0) return null;
	const type: ZoteroAnnotationType = highlight.tool === "pen" ? "underline" : "highlight";
	return {
		type,
		parentKey,
		text: markedText(highlight),
		comment: commentOf(highlight.notes),
		color: zoteroColor(highlight.color),
		pageLabel: page.pageLabel ?? "",
		sortIndex: sortIndex(source.index, source.heightPt, unionOf(highlight.rects)),
		position: annotationPosition(source.index, highlight.rects),
	};
}

/** One standalone margin note as the sticky it becomes, or `null` when there is nothing to say. */
export function noteAnnotation(note: DigestNote, page: DigestPage, source: DigestPageSource, parentKey: string): NewAnnotation | null {
	const comment = note.text.trim();
	// A sticky with no comment marks a spot and says nothing; it cannot be told from a stray click,
	// and the handwriting itself is in the vault's own PDF where the entry already points at it.
	if (note.rect === null || comment === "") return null;
	const rect = stickyRect(note.rect, source);
	return {
		type: "note",
		parentKey,
		comment,
		color: DEFAULT_ANNOTATION_COLOR,
		pageLabel: page.pageLabel ?? "",
		sortIndex: sortIndex(source.index, source.heightPt, rect),
		position: annotationPosition(source.index, [rect]),
	};
}
