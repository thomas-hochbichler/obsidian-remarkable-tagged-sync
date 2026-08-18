import { PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { repairBareColourOps, repairPagePaint } from "./pdf-paint-repair";

/** The shape the device actually writes, measured on page 8 of *Alice*: the colour operator with nothing to set, right before the text. */
const DEVICE_PAGE = "q\n/CSp cs\n1 1 1 scn\n0 0 100 100 re\nf\nQ\nq\n/CSp cs\nscn\nBT\n/F24 57 Tf\n0 0 Td <0029> Tj\nET\nQ\n";

describe("repairBareColourOps", () => {
	it("gives black to a colour operator the device left empty", () => {
		expect(repairBareColourOps(DEVICE_PAGE)).toContain("/CSp cs\n0 0 0 scn\nBT");
	});

	it("leaves the page's real colours alone", () => {
		// The white background is the one colour this page does set, and it has to stay white -- it is
		// also the colour pdf.js was painting the text in.
		expect(repairBareColourOps(DEVICE_PAGE)).toContain("1 1 1 scn");
	});

	it("repairs the stroking form too", () => {
		expect(repairBareColourOps("q\n/CSp CS\nSCN\n1 w\n")).toBe("q\n/CSp CS\n0 0 0 SCN\n1 w\n");
	});

	it("reports nothing to do for a stream that sets its colours properly", () => {
		expect(repairBareColourOps("q\n/CSp cs\n0.5 0.5 0.5 scn\n0 0 10 10 re\nf\nQ\n")).toBeNull();
	});

	it("leaves a pattern colour alone, whose operand is a name and not a number", () => {
		expect(repairBareColourOps("/Pattern cs\n/P0 scn\n0 0 10 10 re\nf\n")).toBeNull();
	});

	it("does not mistake a word that merely ends in the operator's letters", () => {
		expect(repairBareColourOps("BT\n(the descn of it) Tj\nET\n")).toBeNull();
	});
});

describe("repairPagePaint", () => {
	/** A one-page document whose content stream is `content`, uncompressed. */
	async function documentWith(content: string): Promise<{ doc: PDFDocument; ref: PDFRef }> {
		const doc = await PDFDocument.create();
		const page = doc.addPage([100, 100]);
		const ref = doc.context.register(PDFRawStream.of(doc.context.obj({}), new TextEncoder().encode(content)));
		page.node.set(PDFName.of("Contents"), ref);
		return { doc, ref };
	}

	function contentOf(doc: PDFDocument, ref: PDFRef): string {
		return new TextDecoder().decode((doc.context.lookup(ref) as PDFRawStream).contents);
	}

	it("repairs the page a device wrote, and says it did", async () => {
		const { doc, ref } = await documentWith(DEVICE_PAGE);

		expect(await repairPagePaint(doc, doc.getPage(0))).toBe(true);
		expect(contentOf(doc, ref)).toContain("0 0 0 scn");
	});

	it("leaves a healthy page byte for byte alone", async () => {
		const healthy = "q\n1 0 0 scn\n0 0 10 10 re\nf\nQ\n";
		const { doc, ref } = await documentWith(healthy);

		expect(await repairPagePaint(doc, doc.getPage(0))).toBe(false);
		expect(contentOf(doc, ref)).toBe(healthy);
	});

	it("leaves a stream compressed by something it does not know", async () => {
		const { doc, ref } = await documentWith(DEVICE_PAGE);
		(doc.context.lookup(ref) as PDFRawStream).dict.set(PDFName.of("Filter"), PDFName.of("LZWDecode"));

		expect(await repairPagePaint(doc, doc.getPage(0))).toBe(false);
	});
});
