import { describe, expect, it } from "vitest";
import { pageText, type ReuseCandidate, reusableTranscripts, type StoredPage, transcriptFingerprint, transcriptSections } from "./transcript-store";

// The reader half of the per-page transcript store (issue #117). Everything here answers one
// question: may this page keep the text the note already holds for it? The tie-breaker the whole
// feature was decided under is that a wrong transcript is undetectable and permanent while a wasted
// request costs seconds -- so every ambiguous case below must come out as "read it again".

const EMBED = "tagged-sync/attachments/doc-1.pdf";
const heading = (label: number) => `### [[${EMBED}#page=${label}|Page ${label}]]`;

/** A transcript region in the exact shape `renderTranscript` writes for a multi-page unit. */
function region(...sections: string[]): string {
	return sections.join("\n\n");
}

const FINGERPRINT = transcriptFingerprint("vision");

function candidate(id: string, hash: string, renderSafe = true): ReuseCandidate {
	return { id, hash, renderSafe };
}

function stored(...pages: StoredPage[]) {
	return { with: FINGERPRINT, pages };
}

describe("transcriptSections", () => {
	it("splits the region back into the page ordinals its headings name", () => {
		const body = region(`${heading(1)}\n\nfirst page`, `${heading(2)}\n\nsecond page`);
		expect(transcriptSections(body)).toEqual(
			new Map([
				[1, "first page"],
				[2, "second page"],
			]),
		);
	});

	// The footnotes describe the *unit*, and they follow whichever section happens to be last. Reading
	// them as that page's text would corrupt it; refusing every section they follow would make the
	// store useless, because most notebooks have a blank page somewhere.
	it("trims the no-text and typed-text footnotes off the last page rather than reading them as its text", () => {
		const body = region(`${heading(1)}\n\nfirst page`, `${heading(3)}\n\nthird page`, "*No text on page 2.*", "*Page 4 is typed text — see the embedded page.*");
		expect(transcriptSections(body).get(3)).toBe("third page");
	});

	it("finds nothing in a region that was written without page headings", () => {
		expect(transcriptSections("a flat unlabelled transcript")).toEqual(new Map());
	});
});

describe("pageText", () => {
	it("returns the body of a page that carries only transcribed text", () => {
		expect(pageText("the whole page", 0)).toBe("the whole page");
	});

	// A handwritten page of a notebook that also has a digest can carry quotes, folded in above the
	// text (#115 ticket 05). Storing the count is what lets them be dropped again exactly.
	it("drops the folded-in quote bullets and keeps the transcribed text", () => {
		expect(pageText("- deployment window is Friday\n- ask Ops\n\nNext: book the window", 2)).toBe("Next: book the window");
	});

	it("keeps a multi-paragraph transcript whole once the quotes are dropped", () => {
		expect(pageText("- a quote\n\nfirst paragraph\n\nsecond paragraph", 1)).toBe("first paragraph\n\nsecond paragraph");
	});

	it("refuses a section whose quotes were promised but have no break after them", () => {
		expect(pageText("- a quote with nothing under it", 1)).toBeNull();
	});

	// Neither can be a stored page's text: a failed page is never stored, and the footnotes are
	// trimmed off the tail. Meeting one here means the split went wrong, and a wrong split is the one
	// outcome worth refusing over.
	it("refuses a failed page's callout and a stray footnote", () => {
		expect(pageText("> [!warning] Could not read this page", 0)).toBeNull();
		expect(pageText("real text\n\n*No text on pages 2, 4.*", 0)).toBeNull();
	});

	it("refuses an empty body rather than storing silence over a real transcript", () => {
		expect(pageText("   ", 0)).toBeNull();
	});
});

describe("reusableTranscripts", () => {
	const body = region(`${heading(1)}\n\npage one`, `${heading(2)}\n\npage two`);

	it("keeps a page whose hash has not moved", () => {
		const map = reusableTranscripts(stored({ id: "a", hash: "h-a", label: 1, quotes: 0 }), FINGERPRINT, body, [candidate("a", "h-a")]);
		expect(map).toEqual(new Map([["a", "page one"]]));
	});

	it("drops a page whose hash has moved", () => {
		const map = reusableTranscripts(stored({ id: "a", hash: "h-a", label: 1, quotes: 0 }), FINGERPRINT, body, [candidate("a", "h-a-edited")]);
		expect(map).toEqual(new Map());
	});

	// The point of storing the label rather than the array position: the note anchors by ordinal, and
	// inserting a page renumbers every heading below it. Page `b` was written as Page 2 and is Page 3
	// now, so its text has to be found under 2 and not under 3.
	it("finds a page's text under the ordinal it was written with, not the one it has now", () => {
		const map = reusableTranscripts(stored({ id: "b", hash: "h-b", label: 2, quotes: 0 }), FINGERPRINT, body, [candidate("b", "h-b")]);
		expect(map.get("b")).toBe("page two");
	});

	// The reporter's own case, and the one he called the part he would think about hardest.
	it("keeps nothing when the backend or model has changed", () => {
		const map = reusableTranscripts(stored({ id: "a", hash: "h-a", label: 1, quotes: 0 }), transcriptFingerprint("ollama|http://localhost:11434|gemma3:4b"), body, [candidate("a", "h-a")]);
		expect(map).toEqual(new Map());
	});

	// `reusableTranscript`'s existing carve-out, moved from the unit to the page: placing anchored ink
	// changes what the rasterizer sees, so such a page is worth re-reading after a renderer change.
	it("keeps nothing for a page whose render is no longer the one the note embeds", () => {
		const map = reusableTranscripts(stored({ id: "a", hash: "h-a", label: 1, quotes: 0 }), FINGERPRINT, body, [candidate("a", "h-a", false)]);
		expect(map).toEqual(new Map());
	});

	it("keeps nothing for a row that has no store yet, or a note it could not read", () => {
		expect(reusableTranscripts(undefined, FINGERPRINT, body, [candidate("a", "h-a")])).toEqual(new Map());
		expect(reusableTranscripts(stored({ id: "a", hash: "h-a", label: 1, quotes: 0 }), FINGERPRINT, null, [candidate("a", "h-a")])).toEqual(new Map());
	});

	// The store said this page was read successfully, and the note disagrees. Something has gone wrong
	// between them, so the page is read again rather than handed a callout as its transcript.
	it("keeps nothing for a stored page whose section no longer parses to text", () => {
		const damaged = region(`${heading(1)}\n\n> [!warning] Could not read this page`);
		const map = reusableTranscripts(stored({ id: "a", hash: "h-a", label: 1, quotes: 0 }), FINGERPRINT, damaged, [candidate("a", "h-a")]);
		expect(map).toEqual(new Map());
	});

	it("keeps nothing for a stored page whose heading is gone from the note", () => {
		const map = reusableTranscripts(stored({ id: "z", hash: "h-z", label: 9, quotes: 0 }), FINGERPRINT, body, [candidate("z", "h-z")]);
		expect(map).toEqual(new Map());
	});
});

describe("transcriptFingerprint", () => {
	it("separates two models of the same provider", () => {
		expect(transcriptFingerprint("ollama|http://localhost:11434|qwen3-vl:4b")).not.toBe(transcriptFingerprint("ollama|http://localhost:11434|gemma3:4b"));
	});

	// The same server and the same model read the same way, so a run that changed neither must not pay
	// for the whole notebook again.
	it("is stable across runs for an unchanged backend", () => {
		expect(transcriptFingerprint("vision")).toBe(transcriptFingerprint("vision"));
	});
});
