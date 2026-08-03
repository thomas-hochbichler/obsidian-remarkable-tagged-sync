import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { highlightRgb, renderAnnotatedPdf, renderPagesToPdf, toPdfPoint } from "./pdf-renderer";
import { parseRmV6, type RmPage, type RmStroke } from "./rm-parser";

const FIXTURE_PATH = "./test-fixtures/rmv6/normal-a-stroke-2-layers.rm";

function loadFixturePage(): RmPage {
	const data = readFileSync(FIXTURE_PATH);
	return parseRmV6(new Uint8Array(data));
}

function stroke(overrides: Partial<RmStroke>): RmStroke {
	return {
		layerId: "layer-1",
		penType: 17, // fineliner
		color: 0,
		brushSize: 2,
		points: [
			{ x: 0, y: 0, speed: 0, width: 0, direction: 0, pressure: 0 },
			{ x: 10, y: 10, speed: 0, width: 0, direction: 0, pressure: 0 },
		],
		...overrides,
	};
}

function pageWithStrokes(strokes: RmStroke[], paperSize?: RmPage["paperSize"]): RmPage {
	return { formatVersion: 6, layers: [{ id: "layer-1", name: null, strokes }], paperSize };
}

/** The `x y m` / `x y l` path points in a decoded content stream, in the top-origin frame `drawSvgPath` emits. */
function pathPoints(ops: string): { x: number; y: number }[] {
	return Array.from(ops.matchAll(/^(-?[\d.]+) (-?[\d.]+) [ml]$/gm), (match) => ({ x: Number(match[1]), y: Number(match[2]) }));
}

/**
 * The filled rectangles in a decoded content stream, with y measured from the page bottom.
 * pdf-lib draws a rectangle as a translate to its lower-left corner plus a closed path, not
 * as PDF's own `re` operator, so both the position and the size have to be read back out.
 */
function filledRects(ops: string): { x: number; y: number; width: number; height: number }[] {
	const pattern = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n(?:1 0 0 1 0 0 cm\n)*0 0 m\n0 (-?[\d.]+) l\n(-?[\d.]+) -?[\d.]+ l/g;
	return Array.from(ops.matchAll(pattern), (match) => ({
		x: Number(match[1]),
		y: Number(match[2]),
		height: Number(match[3]),
		width: Number(match[4]),
	}));
}

/** Decodes a rendered PDF's page content stream(s) into their raw operator text, and the page's /ExtGState resources, for asserting on color/opacity/blend-mode/draw-order. */
async function decodePageContent(bytes: Uint8Array): Promise<{ ops: string; extGStates: Record<string, { ca?: number; bm?: string }> }> {
	const doc = await PDFDocument.load(bytes);
	const page = doc.getPage(0);
	const contentsRef = page.node.Contents();
	const refs = contentsRef instanceof PDFArray ? contentsRef.asArray() : [contentsRef];
	const ops = refs
		.map((ref) => {
			const contentStream = doc.context.lookup(ref) as PDFRawStream;
			const filter = contentStream.dict.get(PDFName.of("Filter"));
			return filter ? inflateSync(contentStream.contents).toString("latin1") : Buffer.from(contentStream.contents).toString("latin1");
		})
		.join("\n");

	const extGStates: Record<string, { ca?: number; bm?: string }> = {};
	const extGStateDict = page.node.Resources()?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
	for (const [key, ref] of extGStateDict?.entries() ?? []) {
		const gs = doc.context.lookup(ref, PDFDict);
		const ca = gs.lookupMaybe(PDFName.of("CA"), PDFNumber)?.asNumber();
		const bm = gs.lookupMaybe(PDFName.of("BM"), PDFName)?.toString();
		extGStates[key.toString()] = { ca, bm };
	}

	return { ops, extGStates };
}

