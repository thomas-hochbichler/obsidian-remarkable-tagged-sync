// The reading half of the `remarkable-note` block: what `digest-builder.ts` writes into a margin
// note, parsed back, and the piece of page a click on it draws. Pure -- no Obsidian, no pdf.js -- so
// the two decisions that live here can be tested as what they are, arithmetic and parsing.

import type { NoteRegion } from "./digest-builder";

/**
 * What stands in the note when a block cannot be read.
 *
 * The block is the entry's own text, so the entry keeps everything else it has: transcription,
 * anchor and page link are untouched by any of this. That is the fallback the format was chosen for
 * -- the image was always the part that could go missing, and now it is the only part that can.
 */
export const UNREADABLE_BLOCK = "This handwriting block could not be read.";

/**
 * A reason a reader can act on, told in the note.
 *
 * The point of the class is that the message is *for the user*: it is thrown where the cause is
 * known -- a PDF that moved, a page that is not there -- and printed verbatim. Anything else that
 * goes wrong ends up in {@link regionFailureMessage}'s catch-all instead, which says what it can
 * without pretending to know why.
 */
export class RegionUnavailable extends Error {}

/**
 * The sentence a failed draw puts in the note. Never nothing: this runs while the reader is looking
 * at the entry, so a console line alone would be a button that does nothing when pressed.
 */
export function regionFailureMessage(error: unknown): string {
	if (error instanceof RegionUnavailable) return error.message;
	const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return `The handwriting could not be drawn from the embedded PDF (${reason}).`;
}

/**
 * The block's fields, or null when it does not say what it must.
 *
 * The block is editable text in the user's own vault: somebody types in it, a number goes missing, a
 * merge mangles it. Null is that answer, and the caller says so in the note -- silence is the one
 * response the format's own spec rules out.
 *
 * Unknown fields are read and ignored rather than rejected, so a block written by a later version
 * still opens here.
 */
export function parseRegionBlock(source: string): NoteRegion | null {
	const fields = new Map<string, string>();
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const colon = trimmed.indexOf(":");
		if (colon < 0) return null;
		fields.set(trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim());
	}

	const page = Number(fields.get("page"));
	// `Number("")` is 0 and `Number(undefined)` is NaN, so both a missing and an empty field fail here.
	if (!Number.isInteger(page) || page < 1) return null;

	const rect = (fields.get("rect") ?? "").split(/\s+/).map(Number);
	if (rect.length !== 4 || rect.some((value) => !Number.isFinite(value))) return null;
	const [x, y, width, height] = rect;
	if (width <= 0 || height <= 0) return null;

	return { page, x, y, width, height };
}

/** How much of the page's width the band leaves free on each side. */
const BAND_SIDE_MARGIN = 0.05;

/** Air above and below the ink, in PDF points, so the handwriting does not touch the image edge. */
const BAND_PADDING_PT = 8;

/**
 * The piece of page a note shows: a band across the page at the height of its ink.
 *
 * Not the ink's own box, which is what the crop attachment used to be -- a margin note stands in the
 * margin, where nothing is printed, so its box renders as a white rectangle with handwriting in it
 * and says nothing about what the note is *about*. The band brings the printed text beside it along,
 * which is the whole reason the entry stores a place instead of a picture.
 *
 * Full width rather than "as far as the text column", which would be tighter and better-looking: the
 * column is page-layout knowledge, and nothing here has any. This function knows a rectangle and a
 * page width, and it works the same whether the note sits in the right margin, the left, or across
 * the text -- which is exactly why the rule can change later without touching a single stored note.
 */
export function drawnBand(region: NoteRegion, page: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
	// Held inside the sheet: ink that reaches the very top or bottom edge would otherwise pad the band
	// out past the paper, and everything past it draws as nothing -- a blank strip above the
	// handwriting, which reads as a rendering fault rather than as a page edge.
	const top = Math.max(0, region.y - BAND_PADDING_PT);
	const bottom = Math.min(page.height, region.y + region.height + BAND_PADDING_PT);
	return {
		x: page.width * BAND_SIDE_MARGIN,
		y: top,
		width: page.width * (1 - 2 * BAND_SIDE_MARGIN),
		height: bottom - top,
	};
}

/**
 * Whether the ink this block names is on the page at all.
 *
 * The check the fourth failure case needs, and the honest place for it: a rectangle nobody typed
 * wrong lands on its page by construction, while one that does not overlap the sheet cannot produce
 * an image of anything -- and asking for a region a million points tall is how a canvas gets too big
 * to allocate. Overlap rather than containment: ink drawn past the edge of the paper on the device
 * maps to a box that hangs over it, and the part that *is* on the page is still worth showing.
 */
export function liesOnPage(region: NoteRegion, page: { width: number; height: number }): boolean {
	return region.x < page.width && region.y < page.height && region.x + region.width > 0 && region.y + region.height > 0;
}
