import { describe, expect, it } from "vitest";
import { renderSummary } from "./nightly-summary.mjs";

describe("the run summary table", () => {
	it("shows CER, baseline and delta per page, names problems, and surfaces a lost structure", () => {
		const part = {
			status: "degraded",
			detail: {
				backends: {
					"openrouter/openai/gpt-4o": {
						status: "degraded",
						reason: "page 05: CER above baseline",
						medianCer: 0.022,
						pages: {
							"05": { cer: 0.049, structure: { table: "lost" } },
							"09": { cer: null, structure: {}, problem: "empty-output" },
						},
					},
				},
			},
		};
		const summary = renderSummary(part, { "openrouter/openai/gpt-4o/05": { cer: 0.031 } });
		expect(summary).toContain("| 05 | 4.9 % | 3.1 % | +1.8 pp | table: lost |");
		expect(summary).toContain("| 09 | empty-output | — | — | — |");
		expect(summary).toContain("**median** | **2.2 %**");
	});
});
