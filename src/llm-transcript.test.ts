// These three used to live in `pro/` and were only exercised by `pro/llm-transcript.test.ts`, which
// `npm test` does not run. The free build's local model backend now depends on all three, so they
// need coverage in the suite that actually gates this repo.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	isUnreachable,
	LLM_MAX_PARALLELISM,
	NOTE_TRANSCRIPTION_PROMPT,
	pageCount,
	DIAGRAM_PROMPT,
	pagePrompt,
	placeDiagram,
	PLAIN_TRANSCRIPTION_PROMPT,
	readAgain,
	refusalDetail,
	repairMermaid,
	sanitizeTranscript,
	splitAtTypedText,
	TRANSCRIPTION_PROMPT,
	transcribePages,
	splitTallInk,
	upperFirst,
} from "./llm-transcript";
import { NOTE_PADDING_PX } from "./ocr-backend";
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

	// Research 31: without these a model wrote every Bullet Journal sign as "- ", and a migrated task
	// read as open; boxes and strike-through went missing as well.
	it("keeps what the writer marked: strike-through, boxes, and the sign a line starts with", () => {
		expect(TRANSCRIPTION_PROMPT).toContain("Write struck-through text as ~~text~~");
		expect(TRANSCRIPTION_PROMPT).toContain("- [ ] when it is empty and as - [x] when it holds a tick or a cross");
		expect(TRANSCRIPTION_PROMPT).toContain("Copy the sign a line starts with exactly as drawn: • X > < ○ —.");
	});

	// Ticket 43: the user's signs replace the fixed list, and the sign takes the list marker's place
	// (ticket 42's "- - "). An empty table is the measured prompt, unchanged.
	it("copies the user's signs, in place of the list marker", () => {
		expect(pagePrompt([])).toBe(TRANSCRIPTION_PROMPT);
		expect(TRANSCRIPTION_PROMPT).not.toContain("list marker");

		const prompt = pagePrompt([
			{ glyph: "★", meaning: "custom", text: "important" },
			{ glyph: "△", drawn: "a small triangle", meaning: "custom", text: "an idea" },
			{ glyph: " ", meaning: "note" },
		]);
		expect(prompt).toContain("Copy the sign a line starts with exactly as drawn: ★, △ for a small triangle. ");
		expect(prompt).toContain("The sign stands in place of the list marker: write ★ text, never - ★ text; a list line without a sign starts with - as usual.");
		expect(prompt).not.toContain("• X > < ○ —");
		// The example shows the sign alone, never its look.
		expect(pagePrompt([{ glyph: "•", drawn: "a dot", meaning: "task-open" }])).toContain("write • text, never - • text;");
		expect(prompt.startsWith(PLAIN_TRANSCRIPTION_PROMPT)).toBe(true);
		expect(prompt).toContain("Every line of text outside the diagram is transcribed as usual, none left out.");
	});

	// Ticket 38: words joined by drawn lines came out as loose lines that read like sentences.
	it("writes a drawn diagram as a Mermaid flowchart, and nothing else as one", () => {
		expect(TRANSCRIPTION_PROMPT).toContain("as a Mermaid flowchart in a ```mermaid block");
		expect(TRANSCRIPTION_PROMPT).toContain("Add no node, edge or label that is not drawn.");
		expect(TRANSCRIPTION_PROMPT).toContain("Lines, boxes, brackets and underlines that do not join words are not a diagram.");
		expect(TRANSCRIPTION_PROMPT).toContain("Every line of text outside the diagram is transcribed as usual, none left out.");
		expect(PLAIN_TRANSCRIPTION_PROMPT).not.toContain("Mermaid");
	});

	// One prompt, shared verbatim by the six Pro providers and the free local model. A second copy
	// that drifts would silently regress whichever build owns it.
	it("is one string, not a template", () => {
		expect(TRANSCRIPTION_PROMPT).not.toContain("${");
	});
});

describe("what a margin note is sent with", () => {
	/**
	 * The CHANGELOG quotes a measurement of exactly this pair: 6.7 % median CER over the reference set's
	 * 180 line crops, against 18.0 % for what was sent before. No nightly reads a note, so nothing else
	 * notices when either moves and the figure goes on being quoted for something no longer shipped.
	 */
	it("is the prompt and padding the published figure was measured with", () => {
		const sha = createHash("sha256").update(`${NOTE_TRANSCRIPTION_PROMPT}\npadding ${NOTE_PADDING_PX}px`).digest("hex").slice(0, 16);

		expect(sha, "the note prompt or padding changed: measure the reference line crops again, then update the CHANGELOG figure and this hash").toBe("51872b7293c1a5ca");
	});
});

