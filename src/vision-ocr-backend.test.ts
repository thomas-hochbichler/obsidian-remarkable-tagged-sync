import { describe, expect, it, vi } from "vitest";
import { chunk, mapWithConcurrency, UnavailableOcrBackend, type VisionBatchResult, VisionOcrBackend } from "./vision-ocr-backend";
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

const available = () => Promise.resolve(true);

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

describe("VisionOcrBackend", () => {
	it("skips an empty page list without probing or spawning", async () => {
		const probe = vi.fn(available);
		const runBatch = vi.fn();
		const backend = new VisionOcrBackend({ runBatch, probe });

		expect(await backend.recognize([])).toEqual({ status: "skipped", text: "", confidence: null });
		expect(probe).not.toHaveBeenCalled();
		expect(runBatch).not.toHaveBeenCalled();
	});

	it("returns unavailable, without spawning, when the probe fails", async () => {
		const runBatch = vi.fn();
		const backend = new VisionOcrBackend({ runBatch, probe: () => Promise.resolve(false) });

		expect(await backend.recognize([page()])).toEqual({ status: "unavailable", text: "", confidence: null });
		expect(runBatch).not.toHaveBeenCalled();
	});

	it("probes only once across many recognize calls", async () => {
		const probe = vi.fn(available);
		const { runBatch } = stubRunner([[{ text: "a" }], [{ text: "b" }]]);
		const backend = new VisionOcrBackend({ runBatch, probe });

		await backend.recognize([page()]);
		await backend.recognize([page()]);

		expect(probe).toHaveBeenCalledTimes(1);
	});

	it("recognizes pages and joins per-page text with a blank line, confidence null", async () => {
		const { runBatch } = stubRunner([[{ text: "page one" }, { text: "page two" }]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		const result = await backend.recognize([page(), page()]);

		expect(result).toEqual({ status: "ok", text: "page one\n\npage two", confidence: null });
	});

	it("batches pages per process and caps parallelism", async () => {
		const results = [
			[{ text: "1" }, { text: "2" }],
			[{ text: "3" }, { text: "4" }],
			[{ text: "5" }],
		];
		const { runBatch, batchSizes } = stubRunner(results);
		const backend = new VisionOcrBackend({ runBatch, probe: available, batchSize: 2, maxParallelism: 8 });

		const result = await backend.recognize([page(), page(), page(), page(), page()]);

		expect(batchSizes).toEqual([2, 2, 1]);
		expect(result.text).toBe("1\n\n2\n\n3\n\n4\n\n5");
	});

	it("reports skipped (blank), not failed, when Vision runs but finds no text", async () => {
		const { runBatch } = stubRunner([[{ text: "" }, { text: "   " }]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		expect(await backend.recognize([page(), page()])).toEqual({ status: "skipped", text: "", confidence: null });
	});

	it("reports failed when an image errored and no text came back", async () => {
		const { runBatch } = stubRunner([[{ error: "unreadable_image" }, { text: "" }]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		expect(await backend.recognize([page(), page()])).toEqual({ status: "failed", text: "", confidence: null });
	});

	it("keeps good text even when a sibling image errored", async () => {
		const { runBatch } = stubRunner([[{ text: "kept" }, { error: "unreadable_image" }]]);
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		expect(await backend.recognize([page(), page()])).toEqual({ status: "ok", text: "kept", confidence: null });
	});

	it("reports failed and never throws when the runner throws (Vision cannot run)", async () => {
		const runBatch = vi.fn().mockRejectedValue(new Error("spawn EACCES"));
		const backend = new VisionOcrBackend({ runBatch, probe: available });

		expect(await backend.recognize([page()])).toEqual({ status: "failed", text: "", confidence: null });
	});
});

describe("UnavailableOcrBackend", () => {
	it("skips an empty page list and reports unavailable otherwise, carrying the chosen id", async () => {
		const backend = new UnavailableOcrBackend("openai");

		expect(backend.id).toBe("openai");
		expect(await backend.recognize([])).toEqual({ status: "skipped", text: "", confidence: null });
		expect(await backend.recognize([page()])).toEqual({ status: "unavailable", text: "", confidence: null });
	});
});
