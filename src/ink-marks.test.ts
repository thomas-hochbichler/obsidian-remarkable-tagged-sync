import { describe, expect, it } from "vitest";
import { findInkMarks, readsAsMark } from "./ink-marks";
import type { DeviceCanvas } from "./pdf-renderer";
import type { PdfPageText } from "./pdf-text";
import type { RmStroke } from "./rm-parser";

/** A 1000x1000 pt page at 1 px per pt, so scene x maps to `x + 500` and scene y to `1000 - y`. */
const FRAME: DeviceCanvas = { widthPx: 1000, heightPx: 1000, pxToPt: 1, widthPt: 1000, heightPt: 1000 };
const LINE_HEIGHT_PT = 12;

const PAGE: PdfPageText = {
	label: "1",
	width: 1000,
	height: 1000,
	lines: [
		{ text: "Die kleinstmoegliche Menge an Tokens finden", x: 500, y: 900, width: 300, height: 10 },
		{ text: "Ein zweiter Satz steht darunter auf Seite eins", x: 500, y: 880, width: 300, height: 10 },
	],
};

function point(x: number, y: number) {
	return { x, y, speed: 0, width: 2, direction: 0, pressure: 1 };
}

function stroke(id: string, points: { x: number; y: number }[]): RmStroke {
	return { layerId: "0001", id, timestamp: "0001", penType: 2, color: 0, brushSize: 2, points: points.map((p) => point(p.x, p.y)) };
}

/** A flat stroke of `width` scene px whose top edge lands `gapPt` under the first line's bottom. */
function underline(id: string, width: number, gapPt = 4, x = 0): RmStroke {
	const bottom = 1000 - (PAGE.lines[0].y - gapPt);
	return stroke(id, [{ x, y: bottom - 1 }, { x: x + width, y: bottom }]);
}

/** A closed loop of `width` scene px drawn over the first line. */
function loop(id: string, width: number, x = 0): RmStroke {
	const top = 88;
	const bottom = 105;
	const middle = (top + bottom) / 2;
	return stroke(id, [
		{ x, y: middle },
		{ x: x + width / 2, y: top },
		{ x: x + width, y: middle },
		{ x: x + width / 2, y: bottom },
		{ x, y: middle },
	]);
}

