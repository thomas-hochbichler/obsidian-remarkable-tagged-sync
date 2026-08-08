import { describe, expect, it, vi } from "vitest";
import { classifyRun, type FinishedRun, LocalOcrBackend, type LocalPageOutcome } from "./local-ocr-backend";
import { ENOUGH_PAGES_TO_MEASURE, readLocalModelSettings } from "./local-model-settings";
import type { RmPage } from "./rm-parser";

/** A page with one stroke, which is all the rasterizer needs to produce an image. */
function page(typed?: string): RmPage {
	return {
		layers: [
			{
				id: "l",
				name: null,
				strokes: [
					{
						penType: 2,
						color: 0,
						width: 2,
						points: [
							{ x: 0, y: 0, speed: 0, direction: 0, width: 2, pressure: 1 },
							{ x: 10, y: 10, speed: 0, direction: 0, width: 2, pressure: 1 },
						],
					},
				],
			},
		],
		...(typed === undefined
			? {}
			: { text: { posX: -468, posY: 234, width: 936, runs: [{ id: "1:10", text: typed, deleted: 0 }], styles: new Map() } }),
	} as unknown as RmPage;
}

function textOutcome(text: string, durationMs = 14_900): LocalPageOutcome {
	return { kind: "text", text, durationMs };
}

function backendOver(outcomes: LocalPageOutcome[], blob: Record<string, unknown> = {}) {
	const runPage = vi.fn(async () => outcomes.shift() ?? textOutcome(""));
	return { backend: new LocalOcrBackend({ runPage, settings: blob }), runPage, blob };
}

describe("LocalOcrBackend", () => {
	it("skips an empty page set without spawning anything", async () => {
		const { backend, runPage } = backendOver([]);

		expect(await backend.recognize([])).toEqual({ status: "skipped", pages: [], text: "", confidence: null });
		expect(runPage).not.toHaveBeenCalled();
	});

	it("joins each page's transcript with a blank line", async () => {
		const { backend } = backendOver([textOutcome("# One"), textOutcome("- two")]);

		const result = await backend.recognize([page(), page()]);
		expect(result.status).toBe("ok");
		expect(result.text).toBe("# One\n\n- two");
	});

	/**
	 * One spawn per page, strictly sequential, nothing kept alive (§8.3). Two concurrent processes are
	 * 27 GB -- the same arithmetic that produced the lock.
	 */
	it("runs one page at a time", async () => {
		let inFlight = 0;
		let peak = 0;
		const runPage = vi.fn(async () => {
			peak = Math.max(peak, ++inFlight);
			await Promise.resolve();
			inFlight--;
			return textOutcome("x");
		});
		const backend = new LocalOcrBackend({ runPage, settings: {} });

		await backend.recognize([page(), page(), page()]);
		expect(runPage).toHaveBeenCalledTimes(3);
		expect(peak).toBe(1);
	});

	// Confidence is permanently null: the model reports none, and inventing one would put a fabricated
	// score in frontmatter.
	it("never reports a confidence", async () => {
		const { backend } = backendOver([textOutcome("a")]);

		expect((await backend.recognize([page()])).confidence).toBeNull();
	});
});

describe("failure mapping (§8.2)", () => {
	/**
	 * Case 1: the runtime will not start at all -> `unavailable`, and **the adapter remembers it for
	 * the rest of the run**. Otherwise it is 39 more pages of fans for 39 identical failures.
	 */
	it("returns unavailable and stops spawning once the runtime is broken", async () => {
		const { backend, runPage } = backendOver([{ kind: "runtime-broken", message: "spawn ENOENT" }]);

		const first = await backend.recognize([page(), page(), page()]);
		expect(first.status).toBe("unavailable");
		expect(runPage).toHaveBeenCalledTimes(1);

		const second = await backend.recognize([page(), page()]);
		expect(second.status).toBe("unavailable");
		expect(runPage).toHaveBeenCalledTimes(1);
	});

	// A broken runtime must never write a partial transcript: the sync skips an unchanged document
	// forever after, so half a note is permanent.
	it("keeps no text from a unit whose runtime died midway", async () => {
		const { backend } = backendOver([textOutcome("first page"), { kind: "runtime-broken", message: "killed" }]);

		const result = await backend.recognize([page(), page()]);
		expect(result.status).toBe("unavailable");
		expect(result.text).toBe("");
	});

	/**
	 * Case 2: one page fails while the runtime is healthy -> the other pages are kept and the unit is
	 * `ok`, following the Vision precedent -- **but with a line pushed into `skipErrors`**, which
	 * Vision does not do. Under §8.1, silently lost is permanently lost.
	 */
	it("keeps the good pages and reports the bad one", async () => {
		const { backend } = backendOver([textOutcome("kept"), { kind: "page-failed", message: "exit 1" }]);

		const result = await backend.recognize([page(), page()]);
		expect(result.status).toBe("ok");
		expect(result.text).toBe("kept");
		expect(result.warnings).toEqual([expect.stringContaining("page 2")]);
		expect(result.warnings?.[0]).toContain("exit 1");
	});

	/** Case 3: no page produced text and at least one errored -> `failed`. */
	it("fails a unit where every page errored", async () => {
		const { backend } = backendOver([{ kind: "page-failed", message: "exit 1" }]);

		const result = await backend.recognize([page()]);
		expect(result.status).toBe("failed");
		expect(result.warnings).toHaveLength(1);
	});

	// A genuinely blank page is not a failure; Vision reads it the same way.
	it("skips a unit whose pages were simply blank", async () => {
		const { backend } = backendOver([textOutcome(""), textOutcome("   ")]);

		expect((await backend.recognize([page(), page()])).status).toBe("skipped");
	});

	it("probes again on the next sync, because the adapter is built per run", async () => {
		const broken = backendOver([{ kind: "runtime-broken", message: "gone" }]);
		await broken.backend.recognize([page()]);

		const fresh = backendOver([textOutcome("back")]);
		expect((await fresh.backend.recognize([page()])).status).toBe("ok");
	});
});

