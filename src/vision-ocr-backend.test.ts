import { beforeEach, describe, expect, it, vi } from "vitest";
// Its own module now -- `device-api` overlaps SFTP round trips with it, and an OCR backend was a
// strange address for that. The test stays here so the shrink-only allowlist, which is keyed by
// file and test name, does not have to grow a line to lose one.
import { mapWithConcurrency } from "./concurrency";
import {
	chunk,
	DEFAULT_MAX_PARALLELISM,
	UnavailableOcrBackend,
	type VisionBatchResult,
	type VisionBox,
	VisionOcrBackend,
	visionRunStats,
} from "./vision-ocr-backend";
import type { OcrBackend } from "./ocr-backend";
import { rasterizePage } from "./page-rasterizer";
import { encodeGrayscalePng } from "./png-encoder";
import type { RmPage } from "./rm-parser";

function page(): RmPage {
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
						penType: 0,
						color: 0,
						brushSize: 2,
						points: [
							{ x: 10, y: 10, speed: 0, width: 0, direction: 0, pressure: 0 },
							{ x: 20, y: 20, speed: 0, width: 0, direction: 0, pressure: 0 },
						],
					},
				],
			},
		],
	};
}

/** A runBatch that echoes canned per-image results and records the PNG batch sizes it was called with. */
function stubRunner(results: VisionBatchResult[][]): { runBatch: (images: Uint8Array[]) => Promise<VisionBatchResult[]>; batchSizes: number[] } {
	const batchSizes: number[] = [];
	let call = 0;
	return {
		batchSizes,
		runBatch: async (images) => {
			batchSizes.push(images.length);
			// Every image is a real PNG the backend rasterized+encoded.
			expect([...images[0].subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			return results[call++];
		},
	};
}

/** A stroke along one line of writing, as a scene carries it. */
function stroke(id: string, y: number) {
	return {
		layerId: "layer-1",
		id,
		timestamp: "0001",
		penType: 0,
		color: 0,
		brushSize: 2,
		points: [
			{ x: 0, y, speed: 0, width: 0, direction: 0, pressure: 0 },
			{ x: 50, y: y + 20, speed: 0, width: 0, direction: 0, pressure: 0 },
			{ x: 100, y, speed: 0, width: 0, direction: 0, pressure: 0 },
		],
	};
}

/** Two lines of writing far enough apart to cluster separately -- one near the page top, one well below. */
function twoLinePage(): RmPage {
	return { formatVersion: 6, layers: [{ id: "layer-1", name: null, strokes: [stroke("stroke-1", 100), stroke("stroke-2", 400)] }] };
}

/**
 * Three lines of writing, the first of them written in two strokes -- which is what a line of real
 * handwriting is. The stroke centres sit at 110, 114, 170 and 410 device px, so the line height
 * decides the clustering three different ways: at 40 the two strokes of the first line are one line
 * and the other two stand alone, at 200 the first two lines merge, and at 2 even one line's own
 * strokes come apart.
 */
function threeLinePage(): RmPage {
	return {
		formatVersion: 6,
		layers: [
			{
				id: "layer-1",
				name: null,
				strokes: [stroke("stroke-1", 100), stroke("stroke-2", 104), stroke("stroke-3", 160), stroke("stroke-4", 400)],
			},
		],
	};
}

/**
 * A read in the shape the JXA driver sends it: every line with its box and its words. Each word comes
 * without a box of its own, which the driver sends when `boundingBoxForRange` gives none.
 */
function driverRead(lines: string[], boxes: VisionBox[]): VisionBatchResult {
	return { lines, boxes, words: lines.map((line) => (line.match(/\S+/g) ?? []).map((text) => ({ text, box: null }))), revision: 3 };
}

/** A page read whose one observation covers the whole image, so no cluster is left for the rescue pass. */
function readAll(text: string): VisionBatchResult {
	return text.trim() === "" ? driverRead([], []) : driverRead([text], [WHOLE_IMAGE]);
}

const WHOLE_IMAGE: VisionBox = { x: 0, y: 0, w: 1, h: 1 };

const available = () => Promise.resolve(true);

/**
 * The normalised height of the top line's band on {@link twoLinePage}, as `uncoveredClusters`
 * measures it: the two strokes span y 100..420 together, and each is 20px tall, so a line's band is
 * 20/320 of the ink frame.
 */
const TOP_BAND_H = 20 / 320;

describe("chunk", () => {
	it("splits into contiguous chunks of at most size, order preserved", () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		expect(chunk([], 3)).toEqual([]);
		expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
	});
});

describe("mapWithConcurrency", () => {
	it("preserves order and never exceeds the concurrency limit", async () => {
		let inFlight = 0;
		let peak = 0;
		const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Promise.resolve();
			inFlight--;
			return n * 10;
		});
		expect(out).toEqual([10, 20, 30, 40, 50]);
		expect(peak).toBeLessThanOrEqual(2);
	});
});

