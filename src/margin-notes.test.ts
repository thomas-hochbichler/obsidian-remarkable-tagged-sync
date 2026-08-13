import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clusterStrokes } from "./margin-notes";
import { parseRmV6 } from "./rm-parser";
import type { RmStroke } from "./rm-parser";

const PDF_PAGE_FIXTURE_PATH = "./test-fixtures/rmv6/pdf-page-highlights-and-margin-notes.rm";
const LINE_HEIGHT_PX = 40;
/** The fixture PDF's body line spacing (13.5 pt) in the device's px, its 226 dpi against PDF's 72. */
const FIXTURE_LINE_HEIGHT_PX = (13.5 * 226) / 72;
/** reMarkable's two highlighter tool ids plus the Paper Pro shader -- marker bands, not margin notes. */
const MARKER_PEN_TYPES = new Set([5, 18, 23]);

/** A stroke whose ink spans the given box, which is all the clustering looks at. */
function boxStroke(id: string, x: number, y: number, width: number, height: number): RmStroke {
	const point = (px: number, py: number) => ({ x: px, y: py, speed: 0, width: 2, direction: 0, pressure: 1 });
	return {
		layerId: "0001",
		id,
		timestamp: "0001",
		penType: 2,
		color: 0,
		brushSize: 2,
		points: [point(x, y), point(x + width, y + height)],
	};
}

