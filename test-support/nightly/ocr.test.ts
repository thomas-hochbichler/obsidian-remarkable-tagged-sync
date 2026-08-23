import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyFailure, evaluateBackend, loadReferencePages, mergeBackendStatuses, type ReferencePage } from "./ocr";

const PAGES_DIR = join(process.cwd(), "test-fixtures", "ocr-reference", "pages");

function page(id: string, body: string): ReferencePage {
	return { id, trait: `t${id}`, body, alternates: [] };
}

describe("loading the reference pages", () => {
	it("loads the committed fourteen with their ids in order", () => {
		const pages = loadReferencePages(PAGES_DIR);
		expect(pages.map((p) => p.id)).toEqual(Array.from({ length: 14 }, (_, i) => String(i + 1).padStart(2, "0")));
		expect(pages.every((p) => p.body.length > 0)).toBe(true);
	});
});

describe("classifying a failed page (§4.4)", () => {
	it("treats a 400 as an abort -- our request shape was rejected, a real break", () => {
		expect(classifyFailure([400]).problem).toBe("abort");
	});

	it("treats auth, quota and server trouble as unavailable -- the provider could not answer tonight", () => {
		for (const status of [401, 402, 429, 500, 503]) {
			expect(classifyFailure([status]).problem).toBe("unavailable");
		}
	});

	it("treats a fetch that never got a status as unavailable, not as a break", () => {
		expect(classifyFailure([]).problem).toBe("unavailable");
	});
});

describe("evaluating a backend's night (§5.3)", () => {
	const ref = page("01", "Der Garten hinter dem Haus war lange Zeit sich selbst überlassen und wurde neu angelegt.");

	it("a clean transcription with no baseline is pass, with its CER measured", () => {
		const run = evaluateBackend([ref], new Map([["01", { text: ref.body }]]), {});
		expect(run.status).toBe("pass");
		expect(run.pages["01"].cer).toBe(0);
		expect(run.medianCer).toBe(0);
	});

	it("empty output is a catastrophe with no baseline needed -- the note silently loses its content", () => {
		const run = evaluateBackend([ref], new Map([["01", { text: "" }]]), {});
		expect(run.status).toBe("catastrophe");
		expect(run.pages["01"].problem).toBe("empty-output");
	});

	it("an aborted page is a catastrophe; an unavailable one is unknown and never blocks on its own", () => {
		expect(evaluateBackend([ref], new Map([["01", { failed: true, httpStatuses: [400] }]]), {}).status).toBe("catastrophe");
		expect(evaluateBackend([ref], new Map([["01", { failed: true, httpStatuses: [429] }]]), {}).status).toBe("unknown");
	});

	it("CER over twice the baseline blocks only together with the 5 pp floor -- one wrong word is Tuesday, not a catastrophe", () => {
		// A steady second page keeps the median aggregate out of the way; this test is the per-page rule.
		const steady = page("01", "Der Garten hinter dem Haus war lange Zeit sich selbst überlassen.");
		const short = page("09", "Ask again on Thursday.");
		const set = [steady, short];
		const baselines = { "01": { cer: 0.02 }, "09": { cer: 0.045 } };
		// 9.1 % against a 4.5 % baseline: over 2x but 4.6 pp under the 5 pp floor -> degraded.
		const drifted = evaluateBackend(set, new Map([["01", { text: steady.body }], ["09", { text: "Ask again on Tuesday." }]]), baselines);
		expect(drifted.status).toBe("degraded");
		// ~45 % against the same baseline: over 2x AND over the floor -> catastrophe.
		const broken = evaluateBackend(set, new Map([["01", { text: steady.body }], ["09", { text: "Ask later on some day." }]]), baselines);
		expect(broken.status).toBe("catastrophe");
	});

	it("a key with no baseline is degraded at worst -- a new model cannot block a release on its first night", () => {
		const run = evaluateBackend([ref], new Map([["01", { text: "Der Garten hinter dem Haus war völlig anders beschrieben als je zuvor gedacht." }]]), {});
		expect(run.status).toBe("pass");
	});

	it("a uniform doubling that trips no single page is caught by the median rule", () => {
		// Fourteen pages, each drifting from a 3 % baseline to ~6.5 % -- under the per-page floor.
		const bodies = Array.from({ length: 14 }, (_, i) =>
			page(String(i + 1).padStart(2, "0"), `Seite ${i} enthält einen längeren Satz mit vielen Wörtern, damit die Fehlerrate fein steuerbar bleibt und nicht springt.`),
		);
		const outcomes = new Map(
			bodies.map(
				(p) =>
					[
						p.id,
						{
							text: p.body
								.replace("enthält einen längeren", "enthaelt einem laengerem")
								.replace("vielen", "villen")
								.replace("springt", "sprinngt"),
						},
					] as const,
			),
		);
		const baseline = Object.fromEntries(bodies.map((p) => [p.id, { cer: 0.03 }]));
		const run = evaluateBackend(bodies, outcomes, baseline);
		expect(run.status).toBe("catastrophe");
		expect(run.reason).toContain("median");
	});
});

describe("merging backend statuses into the part", () => {
	it("the part carries the worst backend, and pass only when every backend passed", () => {
		const pass = { status: "pass" as const, pages: {}, medianCer: 0 };
		expect(mergeBackendStatuses({ a: pass, b: pass })).toBe("pass");
		expect(mergeBackendStatuses({ a: pass, b: { ...pass, status: "unknown" } })).toBe("unknown");
		expect(mergeBackendStatuses({ a: { ...pass, status: "catastrophe" }, b: { ...pass, status: "unknown" } })).toBe("catastrophe");
	});
});
