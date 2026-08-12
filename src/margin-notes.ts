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

/**
 * How thin a cluster's box must be, in line heights, to be read as a fragment of the line beside it
 * rather than as a note of its own.
 *
 * A dot on an `i`, a stray tick, the tail of a descender the line rules did not catch: on the fixture
 * document four of the 51 clusters are one of these, and each one costs a callout with no text and an
 * OCR process of its own. Measured, they sit at 0.10, 0.13, 0.32 and 0.67 line heights
 * tall, while the smallest *real* note -- a circled digit -- is 1.04 tall.
 *
 * This is emphatically **not** the paragraph merging that pdf-annotation ticket 15 measured and
 * rejected: a fragment carries no readable text (all four transcribe to "" or one character), so
 * absorbing one cannot fuse two notes. Nine rules that join *notes* were built and every one broke a
 * real case; the failure mode there is silent, and here the worst case is a rectangle a few px larger.
 */
const FRAGMENT_MAX_HEIGHT = 0.4;

/**
 * How narrow a cluster must be to count as a fragment on width instead, and how tall it may then be.
 *
 * Width alone is not enough, and the bracket down page 3's left margin is why: 10 px wide and 390 tall,
 * narrower than any speck and unmistakably a mark of its own. The height bound is what separates them,
 * and it is placed in the measured gap -- the tallest fragment is 0.67 line heights, the shortest real
 * note 1.04.
 */
const FRAGMENT_MAX_WIDTH = 0.3;
const FRAGMENT_SLIVER_MAX_HEIGHT = 0.7;

/**
 * How close a fragment must sit to the cluster that takes it in, in line heights.
 *
 * A speck belongs to the ink it was written against, so it is touching it or nearly so; something this
 * small further away is not a fragment *of* anything, and absorbing it would undo a separation the line
 * rules made on purpose. With no cluster this close a fragment stays an entry of its own -- visible,
 * which is the failure mode this file prefers throughout.
 */
const FRAGMENT_MAX_GAP = 0.5;

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

/** A cluster too thin to be a note: a sliver of a line either way, but never a tall narrow mark. See {@link FRAGMENT_MAX_HEIGHT}. */
function isFragment(bounds: Bounds, lineHeightPx: number): boolean {
	const height = bounds.maxY - bounds.minY;
	if (height < lineHeightPx * FRAGMENT_MAX_HEIGHT) return true;
	return bounds.maxX - bounds.minX < lineHeightPx * FRAGMENT_MAX_WIDTH && height <= lineHeightPx * FRAGMENT_SLIVER_MAX_HEIGHT;
}

/** The gap between two boxes, 0 where they overlap on that axis. */
function boxGap(a: Bounds, b: Bounds): number {
	const gapX = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
	const gapY = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
	return Math.hypot(gapX, gapY);
}

/** A cluster and the fragments that were absorbed into it -- kept apart so the id can ignore them. */
interface Component {
	host: StrokeGeometry[];
	absorbed: StrokeGeometry[];
}

/**
 * Folds every fragment cluster into its nearest real neighbour, so a speck does not become an entry.
 *
 * The host keeps its own strokes for the purpose of identity: `anchorStrokeId` is computed over
 * `host` alone, so absorbing a fragment never changes the F15 block id of the note that takes it in.
 * Letting the fragment's CRDT id compete would rewrite the id of every note that has one, breaking the
 * reader's links into it, for no gain they can see.
 *
 * A page whose clusters are *all* fragments keeps them: there is nothing to absorb into, and dropping
 * them would lose the page's only ink. Deterministic as F16 requires -- fragments are taken in cluster
 * order and ties on distance go to the earlier host.
 */
function absorbFragments(components: StrokeGeometry[][], lineHeightPx: number): Component[] {
	const boxes = components.map((component) => unionBounds(component));
	const hosts = components.filter((_, index) => !isFragment(boxes[index], lineHeightPx));
	if (hosts.length === 0) return components.map((component) => ({ host: component, absorbed: [] }));

	const result: Component[] = hosts.map((component) => ({ host: component, absorbed: [] }));
	const hostBoxes = result.map((component) => unionBounds(component.host));

	const orphans: StrokeGeometry[][] = [];
	components.forEach((component, index) => {
		if (!isFragment(boxes[index], lineHeightPx)) return;
		let best = -1;
		let bestGap = Number.POSITIVE_INFINITY;
		hostBoxes.forEach((hostBox, hostIndex) => {
			const gap = boxGap(boxes[index], hostBox);
			// Strictly nearer, so an exact tie stays with the earlier host and the result is a pure
			// function of the input, as F16 requires.
			if (gap < bestGap) {
				bestGap = gap;
				best = hostIndex;
			}
		});
		// Nothing near enough: it stays an entry of its own rather than crossing the page to find a host.
		if (best < 0 || bestGap > lineHeightPx * FRAGMENT_MAX_GAP) orphans.push(component);
		else result[best].absorbed.push(...component);
	});

	return [...result, ...orphans.map((component) => ({ host: component, absorbed: [] }))];
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
 * entries in the digest. The failure mode is visible in the note (one entry too many), never silent
 * loss.
 *
 * That was first written because every note on the original 7 fixture pages was a single line. It no
 * longer is -- the refreshed fixture holds a 12-line summary and a 9-line list -- and the rule
 * survives on measurement instead. Nine merge rules were built and run over every page with real OCR
 * under each cluster, and each one broke a real case: the two overlapping notes named above have boxes
 * that overlap on *both* axes, exactly as two lines of one paragraph do, so no gap rule separates them;
 * a left-edge rule that does keep them apart splits an indented paragraph instead. Both features that
 * could break the tie are dead -- all 2450 ink strokes of the fixture share one timestamp CRDT id, and
 * the pair's stroke indices are adjacent. Merging also *grows* the rectangles by a third, since a block's
 * box takes its whitespace with it. See `.scratch/pdf-annotation/issues/15-paragraph-clusters.md`.
 *
 * Fragments are the one exception, and they are not notes at all -- see {@link FRAGMENT_MAX_HEIGHT}.
 */
export function clusterStrokes(strokes: RmStroke[], lineHeightPx: number): StrokeCluster[] {
	const inked: StrokeGeometry[] = [];
	strokes.forEach((stroke, index) => {
		const bounds = strokeBounds(stroke);
		if (bounds) inked.push({ index, bounds, centerY: (bounds.minY + bounds.maxY) / 2 });
	});

	const clusters = absorbFragments(linkedComponents(inked, lineHeightPx), lineHeightPx)
		.map(({ host, absorbed }) => {
			const ordered = [...host, ...absorbed].sort((a, b) => a.index - b.index);
			return {
				strokes: ordered.map(({ index }) => strokes[index]),
				bounds: unionBounds(ordered),
				// Over the host only: an absorbed fragment must not move the note's F15 id.
				anchorStrokeId: host
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
