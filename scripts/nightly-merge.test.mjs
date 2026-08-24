import { describe, expect, it } from "vitest";
import { commitSubject, mergeParts } from "./nightly-merge.mjs";

const NOW = "2026-08-24T03:10:00.000Z";
const RUN = { commit: "abc", runId: "1", runUrl: "https://example/runs/1" };

describe("merging the part files into the verdict", () => {
	it("a job that did not report becomes unknown -- never last night's value wearing a fresh timestamp", () => {
		const verdict = mergeParts({ parts: {}, previous: null, now: NOW, run: RUN });
		expect(verdict.parts.ocr.status).toBe("unknown");
		expect(verdict.parts.ocr.detail.reason).toBe("job did not report");
		expect(verdict.parts.ocr.measuredAt).toBe(NOW);
	});

	it("a measured part stamps lastMeasuredAt with its own measuredAt", () => {
		const verdict = mergeParts({
			parts: { ocr: { status: "pass", measuredAt: NOW, detail: {} } },
			previous: null,
			now: NOW,
			run: RUN,
		});
		expect(verdict.parts.ocr.lastMeasuredAt).toBe(NOW);
	});

	it("an unknown part carries the previous lastMeasuredAt forward, so the gate's second clock keeps ticking", () => {
		const previous = {
			parts: { ocr: { status: "pass", measuredAt: "2026-08-23T03:10:00.000Z", lastMeasuredAt: "2026-08-23T03:10:00.000Z", detail: {} } },
		};
		const verdict = mergeParts({
			parts: { ocr: { status: "unknown", measuredAt: NOW, detail: {} } },
			previous,
			now: NOW,
			run: RUN,
		});
		expect(verdict.parts.ocr.lastMeasuredAt).toBe("2026-08-23T03:10:00.000Z");
		expect(verdict.parts.ocr.measuredAt).toBe(NOW);
	});

	it("a part that has never measured carries no lastMeasuredAt at all", () => {
		const verdict = mergeParts({ parts: {}, previous: null, now: NOW, run: RUN });
		expect("lastMeasuredAt" in verdict.parts.contract).toBe(false);
	});
});

describe("the commit subject", () => {
	it("carries the headline number, so git log --oneline is the drift curve at a glance", () => {
		const verdict = mergeParts({
			parts: {
				ocr: {
					status: "pass",
					measuredAt: NOW,
					detail: { backends: { "openai/gpt-4o": { status: "pass", pages: {}, medianCer: 0.039 } } },
				},
			},
			previous: null,
			now: NOW,
			run: RUN,
		});
		expect(commitSubject(verdict)).toBe("chore(nightly): contract unknown · ocr pass (median CER 3.9 %) · perf unknown [skip ci]");
	});

	it("carries the perf number too, so the render cost has its own drift curve in the log", () => {
		const verdict = mergeParts({
			parts: {
				perf: { status: "pass", measuredAt: NOW, detail: { metrics: { renderPagesToPdfMs: 209.8, rasterizePageMs: 94 } } },
			},
			previous: null,
			now: NOW,
			run: RUN,
		});
		expect(commitSubject(verdict)).toBe("chore(nightly): contract unknown · ocr unknown · perf pass (render 210 ms) [skip ci]");
	});
});
