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

	it("shows the Vision part's text layer: words placed, found by PDFKit, on their box, and Vision's own word boxes", () => {
		const part = {
			status: "pass",
			detail: {
				backends: {},
				textLayer: { groundTruth: { words: 784, placed: 684, found: 684, onBox: 679 }, vision: { words: 742, ownBoxes: 700, placed: 742, found: 742, onBox: 737 } },
			},
		};
		const summary = renderSummary(part, {}, "Apple Vision");
		expect(summary).toContain("| ground truth on Vision's boxes | 684 of 784 (87.2 %) | 684 | 679 |");
		expect(summary).toContain("| Vision's own words (700 of 742 with a box of their own) | 742 | 742 | 737 |");
	});
});