describe("typed text", () => {
	/**
	 * The rasterizer draws ink, so text the user typed on the page is not in the image at all. Vision
	 * splices it in at each line's box; this backend reads one image per invocation and is given no
	 * boxes, so it appends per page -- exactly as the Pro providers do. Dropping it would silently
	 * lose the user's own words.
	 */
	it("appends the page's typed text to that page's transcript", async () => {
		const { backend } = backendOver([textOutcome("handwritten")]);

		const result = await backend.recognize([page("typed on the device")]);
		expect(result.text).toContain("handwritten");
		expect(result.text).toContain("typed on the device");
	});

	// Typed text is exact digital text; a page with nothing but typing still has content.
	it("keeps a page that holds only typed text", async () => {
		const { backend } = backendOver([textOutcome("")]);

		const result = await backend.recognize([page("only typing")]);
		expect(result.status).toBe("ok");
		expect(result.text).toBe("only typing");
	});
});

describe("timing", () => {
	it("records each page's duration into the live settings blob", async () => {
		const blob: Record<string, unknown> = {};
		const { backend } = backendOver([textOutcome("a", 12_000), textOutcome("b", 16_000)], blob);

		await backend.recognize([page(), page()]);
		expect(readLocalModelSettings(blob).recentPageMs).toEqual([12_000, 16_000]);
	});

	it("times only the pages that produced something", async () => {
		const blob: Record<string, unknown> = {};
		const { backend } = backendOver([{ kind: "page-failed", message: "no" }, textOutcome("b", 16_000)], blob);

		await backend.recognize([page(), page()]);
		expect(readLocalModelSettings(blob).recentPageMs).toEqual([16_000]);
	});

	it("keeps the window bounded across many pages", async () => {
		const blob: Record<string, unknown> = {};
		const outcomes = Array.from({ length: ENOUGH_PAGES_TO_MEASURE + 4 }, () => textOutcome("x"));
		const { backend } = backendOver(outcomes, blob);

		await backend.recognize(outcomes.map(() => page()));
		expect(readLocalModelSettings(blob).recentPageMs).toHaveLength(ENOUGH_PAGES_TO_MEASURE);
	});
});

describe("classifyRun", () => {
	function run(overrides: Partial<FinishedRun> = {}): FinishedRun {
		return { code: 0, timedOut: false, stdout: "a transcript", stderr: "", executablePresent: true, ...overrides };
	}

	it("reads a clean exit as the page's text", () => {
		expect(classifyRun(run())).toEqual({ kind: "text", text: "a transcript", durationMs: 0 });
	});

	/**
	 * The defect the release gate found, and the reason this function exists.
	 *
	 * A page that hit the ten-minute timer was read as case 1, which throws the whole document away,
	 * remembers the runtime as broken and returns `unavailable` for every further unit of the sync. The
	 * run that found it had already transcribed six pages, so the runtime was demonstrably healthy --
	 * and the same page took 7.3 s on the next attempt.
	 */
	it("reads a timeout as one slow page, never as a broken runtime", () => {
		const outcome = classifyRun(run({ code: null, timedOut: true, stdout: "" }));

		expect(outcome.kind).toBe("page-failed");
	});

	// §8.2 case 1: a missing MSVC redistributable fails exactly this silently.
	it("reads an immediate exit with nothing on stdout as a runtime that cannot run here", () => {
		const outcome = classifyRun(run({ code: 1, stdout: "", stderr: "The code execution cannot proceed" }));

		expect(outcome.kind).toBe("runtime-broken");
		expect(outcome.kind === "runtime-broken" && outcome.message).toContain("The code execution cannot proceed");
	});

	it("keeps a non-zero exit that still wrote something to case 2", () => {
		expect(classifyRun(run({ code: 3 })).kind).toBe("page-failed");
	});

	// §5.7: antivirus takes the 12 MB engine and can do it between two pages of one sync.
	it("reads a vanished executable as the removed engine, whatever the exit looked like", () => {
		for (const extra of [{ code: 1, stdout: "" }, { code: null, timedOut: true, stdout: "" }, { code: 3 }]) {
			expect(classifyRun(run({ ...extra, executablePresent: false })).kind).toBe("runtime-broken");
		}
	});
});
