// These three used to live in `pro/` and were only exercised by `pro/llm-transcript.test.ts`, which
// `npm test` does not run. The free build's local model backend now depends on all three, so they
// need coverage in the suite that actually gates this repo.

import { describe, expect, it, vi } from "vitest";
import { isUnreachable, LLM_MAX_PARALLELISM, refusalDetail, sanitizeTranscript, splitAtTypedText, TRANSCRIPTION_PROMPT, transcribePages, splitTallInk } from "./llm-transcript";
import type { RmPage, RmStroke } from "./rm-parser";
import { inkBounds } from "./page-rasterizer";
import { layoutText } from "./text-layout";

function pageWithText(text: string | null): RmPage {
	return {
		layers: [],
		...(text === null ? {} : { text: { posX: -468, posY: 234, width: 936, runs: [{ id: "1:10", text, deleted: 0 }], styles: new Map() } }),
	} as unknown as RmPage;
}

/** The baselines `layoutText` gives this text, so a test can place a stroke above or below one. */
function baselines(text: string): number[] {
	return layoutText(pageWithText(text).text!).lines.filter((line) => line.text.trim() !== "").map((line) => line.yPx);
}

/** One stroke, flat, at the given height -- enough for `splitAtTypedText`, which reads y and nothing else. */
function strokeAt(y: number, id: string) {
	return { layerId: "l", id, timestamp: "1", penType: 0, color: 0, brushSize: 2, points: [{ x: 0, y }, { x: 10, y }] };
}

/** A page whose typed text sits between the given strokes, in the frame `layoutText` lays lines out in. */
function pageWithInkAndText(text: string, strokeYs: number[]): RmPage {
	return {
		...pageWithText(text),
		layers: [{ id: "l", name: null, strokes: strokeYs.map((y, i) => strokeAt(y, `s${i}`)) }],
	} as unknown as RmPage;
}

describe("TRANSCRIPTION_PROMPT", () => {
	/**
	 * Four alternatives were measured against this one and every one was equal or worse. The short
	 * literal arm produced zero headings on every page, lost all bullets on both non-linear pages, and
	 * looped at 836.8 % CER on the mind map. **The boilerplate is load-bearing**, so the pieces that
	 * carry the structure are pinned rather than left to a future tidy-up.
	 */
	it("keeps the clauses the measurement showed were doing the work", () => {
		expect(TRANSCRIPTION_PROMPT).toContain("clean Markdown");
		expect(TRANSCRIPTION_PROMPT).toContain("reading order");
		expect(TRANSCRIPTION_PROMPT).toContain("headings, lists, GFM task lists");
		expect(TRANSCRIPTION_PROMPT).toContain("Do not invent structure");
		// The defence against a commentary preamble is this sentence, not the sanitiser below.
		expect(TRANSCRIPTION_PROMPT).toContain("no commentary, preamble, code fences, or page labels");
	});

	// Every backend sends exactly one image now -- the local model always did, and the cloud adapters
	// joined it so the page boundary comes from the request rather than from the model's goodwill.
	// The plural wording this replaced was already wrong for the local backend.
	it("addresses a single page image", () => {
		expect(TRANSCRIPTION_PROMPT).toContain("this page image");
		expect(TRANSCRIPTION_PROMPT).not.toContain("each of the following");
		// "No page labels" now means what it says: the sync engine attaches the page heading.
		expect(TRANSCRIPTION_PROMPT).not.toContain("separated by a blank line");
	});

	// One prompt, shared verbatim by the six Pro providers and the free local model. A second copy
	// that drifts would silently regress whichever build owns it.
	it("is one string, not a template", () => {
		expect(TRANSCRIPTION_PROMPT).not.toContain("${");
	});
});

