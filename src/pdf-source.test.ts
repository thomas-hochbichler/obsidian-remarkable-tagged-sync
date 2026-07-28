import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { validateSourcePdf } from "./pdf-source";

async function makePdf(pageCount: number): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	for (let i = 0; i < pageCount; i++) doc.addPage([100, 100]);
	return doc.save();
}

describe("validateSourcePdf", () => {
	it("returns the bytes unchanged for a valid PDF", async () => {
		const bytes = await makePdf(1);
		expect(await validateSourcePdf(bytes)).toBe(bytes);
	});

	it("throws on empty bytes", async () => {
		await expect(validateSourcePdf(new Uint8Array(0))).rejects.toThrow(/empty/);
	});
});
