import type { RmStroke } from "./rm-parser";

/** Ink bounding box in scene coordinates (device px, x from the midline, y from the top). */
interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface StrokeCluster {
	/** The cluster's strokes, in parse order. */
	strokes: RmStroke[];
	bounds: Bounds;
	/** Smallest stroke CRDT id in the cluster -- the stable identity per F15. */
	anchorStrokeId: string;
	/**
	 * The top of the row this cluster shares with the notes beside it, for reading order.
	 *
	 * Its own `bounds.minY` cannot do that job: two notes written side by side never start on exactly
	 * the same pixel, so ordering by it puts whichever happens to sit a few pixels higher first. A
	 * shared value collapses that into a tie, which the caller's stable sort then leaves in the
	 * left-to-right order `clusterStrokes` returned.
	 */
	rowTop: number;
}

/**
 * How far apart two strokes' vertical centers may sit and still be the same line of handwriting.
 *
 * Measured against the fixture page: within a note the centers stay well inside half a line height
 * (a circled digit and the words after it are ~6 pt apart), while the strokes of the note above are
 * 17 pt or more away. Comparing centers rather than boxes is the point -- handwriting on one line
 * shares a center band whatever its ascenders do, and a long arrow or underline keeps a center near
 * the letters it belongs to instead of a box that swallows them.
 */
const VERTICAL_TOLERANCE = 0.55;

/**
 * How much of a line height two strokes' vertical bands must share to read as the same line of
 * handwriting, whatever their centers say.
 *
 * The center test alone misses a descender. On page 3 of the acceptance document the `g` ending
 * `#Techniken zur Steigerung` reaches so far below the baseline that its stroke's center lands 29.6
 * px under the center of `der`, the next word 24 px to its right -- 0.72 line heights where the
 * bound is 0.55, so the line was split into two notes that then printed in the wrong order. Widening
 * the center bound to cover it is what does not work: at 0.8 it reaches the row below and merges
 * `3. Beispiele` with `4. XML Tag`.
 *
 * Measured against the line height and not against the shorter of the two strokes, which is the
 * distinction the same page turns on: the 8 px opening stroke of `5. Role zuweisen` on the row below
 * sits *entirely* inside that descender's span, so as a fraction of itself it overlaps completely
 * and pulled the two rows into one note. Against a line height it shares 8 px where the words beside
 * it share 30, and 0.5 separates them.
 */
const VERTICAL_OVERLAP = 0.5;

/**
 * How tall a stroke may be, in line heights, for the overlap rule to speak for it.
 *
 * Overlap is a claim about two strokes sharing a line, and a stroke far taller than a line is not on
 * one -- a bracket, a long arrow, a box drawn around a paragraph. Page 3 of the acceptance document
 * has a 391 px bracket down the left margin (9.5 line heights); without this bound it overlaps every
 * note it spans and single linkage pulls the whole margin into one cluster. The descender the
 * overlap rule exists for reaches 1.87 line heights, so 2.5 clears it and stops well short.
 */
const MAX_LINE_STROKE = 2.5;

/**
 * How far apart two strokes' boxes may sit horizontally and still be the same note: a word gap, an
 * arrow, an indent. Boxes rather than centers here, because a long horizontal stroke's center says
 * nothing about where it reaches.
 *
 * This is the half of the rule that separates the two overlapping notes on the fixture page. Their
 * boxes overlap on both axes, their stroke indices are adjacent, their timestamps are identical and
 * an ink-occupancy scan finds no blank row between them -- so box gaps, draw order and timestamps
 * all fail. The one cross-note stroke pair that passes the vertical test (4.1 pt apart) sits 87 pt
 * apart horizontally, and that is what keeps the notes apart.
 */
const HORIZONTAL_TOLERANCE = 3;

/** One stroke's geometry: the box for the horizontal test, the vertical center for the vertical one. */
interface StrokeGeometry {
	/** Position in the input array, so a cluster can report its strokes in parse order. */
	index: number;
	bounds: Bounds;
	centerY: number;
}

/** Null for a stroke with no points: it has no ink and no box, so it cannot anchor or attract a cluster. */
function strokeBounds(stroke: RmStroke): Bounds | null {
	if (stroke.points.length === 0) return null;
	const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (const point of stroke.points) {
		bounds.minX = Math.min(bounds.minX, point.x);
		bounds.minY = Math.min(bounds.minY, point.y);
		bounds.maxX = Math.max(bounds.maxX, point.x);
		bounds.maxY = Math.max(bounds.maxY, point.y);
	}
	return bounds;
}

/** Same line of handwriting: centers in one band, or bands that overlap enough for a descender to count. */
function sameLine(a: StrokeGeometry, b: StrokeGeometry, lineHeightPx: number): boolean {
	if (Math.abs(a.centerY - b.centerY) <= lineHeightPx * VERTICAL_TOLERANCE) return true;

	const tallest = Math.max(a.bounds.maxY - a.bounds.minY, b.bounds.maxY - b.bounds.minY);
	if (tallest > lineHeightPx * MAX_LINE_STROKE) return false;

	const overlap = Math.min(a.bounds.maxY, b.bounds.maxY) - Math.max(a.bounds.minY, b.bounds.minY);
	return overlap >= lineHeightPx * VERTICAL_OVERLAP;
}