describe("renderPagesToPdf", () => {
	it("renders a real page fixture into a one-page PDF", async () => {
		const page = loadFixturePage();

		const bytes = await renderPagesToPdf([page]);

		expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
		const doc = await PDFDocument.load(bytes);
		expect(doc.getPageCount()).toBe(1);
	});

	it("throws rather than producing an empty PDF when there are no pages", async () => {
		await expect(renderPagesToPdf([])).rejects.toThrow(/no pages/);
	});

	it("renders a blank page (no layers) as a real, empty PDF page", async () => {
		const blank: RmPage = { formatVersion: 6, layers: [] };

		const doc = await PDFDocument.load(await renderPagesToPdf([blank]));

		expect(doc.getPageCount()).toBe(1);
	});

	it("assembles multiple pages into one PDF, in order", async () => {
		const page = loadFixturePage();

		const bytes = await renderPagesToPdf([page, page, page]);

		const doc = await PDFDocument.load(bytes);
		expect(doc.getPageCount()).toBe(3);
	});

	it("uses the reMarkable device page size for every page", async () => {
		const page = loadFixturePage();

		const bytes = await renderPagesToPdf([page]);

		const doc = await PDFDocument.load(bytes);
		const { width, height } = doc.getPage(0).getSize();
		expect(width).toBeCloseTo(447.32, 1);
		expect(height).toBeCloseTo(596.39, 1);
	});

	it("grows a page to fit ink written past the screen height, instead of clipping the scrolled part off", async () => {
		// A notebook page scrolls: the writer keeps going and the canvas keeps growing, so y=4000 is
		// ordinary ink on a screen only 1872px tall -- and a screen-height page would drop all of it.
		const scrolled = pageWithStrokes([
			stroke({
				points: [
					{ x: 0, y: 100, speed: 0, width: 0, direction: 0, pressure: 0 },
					{ x: 10, y: 4000, speed: 0, width: 0, direction: 0, pressure: 0 },
				],
			}),
		]);

		const bytes = await renderPagesToPdf([scrolled]);

		const { width, height } = (await PDFDocument.load(bytes)).getPage(0).getSize();
		expect(width).toBeCloseTo(447.32, 1); // unchanged: only the bottom moves
		expect(height).toBeCloseTo((4001 * 72) / 226, 1); // the ink's reach, plus half the stroke's width
		// ...and every point of it lands inside that page (path y is measured from the page top).
		const { ops } = await decodePageContent(bytes);
		for (const point of pathPoints(ops)) expect(point.y).toBeLessThanOrEqual(height);
	});

	it("keeps y=0 at the page top when a page grows, so ink above the fold doesn't move", async () => {
		const scrolled = pageWithStrokes([
			stroke({
				points: [
					{ x: 0, y: 100, speed: 0, width: 0, direction: 0, pressure: 0 },
					{ x: 0, y: 4000, speed: 0, width: 0, direction: 0, pressure: 0 },
				],
			}),
		]);

		const bytes = await renderPagesToPdf([scrolled]);

		const { ops } = await decodePageContent(bytes);
		const { height } = (await PDFDocument.load(bytes)).getPage(0).getSize();
		// The path is laid down top-down from an origin the renderer puts at the page's top edge...
		expect(Number(/^1 0 0 1 0 (-?[\d.]+) cm$/m.exec(ops)?.[1])).toBeCloseTo(height, 1);
		// ...so ink at y=100 stays 100px below the top, grown page or not.
		expect(pathPoints(ops)[0].y).toBeCloseTo((100 * 72) / 226, 1);
	});

	it("counts a text highlight's rectangles as ink when sizing a grown page", async () => {
		const highlighted: RmPage = {
			formatVersion: 6,
			layers: [{ id: "layer-1", name: null, strokes: [] }],
			highlights: [{ color: 3, text: "", rects: [{ x: 0, y: 3000, width: 100, height: 20 }] }],
		};

		const { height } = (await PDFDocument.load(await renderPagesToPdf([highlighted]))).getPage(0).getSize();

		expect(height).toBeCloseTo((3020 * 72) / 226, 1);
	});

	it("doesn't grow a page for a non-physical outlier y (decode noise), which would stretch it to hundreds of inches", async () => {
		// The counterpart of the x-outlier guard above: real fixtures carry a few garbage
		// coordinates, and one of them must not size the page the rest of the ink is drawn on.
		const noisy = pageWithStrokes([
			stroke({
				points: [
					{ x: 10, y: 10, speed: 0, width: 0, direction: 0, pressure: 0 },
					{ x: 10, y: 1e38, speed: 0, width: 0, direction: 0, pressure: 0 },
				],
			}),
		]);

		expect((await PDFDocument.load(await renderPagesToPdf([noisy]))).getPage(0).getSize().height).toBeCloseTo(596.39, 1);
	});

	it("renders on the larger Paper Pro canvas when a stroke's x falls outside the reMarkable 1/2 frame", async () => {
		// x=800 is past the 1/2 half-width (702) but within the Paper Pro frame -- only the wider
		// Paper Pro canvas could have produced it, so the page must be sized (and strokes mapped) for it.
		const paperPro = pageWithStrokes([
			stroke({
				points: [
					{ x: 800, y: 100, speed: 0, width: 0, direction: 0, pressure: 0 },
					{ x: 810, y: 200, speed: 0, width: 0, direction: 0, pressure: 0 },
				],
			}),
		]);

		const { width, height } = (await PDFDocument.load(await renderPagesToPdf([paperPro]))).getPage(0).getSize();

		expect(width).toBeCloseTo((1620 * 72) / 229, 1); // 509.43
		expect(height).toBeCloseTo((2160 * 72) / 229, 1); // 679.24
	});

	it("stays on the reMarkable 1/2 canvas when only a non-physical outlier exceeds the frame (decode noise)", async () => {
		// A single garbage coordinate (some files decode a few) must not masquerade as a wider device.
		const noisy = pageWithStrokes([
			stroke({
				points: [
					{ x: 1e38, y: 0, speed: 0, width: 0, direction: 0, pressure: 0 },
					{ x: 10, y: 10, speed: 0, width: 0, direction: 0, pressure: 0 },
				],
			}),
		]);

		expect((await PDFDocument.load(await renderPagesToPdf([noisy]))).getPage(0).getSize().width).toBeCloseTo(447.32, 1);
	});

	it("renders an empty scene (no strokes) without throwing", async () => {
		const emptyPage: RmPage = { formatVersion: 6, layers: [] };

		const bytes = await renderPagesToPdf([emptyPage]);

		const doc = await PDFDocument.load(bytes);
		expect(doc.getPageCount()).toBe(1);
	});

	it("maps reMarkable's horizontally-centered x origin to the PDF's left-origin x", () => {
		// x=0 in a .rm file is the page's vertical midline (confirmed against real
		// device data, which ranges roughly -700..+720 for a 1404px-wide page),
		// not the left edge -- unlike y, which is already top-origin.
		expect(toPdfPoint({ x: 0, y: 0 }).x).toBeCloseTo(447.32 / 2, 1);
		expect(toPdfPoint({ x: -702, y: 0 }).x).toBeCloseTo(0, 1);
		expect(toPdfPoint({ x: 702, y: 0 }).x).toBeCloseTo(447.32, 1);
	});

	it("renders a single-point stroke (a tap) without throwing", async () => {
		const tapPage: RmPage = {
			formatVersion: 6,
			layers: [
				{
					id: "layer-1",
					name: null,
					strokes: [
						{
							layerId: "layer-1",
							penType: 17,
							color: 0,
							brushSize: 2,
							points: [{ x: 100, y: 100, speed: 0, width: 0, direction: 0, pressure: 0 }],
						},
					],
				},
			],
		};

		const bytes = await renderPagesToPdf([tapPage]);

		const doc = await PDFDocument.load(bytes);
		expect(doc.getPageCount()).toBe(1);
	});

	it("renders every known colorId in its correct color, and falls back to black for an unmapped one", async () => {
		const blue = stroke({ color: 6 }); // BLUE
		const unmapped = stroke({ color: 42 });

		const bytes = await renderPagesToPdf([pageWithStrokes([blue, unmapped])]);

		const { ops } = await decodePageContent(bytes);
		expect(ops).toContain("0.3058823529411765 0.4117647058823529 0.788235294117647 RG"); // BLUE = (78, 105, 201)
		expect(ops).toContain("0 0 0 RG"); // unmapped colorId falls back to black
	});

	it("renders a highlighter stroke at full strength with a Multiply blend, using its true color from color_rgba", async () => {
		const highlighter = stroke({ penType: 18, color: 9, colorRgba: { r: 10, g: 20, b: 30 } });

		const bytes = await renderPagesToPdf([pageWithStrokes([highlighter])]);

		const { ops, extGStates } = await decodePageContent(bytes);
		expect(ops).toContain("0.0392156862745098 0.0784313725490196 0.11764705882352941 RG");
		expect(Object.values(extGStates)).toContainEqual({ ca: 1, bm: "/Multiply" });
	});

	/**
	 * Paper Pro firmware writes a stroke's real color as a palette id (e.g. 3 = YELLOW) while
	 * filling color_rgba with an opaque-black placeholder -- the reverse of the HIGHLIGHT-9
	 * convention. Preferring color_rgba unconditionally rendered those strokes black.
	 */
	it("prefers a known palette id over color_rgba, which only resolves the HIGHLIGHT placeholder", async () => {
		const highlighter = stroke({ penType: 18, color: 3, colorRgba: { r: 0, g: 0, b: 0 } });

		const bytes = await renderPagesToPdf([pageWithStrokes([highlighter])]);

		const { ops } = await decodePageContent(bytes);
		expect(ops).toContain("0.984313725490196 0.9686274509803922 0.09803921568627451 RG"); // YELLOW (251, 247, 25)
	});

	it("draws highlighter/shader strokes before every other stroke on the page, regardless of original order", async () => {
		const ink = stroke({ penType: 17, color: 0 });
		const highlighter = stroke({ penType: 5, color: 9, colorRgba: { r: 1, g: 2, b: 3 } });

		const bytes = await renderPagesToPdf([pageWithStrokes([ink, highlighter])]);

		const { ops } = await decodePageContent(bytes);
		const highlighterOpIndex = ops.indexOf("gs");
		const inkColorIndex = ops.indexOf("0 0 0 RG");
		expect(highlighterOpIndex).toBeGreaterThan(-1);
		expect(highlighterOpIndex).toBeLessThan(inkColorIndex);
	});

	it("treats SHADER (23) the same as a highlighter", async () => {
		const shader = stroke({ penType: 23, color: 9, colorRgba: { r: 5, g: 6, b: 7 } });

		const bytes = await renderPagesToPdf([pageWithStrokes([shader])]);

		const { extGStates } = await decodePageContent(bytes);
		expect(Object.values(extGStates)).toContainEqual({ ca: 1, bm: "/Multiply" });
	});

	it("takes a highlighter's width from the recorded point width, not from the near-1 thickness_scale that would render a hairline", async () => {
		const banded = (width: number, penType: number) =>
			stroke({
				penType,
				color: 9,
				brushSize: 1, // what a device highlighter actually carries
				points: [
					{ x: 0, y: 0, speed: 0, width, direction: 0, pressure: 0 },
					{ x: 10, y: 10, speed: 0, width, direction: 0, pressure: 0 },
				],
			});
		const strokes = [
			banded(120, 18), // device highlighter: 120 quarter-px -> 30 px
			banded(48, 23), // shader -> 12 px
			stroke({ penType: 17, color: 0, brushSize: 1 }), // pen -> thickness_scale, unchanged
		];

		const bytes = await renderPagesToPdf([pageWithStrokes(strokes)]);

		const { ops } = await decodePageContent(bytes);
		const widths = Array.from(ops.matchAll(/([\d.]+) w\b/g), (match) => Number(match[1]));
		expect(widths).toHaveLength(3);
		for (const [i, px] of [30, 12, 1].entries()) expect(widths[i]).toBeCloseTo((px * 72) / 226, 6);
	});

	it("varies a calligraphy stroke's width per segment from the recorded point widths, instead of flattening it to thickness_scale", async () => {
		const calligraphy = stroke({
			penType: 21,
			color: 0,
			brushSize: 2,
			points: [8, 16, 24].map((width, i) => ({ x: i * 10, y: 0, speed: 0, width, direction: 0, pressure: 0 })),
		});

		const bytes = await renderPagesToPdf([pageWithStrokes([calligraphy])]);

		const { ops } = await decodePageContent(bytes);
		const widths = Array.from(ops.matchAll(/([\d.]+) w\b/g), (match) => Number(match[1]));
		expect(widths).toHaveLength(2); // one per segment, not one for the stroke
		// each segment takes the mean of its endpoints' widths, in quarter-pixels
		for (const [i, px] of [(8 + 16) / 2 / 4, (16 + 24) / 2 / 4].entries()) expect(widths[i]).toBeCloseTo((px * 72) / 226, 6);
	});

	it("draws each stroke as a single path, so overlapping segments of a translucent marker don't composite twice", async () => {
		const marker = stroke({
			penType: 18,
			color: 9,
			points: [0, 1, 2, 3].map((i) => ({ x: i * 10, y: 0, speed: 0, width: 120, direction: 0, pressure: 0 })),
		});

		const bytes = await renderPagesToPdf([pageWithStrokes([marker])]);

		const { ops } = await decodePageContent(bytes);
		expect(ops.match(/^S$/gm)).toHaveLength(1); // one stroke operator for the whole polyline
		expect(ops.match(/ l$/gm)).toHaveLength(3); // ...covering all three segments
	});
});

