import { describe, expect, it } from "vitest";
import type { DigestHighlight, DigestNote, DigestPage, DigestPageSource } from "./digest-builder";
import { highlightAnnotation, markedText, noteAnnotation, sortIndex, stickyRect, zoteroColor, ZOTERO_COLORS } from "./zotero-annotations";

const SOURCE: DigestPageSource = { index: 1, widthPt: 612, heightPt: 792 };

function page(overrides: Partial<DigestPage> = {}): DigestPage {
	return { pageLabel: "xii", embedPage: 2, source: SOURCE, highlights: [], notes: [], ...overrides };
}

function highlight(overrides: Partial<DigestHighlight> = {}): DigestHighlight {
	return {
		id: "hl-9f21c4",
		sentence: "Die Techniken gelten für alle aktuellen Claude-Modelle, sagt der Text.",
		rects: [{ x: 72, y: 700, width: 228, height: 12 }],
		tool: "marker",
		marked: ["für alle aktuellen Claude-Modelle,"],
		color: null,
		notes: [],
		section: null,
		top: 80,
		...overrides,
	};
}

function note(overrides: Partial<DigestNote> = {}): DigestNote {
	return { id: "nt-4c8a17", anchor: { kind: "page" }, text: "eine Randnotiz", region: null, rect: { x: 500, y: 600, width: 90, height: 40 }, top: 0, ...overrides };
}

describe("what kind of annotation an entry becomes", () => {
	// The digest renders both identically -- the reader wants the passage, not the tool -- but in
	// Zotero they are two different marks, and only the tool says which.
	it("makes a marker swipe a highlight and a pen mark an underline", () => {
		expect(highlightAnnotation(highlight(), page(), SOURCE, "ATT1")?.type).toBe("highlight");
		expect(highlightAnnotation({ ...highlight(), tool: "pen" }, page(), SOURCE, "ATT1")?.type).toBe("underline");
	});

	it("makes a standalone margin note a sticky", () => {
		expect(noteAnnotation(note(), page(), SOURCE, "ATT1")?.type).toBe("note");
	});

	// A highlight with no rectangles has no position, and `annotationPosition` is not optional. The
	// entry is still in the vault note; only Zotero cannot be told where on the page it was.
	it("offers nothing for a highlight with no place on the page", () => {
		expect(highlightAnnotation({ ...highlight(), rects: [] }, page(), SOURCE, "ATT1")).toBeNull();
	});

	// A sticky with no comment marks a spot and says nothing -- it cannot be told from a stray click,
	// and the handwriting itself is in the vault's own PDF, which the entry already points at.
	it("offers nothing for a margin note that could not be transcribed", () => {
		expect(noteAnnotation({ ...note(), text: "" }, page(), SOURCE, "ATT1")).toBeNull();
		expect(noteAnnotation({ ...note(), text: "   " }, page(), SOURCE, "ATT1")).toBeNull();
	});

	it("offers nothing for a margin note with no place on the page", () => {
		expect(noteAnnotation({ ...note(), rect: null }, page(), SOURCE, "ATT1")).toBeNull();
	});
});

describe("the words the annotation carries", () => {
	// ⚠️ The digest quotes a highlight in its sentence because that is what makes a note readable. In
	// Zotero the annotation sits on the page it came from, so the sentence is not context there -- it
	// is a claim that the reader marked words the page shows they did not.
	it("is the marked runs, never the sentence around them", () => {
		expect(markedText(highlight())).toBe("für alle aktuellen Claude-Modelle,");
	});

	it("joins several runs of one gesture into the passage it covered", () => {
		expect(markedText({ ...highlight(), marked: ["für alle", "aktuellen Claude-Modelle,"] })).toBe("für alle aktuellen Claude-Modelle,");
	});

	// The F4 soft fail puts the device's own recorded text into `sentence` and leaves `marked` empty,
	// so this is the device's text and not a sentence the text layer built.
	it("falls back to what the device recorded when no run is known", () => {
		expect(markedText({ ...highlight(), marked: [], sentence: "what the device recorded" })).toBe("what the device recorded");
	});

	it("carries a margin note anchored to a highlight as that highlight's comment", () => {
		const annotation = highlightAnnotation({ ...highlight(), notes: [note({ text: "erste" }), note({ text: "zweite" })] }, page(), SOURCE, "ATT1");
		expect(annotation?.comment).toBe("erste\n\nzweite");
	});

	it("leaves the comment empty where nothing was written beside the passage", () => {
		expect(highlightAnnotation(highlight(), page(), SOURCE, "ATT1")?.comment).toBe("");
	});
});

