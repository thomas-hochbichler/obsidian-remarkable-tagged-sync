import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, type PDFRawStream, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { renderPagesToPdf } from "./pdf-renderer";
import { parseRmV6, type RmPage } from "./rm-parser";
import { addTextLayer, foldWord, visionBoxToPdf } from "./text-layer";

const PT_PER_PX = 72 / 226;

/**
 * One fineliner stroke from scene (-100, 200) to (300, 1000), each point 1 px in radius, so its ink
 * bitmap is the box from (-101, 199), 402 x 802 px.
 */
function scene(): RmPage {
	const point = (x: number, y: number) => ({ x, y, speed: 0, width: 8, direction: 0, pressure: 0 });
	return {
		formatVersion: 6,
		layers: [
			{
				id: "layer-1",
				name: null,
				strokes: [{ layerId: "layer-1", id: "s", timestamp: "0", penType: 17, color: 0, brushSize: 2, points: [point(-100, 200), point(300, 1000)] }],
			},
		],
	};
}

/** All of one page's content streams, decoded. */
async function pageOps(bytes: Uint8Array, index = 0): Promise<string> {
	const doc = await PDFDocument.load(bytes);
	const contents = doc.getPage(index).node.Contents();
	const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
	return refs
		.map((ref) => {
			const stream = doc.context.lookup(ref) as PDFRawStream;
			return stream.dict.get(PDFName.of("Filter")) ? inflateSync(stream.contents).toString("latin1") : Buffer.from(stream.contents).toString("latin1");
		})
		.join("\n");
}

/** Every word the layer shows: its font size, horizontal scaling, where its baseline starts, and its text (WinAnsi is Latin-1 for these). */
function shownWords(ops: string): { size: number; squeeze: number; x: number; y: number; text: string }[] {
	return Array.from(ops.matchAll(/ ([\d.]+) Tf\n(-?[\d.]+) Tz\n1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\n<([0-9A-F]*)> Tj/g), (match) => ({
		size: Number(match[1]),
		squeeze: Number(match[2]),
		x: Number(match[3]),
		y: Number(match[4]),
		text: Buffer.from(match[5], "hex").toString("latin1"),
	}));
}

/** The reMarkable 1/2 screen at 226 DPI, written out rather than imported so the expected numbers stay independent. */
const RM_1_2_FRAME = { widthPx: 1404, heightPx: 1872, pxToPt: 72 / 226, widthPt: (1404 * 72) / 226, heightPt: (1872 * 72) / 226 };

const LINE = { x: 0, y: 0.5, w: 1, h: 0.1 };

describe("visionBoxToPdf", () => {
	it("maps a box normalised on the ink bitmap onto the page it was drawn on", () => {
		// The bitmap starts 100 px left of the midline and 200 px down, 400 x 800 px. The box covers its
		// middle half across and the band 0.5..0.625 up from the bottom, i.e. scene x 0..200, y 500..600.
		const ink = { minX: -100, minY: 200, width: 400, height: 800 };
		const rect = visionBoxToPdf({ x: 0.25, y: 0.5, w: 0.5, h: 0.125 }, ink, RM_1_2_FRAME);

		// Scene x 0 is the midline, 702 px from the left edge; scene y 600 is 1272 px above the bottom.
		expect(rect.x).toBeCloseTo((702 * 72) / 226, 3);
		expect(rect.y).toBeCloseTo((1272 * 72) / 226, 3);
		expect(rect.width).toBeCloseTo((200 * 72) / 226, 3);
		expect(rect.height).toBeCloseTo((100 * 72) / 226, 3);
	});
});