/** The anisotropic link test: same line vertically and close enough horizontally (boxes). */
function joins(a: StrokeGeometry, b: StrokeGeometry, lineHeightPx: number): boolean {
	if (!sameLine(a, b, lineHeightPx)) return false;
	const gapX = Math.max(0, a.bounds.minX - b.bounds.maxX, b.bounds.minX - a.bounds.maxX);
	return gapX <= lineHeightPx * HORIZONTAL_TOLERANCE;
}

/**
 * Single linkage: every pair of strokes that passes `joins` ends up in one cluster, so chained
 * merges settle by construction -- the connected components of the link graph *are* the fixed
 * point, no repeated pass can change them. Deterministic, a pure function of the input.
 */
function linkedComponents(inked: StrokeGeometry[], lineHeightPx: number): StrokeGeometry[][] {
	const parent = inked.map((_, index) => index);
	const find = (start: number): number => {
		let root = start;
		while (parent[root] !== root) root = parent[root];
		for (let node = start; parent[node] !== root; ) {
			const next = parent[node];
			parent[node] = root;
			node = next;
		}
		return root;
	};

	for (let a = 0; a < inked.length; a++) {
		for (let b = a + 1; b < inked.length; b++) {
			if (joins(inked[a], inked[b], lineHeightPx)) parent[find(a)] = find(b);
		}
	}

	const components = new Map<number, StrokeGeometry[]>();
	inked.forEach((geometry, index) => {
		const root = find(index);
		const component = components.get(root);
		if (component) component.push(geometry);
		else components.set(root, [geometry]);
	});
	return [...components.values()];
}

function unionBounds(geometries: StrokeGeometry[]): Bounds {
	return geometries.reduce(
		(union, { bounds }) => ({
			minX: Math.min(union.minX, bounds.minX),
			minY: Math.min(union.minY, bounds.minY),
			maxX: Math.max(union.maxX, bounds.maxX),
			maxY: Math.max(union.maxY, bounds.maxY),
		}),
		{ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
	);
}

/**
 * Orders two CRDT ids by their raw encoding: a longer LEB128 encoding is always the larger id, so
 * length decides first and the hex compares byte-wise within one length.
 */
function compareCrdtIds(a: string, b: string): number {
	return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Groups handwritten strokes into margin notes (F12), one cluster per line of handwriting, ordered
 * top-down and then left-to-right. Pass ink strokes only -- highlighter/shader strokes are marker
 * bands, not notes, and the caller filters them out.
 *
 * Deliberately no line-merging stage: a note spanning two lines becomes two clusters, i.e. two
 * entries in the digest. Every note on all 7 fixture pages is a single line, so there is no data to
 * tune a merge on, and guessing one would split the fixture's two overlapping notes wrongly. The
 * failure mode is visible in the note (one entry too many), never silent loss.
 */
export function clusterStrokes(strokes: RmStroke[], lineHeightPx: number): StrokeCluster[] {
	const inked: StrokeGeometry[] = [];
	strokes.forEach((stroke, index) => {
		const bounds = strokeBounds(stroke);
		if (bounds) inked.push({ index, bounds, centerY: (bounds.minY + bounds.maxY) / 2 });
	});

	const clusters = linkedComponents(inked, lineHeightPx)
		.map((component) => {
			const ordered = [...component].sort((a, b) => a.index - b.index);
			return {
				strokes: ordered.map(({ index }) => strokes[index]),
				bounds: unionBounds(ordered),
				anchorStrokeId: ordered
					.map(({ index }) => strokes[index].id)
					.reduce((smallest, id) => (compareCrdtIds(id, smallest) < 0 ? id : smallest)),
			};
		})
		.sort((a, b) => a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX);

	return inReadingOrder(clusters, lineHeightPx);
}

/**
 * Reading order: the rows of the page top-down, and each row left to right.
 *
 * Sorting on `minY` alone leaves the left-to-right tiebreak unreachable, because it only applies to
 * an exact tie and two notes side by side never start on exactly the same pixel. Page 3 of the
 * acceptance document holds a two-column list whose right column happens to start 4 px above its
 * left, and the digest printed it `5, 1, 2, 7, 3, 4`.
 *
 * Two notes are on one row when they *start* within a line height of each other. Measuring where
 * they start rather than whether their boxes overlap is what keeps one tall note from swallowing the
 * page: the bracket down page 3's left margin spans 391 px, and against overlap it joined every row
 * it reached into a single one that then sorted purely left to right. There is no bucket boundary to
 * fall the wrong side of either, since the band is measured from the row's own top. The input is
 * already sorted top-down and the pass over it is single and total, so the result stays a pure
 * function of the input, as F16 requires.
 */
function inReadingOrder(clusters: Omit<StrokeCluster, "rowTop">[], lineHeightPx: number): StrokeCluster[] {
	const rows: Omit<StrokeCluster, "rowTop">[][] = [];
	let rowTop = -Infinity;

	for (const cluster of clusters) {
		const row = rows[rows.length - 1];
		if (row && cluster.bounds.minY < rowTop + lineHeightPx) row.push(cluster);
		else {
			rows.push([cluster]);
			rowTop = cluster.bounds.minY;
		}
	}

	return rows.flatMap((row) => {
		const top = row[0].bounds.minY;
		return row.sort((a, b) => a.bounds.minX - b.bounds.minX).map((cluster) => ({ ...cluster, rowTop: top }));
	});
}
