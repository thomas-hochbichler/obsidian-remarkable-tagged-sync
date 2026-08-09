// These three used to live in `pro/` and were only exercised by `pro/llm-transcript.test.ts`, which
// `npm test` does not run. The free build's local model backend now depends on all three, so they
// need coverage in the suite that actually gates this repo.

import { describe, expect, it } from "vitest";
import { sanitizeTranscript, TRANSCRIPTION_PROMPT, typedText } from "./llm-transcript";
import type { RmPage } from "./rm-parser";

function pageWithText(text: string | null): RmPage {
	return {
		layers: [],
		...(text === null ? {} : { text: { posX: -468, posY: 234, width: 936, runs: [{ id: "1:10", text, deleted: 0 }], styles: new Map() } }),
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

describe("typedText", () => {
	/**
	 * Text the user typed on the device is not on the page image at all -- the rasterizer draws ink --
	 * and it must not go through the model either, being exact already.
	 */
	it("returns the typed text of each page", () => {
		expect(typedText([pageWithText("one"), pageWithText("two")])).toBe("one\n\ntwo");
	});

	it("skips pages with no typed text", () => {
		expect(typedText([pageWithText(null), pageWithText("only this"), pageWithText(null)])).toBe("only this");
		expect(typedText([pageWithText(null)])).toBe("");
		expect(typedText([])).toBe("");
	});
});