describe("addTextLayer", () => {
	it("writes each word invisibly over its box, in reading order, each followed by a space", async () => {
		const pdf = await renderPagesToPdf([scene()]);
		const line2 = { x: 0, y: 0.3, w: 0.5, h: 0.1 };
		const layered = await addTextLayer(pdf, [scene()], [
			[
				{ box: LINE, words: [{ text: "Rapoldeck", box: { x: 0, y: 0.5, w: 0.6, h: 0.1 } }, { text: "Hütte", box: { x: 0.7, y: 0.5, w: 0.3, h: 0.1 } }] },
				{ box: line2, words: [{ text: "zwei", box: line2 }] },
			],
		]);

		const ops = await pageOps(layered);
		expect(ops).toMatch(/^3 Tr$/m);
		const words = shownWords(ops);
		expect(words.map((word) => word.text)).toEqual(["Rapoldeck ", "Hütte ", "zwei "]);

		// The line's ink starts 601 px right of the page's left edge (scene x -101, midline at 702).
		expect(words[0].x).toBeCloseTo(601 * PT_PER_PX, 2);
		expect(words[1].x).toBeCloseTo((601 + 0.7 * 402) * PT_PER_PX, 2);
		// Line one is 80.2 px tall, so Helvetica (ascender 718, descender 207 per 1000) is set at
		// 80.2 px / 0.925, and its descender sits under the box's bottom: scene y 199 + 0.5 * 802 = 600.
		const size = (80.2 * PT_PER_PX) / 0.925;
		expect(words[0].y).toBeCloseTo((1872 - 600) * PT_PER_PX + 0.207 * size, 2);
		expect(words[2].y).toBeLessThan(words[0].y);
		// "Rapoldeck" is 4724/1000 em wide in Helvetica; squeezed to fill 60 % of the 402 px line.
		expect(words[0].squeeze).toBeCloseTo((100 * 0.6 * 402 * PT_PER_PX) / (4.724 * size), 1);
	});

	it("sets every word of a line at the line's height, however tall the word's own box is", async () => {
		const pdf = await renderPagesToPdf([scene()]);
		const layered = await addTextLayer(pdf, [scene()], [
			[{ box: LINE, words: [{ text: "ab", box: { x: 0, y: 0.52, w: 0.4, h: 0.04 } }, { text: "Kl", box: { x: 0.5, y: 0.5, w: 0.5, h: 0.1 } }] }],
		]);

		const words = shownWords(await pageOps(layered));
		const size = (80.2 * PT_PER_PX) / 0.925;
		expect(words.map((word) => word.size)).toEqual([expect.closeTo(size, 2), expect.closeTo(size, 2)]);
	});

	it("shares a line out by characters where Vision gave its words no boxes of their own", async () => {
		const pdf = await renderPagesToPdf([scene()]);
		const layered = await addTextLayer(pdf, [scene()], [
			[{ box: LINE, words: [{ text: "ab", box: LINE }, { text: "cd", box: LINE }, { text: "efgh", box: null }] }],
		]);

		// "ab cd efgh" is ten characters: "cd" starts at the fourth, "efgh" at the seventh.
		const words = shownWords(await pageOps(layered));
		expect(words.map((word) => word.x)).toEqual([
			expect.closeTo(601 * PT_PER_PX, 2),
			expect.closeTo((601 + 0.3 * 402) * PT_PER_PX, 2),
			expect.closeTo((601 + 0.6 * 402) * PT_PER_PX, 2),
		]);
	});

	it("writes a character Helvetica has no code for as the render's own substitute, keeping the rest of the word", async () => {
		const pdf = await renderPagesToPdf([scene()]);
		const layered = await addTextLayer(pdf, [scene()], [[{ box: LINE, words: [{ text: "Ost→West", box: LINE }] }]]);

		expect(shownWords(await pageOps(layered)).map((word) => word.text)).toEqual(["Ost·West "]);
	});

	it("leaves the drawing as it was: the render's own stream is kept whole, and nothing but the layer is shown", async () => {
		const pdf = await renderPagesToPdf([scene()]);
		const layered = await addTextLayer(pdf, [scene()], [[{ box: LINE, words: [{ text: "Hütte", box: LINE }] }]]);

		const ops = await pageOps(layered);
		expect(ops).toContain(await pageOps(pdf));
		// Every text object the layer opens is in render mode 3 before it shows anything.
		expect(ops.match(/BT\n3 Tr\n/g)).toHaveLength(ops.match(/BT\n/g)?.length ?? 0);
		const doc = await PDFDocument.load(layered);
		expect(doc.getPage(0).getSize()).toEqual((await PDFDocument.load(pdf)).getPage(0).getSize());
	});

	it("gives a page with no words no layer, and the others theirs", async () => {
		const pdf = await renderPagesToPdf([scene(), scene()]);
		const layered = await addTextLayer(pdf, [scene(), scene()], [[], [{ box: LINE, words: [{ text: "zwei", box: LINE }] }]]);

		expect(await pageOps(layered, 0)).toBe(await pageOps(pdf, 0));
		expect(shownWords(await pageOps(layered, 1)).map((word) => word.text)).toEqual(["zwei "]);
	});

	it("hands the render back untouched when no page has a word to place", async () => {
		const pdf = await renderPagesToPdf([scene()]);

		expect(await addTextLayer(pdf, [scene()], [[]])).toBe(pdf);
	});

	// Reference page 15 was scrolled: its writing runs on below the screen, and the render grows the
	// page downwards to hold it. A box mapped against the bare screen would land below the page.
	it("puts a word written below the screen on the grown page, where it was written", async () => {
		const tall = parseRmV6(readFileSync("test-fixtures/ocr-reference/scenes/15-6ba0cccb-5972-4b82-8c42-3dc6ed106964.rm"));
		const pdf = await renderPagesToPdf([tall]);
		// The bottom line of the page's ink.
		const bottom = { x: 0, y: 0, w: 1, h: 0.02 };
		const layered = await addTextLayer(pdf, [tall], [[{ box: bottom, words: [{ text: "unten", box: bottom }] }]]);

		const { height } = (await PDFDocument.load(pdf)).getPage(0).getSize();
		expect(height).toBeGreaterThan(1872 * PT_PER_PX);
		const [word] = shownWords(await pageOps(layered));
		expect(word.y).toBeGreaterThan(0);
		expect(word.y).toBeLessThan(height - 1872 * PT_PER_PX);
	});
});

describe("foldWord", () => {
	/** What Helvetica can write: WinAnsi. */
	async function winAnsi(): Promise<Set<number>> {
		const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
		return new Set(font.getCharacterSet());
	}

	// Letter by letter, `ó` (in WinAnsi) would stay and give "Lódz", which neither spelling finds.
	it("folds a word with a letter outside WinAnsi as a whole, so the plain spelling finds it", async () => {
		expect(foldWord("Łódź", await winAnsi())).toBe("Lodz");
	});

	it("leaves a word WinAnsi holds as it is, umlauts and typographic marks included", async () => {
		const encodable = await winAnsi();
		for (const word of ["Grüße", "€", "„", "“", "–", "…"]) expect(foldWord(word, encodable)).toBe(word);
	});

	// "Grüße": the umlaut sent as u plus a combining mark, which WinAnsi does not hold on its own.
	it("leaves a WinAnsi word sent decomposed whole, umlaut composed", async () => {
		expect(foldWord("Grüße", await winAnsi())).toBe("Grüße");
	});

	it("writes a sign with no base letter as ·", async () => {
		expect(foldWord("√2", await winAnsi())).toBe("·2");
	});

	it("writes one · per character with no base letter, as typed text does", async () => {
		expect(foldWord("한국", await winAnsi())).toBe("··");
	});

	it("writes a minus sign as a hyphen", async () => {
		expect(foldWord("−1", await winAnsi())).toBe("-1");
	});
});
