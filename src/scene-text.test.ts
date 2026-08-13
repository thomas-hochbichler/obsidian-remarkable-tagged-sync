import { describe, expect, it } from "vitest";
import { PLAIN_TEXT_SIZE_PX } from "./device-font";
import { notebookPageFrame, resolveDeviceCanvas, toPdfPoint } from "./pdf-renderer";
import type { RmPage, RmText } from "./rm-parser";
import { hasTypedText, isDocumentText, sceneHeadings, sceneTextPage } from "./scene-text";

/** A text box at the device's usual position, as `text-layout.test.ts` builds one. */
function text(runs: RmText["runs"], styles: RmText["styles"] = new Map()): RmText {
	return { posX: -468, posY: 234, width: 936, runs, styles };
}

function page(overrides: Partial<RmPage> = {}): RmPage {
	return { formatVersion: 6, layers: [], ...overrides };
}

/** The screen a scene with no `scene_info` block falls back to -- a reMarkable 1/2. */
const SCREEN = resolveDeviceCanvas([]);

/** The style map that makes the paragraph opening at `charId` a heading (code 3). */
function headingAt(...charIds: string[]): RmText["styles"] {
	return new Map(charIds.map((id) => [id, 3]));
}

describe("hasTypedText", () => {
	it("is false for a page with no text at all, which is most notebook pages", () => {
		expect(hasTypedText(page())).toBe(false);
		expect(hasTypedText(null)).toBe(false);
	});

	it("is false for a text box holding nothing, and for one holding only deleted runs", () => {
		expect(hasTypedText(page({ text: text([]) }))).toBe(false);
		expect(hasTypedText(page({ text: text([{ id: "1:10", text: "gone", deleted: 1 }]) }))).toBe(false);
	});

	it("is true once a run carries text", () => {
		expect(hasTypedText(page({ text: text([{ id: "1:10", text: "typed", deleted: 0 }]) }))).toBe(true);
	});
});

describe("isDocumentText", () => {
	/** `count` paragraphs of one short line each -- typed lines that never wrap. */
	const shortLines = (count: number) => page({ text: text([{ id: "1:10", text: Array(count).fill("entry").join("\n"), deleted: 0 }]) });
	/** `count` lines of prose, wrapped by the text box the way the device wraps it. */
	const prose = (count: number) =>
		page({ text: text([{ id: "1:10", text: "a sentence long enough to wrap against the box it is set in, ".repeat(count), deleted: 0 }]) });

	it("is false for the page this repo's own fixture is: two strokes and one typed letter", () => {
		expect(isDocumentText(page({ text: text([{ id: "1:10", text: "A", deleted: 0 }]) }))).toBe(false);
	});

	it("is false for a page nobody typed on", () => {
		expect(isDocumentText(page())).toBe(false);
		expect(isDocumentText(null)).toBe(false);
	});

	// `Daily-2bd24a83` of the corpus: 35 typed lines, not one of them wrapped, and 909 strokes around
	// them. A list somebody wrote beside, not a document somebody marked up.
	it("is false for many short typed lines, however many there are", () => {
		expect(isDocumentText(shortLines(35))).toBe(false);
	});

	// `Obsidian_Sync_Plugin-6f1217bc`: prose, but two lines of it.
	it("is false for a couple of lines of prose", () => {
		expect(isDocumentText(prose(1))).toBe(false);
	});

	it("is true once there is prose enough to mark up", () => {
		const scene = prose(12);

		expect(sceneTextPage(scene, SCREEN, "1")!.lines.length).toBeGreaterThanOrEqual(10);
		expect(isDocumentText(scene)).toBe(true);
	});
});

