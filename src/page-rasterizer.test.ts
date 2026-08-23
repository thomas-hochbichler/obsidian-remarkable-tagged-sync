import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inkBounds, rasterizePage } from "./page-rasterizer";
import { parseRmV6, type RmPage } from "./rm-parser";

const FIXTURE_PATH = "./test-fixtures/rmv6/normal-a-stroke-2-layers.rm";

function loadFixturePage(): RmPage {
	const data = readFileSync(FIXTURE_PATH);
	return parseRmV6(new Uint8Array(data));
}

describe("rasterizePage", () => {
	it("falls back to the reMarkable device resolution for a page with no ink to size it by", () => {
		const emptyPage: RmPage = { formatVersion: 6, layers: [] };

		const image = rasterizePage(emptyPage);

		expect(image.width).toBe(1404);
		expect(image.height).toBe(1872);
		expect(image.pixels.length).toBe(1404 * 1872);
		expect(image.pixels.every((p) => p === 255)).toBe(true);
	});

	it("darkens pixels along a real stroke fixture", () => {
		const page = loadFixturePage();

		const image = rasterizePage(page);

		let darkCount = 0;
		for (const p of image.pixels) if (p < 255) darkCount++;
		expect(darkCount).toBeGreaterThan(0);
	});

	it("draws a single-point stroke (a tap) as a filled dot without throwing", () => {
		const tapPage: RmPage = {
			formatVersion: 6,
			layers: [
				{
					id: "layer-1",
					name: null,
					strokes: [
						{
							layerId: "layer-1",
							id: "stroke-1",
							timestamp: "0001",
							penType: 0,
							color: 0,
							brushSize: 4,
							points: [{ x: 100, y: 100, speed: 0, width: 0, direction: 0, pressure: 0 }],
						},
					],
				},
			],
		};

		const image = rasterizePage(tapPage);

		// The bitmap is sized to the ink, so the tap sits at its centre rather than at (100, 100).
		expect(image.pixels[Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)]).toBe(0);
	});

	/**
	 * Scene x is measured from the page midline, so the left half of every page is negative --
	 * against a bitmap anchored at (0, 0) all of it landed outside the image and was never
	 * transcribed, which is what reduced the transcripts to noise.
	 */
	it("keeps ink left of the page midline, where scene x is negative", () => {
		const leftOfMidline: RmPage = {
			formatVersion: 6,
			layers: [
				{
					id: "layer-1",
					name: null,
					strokes: [
						{
							layerId: "layer-1",
							id: "stroke-1",
							timestamp: "0001",
							penType: 0,
							color: 0,
							brushSize: 2,
							points: [
								{ x: -600, y: 300, speed: 0, width: 0, direction: 0, pressure: 0 },
								{ x: -400, y: 300, speed: 0, width: 0, direction: 0, pressure: 0 },
							],
						},
					],
				},
			],
		};

		const image = rasterizePage(leftOfMidline);

		expect(image.pixels.some((pixel) => pixel < 255)).toBe(true);
		expect(image.width).toBeGreaterThanOrEqual(200); // the full 200px-wide stroke, not a sliver
	});

	it("grows the bitmap by the padding on all four sides, carrying the ink along with it", () => {
		const page = loadFixturePage();
		const padding = 12;
		const plain = rasterizePage(page);

		const padded = rasterizePage(page, { paddingPx: padding });

		expect(padded.width).toBe(plain.width + 2 * padding);
		expect(padded.height).toBe(plain.height + 2 * padding);
		let darkCount = 0;
		for (let y = 0; y < plain.height; y++) {
			for (let x = 0; x < plain.width; x++) {
				const pixel = plain.pixels[y * plain.width + x];
				if (pixel === 255) continue;
				darkCount++;
				expect(padded.pixels[(y + padding) * padded.width + (x + padding)]).toBe(pixel);
			}
		}
		expect(darkCount).toBeGreaterThan(0);
	});

	/** A horizontal stroke of `width` quarter-pixels per point, drawn with the given pen and setting. */
	function horizontalStroke(penType: number, brushSize: number, width: number): RmPage {
		return {
			formatVersion: 6,
			layers: [
				{
					id: "layer-1",
					name: null,
					strokes: [
						{
							layerId: "layer-1",
							id: "stroke-1",
							timestamp: "0001",
							penType,
							color: 0,
							brushSize,
							points: [
								{ x: 0, y: 300, speed: 0, width, direction: 0, pressure: 0 },
								{ x: 100, y: 300, speed: 0, width, direction: 0, pressure: 0 },
							],
						},
					],
				},
			],
		};
	}

	/**
	 * `brushSize` is the tool's size setting (1/2/3), not a width -- drawing at it made every pen
	 * stroke 2x-9x too thin, and thin hairlines are what Vision misread and lost whole lines of.
	 */
	it("draws a pen stroke at the width the device recorded per point, not at its size setting", () => {
		const image = rasterizePage(horizontalStroke(15, 1, 32)); // 32 quarter-px = 8 px wide

		expect(image.height).toBeGreaterThanOrEqual(8);
		expect(image.height).toBeLessThanOrEqual(10); // the 8px band, plus the bounds' own rounding
	});

	/** The raster is 1-bit, so a highlighter at its true 30px would bury the words instead of marking them. */
	it("keeps a highlighter stroke at its size setting, where its true width would black out the line", () => {
		const image = rasterizePage(horizontalStroke(18, 1, 120)); // 120 quarter-px = 30 px if believed

		expect(image.height).toBeLessThanOrEqual(3);
	});

	it("clips strokes that fall outside the page bounds instead of throwing", () => {
		const outOfBoundsPage: RmPage = {
			formatVersion: 6,
			layers: [
				{
					id: "layer-1",
					name: null,
					strokes: [
						{
							layerId: "layer-1",
							id: "stroke-1",
							timestamp: "0001",
							penType: 0,
							color: 0,
							brushSize: 2,
							points: [
								{ x: -50, y: -50, speed: 0, width: 0, direction: 0, pressure: 0 },
								{ x: 5000, y: 5000, speed: 0, width: 0, direction: 0, pressure: 0 },
							],
						},
					],
				},
			],
		};

		expect(() => rasterizePage(outOfBoundsPage)).not.toThrow();

		// Gap G36: `not.toThrow()` was the whole assertion, so a rasteriser producing a 5050x5050
		// bitmap of nothing passed. `clampPoint` holds a coordinate to the page, so the ink box stays
		// the size of a page rather than the size of the numbers in the file.
		// The two points are 10 000 apart in each axis; `clampPoint` holds each to the page, so the
		// bitmap is the size of a page rather than the size of the numbers in the file.
		const image = rasterizePage(outOfBoundsPage);
		expect(image.width).toBeLessThan(10_000);
		expect(image.height).toBeLessThan(10_000);
		expect(image.pixels).toHaveLength(image.width * image.height);
	});
});