// Gap G22. Every test in this file injects its own `maxParallelism` and its own runner, so not one of
// them ever saw a shipped default -- `DEFAULT_MAX_PARALLELISM` 8 -> 64 passed all 996, and 64
// concurrent `osascript` processes is a Mac that stops responding while somebody syncs a notebook.
//
// The rescue pass has the same problem and it is worse there: it is Vision's most expensive
// behaviour, and none of the three numbers deciding how often it runs was pinned.
describe("the numbers this backend ships with", () => {
	it("keeps concurrent Vision processes near a Mac's perf-core count", async () => {
		// Not asserted as a literal alone: the constant and the behaviour, because a constant nothing
		// reads is a number, not a default.
		expect(DEFAULT_MAX_PARALLELISM).toBe(8);

		let inFlight = 0;
		let peak = 0;
		const backend = new VisionOcrBackend({
			batchSize: 1,
			probe: available,
			runBatch: async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 0));
				inFlight--;
				return [readAll("x")];
			},
		});

		await backend.recognize(Array.from({ length: 40 }, page));

		expect(peak).toBeLessThanOrEqual(DEFAULT_MAX_PARALLELISM);
		expect(peak).toBeGreaterThan(1);
	});

	it("treats a line as read when an observation covers a third of it, and not a tenth", async () => {
		// `COVERAGE_FRACTION`. Vision reports a confidence of 1.000 over plain misreads, so "no
		// observation covers this writing" is the only signal that a line went missing -- and where the
		// bar sits decides whether the rescue pass runs over the whole page or not at all.
		const rescued = async (coverage: number): Promise<number> => {
			let calls = 0;
			// The rescue pass reads every uncovered cluster in one batch, so the *images* it sends are
			// the cluster count -- the call count is not.
			const sent: number[] = [];
			const backend = new VisionOcrBackend({
				probe: available,
				runBatch: async (images) => {
					calls++;
					sent.push(images.length);
					// The page pass first: one observation over the top line only, covering `coverage` of
					// its height. Everything after is the rescue pass.
					return calls === 1
						? [driverRead(["the top line"], [{ x: 0, y: 0, w: 1, h: TOP_BAND_H * coverage }])]
						: images.map(() => readAll("rescued"));
				},
			});
			await backend.recognize([twoLinePage()]);
			return sent.slice(1).reduce((total, count) => total + count, 0);
		};

		// A third of the band covered is enough: only the second line is rescued.
		expect(await rescued(0.4)).toBe(1);
		// A tenth is not: both lines go back through Vision.
		expect(await rescued(0.1)).toBe(2);
	});

	it("clusters ink into lines rather than into one block or into every stroke", async () => {
		// `RESCUE_LINE_HEIGHT_PX`. Too small and every stroke is its own "line", which sends a page
		// through Vision a hundred times; too large and the whole page is one cluster, which makes the
		// rescue pass a second full-page read that adds nothing.
		let calls = 0;
		const sent: number[] = [];
		const backend = new VisionOcrBackend({
			probe: available,
			runBatch: async (images) => {
				calls++;
				sent.push(images.length);
				// Nothing read at all, so every cluster on the page is rescued -- the images sent after
				// the page pass are exactly the clusters it found.
				return calls === 1 ? [driverRead([], [])] : images.map(() => readAll("rescued"));
			},
		});

		await backend.recognize([threeLinePage()]);

		// Three lines of writing, three clusters. Not two -- which is what a taller line height gives,
		// by merging two lines into a second full-page read that adds nothing -- and not four, which is
		// what a shorter one gives by splitting one line's own strokes and sending a page through
		// Vision once per stroke.
		expect(sent.slice(1).reduce((total, count) => total + count, 0)).toBe(3);
	});
});

