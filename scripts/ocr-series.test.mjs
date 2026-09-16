import { describe, expect, it } from "vitest";
import { localRows, toCsv, toRows, traitsFromFilenames } from "./ocr-series.mjs";

const traits = traitsFromFilenames(["01-clean-prose-de.md", "07-mixed-language.md", "13-corrections-de.md"]);

const night = (measuredAt, pages, extra = {}) => ({
	runId: "run-1",
	parts: { ocr: { status: "pass", measuredAt, detail: { promptSha: "abc123", renderVersion: 31, backends: { "openrouter/anthropic/claude-sonnet-5": { status: "pass", pages } } } } },
	...extra,
});

describe("the published series", () => {
	it("skips a night that produced no backends -- an unmeasured night is not a night of zeros", () => {
		const unknown = { runId: "run-0", parts: { ocr: { status: "unknown", measuredAt: "2026-08-19T03:00:00Z", detail: {} } } };
		expect(toRows([unknown, night("2026-08-20T03:00:00Z", { "01": { cer: 0 } })], traits)).toHaveLength(1);
	});

	it("contributes a run's pages once, however often the verdict was committed", () => {
		const once = night("2026-08-20T03:00:00Z", { "01": { cer: 0.01 } });
		expect(toRows([once, structuredClone(once)], traits)).toHaveLength(1);
	});

	it("writes the fraction as measured, names a problem in place of a number, and flattens the structure verdicts", () => {
		const rows = toRows(
			[night("2026-08-20T03:00:00Z", { "01": { cer: 0.0011890606420927466, structure: { table: "ok", list: "lost" } }, "13": { cer: null, problem: "empty-output" } })],
			traits,
		);
		expect(rows[0]).toMatchObject({ page: "01", cer: "0.001189", problem: "", structure: "table:ok;list:lost" });
		expect(rows[1]).toMatchObject({ page: "13", cer: "", problem: "empty-output" });
	});

	// Recorded from 2026-09-09. The endpoint and the token counts are what make a routing change
	// visible in the series instead of hidden in it: unpinned, two providers of one model differed by
	// 1.40 points of median CER, and the prompt-token count was the only thing that said why.
	it("carries the request envelope, and leaves it empty for every night measured before it existed", () => {
		const withEnvelope = { cer: 0.02, envelope: { endpoint: "deepinfra/fp8", servedBy: "DeepInfra", promptTokens: 373, completionTokens: 126, reasoningTokens: 0, cost: 0.000196 } };
		const rows = toRows([night("2026-08-20T03:00:00Z", { "01": withEnvelope, "13": { cer: 0.18 } })], traits);

		expect(rows[0]).toMatchObject({ endpoint: "deepinfra/fp8", served_by: "DeepInfra", prompt_tokens: 373, reasoning_tokens: 0, cost: "0.00019600" });
		expect(rows[1]).toMatchObject({ endpoint: "", served_by: "", prompt_tokens: "", reasoning_tokens: "", cost: "" });
	});

	it("names each page's trait from the reference filenames, and carries the two fields that separate a jump from a regression", () => {
		const [row] = toRows([night("2026-08-20T03:00:00Z", { "13": { cer: 0.18 } })], traits);
		expect(row).toMatchObject({ trait: "corrections", prompt_sha: "abc123", render_version: 31 });
		expect(traits["07"]).toBe("mixed-language");
		expect(toCsv([row]).split("\n")[1]).toContain(",corrections,0.180000,");
	});
	// Nobody hosts the models a laptop can run, so their rows come from a Mac rather than from a
	// night; the series carries them under their own backend name, with the runtime where an
	// endpoint would be and the machine where a provider would.
	it("appends the local figures as rows of their own backend, with the runtime and the machine in place of an endpoint and a provider", () => {
		const figure = {
			measuredAt: "2026-09-16T10:00:00.000Z", generation: "qwen3-vl-8b-instruct-q4_k_m", runtime: "b10295",
			machine: { cpu: "Apple M2 Max", memoryGb: 64, os: "macOS 26.5.2" }, promptSha: "abc123", renderVersion: 31, status: "pass",
			pages: { "13": { cer: 0.159, structure: {}, ms: 9000, peakRssBytes: 1 }, "01": { cer: 0.014, structure: { list: "ok" }, ms: 8000, peakRssBytes: 1 } },
		};
		const rows = localRows([figure], traits);
		expect(rows.map((r) => r.page)).toEqual(["01", "13"]);
		expect(rows[1]).toMatchObject({ backend: "local/qwen3-vl-8b-instruct-q4_k_m", run_id: "", trait: "corrections", cer: "0.159000", endpoint: "llama.cpp b10295", served_by: "Apple M2 Max · 64 GB · macOS 26.5.2", prompt_tokens: "", cost: "" });
		expect(toCsv(rows).split("\n")[1]).not.toMatch(/"/);
	});
});
