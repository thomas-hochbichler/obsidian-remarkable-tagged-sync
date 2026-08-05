// Where a margin note sat on the page, decided from geometry alone (spec F14). The digest turns the
// answer into the note callout's title -- "at the heading", "next to the highlight" -- so this module
// owns the whole cascade and nothing else: no rendering, no I/O, a pure function of the input.
//
// Ticket 06 settled the tone: within the thresholds the nearest candidate wins *silently*. No
// "probably", no hedged wording anywhere in the digest. The cascade's honesty lives in its last
// stage instead -- a note that matches nothing gets "on this page", which claims exactly as much as
// the geometry supports.

import type { PdfRect, PdfTextLine } from "./pdf-text";

export type DigestAnchor =
	| { kind: "heading"; heading: string }
	| { kind: "highlight"; highlightId: string }
	| { kind: "line"; line: string }
	| { kind: "page" };

export interface AnchorCandidates {
	/** Headings on this page with their y in PDF points, bottom-left origin. */
	headings: { title: string; y: number }[];
	/** Highlights on this page: their id and their union rect in PDF points. */
	highlights: { id: string; rect: PdfRect }[];
	/** The page's text lines (PDF points). */
	lines: PdfTextLine[];
	/** Typical line height in PDF points -- the tolerance unit for the whole cascade. */
	lineHeight: number;
}

/**
 * How far a heading's y may sit from the cluster's vertical center and still claim it, in line
 * heights. Exactly 1.0, and this is load-bearing rather than a round number.
 *
 * Calibrated on the fixture page (body line height 13.5 pt): the note `-> Claude validate Examples`
 * has its center at y 169 with the nearest heading at y 151 -- 18 pt away, i.e. 1.33 line heights.
 * It belongs to the highlight `generieren.` at y 175, which stage 2 finds 9 pt away. Widening the
 * tolerance to 1.5 line heights (20.25 pt) makes stage 1 swallow that note and label it "at the
 * heading", and the anchor is then simply wrong. The other four notes on the page sit within 6 pt
 * of their heading, so nothing needs the extra room.
 */
const HEADING_TOLERANCE = 1;

/**
 * How close a highlight must be to claim the note, in line heights, measured between the boxes'
 * edges. Generous compared to the heading tolerance because a margin note sits *beside* its
 * highlight, out in the margin -- the fixture's case is 9 pt of horizontal gap -- while the heading
 * test is about sharing a line and must stay tight.
 */
const HIGHLIGHT_TOLERANCE = 3;

/** A cluster's vertical center: handwriting on one line shares a center band whatever its ascenders and descenders do. */
function centerY(rect: PdfRect): number {
	return rect.y + rect.height / 2;
}

/** Gap between two boxes, 0 on an axis where they overlap -- so a note reaching across its highlight scores the horizontal gap alone. */
function boxDistance(a: PdfRect, b: PdfRect): number {
	const gapX = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
	const gapY = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
	return Math.hypot(gapX, gapY);
}

/**
 * The nearest candidate within `limit`, or null. Ties go to the earlier entry (the comparison is
 * strict), which makes the whole cascade a pure function of the caller's ordering -- the digest is
 * regenerated on every sync (F16) and has to come out byte-identical.
 */
function nearest<T>(candidates: readonly T[], distance: (candidate: T) => number, limit: number): T | null {
	let best: T | null = null;
	let bestDistance = Infinity;
	for (const candidate of candidates) {
		const value = distance(candidate);
		if (value <= limit && value < bestDistance) {
			best = candidate;
			bestDistance = value;
		}
	}
	return best;
}

/**
 * Picks the anchor for one margin-note cluster: heading, else highlight, else nearest text line,
 * else the page itself. `clusterRect` is the cluster's ink box in PDF points.
 *
 * Stage 3 carries no distance limit on purpose. Once a note has missed every heading and every
 * highlight, *some* line of the page is still the most specific true thing that can be said about
 * it, however far away it sits. Stage 4 is therefore reached only when the page has no text layer
 * at all -- a scanned page -- which is exactly the case where "on this page" is the whole truth.
 */
export function resolveAnchor(clusterRect: PdfRect, candidates: AnchorCandidates): DigestAnchor {
	const { headings, highlights, lines, lineHeight } = candidates;
	const center = centerY(clusterRect);

	const heading = nearest(headings, (item) => Math.abs(item.y - center), HEADING_TOLERANCE * lineHeight);
	if (heading) return { kind: "heading", heading: heading.title };

	const highlight = nearest(highlights, (item) => boxDistance(clusterRect, item.rect), HIGHLIGHT_TOLERANCE * lineHeight);
	if (highlight) return { kind: "highlight", highlightId: highlight.id };

	const line = nearest(lines, (item) => boxDistance(clusterRect, item), Infinity);
	if (line) return { kind: "line", line: line.text };

	return { kind: "page" };
}