describe("the words a model backend's warning is made of", () => {
	it("counts pages, and leaves a margin note's count out", () => {
		expect(pageCount(1, "page")).toBe("1 page was");
		expect(pageCount(3, "page")).toBe("3 pages were");
		expect(pageCount(1, "note")).toBe("margin notes were");
		expect(upperFirst(pageCount(1, "note"))).toBe("Margin notes were");
	});

	// Re-transcribe refuses a PDF note with a digest, so naming it for a margin note sent the user to a
	// refusal -- and for a page added to the PDF, which the digest reads too.
	it("names the re-transcribe command for a page and never for a margin note or an added page", () => {
		expect(readAgain("page")).toBe('run "Re-transcribe all synced notes"');
		expect(readAgain("note")).not.toContain("Re-transcribe");
		expect(readAgain("note")).toBe("the next sync reads them again");
		expect(readAgain("added-page")).toBe("the next sync reads them again");
	});

	// An added page goes to the backend alone, as a margin note does, so its count was always 1 -- and
	// the warning is said once for the whole sync, of a PDF that may have lost five.
	it("leaves an added page's count out too", () => {
		expect(pageCount(1, "added-page")).toBe("pages added on the tablet were");
		expect(upperFirst(pageCount(1, "added-page"))).toBe("Pages added on the tablet were");
	});
});

// Ticket 38, 2026-10-14: asked for text and diagram at once, qwen3-vl-30b-a3b-instruct gave back only
// the diagram for the user's page 4 -- an open and a done task among the lines lost.
describe("the diagram in a request of its own", () => {
	it("leaves the diagram sentences out of the page prompt, and nothing else", () => {
		const text = pagePrompt([], false);
		expect(text).not.toContain("Mermaid");
		expect(text.endsWith("Transcribe exactly what is written; do not correct spelling or wording.")).toBe(true);
		expect(TRANSCRIPTION_PROMPT.startsWith(text)).toBe(true);
		expect(pagePrompt([])).toBe(TRANSCRIPTION_PROMPT);
		// The diagram prompt: quoted node words, a line with an arrow in it is text, nothing without a diagram.
		expect(DIAGRAM_PROMPT).toContain('A["words"]');
		expect(DIAGRAM_PROMPT).toContain("8k -> 16k, is text");
		expect(DIAGRAM_PROMPT).toContain("nothing at all when the page holds no diagram");
	});

	// The user's page 4 as the two requests would read it: the text with the diagram's words loose, and the diagram.
	const text = [
		"14/10/2026",
		"7:30h • CAIMAN loggin issue on PROD analyze",
		"× TARDIS icto registration on insa-test -> /HSR-7234",
		"",
		"CAIMAN PROD ISSUE",
		"login",
		"INSK Browser",
		"calls. callback",
		"",
		"Done today",
	].join("\n");
	const diagram = ["```mermaid", "graph TD", '    A["CAIMAN PROD ISSUE"] --> B["login"]', '    B --> C["INSK Browser"]', '    C -->|calls.| D["callback"]', "```"].join("\n");

	it("puts the diagram where its words stood, and keeps every other line where it was", () => {
		expect(placeDiagram(text, diagram)).toBe(
			["14/10/2026", "7:30h • CAIMAN loggin issue on PROD analyze", "× TARDIS icto registration on insa-test -> /HSR-7234", "", diagram, "", "Done today"].join("\n"),
		);
	});

	it("keeps the text as it is without a diagram, and puts a diagram whose words stand nowhere after it", () => {
		expect(placeDiagram(text, "")).toBe(text);
		expect(placeDiagram("- [ ] call Anna", diagram)).toBe(`- [ ] call Anna\n\n${diagram}`);
	});

	// Reference page 08, qwen3-vl-30b-a3b-instruct's text request, live 2026-10-14.
	it("takes a line of arrows alone between the diagram's words, and leaves one elsewhere and a divider", () => {
		const block = ["```mermaid", "graph LR", '    A["Gerät"] --> B["Abgleich"]', '    B --> C["Notiz"]', '    B --> D["Zwischenspeicher"]', "```"].join("\n");
		expect(placeDiagram("Abgab\n\nGerät → Abgleich → Notiz\n↓\nZwischenspeicher\n\n---\n\n↓ morgen\n→", block)).toBe(`Abgab\n\n${block}\n\n---\n\n↓ morgen\n→`);
	});

	// Qwen3-VL-8B in LM Studio, 2026-10-14: every line of a page with no diagram became a node, and only the block was left.
	it("trusts no diagram that copied the page's lines into its nodes, and never takes a list item or a task", () => {
		const page = ["13/10/2026", "- [x] IMSA-7232: Conjur → TARDIS Wipe Out Playground", "  - CICD auth problem", "× Analyse the CAIMAN 502 Login issue on PROD"].join("\n");
		const copied = ["```mermaid", "flowchart TD", '    A["X IMSA-7232: Conjur → TARDIS Wipe Out Playground"] --> B["- CICD auth problem"]', '    U["× Analyse the CAIMAN 502 Login issue on PROD"]', "```"].join("\n");
		expect(placeDiagram(page, copied)).toBe(page);
		const words = ["```mermaid", "graph TD", '    A["login"] --> B["Browser"]', "```"].join("\n");
		expect(placeDiagram("- login\nX Browser\nlogin\nBrowser", words)).toBe(`- login\nX Browser\n${words}`);
	});

	it("never takes a line with a word of its own, and takes a diagram drawn in a code fence whole", () => {
		const drawn = ["Plan", "```", "+-------+     +-------+", "| login | --> | INSK Browser |", "+-------+     +-------+", "```", "login again tomorrow"].join("\n");
		expect(placeDiagram(drawn, diagram)).toBe(["Plan", diagram, "login again tomorrow"].join("\n"));
	});
});