describe("sceneTextPage", () => {
	it("has no text layer for a page nobody typed on", () => {
		expect(sceneTextPage(page(), SCREEN, "1")).toBeNull();
	});

	it("puts a line's box where the renderer draws that line", () => {
		const scene = page({ text: text([{ id: "1:10", text: "one", deleted: 0 }]) });

		const layer = sceneTextPage(scene, SCREEN, "1")!;

		// The renderer draws the glyphs at the box's x plus the device's left padding, on the line's own
		// y as its baseline -- and a text layer names the same two numbers.
		const drawn = toPdfPoint({ x: -468 + 4.1, y: 234 + 33.8 }, SCREEN);
		expect(layer.lines).toHaveLength(1);
		expect(layer.lines[0].x).toBeCloseTo(drawn.x, 6);
		expect(layer.lines[0].y).toBeCloseTo(drawn.y, 6);
		expect(layer.lines[0].height).toBeCloseTo(PLAIN_TEXT_SIZE_PX * SCREEN.pxToPt, 6);
		expect(layer.lines[0].width).toBeGreaterThan(0);
		expect(layer.width).toBe(SCREEN.widthPt);
	});

	it("drops the empty lines a paragraph break leaves, which carry no text to quote", () => {
		const scene = page({ text: text([{ id: "1:10", text: "one\n\ntwo", deleted: 0 }]) });

		expect(sceneTextPage(scene, SCREEN, "1")!.lines.map((line) => line.text)).toEqual(["one", "two"]);
	});

	it("measures against the grown frame, so a scrolled page's lines are not folded off the bottom", () => {
		// Long enough to reach past one screen: every line has to stay inside the page the renderer
		// writes, or the digest would place the ones below the fold at a negative y.
		const scene = page({ text: text([{ id: "1:10", text: "line\n".repeat(60), deleted: 0 }]) });
		const frame = notebookPageFrame(scene, SCREEN);

		const layer = sceneTextPage(scene, frame, "1")!;

		expect(frame.heightPt).toBeGreaterThan(SCREEN.heightPt);
		expect(layer.lines.every((line) => line.y >= 0 && line.y <= frame.heightPt)).toBe(true);
	});
});

describe("sceneHeadings", () => {
	it("finds nothing on a page whose paragraphs are all plain", () => {
		const scene = page({ text: text([{ id: "1:10", text: "one\ntwo", deleted: 0 }]) });

		expect(sceneHeadings(scene, SCREEN, 0)).toEqual([]);
	});

	it("reads a heading paragraph, at the top of its own first line", () => {
		const scene = page({ text: text([{ id: "1:10", text: "Conclusion\nbody text", deleted: 0 }], headingAt("0:0")) });

		const headings = sceneHeadings(scene, SCREEN, 0);

		expect(headings.map((heading) => heading.title)).toEqual(["Conclusion"]);
		expect(headings[0].pageIndex).toBe(0);
		expect(headings[0].y).toBeCloseTo(sceneTextPage(scene, SCREEN, "1")!.lines[0].y, 6);
	});

	// A title too long for the text box wraps, and the style belongs to the paragraph. Two entries
	// would offer the anchor cascade half a title to hang a note under.
	it("joins a heading that wraps into the one heading it is", () => {
		const long = "Why context engineering is important to building capable agents";
		const scene = page({ text: text([{ id: "1:10", text: `${long}\nbody`, deleted: 0 }], headingAt("0:0")) });

		const headings = sceneHeadings(scene, SCREEN, 0);

		expect(headings.map((heading) => heading.title)).toEqual([long]);
	});

	it("keeps two heading paragraphs apart", () => {
		// "one" ends at character 1:12, so the newline closing it keys the next paragraph's style.
		const scene = page({ text: text([{ id: "1:10", text: "one\ntwo", deleted: 0 }], headingAt("0:0", "1:13")) });

		expect(sceneHeadings(scene, SCREEN, 0).map((heading) => heading.title)).toEqual(["one", "two"]);
	});
});

// Measured on the page this effort came from -- an article the "Read on reMarkable" extension turned
// into a notebook, 21 050 characters over 333 laid-out lines. No fixture: the file is the whole
// article, and a public repo is not the place to keep somebody else's post. The numbers are recorded
// in `.scratch/notebook-document-digest/spec.md` and reproducible with `npm run inspect:doc`.
//
//   10 of its lines carry the heading style, and they merge into the article's 6 sections
//   ("Why context engineering is important to building capable agents", "The anatomy of effective
//   context", "Context retrieval and agentic search", …) -- exactly what the anchor cascade wants,
//   out of a document with no outline to read.
describe("a page that scrolls far past one screen", () => {
	it("keeps every line inside the page, as the imported article's 333 lines have to be", () => {
		const scene = page({ text: text([{ id: "1:10", text: "a line of text\n".repeat(200), deleted: 0 }]) });
		const frame = notebookPageFrame(scene, SCREEN);

		const layer = sceneTextPage(scene, frame, "1")!;

		expect(layer.lines).toHaveLength(200);
		expect(layer.lines.every((line) => line.y >= 0 && line.y + line.height <= frame.heightPt)).toBe(true);
	});
});
