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
	// Every colour a device has been seen to record, read out of real files with `parseRmV6`:
	// the reMarkable 2 (rmscene's Wikipedia_highlighted pages, firmware 3.1) and the Paper Pro's
	// selection gesture write a palette id; the Paper Pro's highlighter and shader write the true
	// colour (rmscene's Color_and_tool_v3.14.4 and More_color_highlight_shader_v3.15.4.2, the
	// maintainer's own pages of 2026-08). Each row is what the eye calls that colour in Zotero's
	// names -- a palette change on either side moves a row and fails here.
	const RECORDED: [name: string, rgb: { r: number; g: number; b: number }, zotero: string][] = [
		// palette ids, as `recordedColor` resolves them (reMarkable 2; Paper Pro gesture)
		["palette 3 yellow", { r: 251, g: 247, b: 25 }, "#ffd400"],
		["palette 4 green", { r: 0, g: 255, b: 0 }, "#5fb236"],
		["palette 5 pink", { r: 255, g: 192, b: 203 }, "#ff6666"],
		["palette 6 blue", { r: 78, g: 105, b: 201 }, "#2ea8e5"],
		["palette 7 red", { r: 179, g: 62, b: 57 }, "#ff6666"],
		["palette 10 green_2", { r: 161, g: 216, b: 125 }, "#5fb236"],
		["palette 11 cyan", { r: 139, g: 208, b: 229 }, "#2ea8e5"],
		["palette 12 magenta", { r: 183, g: 130, b: 205 }, "#e56eee"],
		["palette 13 yellow_2", { r: 247, g: 232, b: 81 }, "#ffd400"],
		// Paper Pro highlighter, id 9 + color_rgba
		["highlighter yellow", { r: 255, g: 237, b: 117 }, "#ffd400"],
		["highlighter blue", { r: 190, g: 234, b: 254 }, "#2ea8e5"],
		["highlighter pink", { r: 242, g: 158, b: 255 }, "#e56eee"],
		["highlighter orange", { r: 255, g: 195, b: 140 }, "#f19837"],
		["highlighter green", { r: 172, g: 255, b: 133 }, "#5fb236"],
		["highlighter grey", { r: 199, g: 199, b: 198 }, "#aaaaaa"],
		// Paper Pro shader, id 9 + color_rgba
		["shader black", { r: 33, g: 30, b: 28 }, "#aaaaaa"],
		["shader amber", { r: 254, g: 178, b: 0 }, "#ffd400"],
		["shader purple", { r: 192, g: 127, b: 210 }, "#e56eee"],
		["shader blue", { r: 48, g: 74, b: 224 }, "#2ea8e5"],
		["shader red", { r: 194, g: 49, b: 50 }, "#ff6666"],
		["shader green", { r: 145, g: 218, b: 113 }, "#5fb236"],
		["shader yellow", { r: 250, g: 231, b: 25 }, "#ffd400"],
		["shader cyan", { r: 116, g: 210, b: 232 }, "#2ea8e5"],
	];

	it("is the one of Zotero's eight whose hue band the device colour falls in", () => {
		for (const [name, rgb, zotero] of RECORDED) expect(zoteroColor(rgb), name).toBe(zotero);
	});

	// The nearest in RGB is not it: by squared distance the Paper Pro's pastel green and orange are
	// nearer Zotero's grey than their namesakes, and its yellow is nearer orange. Pinned so a "simpler"
	// metric cannot come back.
	it("keeps a pastel with its namesake rather than with grey", () => {
		expect(zoteroColor({ r: 172, g: 255, b: 133 })).not.toBe("#aaaaaa");
		expect(zoteroColor({ r: 255, g: 237, b: 117 })).toBe("#ffd400");
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
