// Pen marks that point at printed text rather than saying anything themselves (spec F23): an
// underline, a circle drawn around a passage. They are not handwriting and they have no
// transcription -- what they mean is the text under them, so they resolve through the same
// `quoteForRects` the marker highlights use and render as highlights.
//
// Pure: geometry in, quotes out. The caller removes the strokes this returns from the clustering
// input, so a stroke is either a mark or handwriting and never both.
//
// The direction of doubt is fixed and it is not symmetric. Handwriting misread as a mark is *silent*
// -- the note is gone and nothing says so -- while a mark misread as handwriting is what shipped
// before this file existed: a callout with a picture of a line in it, visible and wrong in a way the
// reader can see. So every test here is conjunctive, and every threshold is placed on the side that
// leaves the stroke a note.

import type { DeviceCanvas, PdfRect } from "./pdf-renderer";
import { sceneRectToPdf } from "./pdf-renderer";
import { quoteForRects, type PdfPageText, type PdfTextLine } from "./pdf-text";
import type { RmStroke } from "./rm-parser";

/**
 * How wide a stroke must be, in line heights, before its shape is allowed to speak for it at all.
 *
 * This is the one threshold that separates a mark from handwriting, and it was placed in a measured
 * gap rather than chosen. Across the 1262 ink strokes of the two fixture documents:
 *
 * | | flat strokes (under 0.4 lh tall) | closed loops |
 * |---|---|---|
 * | widest that is handwriting | 2.40 lh | 2.00 lh |
 * | narrowest that is a real mark | 2.52 lh | 7.18 lh |
 *
 * The flat column is the tight one -- 2.40 against 2.52 -- so the bound sits at the top of it. A
 * short underline under the bar therefore stays a note, which is the failure this file is willing to
 * have. Neither of the two strokes that come closest survives the second test anyway: the 2.40 lh
 * one has no text line under it at all.
 */
const MIN_MARK_WIDTH = 2.5;

/**
 * How tall an underline may be, in line heights. 0.4 is `margin-notes.ts`'s own fragment bound, and
 * it means the same thing here: a stroke with no vertical excursion worth measuring. The three
 * underlines measured sit at 0.00, 0.00 and 0.08 -- a ruled line and two near-ruled ones.
 */
const MAX_UNDERLINE_HEIGHT = 0.4;

/**
 * Where an underline sits relative to the line it marks: the gap from the text line's bottom edge
 * down to the stroke's top, in line heights.
 *
 * Measured at 0.16, 0.18 and 0.38, so the window reaches 0.6 and stops well short of the next line.
 * The small negative allowance is for an underline drawn high enough to touch the descenders.
 *
 * **A strikethrough is deliberately outside this window.** It would sit at about -0.5, and neither
 * fixture has one -- ticket 15's lesson is that a rule fitted to no instance is a rule fitted to
 * nothing. It stays a note until a document with one exists.
 */
const UNDERLINE_GAP_MIN = -0.1;
const UNDERLINE_GAP_MAX = 0.6;

/** How much of the stroke's width the text line above it must span for the stroke to be underlining *that* line. */
const UNDERLINE_COVERAGE = 0.5;

/**
 * How near a stroke's two ends must meet, over its box diagonal, to read as a loop drawn around
 * something. The one circle measured closes exactly (0.00); the bound is loose because a hand-drawn
 * oval rarely does, and {@link MIN_MARK_WIDTH} is what actually keeps the letters `o`, `e` and a
 * circled digit out.
 */
const MAX_LOOP_GAP = 0.4;

/** One pen mark: the strokes it consumed, and the passage it points at. */
export interface InkMark {
	/** The mark's stroke CRDT id -- its F15 identity, exactly as a cluster's `anchorStrokeId` is. */
	strokeId: string;
	/** The sentence around the marked text, as `quoteForRects` resolved it. */
	sentence: string;
	/** The marked runs inside `sentence`. Never empty: a mark that lands on no words is not a mark. */
	marked: string[];
	/** Scene y (growing down), for reading order. */
	top: number;
	/**
	 * The marked *text's* box in PDF points, for the anchor cascade and the section lookup -- not the
	 * ink's. An underline's own box sits in the whitespace under the line, and a note written beside
	 * the passage has to measure its distance to the passage, exactly as it does for a marker
	 * highlight.
	 */
	pdfRect: PdfRect;
}