describe("where Zotero is told the annotation sits", () => {
	// ⚠️ A JSON string, not an object: Zotero's data layer rejects the object form outright.
	it("is a string, in the PDF's own frame", () => {
		const annotation = highlightAnnotation(highlight(), page(), SOURCE, "ATT1");
		expect(typeof annotation?.position).toBe("string");
		expect(JSON.parse(annotation?.position ?? "")).toEqual({ pageIndex: 1, rects: [[72, 700, 300, 712]] });
	});

	it("carries one rectangle per run, so a wrapped gesture marks the words and not the block", () => {
		const wrapped = highlight({ rects: [{ x: 72, y: 700, width: 228, height: 12 }, { x: 72, y: 686, width: 100, height: 12 }] });
		const rects = (JSON.parse(highlightAnnotation(wrapped, page(), SOURCE, "ATT1")?.position ?? "") as { rects: number[][] }).rects;
		expect(rects).toEqual([[72, 700, 300, 712], [72, 686, 172, 698]]);
	});

	// Both of these are real in the fixture rather than hypothetical: a single horizontal stroke is a
	// box of zero height, and margin ink sits past the page edge because the device's canvas is wider
	// than the paper. Zotero paints a rectangle, so either one paints nothing.
	it("gives a sticky a square Zotero can actually draw, on the page", () => {
		const flat = stickyRect({ x: 743, y: 600, width: 90, height: 0 }, SOURCE);
		expect(flat).toEqual({ x: 590, y: 578, width: 22, height: 22 });
	});

	it("puts the sticky at the corner the reader started writing in", () => {
		expect(stickyRect({ x: 400, y: 600, width: 90, height: 40 }, SOURCE)).toEqual({ x: 400, y: 618, width: 22, height: 22 });
	});
});

describe("the sort index Zotero will not do without", () => {
	it("is the page, six zeros, and the distance from the page top", () => {
		expect(sortIndex(1, 792, { x: 72, y: 700, width: 228, height: 12 })).toBe("00001|000000|00080");
	});

	// Fixed width, so a rectangle above the page top or below its bottom would otherwise produce a
	// negative number or a sixth digit -- and Zotero refuses the whole annotation.
	it("stays five digits for a rectangle off the top or the bottom of the page", () => {
		expect(sortIndex(0, 792, { x: 0, y: 1000, width: 10, height: 10 })).toBe("00000|000000|00000");
		expect(sortIndex(0, 792, { x: 0, y: -100000, width: 10, height: 10 })).toBe("00000|000000|99999");
	});

	it("puts an entry with no rectangle at the top of its page rather than nowhere", () => {
		expect(sortIndex(3, 792, null)).toBe("00003|000000|00000");
	});
});

describe("the colour", () => {
	it("is the nearest of the eight Zotero's reader offers", () => {
		// Three of the reMarkable's own palette, each snapped to the nearest Zotero offers. Pink lands
		// on Zotero's magenta rather than its red, which is what the numbers say and what the eye says.
		expect(zoteroColor({ r: 255, g: 255, b: 0 })).toBe("#ffd400");
		expect(zoteroColor({ r: 255, g: 192, b: 203 })).toBe("#e56eee");
		expect(zoteroColor({ r: 0, g: 255, b: 0 })).toBe("#5fb236");
		expect(zoteroColor({ r: 255, g: 0, b: 0 })).toBe("#ff6666");
	});

	it("is Zotero's own yellow for a mark that has no colour", () => {
		expect(zoteroColor(null)).toBe("#ffd400");
		expect(highlightAnnotation({ ...highlight(), tool: "pen" }, page(), SOURCE, "ATT1")?.color).toBe("#ffd400");
	});

	// Zotero's data layer matches `#[a-f0-9]{6}` and rejects anything else, uppercase included.
	it("is always lowercase six-digit hex", () => {
		for (const colour of ZOTERO_COLORS) expect(colour.hex).toMatch(/^#[a-f0-9]{6}$/);
	});
});

describe("the page label", () => {
	// Our label, not the index: a paper's page xii is page xii in Zotero's sidebar too, and the
	// physical page is already carried by `pageIndex`.
	it("is the document's own, as the digest reads it", () => {
		expect(highlightAnnotation(highlight(), page(), SOURCE, "ATT1")?.pageLabel).toBe("xii");
	});

	it("is empty where the document does not number its pages", () => {
		expect(highlightAnnotation(highlight(), page({ pageLabel: null }), SOURCE, "ATT1")?.pageLabel).toBe("");
	});
});
