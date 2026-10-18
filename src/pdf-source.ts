import { ParseSpeeds, PDFDocument } from "pdf-lib";

/**
 * Every `PDFDocument.load` and `save` in the sync goes through these, so pdf-lib never pauses on
 * the window's timer (issue #211).
 *
 * By default pdf-lib parses in slices of 100 objects and writes in slices of 50, waiting on
 * `setTimeout(…, 0)` between them so the window stays responsive. While Obsidian's window is hidden
 * Chromium throttles that timer -- at least a second per wait, and after five minutes in the
 * background about one per minute. A 617-page book from a reporter's tablet needed so many waits
 * that the sync never finished while the window was minimised.
 *
 * The price is that Obsidian is busy for the whole parse instead of in slices: measured at 134 ms
 * for an 11.7 MB, 7 400-object book, against 232 ms spread over 74 waits with pdf-lib's default. A
 * short freeze while a book syncs is the better failure than a sync that never ends.
 */
export const LOAD_WITHOUT_PAUSES = { parseSpeed: ParseSpeeds.Fastest } as const;
/** See {@link LOAD_WITHOUT_PAUSES}. */
export const SAVE_WITHOUT_PAUSES = { objectsPerTick: Infinity } as const;

/**
 * Guard for the source PDF of a PDF-backed document (an uploaded PDF, or the render the device makes
 * of an EPUB -- see `isPdfBacked`), fetched
 * via `getPdf` before it's composited with its handwritten annotations (see `renderAnnotatedPdf`).
 * An empty or pageless source is a failed sync, not a valid empty note.
 */
export async function validateSourcePdf(bytes: Uint8Array): Promise<Uint8Array> {
	if (bytes.length === 0) throw new Error("source PDF is empty");
	const doc = await PDFDocument.load(bytes, LOAD_WITHOUT_PAUSES);
	if (doc.getPageCount() === 0) throw new Error("source PDF has no pages");
	return bytes;
}