describe("findInkMarks", () => {
	it("reads an underline as the words above it", () => {
		const result = findInkMarks([underline("0a", 100)], PAGE, FRAME, LINE_HEIGHT_PT);

		expect(result.strokes).toEqual([]);
		expect(result.marks).toHaveLength(1);
		expect(result.marks[0].strokeId).toBe("0a");
		expect(result.marks[0].marked).toEqual(["Die kleinstmoegliche"]);
		expect(result.marks[0].sentence).toContain("Die kleinstmoegliche");
	});

	it("reads a circle as the words inside it", () => {
		const result = findInkMarks([loop("0a", 100)], PAGE, FRAME, LINE_HEIGHT_PT);

		expect(result.strokes).toEqual([]);
		expect(result.marks).toHaveLength(1);
		expect(result.marks[0].marked).toEqual(["Die kleinstmoegliche"]);
	});

	it("anchors the mark to the text's box, not to the ink's", () => {
		const [mark] = findInkMarks([underline("0a", 100)], PAGE, FRAME, LINE_HEIGHT_PT).marks;

		expect(mark.pdfRect.y).toBe(PAGE.lines[0].y);
		expect(mark.pdfRect.height).toBe(PAGE.lines[0].height);
	});

	it("leaves a flat stroke too short to be an underline as handwriting", () => {
		const short = underline("0a", 20);

		expect(findInkMarks([short], PAGE, FRAME, LINE_HEIGHT_PT)).toEqual({ marks: [], strokes: [short] });
	});

	it("leaves a long flat stroke with no text line above it as handwriting", () => {
		// Same shape, four line heights lower down the page: nothing there for it to underline.
		const stray = stroke("0a", [{ x: 0, y: 200 }, { x: 100, y: 201 }]);

		expect(findInkMarks([stray], PAGE, FRAME, LINE_HEIGHT_PT)).toEqual({ marks: [], strokes: [stray] });
	});

	it("leaves a strikethrough as handwriting -- no fixture has one, so no rule claims it", () => {
		// Its top edge sits inside the line rather than under it: a negative gap past the allowance.
		const through = underline("0a", 100, -6);

		expect(findInkMarks([through], PAGE, FRAME, LINE_HEIGHT_PT)).toEqual({ marks: [], strokes: [through] });
	});

	it("leaves a small closed loop -- an o, a circled digit -- as handwriting", () => {
		const letter = loop("0a", 20);

		expect(findInkMarks([letter], PAGE, FRAME, LINE_HEIGHT_PT)).toEqual({ marks: [], strokes: [letter] });
	});

	it("leaves a wide loop that encloses no text as handwriting", () => {
		// Past the right edge of every line on the page.
		const empty = loop("0a", 100, 400);

		expect(findInkMarks([empty], PAGE, FRAME, LINE_HEIGHT_PT)).toEqual({ marks: [], strokes: [empty] });
	});

	it("leaves a wide open stroke over the text as handwriting", () => {
		// The size of the circle and in the same place, but its ends do not meet.
		const open = stroke("0a", [{ x: 0, y: 105 }, { x: 50, y: 88 }, { x: 100, y: 105 }]);

		expect(findInkMarks([open], PAGE, FRAME, LINE_HEIGHT_PT)).toEqual({ marks: [], strokes: [open] });
	});

	it("keeps the handwriting in input order, so the clustering sees what it always did", () => {
		const a = stroke("0a", [{ x: 0, y: 300 }, { x: 5, y: 305 }]);
		const b = stroke("0b", [{ x: 20, y: 300 }, { x: 25, y: 305 }]);

		const result = findInkMarks([a, underline("0c", 100), b], PAGE, FRAME, LINE_HEIGHT_PT);

		expect(result.strokes.map((item) => item.id)).toEqual(["0a", "0b"]);
		expect(result.marks.map((mark) => mark.strokeId)).toEqual(["0c"]);
	});

	it("ignores a stroke with no points at all", () => {
		const empty = stroke("0a", []);

		expect(findInkMarks([empty], PAGE, FRAME, LINE_HEIGHT_PT)).toEqual({ marks: [], strokes: [empty] });
	});
});

/**
 * The strokes `findInkMarks` hands back that the reader nevertheless drew *at* the text. With margin
 * notes off they reach the vault nowhere, so the digest names them instead of losing them quietly.
 */
describe("readsAsMark", () => {
	it("holds for a strikethrough, which is not a mark but was aimed at the line", () => {
		expect(readsAsMark(underline("0a", 100, -6), FRAME, LINE_HEIGHT_PT)).toBe(true);
	});

	it("holds for an underline drawn too far below its line", () => {
		expect(readsAsMark(underline("0a", 100, 40), FRAME, LINE_HEIGHT_PT)).toBe(true);
	});

	it("holds for a wide loop that encloses no text", () => {
		expect(readsAsMark(loop("0a", 100, 400), FRAME, LINE_HEIGHT_PT)).toBe(true);
	});

	it("does not hold for a stroke too short to be a mark at all -- that is just handwriting", () => {
		expect(readsAsMark(underline("0a", 20), FRAME, LINE_HEIGHT_PT)).toBe(false);
	});

	it("does not hold for a wide open stroke, which is a word rather than a mark", () => {
		const open = stroke("0a", [{ x: 0, y: 105 }, { x: 50, y: 88 }, { x: 100, y: 105 }]);

		expect(readsAsMark(open, FRAME, LINE_HEIGHT_PT)).toBe(false);
	});
});