// 2026-10-14, the user's page: every node with a space, a dot or a tilde in its name broke the whole block
// ("Error parsing Mermaid diagram!"). Checked against Mermaid 11's own parser: fails as written, parses repaired.
describe("repairMermaid", () => {
	const block = (...lines: string[]) => ["```mermaid", ...lines, "```"].join("\n");

	it("names each node whose words Mermaid cannot take as a name, and keeps the words as written", () => {
		const page = block(
			"graph TD",
			"    login --> INS A Browser",
			"    CAIMAN ADMIN",
			"    INS A Browser --> calls.",
			"    calls. --> ~~k8s Nginx-Ingress~~",
			"    ~~k8s Nginx-Ingress~~ <--> api-gateway",
			"    bff -->|same secret| auth-code",
		);
		expect(repairMermaid(page)).toBe(
			block(
				"graph TD",
				'    login --> n1["INS A Browser"]',
				'    n2["CAIMAN ADMIN"]',
				'    n1["INS A Browser"] --> n3["calls."]',
				'    n3["calls."] --> n4["~~k8s Nginx-Ingress~~"]',
				'    n4["~~k8s Nginx-Ingress~~"] <--> n5["api-gateway"]',
				'    bff -->|same secret| n6["auth-code"]',
			),
		);
	});

	it("leaves a block that is already right, and a line it does not understand, as they are", () => {
		const right = block("flowchart LR", "    A[Einkauf] --- B(Milch)", "    %% a comment", "    subgraph Home", "    C --> D", "    end", "    --> dangling");
		expect(repairMermaid(right)).toBe(right);
	});

	it("never names a node after a reserved word or one the block already uses, and keeps a quote inside the words", () => {
		expect(repairMermaid(block("graph TD", "    n1 --> end", '    n1 --> say "hi"'))).toBe(block("graph TD", '    n1 --> n2["end"]', '    n1 --> n3["say #quot;hi#quot;"]'));
	});

	it("touches nothing outside a mermaid block, and is applied to every transcript", () => {
		expect(repairMermaid("a --> b c\n```js\nx --> y z\n```")).toBe("a --> b c\n```js\nx --> y z\n```");
		expect(sanitizeTranscript(block("graph TD", "    a b --> c"))).toBe(block("graph TD", '    n1["a b"] --> c'));
	});
});

