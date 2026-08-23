import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { validateSourcePdf } from "./pdf-source";

async function makePdf(pageCount: number): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	for (let i = 0; i < pageCount; i++) doc.addPage([100, 100]);
	return doc.save();
}

/**
 * A pageless PDF, written by hand.
 *
 * pdf-lib cannot make one: `PDFDocument.create()` with no pages saves a Pages tree that reads back
 * with a page count of **1**, so `makePdf(0)` is not a pageless document and the branch it was meant
 * to exercise is unreachable through the library's own writer. Measured, not assumed -- the first
 * draft of this test used `makePdf(0)` and passed while asserting nothing.
 */
const PAGELESS_PDF = new TextEncoder().encode(
	["%PDF-1.4", "1 0 obj", "<< /Type /Catalog /Pages 2 0 R >>", "endobj", "2 0 obj", "<< /Type /Pages /Kids [] /Count 0 >>", "endobj", "trailer", "<< /Size 3 /Root 1 0 R >>", "%%EOF", ""].join("\n"),
);

describe("validateSourcePdf", () => {
	it("returns the bytes unchanged for a valid PDF", async () => {
		const bytes = await makePdf(1);
		expect(await validateSourcePdf(bytes)).toBe(bytes);
	});

	it("throws on empty bytes", async () => {
		await expect(validateSourcePdf(new Uint8Array(0))).rejects.toThrow(/empty/);
	});

	// Gap G32. The doc comment says "an empty **or pageless** source is a failed sync", and only the
	// empty half was tested -- deleting both remaining lines passed all 996 tests. A book with no
	// pages is what a half-finished upload looks like from here, and without the guard it becomes a
	// note embedding an empty PDF, written once and skipped by every sync after it because the device
	// hash never moves again.
	it("throws on a PDF with no pages, which is what a half-finished upload looks like", async () => {
		await expect(validateSourcePdf(PAGELESS_PDF)).rejects.toThrow(/no pages/);
	});

	it("throws on bytes that are not a PDF at all, rather than compositing over them", async () => {
		// The device serves this when a fetch is truncated. `renderAnnotatedPdf` would be handed the
		// bytes and fail somewhere deeper, where the message names pdf-lib rather than the document.
		await expect(validateSourcePdf(new TextEncoder().encode("<!doctype html><title>502</title>"))).rejects.toThrow();
	});

	it("does not copy the bytes, because they are the same bytes the render composites over", async () => {
		// Identity, not equality: the caller holds this array and hands it to `renderAnnotatedPdf`. A
		// copy here would double the peak memory of a book-sized PDF for nothing.
		const bytes = await makePdf(2);

		expect(await validateSourcePdf(bytes)).toBe(bytes);
	});
});
