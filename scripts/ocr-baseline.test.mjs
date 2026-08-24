import { describe, expect, it } from "vitest";
import { computeBaseline, nightFromVerdict } from "./ocr-baseline.mjs";

const KEY = "openrouter/openai/gpt-4o";

function night(cer, extra = {}) {
	return {
		measuredAt: "2026-08-24T03:05:00Z",
		promptSha: "abc123",
		renderVersion: 30,
		backends: { [KEY]: { model: "openai/gpt-4o", pages: { "06": cer } } },
		...extra,
	};
}

const fiveNights = [0.031, 0.03, 0.033, 0.029, 0.031].map((cer) => night(cer));

describe("extracting a night from a committed verdict", () => {
	it("takes the numbers from a measured night and refuses an unknown one", () => {
		const measured = {
			parts: {
				ocr: {
					status: "pass",
					measuredAt: "t",
					detail: { promptSha: "abc", renderVersion: 30, backends: { [KEY]: { model: "m", pages: { "01": { cer: 0.01 }, "02": { cer: null, problem: "empty-output" } } } } },
				},
			},
		};
		const nightData = nightFromVerdict(measured);
		expect(nightData.backends[KEY].pages).toEqual({ "01": 0.01 });
		expect(nightFromVerdict({ parts: { ocr: { status: "unknown", measuredAt: "t", detail: {} } } })).toBeNull();
	});
});

describe("the baseline computation (§5)", () => {
	it("refuses a first baseline before five recorded nights exist", () => {
		const { entries, skipped } = computeBaseline({ nights: fiveNights.slice(0, 3), existing: {}, today: "2026-08-28" });
		expect(entries).toEqual({});
		expect(skipped[0]).toContain("has 3");
	});

	it("sets the first baseline as the median of the recorded nights, with spread and provenance", () => {
		const { entries } = computeBaseline({ nights: fiveNights, existing: {}, today: "2026-08-28" });
		const entry = entries[`${KEY}/06`];
		expect(entry.cer).toBe(0.031);
		expect(entry.spread).toBeCloseTo(0.004, 10);
		expect(entry.nights).toBe(5);
		expect(entry.model).toBe("openai/gpt-4o");
		expect(entry.promptSha).toBe("abc123");
		expect(entry.because).toBe("first baseline");
	});

	it("writes a falling key silently -- improvement is absorbed, like the other ratchets", () => {
		const existing = { [`${KEY}/06`]: { cer: 0.05, because: "first baseline", model: "openai/gpt-4o", promptSha: "abc123", renderVersion: 30 } };
		const { entries, refused } = computeBaseline({ nights: fiveNights, existing, today: "2026-08-28" });
		expect(refused).toEqual([]);
		expect(entries[`${KEY}/06`].cer).toBe(0.031);
	});

	it("refuses a rising key without --accept", () => {
		const existing = { [`${KEY}/06`]: { cer: 0.01, because: "first baseline", model: "openai/gpt-4o", promptSha: "abc123", renderVersion: 30 } };
		const { entries, refused } = computeBaseline({ nights: fiveNights, existing, today: "2026-08-28" });
		expect(refused[0]).toContain("would rise");
		expect(entries[`${KEY}/06`].cer).toBe(0.01);
	});

	it("refuses --accept when model, promptSha and renderVersion are all unchanged -- the alias-swap case stays red", () => {
		const existing = { [`${KEY}/06`]: { cer: 0.01, because: "first baseline", model: "openai/gpt-4o", promptSha: "abc123", renderVersion: 30 } };
		const { refused } = computeBaseline({ nights: fiveNights, existing, accepts: [`${KEY}/06`], because: "it drifted", today: "2026-08-28" });
		expect(refused[0]).toContain("nothing explains the raise");
	});

	it("accepts a raise when the prompt changed and a reason is given", () => {
		const existing = { [`${KEY}/06`]: { cer: 0.01, because: "first baseline", model: "openai/gpt-4o", promptSha: "OLD", renderVersion: 30 } };
		const { entries, refused } = computeBaseline({ nights: fiveNights, existing, accepts: [`${KEY}/06`], because: "prompt rewritten for notation", today: "2026-08-28" });
		expect(refused).toEqual([]);
		expect(entries[`${KEY}/06`].cer).toBe(0.031);
		expect(entries[`${KEY}/06`].because).toBe("prompt rewritten for notation");
	});
});