describe("sanitizeTranscript", () => {
	it("strips a tight preamble line", () => {
		expect(sanitizeTranscript("Here is the transcript:\n\n# Title")).toBe("# Title");
		expect(sanitizeTranscript("Here are the transcription\n- a")).toBe("- a");
	});

	// Not even the plural. Widening it is how a sanitiser starts eating real first lines, and the
	// prompt is what stops a preamble arriving in the first place.
	it("is tight enough to miss a near-match", () => {
		expect(sanitizeTranscript("Here are the transcriptions\n- a")).toBe("Here are the transcriptions\n- a");
	});

	/**
	 * It matches only *"Here is the transcript"* and nothing looser, and that is the point: the
	 * defence against a descriptive preamble is the prompt, not this. Anyone who widens the pattern
	 * here starts eating the user's first line.
	 */
	it("leaves a descriptive preamble alone", () => {
		const descriptive = "This page contains a shopping list.\n\n- milk";
		expect(sanitizeTranscript(descriptive)).toBe(descriptive);
	});

	it("unwraps an outer markdown fence", () => {
		expect(sanitizeTranscript("```markdown\n# Title\n```")).toBe("# Title");
		expect(sanitizeTranscript("```\n# Title\n```")).toBe("# Title");
	});

	// Biased to under-strip: a stray line is a cheap failure, corrupting a note is not.
	it("never touches a real code block the user wrote on the page", () => {
		const withCode = "Notes:\n\n```python\nprint(1)\n```\n\nmore";
		expect(sanitizeTranscript(withCode)).toBe(withCode);
		expect(sanitizeTranscript("```python\nprint(1)\n```")).toBe("```python\nprint(1)\n```");
	});

	it("survives an empty response", () => {
		expect(sanitizeTranscript("")).toBe("");
		expect(sanitizeTranscript("   \n  ")).toBe("");
	});
});

/**
 * Text the user typed on the device is not on the page image at all -- the rasterizer draws ink --
 * and it must not go through the model either, being exact already. Where it lands is what these
 * pin: it used to be appended after the model's answer, so a page with handwriting above and below
 * a typed block read back with the block last.
 */
describe("splitAtTypedText", () => {
	function typedOf(parts: ReturnType<typeof splitAtTypedText>): string[] {
		return parts.map((part) => (part.kind === "typed" ? part.text : "<ink>"));
	}

	it("leaves a page with no typed text as one scene, so it stays one request", () => {
		const parts = splitAtTypedText(pageWithInkAndText("", [100]));

		expect(typedOf(parts)).toEqual(["<ink>"]);
		expect(parts[0].kind === "ink" && parts[0].scene.layers[0].strokes).toHaveLength(1);
	});

	// The reported shape (115 Test, 2026-09-05): "END OF PAGE 1" written under the typed block came
	// back in the middle of page 1, because the block was appended after the whole page's answer.
	it("puts a typed block between the ink above it and the ink below it", () => {
		const [line] = baselines("typed line");
		const parts = splitAtTypedText(pageWithInkAndText("typed line", [line - 50, line + 50]));

		expect(typedOf(parts)).toEqual(["<ink>", "typed line", "<ink>"]);
		const above = parts[0].kind === "ink" ? parts[0].scene.layers[0].strokes : [];
		const below = parts[2].kind === "ink" ? parts[2].scene.layers[0].strokes : [];
		expect(above.map((s) => s.id)).toEqual(["s0"]);
		expect(below.map((s) => s.id)).toEqual(["s1"]);
	});

	// One request, and the order the page reads in -- the append this replaces put it the other way.
	it("puts the typed block first when all of the ink is below it", () => {
		const parts = splitAtTypedText(pageWithInkAndText("typed line", [baselines("typed line")[0] + 50]));

		expect(typedOf(parts)).toEqual(["typed line", "<ink>"]);
	});

	// A stroke that spans the typed text -- a box drawn round it, an arrow across it -- goes whole
	// into the slot its *middle* is in. Wrong half, never two half-glyphs. The stroke here starts above
	// the typed line and runs well past it, so an edge would file it above and the middle files it
	// below; that is the difference this pins.
	it("assigns a stroke that spans the typed text by its middle, rather than cutting it", () => {
		const [line] = baselines("typed line");
		const spanning = { layerId: "l", id: "span", timestamp: "1", penType: 0, color: 0, brushSize: 2, points: [{ x: 0, y: line - 20 }, { x: 0, y: line + 200 }] };
		const page = {
			...pageWithText("typed line"),
			layers: [{ id: "l", name: null, strokes: [strokeAt(line - 100, "above"), spanning] }],
		} as unknown as RmPage;

		const parts = splitAtTypedText(page);

		expect(parts.map((part) => (part.kind === "typed" ? part.text : "<ink>"))).toEqual(["<ink>", "typed line", "<ink>"]);
		const above = parts[0].kind === "ink" ? parts[0].scene.layers[0].strokes : [];
		const below = parts[2].kind === "ink" ? parts[2].scene.layers[0].strokes : [];
		expect(above.map((stroke) => stroke.id)).toEqual(["above"]);
		expect(below.map((stroke) => stroke.id)).toEqual(["span"]);
	});

	// Past the cap the page is transcribed whole and its typed text appended -- what every page did
	// before this existed. A page nobody imagined must not quietly cost ten requests.
	it("falls back to one scene and an appended block past the request cap", () => {
		// Seven runs of ink around seven typed lines. The cap is six since a scrolled page became
		// splittable (page 15 of the reference set needs five pieces), so the fixture has to clear that.
		const text = "a\nb\nc\nd\ne\nf\ng";
		const lines = baselines(text);
		const parts = splitAtTypedText(pageWithInkAndText(text, lines.map((y, i) => (i === 0 ? y - 50 : (lines[i - 1] + y) / 2))));

		expect(parts.filter((part) => part.kind === "ink")).toHaveLength(1);
		expect(typedOf(parts)).toEqual(["<ink>", text]);
	});
});