describe("VisionOcrBackend", () => {
	// The adapter never resets these -- the plugin does, as each run first sends (see `countedOcr`).
	beforeEach(() => {
		visionRunStats.revision = null;
		visionRunStats.unreadableInkRegions = 0;
	});

	it("skips an empty page list without probing or spawning", async () => {
		const probe = vi.fn(available);
		const runBatch = vi.fn();
		const backend = new VisionOcrBackend({ runBatch, probe });

		expect(await backend.recognize([])).toEqual({ status: "skipped", pages: [], text: "", confidence: null });
		expect(probe).not.toHaveBeenCalled();
		expect(runBatch).not.toHaveBeenCalled();
	});

	it("returns unavailable, without spawning, when the probe fails", async () => {
		const runBatch = vi.fn();
		const backend = new VisionOcrBackend({ runBatch, probe: () => Promise.resolve(false) });

		expect(await backend.recognize([page()])).toEqual({ status: "unavailable", pages: null, text: "", confidence: null });
		expect(runBatch).not.toHaveBeenCalled();
	});

	it("probes only once across many recognize calls", async () => {
		const probe = vi.fn(available);
		const { runBatch } = stubRunner([[readAll("a")], [readAll("b")]]);
		const backend = new VisionOcrBackend({ runBatch, probe });

		await backend.recognize([page()]);
		await backend.recognize([page()]);

		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("recognizes pages and joins per-page text with a blank line, confidence null", async () => {
		const { runBatch } = stubRunner([[readAll("page one"), readAll("page two")]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		const result = await backend.recognize([page(), page()]);

		expect(result).toEqual({
			status: "ok",
			pages: [
				{ status: "ok", text: "page one", layer: [{ box: WHOLE_IMAGE, words: [{ text: "page", box: null }, { text: "one", box: null }] }] },
				{ status: "ok", text: "page two", layer: [{ box: WHOLE_IMAGE, words: [{ text: "page", box: null }, { text: "two", box: null }] }] },
			],
			text: "page one\n\npage two",
			confidence: null,
		});
	});

	it("batches pages per process and caps parallelism", async () => {
		const results = [
			[readAll("1"), readAll("2")],
			[readAll("3"), readAll("4")],
			[readAll("5")],
		];
		const { runBatch, batchSizes } = stubRunner(results);
		const backend = new VisionOcrBackend({ runBatch, probe: available, batchSize: 2, maxParallelism: 8 });

		const result = await backend.recognize([page(), page(), page(), page(), page()]);

		expect(batchSizes).toEqual([2, 2, 1]);
		expect(result.text).toBe("1\n\n2\n\n3\n\n4\n\n5");
	});

	it("reports skipped (blank), not failed, when Vision runs but finds no text", async () => {
		// Ink nothing was read over is re-read on its own before the page is called blank.
		const { runBatch } = stubRunner([[readAll(""), readAll("   ")], [readAll(""), readAll("")]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		expect(await backend.recognize([page(), page()])).toEqual({
			status: "skipped",
			// One entry per input page even when every one of them is blank -- the note names them.
			pages: [
				{ status: "skipped", text: "" },
				{ status: "skipped", text: "" },
			],
			text: "",
			confidence: null,
		});
	});

	it("reports failed when an image errored and no text came back", async () => {
		const { runBatch } = stubRunner([[{ error: "unreadable_image" }, readAll("")], [readAll("")]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		expect(await backend.recognize([page(), page()])).toEqual({
			status: "failed",
			// The errored page stays in place rather than being filtered away, so the note can say *which*.
			pages: [
				{ status: "failed", text: "" },
				{ status: "skipped", text: "" },
			],
			text: "",
			confidence: null,
		});
	});

	it("keeps good text even when a sibling image errored", async () => {
		const { runBatch } = stubRunner([[readAll("kept"), { error: "unreadable_image" }]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		expect(await backend.recognize([page(), page()])).toEqual({
			status: "ok",
			pages: [
				{ status: "ok", text: "kept", layer: [{ box: WHOLE_IMAGE, words: [{ text: "kept", box: null }] }] },
				{ status: "failed", text: "" },
			],
			text: "kept",
			confidence: null,
		});
	});

	/**
	 * The rescue pass and its trigger. Vision reports a confidence of 1.000 over plain misreads, so
	 * "this writing has no observation over it" is the only signal that a line went missing at all.
	 */
	it("re-reads ink no observation covers and splices the line in where its writing sits", async () => {
		// One observation over the lower line only: the upper line is ink with no text over it.
		const pageRead = driverRead(["lower"], [{ x: 0, y: 0, w: 1, h: 0.1 }]);
		const { runBatch, batchSizes } = stubRunner([[pageRead], [readAll("upper")]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		const result = await backend.recognize([twoLinePage()]);

		expect(batchSizes).toEqual([1, 1]); // the page, then one crop
		expect(result.text).toBe("upper\nlower"); // spliced above, not appended below
	});

	it("drops a rescued line the page pass already returned, rather than printing it twice", async () => {
		const pageRead = driverRead(["lower"], [{ x: 0, y: 0, w: 1, h: 0.1 }]);
		const { runBatch } = stubRunner([[pageRead], [readAll("Lower ")]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		expect((await backend.recognize([twoLinePage()])).text).toBe("lower");
	});

	/**
	 * Typed text is never on the image -- the rasterizer draws ink -- so it is in the note only if it
	 * is put there, and it is exact digital text that OCR could only damage.
	 */
	it("adds the page's typed text at the height the device lays it out at", async () => {
		const typed: RmPage = {
			...twoLinePage(),
			text: { posX: 0, posY: 200, width: 800, runs: [{ id: "1:1", text: "Hello World!", deleted: 0 }], styles: new Map() },
		};
		// Both lines of writing are covered, so nothing is rescued and only the typed line is added.
		const pageRead = driverRead(
			["upper", "lower"],
			[
				{ x: 0, y: 0.93, w: 1, h: 0.07 },
				{ x: 0, y: 0, w: 1, h: 0.1 },
			],
		);
		const { runBatch, batchSizes } = stubRunner([[pageRead]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		const result = await backend.recognize([typed]);

		expect(batchSizes).toEqual([1]);
		expect(result.text).toBe("upper\nHello World!\nlower");
	});

	it("transcribes a page that is nothing but typed text, which Vision reads as blank", async () => {
		const typed: RmPage = {
			formatVersion: 6,
			layers: [],
			text: { posX: 0, posY: 0, width: 800, runs: [{ id: "1:1", text: "first\nsecond", deleted: 0 }], styles: new Map() },
		};
		const { runBatch } = stubRunner([[readAll("")]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		expect(await backend.recognize([typed])).toEqual({
			status: "ok",
			// Typed text is real text in the render already: none of it goes into the layer.
			pages: [{ status: "ok", text: "first\nsecond", layer: [] }],
			text: "first\nsecond",
			confidence: null,
		});
	});

	it("counts ink that stays wordless at its own framing, for the diagnostics block", async () => {
		const pageRead = driverRead(["lower"], [{ x: 0, y: 0, w: 1, h: 0.1 }]);
		const { runBatch } = stubRunner([[pageRead], [readAll("")]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available, batchSize: 5 });

		await backend.recognize([twoLinePage()]);

		expect(visionRunStats.unreadableInkRegions).toBe(1);
	});

	/** Measured: Vision reads a crop best tight, and its rescue pass pads what that missed. */
	it("reads a margin note tight first, as it reads a page", async () => {
		const runBatch = vi.fn(async (images: Uint8Array[]) => images.map(() => readAll("Nachfragen")));
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		await (backend as OcrBackend).recognize([page()], undefined, "note");

		expect(runBatch.mock.calls[0][0][0]).toEqual(encodeGrayscalePng(rasterizePage(page())));
	});

	it("reports failed and never throws when the runner throws (Vision cannot run)", async () => {
		const runBatch = vi.fn().mockRejectedValue(new Error("spawn EACCES"));
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		expect(await backend.recognize([page()])).toEqual({ status: "failed", pages: null, text: "", confidence: null });
	});
});

// The boxes a text layer is placed on when another backend wrote the words (searchable-pdf spec §2.1).
describe("VisionOcrBackend.readLayer", () => {
	const WORDS = { lines: ["Rapoldeck Hütte"], boxes: [{ x: 0, y: 0, w: 1, h: 1 }], words: [[{ text: "Rapoldeck", box: { x: 0, y: 0, w: 0.6, h: 1 } }, { text: "Hütte", box: null }]], revision: 3 };

	// The second page reads as nothing, which `recognize` would answer with a rescue pass.
	it("reads each page's lines and word boxes off one page pass, no rescue and no typed text after it", async () => {
		const typed: RmPage = { ...page(), text: { posX: 0, posY: 0, width: 800, runs: [{ id: "1:1", text: "typed", deleted: 0 }], styles: new Map() } };
		const { runBatch, batchSizes } = stubRunner([[WORDS, { lines: [], boxes: [], words: [], revision: 3 }, { error: "unreadable_image" }]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		expect(await backend.readLayer([typed, page(), page()])).toEqual([[{ box: WORDS.boxes[0], words: WORDS.words[0] }], [], null]);
		expect(batchSizes).toEqual([3]);
	});

	it.each([
		["Vision cannot run here", { runBatch: vi.fn(), probe: () => Promise.resolve(false) }],
		["the runner throws", { runBatch: vi.fn().mockRejectedValue(new Error("spawn EACCES")), probe: available }],
	])("has no boxes for any page when %s, and never throws", async (_case, options) => {
		expect(await new VisionOcrBackend(options).readLayer([page(), page()])).toEqual([null, null]);
	});

	it("reads nothing for no pages", async () => {
		const runBatch = vi.fn();

		expect(await new VisionOcrBackend({ runBatch, probe: available }).readLayer([])).toEqual([]);
		expect(runBatch).not.toHaveBeenCalled();
	});
});

describe("UnavailableOcrBackend", () => {
	it("skips an empty page list and reports unavailable otherwise, carrying the chosen id", async () => {
		const backend = new UnavailableOcrBackend("openai");

		expect(backend.id).toBe("openai");
		expect(await backend.recognize([])).toEqual({ status: "skipped", pages: [], text: "", confidence: null });
		expect(await backend.recognize([page()])).toEqual({ status: "unavailable", pages: null, text: "", confidence: null });
	});
});