interface Box {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function strokeBox(stroke: RmStroke): Box | null {
	if (stroke.points.length === 0) return null;
	const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (const point of stroke.points) {
		box.minX = Math.min(box.minX, point.x);
		box.minY = Math.min(box.minY, point.y);
		box.maxX = Math.max(box.maxX, point.x);
		box.maxY = Math.max(box.maxY, point.y);
	}
	return box;
}

/** How much of `rect`'s width the line spans, as a share of the rect. */
function xCoverage(rect: PdfRect, line: PdfTextLine): number {
	if (rect.width <= 0) return 0;
	const overlap = Math.min(rect.x + rect.width, line.x + line.width) - Math.max(rect.x, line.x);
	return Math.max(0, overlap) / rect.width;
}

/** The text line this stroke runs along just underneath, or null. */
function underlinedLine(rect: PdfRect, page: PdfPageText, lineHeightPt: number): PdfTextLine | null {
	const top = rect.y + rect.height;
	let best: PdfTextLine | null = null;
	let bestGap = Number.POSITIVE_INFINITY;
	for (const line of page.lines) {
		if (xCoverage(rect, line) < UNDERLINE_COVERAGE) continue;
		const gap = (line.y - top) / lineHeightPt;
		if (gap < UNDERLINE_GAP_MIN || gap > UNDERLINE_GAP_MAX) continue;
		// Strictly nearer, so a tie keeps the earlier line and the digest stays byte-identical across
		// the rewrite every sync performs (F16).
		if (gap < bestGap) {
			bestGap = gap;
			best = line;
		}
	}
	return best;
}

/** True when the stroke's two ends meet, i.e. it was drawn around something rather than along it. */
function isLoop(stroke: RmStroke, box: Box): boolean {
	const points = stroke.points;
	if (points.length < 3) return false;
	const diagonal = Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
	if (diagonal <= 0) return false;
	const first = points[0];
	const last = points[points.length - 1];
	return Math.hypot(last.x - first.x, last.y - first.y) / diagonal <= MAX_LOOP_GAP;
}

/**
 * The rectangle a mark hands to `quoteForRects`, or null when the stroke's shape says nothing.
 *
 * An underline points at the line above it, so the rectangle is *that line's* band with the stroke's
 * own x-range: the stroke itself sits in the whitespace under the text and would hit no line at all.
 * A loop points at whatever it encloses, so its own box is the rectangle.
 */
function markRect(stroke: RmStroke, box: Box, page: PdfPageText, frame: DeviceCanvas, lineHeightPt: number): PdfRect | null {
	const rect = sceneRectToPdf({ x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY }, frame);
	const lineHeightPx = lineHeightPt / frame.pxToPt;
	if (box.maxX - box.minX < MIN_MARK_WIDTH * lineHeightPx) return null;

	if (box.maxY - box.minY < MAX_UNDERLINE_HEIGHT * lineHeightPx) {
		const line = underlinedLine(rect, page, lineHeightPt);
		return line === null ? null : { x: rect.x, y: line.y, width: rect.width, height: line.height };
	}

	return isLoop(stroke, box) ? rect : null;
}

/**
 * True when a stroke has the *shape* of a mark -- wide enough to speak, and either flat or closed --
 * whatever it turned out to point at.
 *
 * {@link findInkMarks} hands such a stroke back as handwriting when it resolves to no text: too low
 * to be an underline, struck through the line, or over a patch the text layer does not cover. With
 * margin notes off that is the end of it -- no cluster, no crop, nothing in the note -- so the caller
 * needs to be able to say so rather than drop it in silence. Ordinary handwriting fails the width
 * test and is not reported: the setting being off is not news.
 */
export function readsAsMark(stroke: RmStroke, frame: DeviceCanvas, lineHeightPt: number): boolean {
	const box = strokeBox(stroke);
	if (box === null) return false;
	const lineHeightPx = lineHeightPt / frame.pxToPt;
	if (box.maxX - box.minX < MIN_MARK_WIDTH * lineHeightPx) return false;
	return box.maxY - box.minY < MAX_UNDERLINE_HEIGHT * lineHeightPx || isLoop(stroke, box);
}

/**
 * Splits a page's ink into the pen marks on its printed text and the handwriting that is left.
 *
 * `strokes` comes back in input order and is what the caller clusters; a mark never reaches
 * `clusterStrokes`, which is the point of running before it. An underline shares its line with the
 * handwriting beside it, and `HORIZONTAL_TOLERANCE` is three line heights -- left in, it would join
 * that note's cluster and stretch its rectangle across the page.
 *
 * A stroke whose shape reads as a mark but whose rectangle lands on no words comes back as
 * handwriting. That is the whole no-text-layer fallback: with no `PdfPageText` the caller never gets
 * here, and every mark stays the note it is today.
 */
export function findInkMarks(
	strokes: RmStroke[],
	page: PdfPageText,
	frame: DeviceCanvas,
	lineHeightPt: number,
): { marks: InkMark[]; strokes: RmStroke[] } {
	const marks: InkMark[] = [];
	const remaining: RmStroke[] = [];

	for (const stroke of strokes) {
		const box = strokeBox(stroke);
		const rect = box === null ? null : markRect(stroke, box, page, frame, lineHeightPt);
		const quote = rect === null ? null : quoteForRects(page, [rect]);
		// `marked` empty means the rectangle covered no whole word, so there is nothing to point at and
		// nothing the reader would recognise as their mark.
		if (box === null || rect === null || !quote || quote.marked.length === 0) {
			remaining.push(stroke);
			continue;
		}
		marks.push({ strokeId: stroke.id, sentence: quote.sentence, marked: quote.marked, top: box.minY, pdfRect: rect });
	}

	return { marks, strokes: remaining };
}