describe("sanitizeTranscript", () => {
	// Qwen3.6-35B-A3B in LM Studio, 2026-10-14: the opening tag stays in the chat template, the
	// thinking and the closing tag come back as the answer.
	it("drops a model's reasoning, with or without its opening tag", () => {
		expect(sanitizeTranscript("The user wants the handwritten text transcribed.\n\n1. **Transcribe line by line:**\n</think>\n\n# Planung\n- a")).toBe("# Planung\n- a");
		expect(sanitizeTranscript("<think>\nIs it 2024 or 2026?\n</think>\n\n1.10.2026 Do")).toBe("1.10.2026 Do");
		// Reasoning and nothing after it: nothing of the page.
		expect(sanitizeTranscript("Hmm, the page is blank.\n</think>")).toBe("");
	});

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

	// Seen live on 2026-09-12 from a local model reading a one-word margin note: two hundred empty
	// "```text" blocks, then the word. An empty block carries nothing of the user's.
	it("drops empty fenced blocks wherever they are", () => {
		expect(sanitizeTranscript("```text\n```\n```text\n```\n\nTest")).toBe("Test");
		expect(sanitizeTranscript("- milk\n\n```\n\n```\n- eggs")).toBe("- milk\n\n- eggs");
	});

	// The second live shape, 2026-09-13: a stroke with no words in it came back as "```text" over
	// "``" -- an opener nothing closes, and a line of backticks. Neither is the user's.
	it("drops an opener no closer follows, and a line of nothing but backticks", () => {
		expect(sanitizeTranscript("```text\n``")).toBe("");
		expect(sanitizeTranscript("```text\nTest")).toBe("Test");
		expect(sanitizeTranscript("Notes\n```\n- a\n```")).toBe("Notes\n```\n- a\n```");
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

describe("splitTallInk on the pages that have no shape to judge", () => {
	function pageOf(strokes: RmStroke[]): RmPage {
		return { formatVersion: 6, layers: [{ id: "l", name: null, strokes }] } as unknown as RmPage;
	}
	function block(y: number, id: string): RmStroke {
		return { layerId: "l", id, timestamp: "1", penType: 0, color: 0, brushSize: 2, points: [{ x: 0, y }, { x: 800, y: y + 40 }] } as unknown as RmStroke;
	}

	// A typed-only page, or one whose layers are empty. There is no frame to measure, so there is
	// nothing to cut and nothing to decide.
	it("leaves a page with no ink on it alone", () => {
		const page = pageOf([]);

		expect(splitTallInk(page)).toEqual([page]);
	});

	// The cap is about cost, not about shape: a page nobody imagined must not quietly become twenty
	// requests. Read whole is exactly what it did before any of this, so it is never a regression --
	// only a page that was going to read badly reads badly still.
	it("sends a page needing more pieces than the cap allows as one image", () => {
		const strokes = Array.from({ length: 7 }, (_, i) => block(i * 3000, `b${i}`));

		expect(splitTallInk(pageOf(strokes)).length).toBeGreaterThan(6);
		expect(splitAtTypedText(pageOf(strokes))).toHaveLength(1);
	});
});

/**
 * Whether a tall page is cut is a property of the model that will read it, not of the page. Measured
 * on the reference set's scrolled page: GPT-4o 39.53 % -> 3.99 % and Qwen2.5-VL-7B 4.32 % -> 1.00 %,
 * against Qwen3-VL-2B 1.00 % -> 10.63 % the other way.
 */
describe("splitAtTypedText, for a model that reads a tall image natively", () => {
	function tallPage(): RmPage {
		const strokes = [0, 1000, 2000, 3000].map((y, i) => ({
			layerId: "l", id: `b${i}`, timestamp: "1", penType: 0, color: 0, brushSize: 2,
			points: [{ x: 0, y }, { x: 800, y: y + 40 }],
		}));
		return { formatVersion: 6, layers: [{ id: "l", name: null, strokes }] } as unknown as RmPage;
	}

	it("cuts by default, which is what every cloud backend and the two larger shipped models want", () => {
		expect(splitAtTypedText(tallPage()).length).toBeGreaterThan(1);
	});

	it("sends the page whole when the model says not to cut it", () => {
		const parts = splitAtTypedText(tallPage(), { splitTall: false });

		expect(parts).toHaveLength(1);
		expect(parts[0].kind === "ink" && parts[0].scene.layers[0].strokes).toHaveLength(4);
	});
	// The typed-text split and the tall-page split compose: a page with writing above and below a typed
	// block is cut on both axes, unless the model says not to cut for height.
	it("still splits at the typed text when it is not splitting for height", () => {
		const [line] = baselines("typed line");
		const page = pageWithInkAndText("typed line", [line - 3000, line + 3000]);

		const parts = splitAtTypedText(page, { splitTall: false });

		expect(parts.map((part) => part.kind)).toEqual(["ink", "typed", "ink"]);
	});
});
