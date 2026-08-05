import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rasterizePage } from "./page-rasterizer";
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
	});
});
