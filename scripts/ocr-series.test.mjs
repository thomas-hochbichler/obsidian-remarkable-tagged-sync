import { describe, expect, it } from "vitest";
import { toCsv, toRows, traitsFromFilenames } from "./ocr-series.mjs";

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

	it("names each page's trait from the reference filenames, and carries the two fields that separate a jump from a regression", () => {
		const [row] = toRows([night("2026-08-20T03:00:00Z", { "13": { cer: 0.18 } })], traits);
		expect(row).toMatchObject({ trait: "corrections", prompt_sha: "abc123", render_version: 31 });
		expect(traits["07"]).toBe("mixed-language");
		expect(toCsv([row]).split("\n")[1]).toContain(",corrections,0.180000,");
	});
});