describe("renderAnnotatedPdf", () => {
	const A4 = { width: 595.276, height: 841.89 };

	async function makeSource(pageCount: number, size = A4): Promise<Uint8Array> {
		const doc = await PDFDocument.create();
		for (let i = 0; i < pageCount; i++) {
			const page = doc.addPage([size.width, size.height]);
			page.drawRectangle({ x: 20, y: 20, width: 200, height: 200 }); // give the page a content stream so it can be embedded
		}
		return doc.save();
	}

	it("throws rather than producing an empty PDF when there are no pages", async () => {
		await expect(renderAnnotatedPdf(await makeSource(1), [])).rejects.toThrow(/no pages/);
	});

	it("produces one output page per input page, each at its own source page's size", async () => {
		const source = await makeSource(3);

		const bytes = await renderAnnotatedPdf(source, [
			{ sourceIndex: 0, annotations: null },
			{ sourceIndex: 1, annotations: null },
			{ sourceIndex: 2, annotations: null },
		]);

		const doc = await PDFDocument.load(bytes);
		expect(doc.getPageCount()).toBe(3);
		// The source page's own size -- annotations are placed in the page's frame, so rescaling
		// the page onto a device-sized canvas would only move every stroke off the words it marks.
		expect(doc.getPage(0).getSize()).toEqual({ width: A4.width, height: A4.height });
	});

	/**
	 * The placement regression: a marker highlight from the book *Reading Comprehension - How to
	 * Retain More of Every Book You Read*, drawn on a Paper Pure over the words "changes the past."
	 * -- which sit at x 67.2-160.0, y 246.4-260.5 down from the top of that A4 page. The device
	 * records it against the page at its own DPI (226), so `x = -728` is 934.2 px left of the page's
	 * midline, not of a 1404 px screen's. Reading those numbers as screen coordinates put the band
	 * about three text lines below the quote and a quarter too wide.
	 */
	it("places annotations on the source page they were drawn on, in the page's own frame", async () => {
		const highlight = stroke({
			penType: 18,
			points: [
				{ x: -728, y: 810, speed: 0, width: 170, direction: 0, pressure: 0 },
				{ x: -452, y: 810, speed: 0, width: 170, direction: 0, pressure: 0 },
			],
		});

		const bytes = await renderAnnotatedPdf(await makeSource(1), [
			{ sourceIndex: 0, annotations: pageWithStrokes([highlight], { width: 1404, height: 1872 }) },
		]);

		const [start, end] = pathPoints((await decodePageContent(bytes)).ops);
		expect(start.x).toBeCloseTo(65.7, 1);
		expect(end.x).toBeCloseTo(153.6, 1);
		expect(start.y).toBeCloseTo(258.05, 2); // down from the page top, i.e. on the line it marks
		expect(end.y).toBeCloseTo(258.05, 2);
	});

	/**
	 * Highlighting selected text in the reader records rectangles, not marker strokes -- so a page
	 * whose highlights all came from text selection has no highlighter strokes at all, and rendering
	 * strokes alone dropped every one of them.
	 */
	it("renders a text highlight's rectangles onto the page it marks", async () => {
		const page: RmPage = {
			formatVersion: 6,
			layers: [],
			paperSize: { width: 1404, height: 1872 },
			// The "“Reading" run from the reported book, rounded: it covers x 472.5-524.6, y 231.6-244.9 pt
			// down the A4 page -- exactly the word the reader highlighted.
			highlights: [{ color: 9, text: "", colorRgba: { r: 242, g: 158, b: 255 }, rects: [{ x: 549, y: 727, width: 163.5, height: 42 }] }],
		};

		const bytes = await renderAnnotatedPdf(await makeSource(1), [{ sourceIndex: 0, annotations: page }]);

		const { ops, extGStates } = await decodePageContent(bytes);
		const [rect] = filledRects(ops);
		expect(rect.x).toBeCloseTo(472.5, 1);
		expect(rect.width).toBeCloseTo(52.1, 1);
		expect(A4.height - rect.y - rect.height).toBeCloseTo(231.6, 1); // top edge, measured down the page
		expect(ops).toContain("0.9490196078431372 0.6196078431372549 1 rg"); // its true color, filled not stroked
		// Multiply, so the words underneath stay legible -- the fill alpha pdf-lib sets for a filled
		// rectangle is the non-stroking `ca`, which this decoder doesn't read.
		expect(Object.values(extGStates).map((state) => state.bm)).toContain("/Multiply");
	});

	/**
	 * The Paper Pro bug from issue 04: a yellow smart highlight synced as opaque black bars.
	 * Its glyph block names the real color as palette id 3 (YELLOW) and carries an
	 * opaque-black color_rgba placeholder, so preferring color_rgba drew black.
	 */
	it("renders a text highlight in its palette color when color_rgba is only a black placeholder", async () => {
		const page: RmPage = {
			formatVersion: 6,
			layers: [],
			paperSize: { width: 1404, height: 1872 },
			highlights: [{ color: 3, text: "", colorRgba: { r: 0, g: 0, b: 0 }, rects: [{ x: 549, y: 727, width: 163.5, height: 42 }] }],
		};

		const bytes = await renderAnnotatedPdf(await makeSource(1), [{ sourceIndex: 0, annotations: page }]);

		const { ops } = await decodePageContent(bytes);
		expect(ops).toContain("0.984313725490196 0.9686274509803922 0.09803921568627451 rg"); // YELLOW (251, 247, 25)
	});

	it("draws text highlights under the ink that annotates them", async () => {
		const page: RmPage = {
			formatVersion: 6,
			layers: [{ id: "layer-1", name: null, strokes: [stroke({})] }],
			highlights: [{ color: 9, text: "", rects: [{ x: 0, y: 0, width: 10, height: 10 }] }],
		};

		const { ops } = await decodePageContent(await renderAnnotatedPdf(await makeSource(1), [{ sourceIndex: 0, annotations: page }]));

		expect(ops.indexOf("\nf\n")).toBeLessThan(ops.indexOf("\nS\n")); // rectangle filled before the stroke is drawn
	});

	it("scales annotations by the DPI of the screen the scene declares", async () => {
		const mark = stroke({
			points: [
				{ x: -728, y: 810, speed: 0, width: 0, direction: 0, pressure: 0 },
				{ x: -452, y: 810, speed: 0, width: 0, direction: 0, pressure: 0 },
			],
		});
		const at = async (paperSize: RmPage["paperSize"]) => {
			const bytes = await renderAnnotatedPdf(await makeSource(1), [{ sourceIndex: 0, annotations: pageWithStrokes([mark], paperSize) }]);
			return pathPoints((await decodePageContent(bytes)).ops);
		};

		// Same stroke, same page: only the declared device's DPI (226 vs 229) moves it.
		expect((await at({ width: 1404, height: 1872 }))[0].x).toBeCloseTo(65.7, 1);
		expect((await at({ width: 1620, height: 2160 }))[0].x).toBeCloseTo(68.7, 1);
	});

	it("embeds the source page as an XObject when the page is in range", async () => {
		const bytes = await renderAnnotatedPdf(await makeSource(1), [{ sourceIndex: 0, annotations: null }]);
		// The embedded source page shows up as a Form XObject in the output.
		expect(new TextDecoder("latin1").decode(bytes)).toContain("/XObject");
	});

	it("draws the annotation strokes over the page", async () => {
		const annotations: RmPage = pageWithStrokes([stroke({}), stroke({})]);

		const bytes = await renderAnnotatedPdf(await makeSource(1), [{ sourceIndex: 0, annotations }]);
		const { ops } = await decodePageContent(bytes);

		expect(ops.match(/^S$/gm)).toHaveLength(2); // both strokes stroked
	});

	it("degrades an out-of-range source index to an annotations-only page instead of failing", async () => {
		const annotations = pageWithStrokes([stroke({})]);

		// One page's index points past the 1-page source; it must still render (strokes only), not throw.
		const bytes = await renderAnnotatedPdf(await makeSource(1), [{ sourceIndex: 5, annotations }]);

		expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
	});
});

describe("highlightRgb", () => {
	const rects = [{ x: 0, y: 0, width: 10, height: 10 }];

	it("resolves a known palette id, ignoring a black color_rgba placeholder (Paper Pro convention)", () => {
		expect(highlightRgb({ color: 3, text: "", colorRgba: { r: 0, g: 0, b: 0 }, rects })).toEqual({ r: 251, g: 247, b: 25 });
	});

	it("resolves the HIGHLIGHT placeholder id from color_rgba", () => {
		expect(highlightRgb({ color: 9, text: "", colorRgba: { r: 242, g: 158, b: 255 }, rects })).toEqual({ r: 242, g: 158, b: 255 });
	});

	it("falls back to the palette's yellow when the placeholder carries no true colour", () => {
		expect(highlightRgb({ color: 9, text: "", rects })).toEqual({ r: 251, g: 247, b: 25 });
	});
});
