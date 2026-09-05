import { describe, expect, it } from "vitest";
import { computePerfBaseline, perfNightFromVerdict } from "./perf-baseline.mjs";

function night(render, raster = 143, extra = {}) {
	return { measuredAt: "2026-08-26T03:05:00Z", page: "2000 strokes x 50 points", node: "v22.23.2", metrics: { renderPagesToPdfMs: render, rasterizePageMs: raster }, ...extra };
}

const fiveNights = [374, 379, 378, 391, 371].map((ms) => night(ms));
const existingAt = (ms, extra = {}) => ({ renderPagesToPdfMs: { ms, because: "first baseline", page: "2000 strokes x 50 points", node: "v22.23.2", ...extra }, rasterizePageMs: { ms: 143, because: "first baseline", page: "2000 strokes x 50 points", node: "v22.23.2" } });

describe("extracting a perf night from a committed verdict", () => {
	it("takes the two metrics from a measured night and refuses an unknown one", () => {
		const measured = { parts: { perf: { status: "pass", measuredAt: "t", detail: { metrics: { renderPagesToPdfMs: 374, rasterizePageMs: 143 }, page: "p", node: "v22" } } } };
		expect(perfNightFromVerdict(measured)).toEqual({ measuredAt: "t", page: "p", node: "v22", metrics: { renderPagesToPdfMs: 374, rasterizePageMs: 143 } });
		expect(perfNightFromVerdict({ parts: { perf: { status: "unknown", measuredAt: "t", detail: {} } } })).toBeNull();
		expect(perfNightFromVerdict({ parts: { ocr: { status: "pass" } } })).toBeNull();
	});
});

describe("the perf baseline computation (ticket 21)", () => {
	it("refuses a first baseline before five recorded nights exist", () => {
		const { entries, skipped } = computePerfBaseline({ nights: fiveNights.slice(0, 3), existing: {}, today: "2026-09-03" });
		expect(entries).toEqual({});
		expect(skipped[0]).toContain("has 3");
	});

	it("sets the first baseline as the median of the recorded nights, with spread and provenance", () => {
		const { entries } = computePerfBaseline({ nights: fiveNights, existing: {}, today: "2026-09-03" });
		expect(entries.renderPagesToPdfMs).toEqual({ ms: 378, spread: 20, setAt: "2026-09-03", nights: 5, page: "2000 strokes x 50 points", node: "v22.23.2", because: "first baseline" });
		expect(entries.rasterizePageMs.ms).toBe(143);
	});

	it("writes a falling metric silently -- a faster renderer is absorbed, like the other ratchets", () => {
		const { entries, refused } = computePerfBaseline({ nights: fiveNights, existing: existingAt(400), today: "2026-09-03" });
		expect(refused).toEqual([]);
		expect(entries.renderPagesToPdfMs.ms).toBe(378);
	});

	it("refuses a rising metric without --accept, and with --accept while page and node are unchanged", () => {
		const existing = existingAt(300);
		expect(computePerfBaseline({ nights: fiveNights, existing, today: "2026-09-03" }).refused[0]).toContain("would rise");
		const { entries, refused } = computePerfBaseline({ nights: fiveNights, existing, accepts: ["renderPagesToPdfMs"], because: "it got slower", today: "2026-09-03" });
		expect(refused[0]).toContain("nothing explains the raise");
		expect(entries.renderPagesToPdfMs.ms).toBe(300);
	});

	it("accepts a raise when the Node version changed and a reason is given", () => {
		const { entries, refused } = computePerfBaseline({ nights: fiveNights, existing: existingAt(300, { node: "v20.19.0" }), accepts: ["renderPagesToPdfMs"], because: "runner moved to Node 22", today: "2026-09-03" });
		expect(refused).toEqual([]);
		expect(entries.renderPagesToPdfMs.ms).toBe(378);
		expect(entries.renderPagesToPdfMs.because).toBe("runner moved to Node 22");
	});
});