// Gap G36. `inkBounds` is exported because it is the frame anything reading an OCR result back has to
// work in -- an observation's box is normalised against this bitmap, so mapping one onto the scene
// means undoing exactly this box. Its own doc says an approximation of it makes every comparison
// silently wrong, and it had no direct test at all.
/** A one-stroke page through the given points, at the given brush size. */
function pageWith(points: RmPage["layers"][number]["strokes"][number]["points"], brushSize: number): RmPage {
	return {
		formatVersion: 6,
		layers: [
			{
				id: "layer-1",
				name: null,
				strokes: [{ layerId: "layer-1", id: "stroke-1", timestamp: "0001", penType: 0, color: 0, brushSize, points }],
			},
		],
	};
}

describe("inkBounds", () => {
	it("has nothing to bound on a page with no ink", () => {
		expect(inkBounds({ formatVersion: 6, layers: [] })).toBeNull();
		expect(inkBounds({ formatVersion: 6, layers: [{ id: "l", name: null, strokes: [] }] })).toBeNull();
	});

	it("boxes the ink, and opens the box by the widest stroke's own radius", () => {
		// The pad is not decoration: a stroke is drawn centred on its points, so a box drawn to the
		// points alone cuts half the ink off every edge.
		const page = pageWith([
			{ x: 100, y: 100, speed: 0, width: 0, direction: 0, pressure: 0 },
			{ x: 200, y: 100, speed: 0, width: 0, direction: 0, pressure: 0 },
		], 8);
		const bounds = inkBounds(page)!;

		expect(bounds.minX).toBeLessThan(100);
		expect(bounds.width).toBeGreaterThan(100);
	});

	it("never asks for a bitmap larger than a raster can be, whatever the file says", () => {
		// A corrupt coordinate is not hypothetical -- a `.rm` file is bytes off a device, and a single
		// wrong exponent asks for a bitmap of a billion pixels a side. The guard is what stands between
		// that and an allocation that takes the app down.
		const bounds = inkBounds(
			pageWith(
				[
					{ x: -1e9, y: -1e9, speed: 0, width: 0, direction: 0, pressure: 0 },
					{ x: 1e9, y: 1e9, speed: 0, width: 0, direction: 0, pressure: 0 },
				],
				2,
			),
		)!;

		expect(bounds.width).toBeLessThanOrEqual(6000);
		expect(bounds.height).toBeLessThanOrEqual(6000);
	});

	it("gives a single point a bitmap of at least one pixel, not of none", () => {
		// A tap has zero extent. Zero times zero is an image with no pixels, which every consumer of a
		// `RasterImage` would then divide by.
		const bounds = inkBounds(pageWith([{ x: 100, y: 100, speed: 0, width: 0, direction: 0, pressure: 0 }], 0))!;

		expect(bounds.width).toBeGreaterThanOrEqual(1);
		expect(bounds.height).toBeGreaterThanOrEqual(1);
	});
});