describe("transcribePages over a page in parts", () => {
	// The page carries one status, as `OcrPageResult` and `unitStatus` have always given it. Assembling
	// what did read would mean either a backend emitting note markup or a second status per page, and a
	// failure here is nearly always systemic -- the next part would fail too.
	it("fails the whole page when a part fails, and does not ask for the parts after it", async () => {
		const [line] = baselines("typed line");
		const page = pageWithInkAndText("typed line", [line - 50, line + 50]);
		const run = vi.fn().mockResolvedValue({ kind: "failed" });

		const result = await transcribePages([page], run);

		expect(result.pages).toEqual([{ status: "failed", text: "" }]);
		expect(run).toHaveBeenCalledTimes(1);
	});

	// One tick per page, whatever the page cost in requests -- the bar's total is counted structurally
	// from the document's live pages, and a page that suddenly counts twice strands it short.
	it("ticks the progress bar once for a page it sent twice", async () => {
		const [line] = baselines("typed line");
		const page = pageWithInkAndText("typed line", [line - 50, line + 50]);
		const onPage = vi.fn();

		const result = await transcribePages([page], async () => ({ kind: "ok", text: "ink" }), undefined, onPage);

		expect(onPage).toHaveBeenCalledTimes(1);
		expect(result.pages?.[0].text).toBe("ink\n\ntyped line\n\nink");
	});
});

// Gap G22. `LLM_MAX_PARALLELISM` 4 -> 64 passed all 996 tests, because every test that transcribes
// injects its own runner and none of them ever counted what was in flight. Shipped, that is 64
// simultaneous requests to a paid provider on the first sync of a notebook -- a self-inflicted 429
// storm, on a key whose limits nobody here can reason about in advance.
describe("how many requests are in flight at once", () => {
	it("keeps to the conservative read of the vendors' own limits", async () => {
		// The constant and the behaviour, because a constant nothing reads is a number, not a default.
		expect(LLM_MAX_PARALLELISM).toBe(4);

		let inFlight = 0;
		let peak = 0;
		const pages: RmPage[] = Array.from({ length: 20 }, () => ({ formatVersion: 6, layers: [] }));

		await transcribePages(pages, async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 0));
			inFlight--;
			return { kind: "ok", text: "a page" };
		});

		expect(peak).toBe(LLM_MAX_PARALLELISM);
	});

	it("is not Vision's cap, and must not become it", async () => {
		// Vision's 8 governs local subprocesses with no rate limiter on the other end. Overloading one
		// constant for both would couple two unrelated tunings, and the coupling would only show up as
		// somebody else's provider returning 429.
		const { DEFAULT_MAX_PARALLELISM } = await import("./vision-ocr-backend");

		expect(LLM_MAX_PARALLELISM).not.toBe(DEFAULT_MAX_PARALLELISM);
	});
});

/**
 * The two helpers that turn a failed request into a sentence. They moved here from the
 * OpenAI-compatible backend when the Anthropic one gained the same three-cause chain (#116): both
 * report refusals now, and a second copy of a rule about response shapes is a rule that drifts.
 */
describe("refusalDetail", () => {
	const errorBody = (body: unknown): Response => ({ json: async () => body }) as unknown as Response;

	it("reads OpenAI's nested error message, which LM Studio and Ollama follow", async () => {
		expect(await refusalDetail(errorBody({ error: { message: "No models loaded" } }))).toBe(": No models loaded");
	});

	it("reads a bare string error, which is also in the wild", async () => {
		expect(await refusalDetail(errorBody({ error: "unauthorized" }))).toBe(": unauthorized");
	});

	/** The status speaks alone rather than putting a stringified object into a note. */
	it("says nothing for a body it does not recognise", async () => {
		expect(await refusalDetail(errorBody({ detail: "nope" }))).toBe("");
	});

	it("says nothing when the body is not JSON at all", async () => {
		const html = { json: async () => { throw new Error("<html>"); } } as unknown as Response;

		expect(await refusalDetail(html)).toBe("");
	});
});

