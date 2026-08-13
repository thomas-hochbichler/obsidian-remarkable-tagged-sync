// A notebook page's typed text as a text layer, in the shape the digest reads a document in.
//
// The digest was built for a PDF: it quotes the sentence a highlight sits in and anchors a margin
// note to the heading above it, both read out of `PdfPageText`. None of that is about PDFs. It is
// about a page carrying text somebody else wrote, which a notebook page does too whenever its text
// was typed rather than drawn -- an article the "Read on reMarkable" extension sent over, a page
// written with the Type Folio.
//
// So the text is presented as the same `PdfPageText` a PDF's text layer arrives as, and every reader
// of it stays as it was. The one thing that has to be exactly right is the frame: these lines are
// measured in the frame `renderPagesToPdf` draws the page in (`notebookPageFrame`), because the
// highlights and handwriting they are compared against are drawn in that frame too.

import { HEADING_TEXT_SIZE_PX, measureDeviceText, PLAIN_TEXT_SIZE_PX, TEXT_LEFT_PADDING_PX } from "./device-font";
import { cleanHeadingTitle, type PdfHeading, type PdfPageText, type PdfTextLine } from "./pdf-text";
import { toPdfPoint, type DeviceCanvas } from "./pdf-renderer";
import type { RmPage } from "./rm-parser";
import { faceOf, layoutText, type LaidOutLine } from "./text-layout";

/** True for a page carrying any typed text at all. Not the same question as `isDocumentText` -- see there. */
export function hasTypedText(page: RmPage | null): boolean {
	return (page?.text?.runs ?? []).some((run) => run.deleted === 0 && run.text.length > 0);
}

/**
 * How many lines of prose a page needs before its text is a document to annotate.
 *
 * The number is doing less work than it looks: the wrap test below is what separates the corpus, and
 * this only rules out the short note. It is set where it is because the digest's whole business is
 * saying *which line* a note sits beside, and a handful of lines gives the anchor cascade nothing to
 * choose between.
 */
const DOCUMENT_MIN_LINES = 10;

/**
 * True for a page whose typed text is a *document* -- something to read and mark up -- rather than
 * text that happens to be on a page somebody wrote by hand.
 *
 * The distinction has to be drawn, and `hasTypedText` cannot draw it: this repo's own
 * `normal-a-stroke-2-layers` fixture is two pen strokes and the single typed letter `A`, and calling
 * that a document turns the two strokes into margin notes on the letter.
 *
 * Two conditions, measured against the 80-page corpus (5 of its pages carry typed text):
 *
 * | lines | wraps | strokes | page                   | verdict    |
 * |-------|-------|---------|------------------------|------------|
 * |     0 | no    |     529 | `Daily-6e02dc1c`       | handwriting |
 * |     1 | no    |     373 | `Schnellnotiz-2ba8af97`| handwriting |
 * |     2 | yes   |     217 | `Obsidian_Sync_Plugin` | handwriting |
 * |    35 | no    |     909 | `Daily-2bd24a83`       | handwriting |
 * |    30 | yes   |       0 | `Schnellnotiz-8c6044dc`| document    |
 * |   333 | yes   |     175 | the imported article   | document    |
 *
 * **Wrapping** is the load-bearing half. Text that wraps was set against a measure, the way prose is;
 * `Daily-2bd24a83` has 35 typed lines and not one of them wraps, because it is a list of short
 * entries with 909 strokes of handwriting around it. Counting lines alone would call it a document
 * and bury its handwriting in a digest of the writer's own list.
 */
export function isDocumentText(page: RmPage | null): boolean {
	if (!page || !hasTypedText(page)) return false;
	const lines = layoutText(page.text!).lines.filter((line) => line.text.trim() !== "");
	return lines.length >= DOCUMENT_MIN_LINES && lines.some((line) => !line.firstLine);
}

function sizePx(line: LaidOutLine): number {
	return faceOf(line.style) === "heading" ? HEADING_TEXT_SIZE_PX : PLAIN_TEXT_SIZE_PX;
}

/**
 * One laid-out line as the text layer's own line box.
 *
 * Matched to what `pdf-text.ts` builds out of pdf.js, field for field, because the same code reads
 * both: `y` is the *baseline* (pdf.js reports `transform[5]`, and the device lays a line out on its
 * baseline as well) and `height` is the type size above it. Descenders fall outside the box in both.
 *
 * `x` carries the same left padding the renderer draws the glyphs at, so the box sits where the text
 * is rather than where its box begins.
 */
function textLine(line: LaidOutLine, frame: DeviceCanvas): PdfTextLine {
	const at = toPdfPoint({ x: line.xPx + TEXT_LEFT_PADDING_PX, y: line.yPx }, frame);
	return {
		text: line.text,
		x: at.x,
		y: at.y,
		width: measureDeviceText(line.text, faceOf(line.style)) * frame.pxToPt,
		height: sizePx(line) * frame.pxToPt,
	};
}

/**
 * The page's typed text as a text layer. Null for a page that has none, which is the great majority
 * of notebook pages and is not a failure -- the caller falls back to a transcript.
 *
 * Empty lines are dropped rather than carried: they are the paragraph breaks, they hold no text to
 * quote, and `bodyLineSpacing` counts lines to find the body spacing every tolerance is derived from.
 */
export function sceneTextPage(page: RmPage, frame: DeviceCanvas, label: string): PdfPageText | null {
	if (!hasTypedText(page)) return null;
	const lines = layoutText(page.text!).lines.filter((line) => line.text.trim() !== "");
	if (lines.length === 0) return null;
	return {
		label,
		width: frame.widthPt,
		height: frame.heightPt,
		lines: lines.map((line) => textLine(line, frame)),
	};
}

/**
 * The page's headings, which the device records as a paragraph style rather than as an outline.
 *
 * Consecutive heading lines are one heading: the style belongs to the paragraph, and a title too
 * long for the text box wraps. Taking them singly would offer the anchor cascade `Why context
 * engineering is important to building` and `capable agents` as two separate sections to hang a note
 * under, and print whichever half the note happened to sit level with.
 */
export function sceneHeadings(page: RmPage, frame: DeviceCanvas, pageIndex: number): PdfHeading[] {
	if (!hasTypedText(page)) return [];
	const headings: PdfHeading[] = [];
	let open: { lines: LaidOutLine[] } | null = null;

	const close = () => {
		if (!open) return;
		const title = cleanHeadingTitle(open.lines.map((line) => line.text).join(" "));
		// The first line's box: a heading is anchored where it starts, and a note sits level with the
		// title's opening line rather than with wherever it happens to end.
		const at = textLine(open.lines[0], frame);
		if (title !== "") headings.push({ pageIndex, x: at.x, y: at.y, title });
		open = null;
	};

	for (const line of layoutText(page.text!).lines) {
		if (faceOf(line.style) !== "heading" || line.text.trim() === "") {
			close();
			continue;
		}
		if (open && line.firstLine) close(); // a heading right below a heading is a second one
		open ??= { lines: [] };
		open.lines.push(line);
	}
	close();
	return headings;
}