describe("clusterStrokes", () => {
	it("returns no clusters for no strokes", () => {
		expect(clusterStrokes([], LINE_HEIGHT_PX)).toEqual([]);
	});

	it("keeps two blocks a line apart separate", () => {
		const strokes = [boxStroke("0a", 0, 0, 100, 20), boxStroke("0b", 0, 500, 100, 20)];

		const clusters = clusterStrokes(strokes, LINE_HEIGHT_PX);

		expect(clusters).toHaveLength(2);
		expect(clusters.map((cluster) => cluster.anchorStrokeId)).toEqual(["0a", "0b"]);
	});

	it("merges two words that share a line", () => {
		const strokes = [boxStroke("0a", 0, 0, 100, 20), boxStroke("0b", 150, 5, 100, 20)];

		const clusters = clusterStrokes(strokes, LINE_HEIGHT_PX);

		expect(clusters).toHaveLength(1);
		expect(clusters[0].strokes).toHaveLength(2);
		expect(clusters[0].bounds).toEqual({ minX: 0, minY: 0, maxX: 250, maxY: 25 });
	});

	it("keeps a tall stroke with the line it belongs to, since the vertical test reads centers not boxes", () => {
		const strokes = [boxStroke("0a", 0, 0, 10, 40), boxStroke("0b", 20, 15, 60, 10)];

		expect(clusterStrokes(strokes, LINE_HEIGHT_PX)).toHaveLength(1);
	});

	it("settles chained merges: A links B, B links C, A alone is too far from C", () => {
		const strokes = [boxStroke("0a", 0, 0, 50, 10), boxStroke("0b", 150, 0, 50, 10), boxStroke("0c", 300, 0, 50, 10)];

		const clusters = clusterStrokes(strokes, LINE_HEIGHT_PX);

		expect(clusters).toHaveLength(1);
		expect(clusters[0].strokes.map((stroke) => stroke.id)).toEqual(["0a", "0b", "0c"]);
	});

	it("splits two notes that share a line band but sit far apart horizontally", () => {
		const strokes = [boxStroke("0a", 0, 0, 100, 20), boxStroke("0b", 400, 10, 100, 20)];

		const clusters = clusterStrokes(strokes, LINE_HEIGHT_PX);

		expect(clusters).toHaveLength(2);
	});

	it("orders clusters top-down, then left-to-right", () => {
		const strokes = [
			boxStroke("0a", 400, 500, 10, 10),
			boxStroke("0b", 0, 0, 10, 10),
			boxStroke("0c", 0, 500, 10, 10),
		];

		const clusters = clusterStrokes(strokes, LINE_HEIGHT_PX);

		expect(clusters.map((cluster) => cluster.anchorStrokeId)).toEqual(["0b", "0c", "0a"]);
	});

	/**
	 * Page 3 of the acceptance document: the `g` of `#Techniken zur Steigerung` reaches 0.72 line
	 * heights below its neighbour's center, past the 0.55 the center test allows, and the line was
	 * split into two notes that then printed trailing half first.
	 */
	it("keeps a descender with the word beside it, which the center test alone misses", () => {
		const descender = boxStroke("0a", 0, 0, 20, 77);
		const neighbour = boxStroke("0b", 44, -12, 40, 42);

		expect(clusterStrokes([descender, neighbour], 41)).toHaveLength(1);
	});

	it("does not let a stroke overlapping only a fraction of a line height join across rows", () => {
		const descender = boxStroke("0a", 0, 0, 20, 77);
		// 8px tall, entirely inside the descender's span but on the row below -- as a fraction of
		// itself it overlaps completely, which is why overlap is measured against the line height.
		const rowBelow = boxStroke("0b", 117, 60, 35, 8);

		expect(clusterStrokes([descender, rowBelow], 41)).toHaveLength(2);
	});

	it("absorbs a speck into the line beside it instead of making it an entry", () => {
		const line = boxStroke("0a", 0, 0, 300, 38);
		// A dot on an `i` far enough above the line's own box that the line rules leave it standing.
		const speck = boxStroke("0b", 120, -8, 4, 5);

		const clusters = clusterStrokes([line, speck], LINE_HEIGHT_PX);

		expect(clusters).toHaveLength(1);
		expect(clusters[0].strokes).toHaveLength(2);
	});

	it("keeps the host's own id when it absorbs a speck, so the note's block id does not move", () => {
		const line = boxStroke("0b", 0, 0, 300, 38);
		// A smaller CRDT id than the line's: it would win the id outright if it were allowed to compete.
		const speck = boxStroke("0a", 120, -8, 4, 5);

		expect(clusterStrokes([line, speck], LINE_HEIGHT_PX)[0].anchorStrokeId).toBe("0b");
		// And the id is the one the line alone would have had.
		expect(clusterStrokes([line], LINE_HEIGHT_PX)[0].anchorStrokeId).toBe("0b");
	});

	it("leaves a speck with nothing near it as its own entry rather than sending it across the page", () => {
		const line = boxStroke("0a", 0, 0, 300, 38);
		const distant = boxStroke("0b", 900, 400, 4, 5);

		expect(clusterStrokes([line, distant], LINE_HEIGHT_PX)).toHaveLength(2);
	});

	it("does not let a bracket taller than a line claim a note by overlap alone", () => {
		const bracket = boxStroke("0a", 0, 0, 10, 390);
		// Far from the bracket's center, so only the overlap rule could join them -- and a stroke this
		// tall is not on a line, so it may not speak through overlap.
		const note = boxStroke("0b", 40, 30, 60, 50);

		expect(clusterStrokes([bracket, note], 41)).toHaveLength(2);
	});

	/**
	 * `minY` alone leaves the left-to-right tiebreak unreachable: two notes side by side never start
	 * on exactly the same pixel. The acceptance document's two-column list came out `5, 1, 2, 7, 3, 4`
	 * because each right-hand entry began a few pixels above its left-hand neighbour.
	 */
	it("reads a row left-to-right even when its right-hand note starts slightly higher", () => {
		const right = boxStroke("0a", 400, 496, 60, 20);
		const left = boxStroke("0b", 0, 500, 60, 20);

		const clusters = clusterStrokes([right, left], LINE_HEIGHT_PX);

		expect(clusters.map((cluster) => cluster.anchorStrokeId)).toEqual(["0b", "0a"]);
		// One shared top, so the caller's stable sort cannot undo the order.
		expect(clusters.map((cluster) => cluster.rowTop)).toEqual([496, 496]);
	});

	it("starts a new row once a note begins more than a line below the row's top", () => {
		const clusters = clusterStrokes(
			[boxStroke("0a", 400, 0, 60, 20), boxStroke("0b", 0, 60, 60, 20)],
			LINE_HEIGHT_PX,
		);

		expect(clusters.map((cluster) => cluster.anchorStrokeId)).toEqual(["0a", "0b"]);
		expect(clusters.map((cluster) => cluster.rowTop)).toEqual([0, 60]);
	});

	it("anchors a cluster on its smallest stroke CRDT id, independent of parse order", () => {
		const strokes = [boxStroke("0f00", 0, 0, 10, 10), boxStroke("0b", 20, 0, 10, 10)];

		const clusters = clusterStrokes(strokes, LINE_HEIGHT_PX);

		expect(clusters[0].anchorStrokeId).toBe("0b");
	});

	it("ignores strokes that carry no points", () => {
		const empty = { ...boxStroke("0a", 0, 0, 10, 10), points: [] };

		expect(clusterStrokes([empty], LINE_HEIGHT_PX)).toEqual([]);
	});

	/**
	 * A note written down the margin is one note, not one per line -- what a reader reported after
	 * seeing a single sentence arrive as four callouts, each transcribed and anchored on its own.
	 *
	 * The column is what makes this safe: merging anywhere fuses two unrelated notes lying across each
	 * other over the text, which is why `pdf-annotation` ticket 15 shipped no merge at all. Out beyond
	 * the printed text there is nothing to lie across.
	 */
	describe("a block written in the margin", () => {
		/** The printed text of a page, in scene px: everything outside this is margin. */
		const COLUMN = { left: -700, right: 700 };

		/** Three lines of one note down the right margin, left edges level, an ordinary gap between them. */
		const block = [boxStroke("0c", 750, 0, 250, 30), boxStroke("0b", 750, 45, 230, 30), boxStroke("0d", 750, 90, 240, 30)];

		it("is one note", () => {
			const clusters = clusterStrokes(block, LINE_HEIGHT_PX, COLUMN);

			expect(clusters).toHaveLength(1);
			expect(clusters[0].strokes).toHaveLength(3);
			expect(clusters[0].bounds).toEqual({ minX: 750, minY: 0, maxX: 1000, maxY: 120 });
		});

		/** The id is the block's own smallest, so the entry a reader links to does not depend on which line came first. */
		it("is anchored on the smallest id in the block", () => {
			expect(clusterStrokes(block, LINE_HEIGHT_PX, COLUMN)[0].anchorStrokeId).toBe("0b");
		});

		it("stays one line per note without a column, which is what a document with no text layer gets", () => {
			expect(clusterStrokes(block, LINE_HEIGHT_PX)).toHaveLength(3);
		});

		/**
		 * The trap, in miniature. Two notes written across each other over the printed text overlap on
		 * both axes exactly as a paragraph's lines do -- nine measured rules fused them, and none of them
		 * could have known the difference, because the difference is not in the strokes.
		 */
		it("does not merge lines that stand over the printed text", () => {
			const overText = block.map((stroke) => boxStroke(stroke.id, 0, stroke.points[0].y, 250, 30));

			expect(clusterStrokes(overText, LINE_HEIGHT_PX, COLUMN)).toHaveLength(3);
		});

		/** A bracket down the margin spans every line it reaches; single linkage would pull them all into it. */
		it("leaves a tall mark out of the block it spans", () => {
			const bracket = boxStroke("0a", 720, 0, 10, 300);

			const clusters = clusterStrokes([bracket, ...block], LINE_HEIGHT_PX, COLUMN);

			expect(clusters).toHaveLength(2);
			expect(clusters.map((cluster) => cluster.strokes.length).sort()).toEqual([1, 3]);
		});

		it("keeps two notes side by side in the margin apart", () => {
			const beside = [boxStroke("0a", 750, 0, 50, 30), boxStroke("0b", 900, 45, 50, 30)];

			expect(clusterStrokes(beside, LINE_HEIGHT_PX, COLUMN)).toHaveLength(2);
		});

		/** Far apart is not one note: the reported block's lines follow each other, a note two lines down does not. */
		it("keeps a line that follows too far below out of the block", () => {
			const late = [boxStroke("0a", 750, 0, 250, 30), boxStroke("0b", 750, 100, 250, 30)];

			expect(clusterStrokes(late, LINE_HEIGHT_PX, COLUMN)).toHaveLength(2);
		});
	});

	it("finds the fixture page's five margin notes, including the two that overlap in both axes", () => {
		const page = parseRmV6(new Uint8Array(readFileSync(PDF_PAGE_FIXTURE_PATH)));
		const ink = page.layers.flatMap((layer) => layer.strokes).filter((stroke) => !MARKER_PEN_TYPES.has(stroke.penType));

		const clusters = clusterStrokes(ink, FIXTURE_LINE_HEIGHT_PX);

		expect(clusters.map((cluster) => cluster.strokes.length)).toEqual([10, 2, 2, 17, 34]);
		expect(clusters.flatMap((cluster) => cluster.strokes)).toHaveLength(ink.length);
		expect(new Set(clusters.map((cluster) => cluster.anchorStrokeId)).size).toBe(clusters.length);
	});
});
