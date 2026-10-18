import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAnnotatedPdf, renderPagesToPdf } from "./pdf-renderer";
import { validateSourcePdf } from "./pdf-source";
import type { RmPage } from "./rm-parser";

/**
 * Issue #211: importing a book stalls while Obsidian's window is hidden, because pdf-lib pauses on
 * the window's timer and Chromium throttles that timer -- see `LOAD_WITHOUT_PAUSES`.
 *
 * A test cannot hide a window, so it counts instead: every call to the window's timer while a book
 * goes through the sync's PDF path is one wait Chromium would throttle. The count must be zero.
 */

/** A book of `pageCount` pages, each carrying a line of text. */
async function makeBook(pageCount: number): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.TimesRoman);
	for (let i = 0; i < pageCount; i++) {
		doc.addPage([445, 594]).drawText(`Page ${i + 1} of the book, a line of body text.`, { x: 40, y: 540, size: 11, font });
	}
	return doc.save();
}

describe("the sync's PDF path while Obsidian's window is hidden (issue #211)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("does not wait on the window's timer, which Chromium throttles in a hidden window", async () => {
		// As many pages as the book in the report.
		const book = await makeBook(617);
		// Still fires, so the test finishes; it only records each wait a hidden window would stretch.
		const windowTimer = vi.spyOn(globalThis, "setTimeout");

		// The two steps sync-engine runs for a tagged page of a book: check the source, then
		// composite the page over it.
		await validateSourcePdf(book);
		const waitsToValidate = windowTimer.mock.calls.length;
		await renderAnnotatedPdf(book, [{ sourceIndex: 0, annotations: null }]);
		const waitsToRender = windowTimer.mock.calls.length - waitsToValidate;

		expect.soft(waitsToValidate, "window-timer waits while validating the source PDF").toBe(0);
		expect.soft(waitsToRender, "window-timer waits while compositing a tagged page").toBe(0);
	});

	it("does not wait on the window's timer while writing a notebook either", async () => {
		// Writing pauses every 50 objects; 300 pages is a page object and a content stream each.
		const pages: RmPage[] = Array.from({ length: 300 }, () => ({ formatVersion: 6, layers: [] }));
		const windowTimer = vi.spyOn(globalThis, "setTimeout");

		await renderPagesToPdf(pages);

		expect(windowTimer).not.toHaveBeenCalled();
	});
});
