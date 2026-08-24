import { describe, expect, it } from "vitest";
import { evaluatePerf } from "./perf";

const METRICS = { renderPagesToPdfMs: 210, rasterizePageMs: 94 };

describe("the perf part", () => {
	it("observes and passes while no baseline exists -- the first nights create the reference", () => {
		const run = evaluatePerf(METRICS, {});
		expect(run.status).toBe("pass");
		expect(run.reasons).toEqual([]);
	});

	it("passes inside the headroom, because a 9-17 % spread must never flap the gate", () => {
		const run = evaluatePerf(METRICS, { renderPagesToPdfMs: 180, rasterizePageMs: 80 });
		expect(run.status).toBe("pass");
	});

	it("degrades past 1.5x the baseline and names the metric with both numbers", () => {
		const run = evaluatePerf({ ...METRICS, renderPagesToPdfMs: 400 }, { renderPagesToPdfMs: 210, rasterizePageMs: 94 });
		expect(run.status).toBe("degraded");
		expect(run.reasons).toEqual(["renderPagesToPdfMs: 400 ms against baseline 210 ms"]);
	});

	it("stays quiet over the factor but under the absolute floor -- a 3 ms metric must not flap on scheduler noise", () => {
		const run = evaluatePerf({ ...METRICS, rasterizePageMs: 40 }, { renderPagesToPdfMs: 210, rasterizePageMs: 20 });
		expect(run.status).toBe("pass");
	});

	it("is silent about a faster night -- lowering the reference is the baseline script's reviewed change, never the gate's", () => {
		const run = evaluatePerf({ renderPagesToPdfMs: 100, rasterizePageMs: 40 }, { renderPagesToPdfMs: 210, rasterizePageMs: 94 });
		expect(run.status).toBe("pass");
		expect(run.reasons).toEqual([]);
	});
});