describe("isUnreachable", () => {
	/**
	 * Matched on the text because Electron's fetch exposes no stable typed error, and deliberately
	 * loose in the harmless direction: a false positive says "is it running?" about a server that is,
	 * which costs a wrong hint. A false negative restores the silence this exists to end.
	 */
	it("recognises the ways a dead address announces itself", () => {
		for (const message of ["connect ECONNREFUSED 127.0.0.1:11434", "fetch failed", "socket hang up", "getaddrinfo ENOTFOUND box.local"]) {
			expect(isUnreachable(new Error(message)), message).toBe(true);
		}
	});

	it("does not call a server that answered badly unreachable", () => {
		expect(isUnreachable(new Error("Unexpected token < in JSON"))).toBe(false);
	});

	it("handles something thrown that is not an Error at all", () => {
		expect(isUnreachable("ECONNRESET")).toBe(true);
		expect(isUnreachable({ nope: true })).toBe(false);
	});
});

/**
 * A scrolled page is one very tall image, and every backend shrinks an image before reading it -- so
 * the writing arrives at a fraction of its legible size. Measured on the reference set's scrolled
 * page, cutting it at its blank bands: GPT-4o 50.17 % -> 4.32 %, Claude 11.30 % -> 8.31 %, Gemini
 * 3.65 % -> 1.33 %, the local model 4.32 % -> 1.00 %. Every backend improved and none regressed.
 */
describe("splitTallInk", () => {
	/** A stroke `height` tall at `y`, `width` wide -- enough for a function that reads x and y only. */
	function block(y: number, id: string, width = 800, height = 40): RmStroke {
		return { layerId: "l", id, timestamp: "1", penType: 0, color: 0, brushSize: 2, points: [{ x: 0, y }, { x: width, y: y + height }] } as unknown as RmStroke;
	}
	function pageOf(strokes: RmStroke[]): RmPage {
		return { formatVersion: 6, layers: [{ id: "l", name: null, strokes }] } as unknown as RmPage;
	}

	// The bracket is measured: the widest ordinary reference page reaches 2.08x its own width and the
	// scrolled one reaches 8.77x, so a gate at 3x has 44 % of clearance on one side and 192 % on the other.
	it("leaves an ordinary page exactly as it was, frame and all", () => {
		const page = pageOf([block(0, "a"), block(600, "b")]);

		const pieces = splitTallInk(page);

		expect(pieces).toEqual([page]);
		// Non-negotiable: `vision-ocr-backend.ts` normalises Vision's observation boxes against this
		// frame, so a frame that moved by a padding would make every cluster read as uncovered and
		// silently re-OCR the page cluster by cluster.
		expect(inkBounds(pieces[0])).toEqual(inkBounds(page));
	});

	it("cuts a tall page where no ink is, and divides no stroke", () => {
		const strokes = [block(0, "a"), block(1000, "b"), block(2000, "c"), block(3000, "d")];

		const pieces = splitTallInk(pageOf(strokes));

		expect(pieces.length).toBeGreaterThan(1);
		const ids = pieces.flatMap((piece) => piece.layers.flatMap((layer) => layer.strokes.map((s) => s.id)));
		// Every stroke, once, whole. A cut through the raster would hand the model two half-glyphs,
		// which is worse than the tall image it was meant to fix.
		expect(ids.sort()).toEqual(["a", "b", "c", "d"]);
	});

	// Cutting at every blank band would send one request per line: more expensive and no better read.
	it("puts neighbours back together while the piece stays a readable shape", () => {
		const tight = splitTallInk(pageOf([block(0, "a"), block(300, "b"), block(3000, "c"), block(3300, "d")]));

		expect(tight).toHaveLength(2);
		expect(tight[0].layers[0].strokes.map((s) => s.id)).toEqual(["a", "b"]);
	});

	it("returns the page itself when the cuts would produce only one piece", () => {
		const page = pageOf([block(0, "a"), block(120, "b"), block(240, "c")]);

		expect(splitTallInk(page)).toEqual([page]);
	});

	// A long stroke drawn early must not let a later one look isolated: the gap is measured from the
	// lowest ink so far, not from the previous stroke's own top.
	it("measures the gap from the lowest ink so far, not from the last stroke", () => {
		const pieces = splitTallInk(pageOf([block(0, "long", 800, 2600), block(500, "inside"), block(3000, "after")]));

		expect(pieces[0].layers[0].strokes.map((s) => s.id)).toEqual(["long", "inside"]);
	});
});
