import { describe, expect, it, vi } from "vitest";
import { openPdfTextLayer, type PdfJsLoader } from "./pdf-text-layer";

/** A char in the shape Obsidian's customized pdf.js returns (`c`/`u`/`r`, see PDF++ typings). */
function char(u: string, x = 0, y = 0): { c: string; u: string; r: number[] } {
	return { c: u, u, r: [x, y, x + 5, y + 10] };
}

type GetTextContent = (options: { includeChars: boolean }) => Promise<{ items: { chars?: { c: string; u: string; r: number[] }[] }[] }>;

/** A loader whose document serves the given items per page (page index → getTextContent items). */
function stubLoader(
	pagesItems: { chars?: ReturnType<typeof char>[] }[][],
	hooks: { getTextContent?: GetTextContent; destroy?: () => Promise<unknown> } = {},
): PdfJsLoader {
	return async () => ({
		getDocument: (options: { data: Uint8Array }) => ({
			promise: Promise.resolve({
				numPages: pagesItems.length,
				getPage: async (pageNumber: number) => ({
					getTextContent:
						hooks.getTextContent ?? (async (opts: { includeChars: boolean }) => ({ items: opts.includeChars ? pagesItems[pageNumber - 1] : [] })),
				}),
				destroy: hooks.destroy ?? (async () => undefined),
			}),
		}),
	});
}

const BYTES = new Uint8Array([1, 2, 3]);

describe("openPdfTextLayer", () => {
	it("returns a page's chars in text order, mapped to text + user-space rect", async () => {
		const layer = await openPdfTextLayer(stubLoader([[{ chars: [char("H", 10, 700), char("i", 15, 700)] }, { chars: [char("!", 20, 700)] }]]), BYTES);

		await expect(layer?.pageChars(0)).resolves.toEqual([
			{ text: "H", rect: [10, 700, 15, 710] },
			{ text: "i", rect: [15, 700, 20, 710] },
			{ text: "!", rect: [20, 700, 25, 710] },
		]);
	});

	it("passes includeChars: true and hands pdf.js a copy of the bytes (the worker detaches its buffer)", async () => {
		const getDocument = vi.fn((options: { data: Uint8Array }) => ({
			promise: Promise.resolve({ numPages: 0, getPage: async () => ({ getTextContent: async () => ({ items: [] }) }), destroy: async () => undefined }),
		}));
		await openPdfTextLayer(async () => ({ getDocument }), BYTES);

		const handed = getDocument.mock.calls[0][0].data;
		expect(handed).toEqual(BYTES);
		expect(handed).not.toBe(BYTES);
	});

	it("reports a page with no chars at all as having no text layer (scanned page)", async () => {
		const layer = await openPdfTextLayer(stubLoader([[{ chars: [] }, {}]]), BYTES);

		await expect(layer?.pageChars(0)).resolves.toBeNull();
	});

	it("reports a page whose chars are all whitespace as having no text layer", async () => {
		const layer = await openPdfTextLayer(stubLoader([[{ chars: [char(" "), char("\n")] }]]), BYTES);

		await expect(layer?.pageChars(0)).resolves.toBeNull();
	});

	it("keeps whitespace chars when the page has real text -- they are the spaces quote re-derivation needs", async () => {
		const layer = await openPdfTextLayer(stubLoader([[{ chars: [char("a", 0, 0), char(" ", 5, 0), char("b", 10, 0)] }]]), BYTES);

		const chars = await layer?.pageChars(0);
		expect(chars?.map((c) => c.text)).toEqual(["a", " ", "b"]);
	});

	it("drops chars whose box is off-shape (undocumented build) instead of poisoning the geometry", async () => {
		const broken = { c: "x", u: "x", r: [0, Number.NaN, 5, 10] };
		const short = { c: "y", u: "y", r: [0, 0] };
		const layer = await openPdfTextLayer(stubLoader([[{ chars: [char("a"), broken, short] }]]), BYTES);

		await expect(layer?.pageChars(0)).resolves.toEqual([{ text: "a", rect: [0, 0, 5, 10] }]);
	});

	it("answers null for a page index outside the document", async () => {
		const layer = await openPdfTextLayer(stubLoader([[{ chars: [char("a")] }]]), BYTES);

		await expect(layer?.pageChars(-1)).resolves.toBeNull();
		await expect(layer?.pageChars(1)).resolves.toBeNull();
	});

	it("returns null when the loader itself throws (pdf.js unavailable)", async () => {
		const loader: PdfJsLoader = () => Promise.reject(new Error("no pdf.js"));

		await expect(openPdfTextLayer(loader, BYTES)).resolves.toBeNull();
	});

	it("returns null when pdf.js can't read the document", async () => {
		const loader: PdfJsLoader = async () => ({ getDocument: () => ({ promise: Promise.reject(new Error("bad pdf")) }) });

		await expect(openPdfTextLayer(loader, BYTES)).resolves.toBeNull();
	});

	it("degrades a single unreadable page to null while the document stays usable", async () => {
		const getTextContent = vi
			.fn<GetTextContent>()
			.mockRejectedValueOnce(new Error("page broke"))
			.mockResolvedValueOnce({ items: [{ chars: [char("b")] }] });
		const layer = await openPdfTextLayer(stubLoader([[], []], { getTextContent }), BYTES);

		await expect(layer?.pageChars(0)).resolves.toBeNull();
		await expect(layer?.pageChars(1)).resolves.toEqual([{ text: "b", rect: [0, 0, 5, 10] }]);
	});

	it("destroy releases the pdf.js document and swallows its errors", async () => {
		const destroy = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error("already gone"));
		const layer = await openPdfTextLayer(stubLoader([[]], { destroy }), BYTES);

		await expect(layer?.destroy()).resolves.toBeUndefined();
		expect(destroy).toHaveBeenCalled();
	});
});
