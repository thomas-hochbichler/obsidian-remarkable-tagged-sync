import { describe, expect, it } from "vitest";
import { resolveAnchor } from "./digest-anchoring";
import type { AnchorCandidates, DigestAnchor } from "./digest-anchoring";
import type { PdfRect, PdfTextLine } from "./pdf-text";

function rect(x: number, y: number, width: number, height: number): PdfRect {
	return { x, y, width, height };
}

function textLine(text: string, x: number, y: number, width: number, height: number): PdfTextLine {
	return { text, x, y, width, height };
}

/** A page with nothing on it, so each test supplies only the candidates it is about. Line height 10 makes the thresholds 10 pt (heading) and 30 pt (highlight). */
function page(overrides: Partial<AnchorCandidates> = {}): AnchorCandidates {
	return { headings: [], highlights: [], lines: [], lineHeight: 10, ...overrides };
}

// --- The fixture page, measured (source PDF page 2, body line height 13.5 pt) ------------------
// The calibration table in the implementation plan. These are real measurements, not invented
// geometry, which is what makes this the regression net for the whole cascade: any change to a
// threshold that breaks a row here would silently mislabel the signed-off sample digest.

const FIXTURE_LINE_HEIGHT = 13.5;

/** The page's section headings with the y their text sits at. */
const FIXTURE_HEADINGS = [
	{ title: "Sei klar und direkt", y: 653 },
	{ title: "Füge Kontext hinzu, um die Leistung zu verbessern", y: 442 },
	{ title: "Verwende Beispiele effektiv", y: 350 },
	{ title: "Strukturiere Prompts mit XML-Tags", y: 151 },
];

/** All nine marker highlights of the page, keyed by their CRDT id, as union rects in PDF points. */
const FIXTURE_HIGHLIGHTS = [
	{ id: "0110", rect: rect(363.2, 693.1, 145.6, 10.1) },
	{ id: "0111", rect: rect(150.5, 626.1, 124.8, 10.1) },
	{ id: "0112", rect: rect(83.4, 481.5, 433.8, 10.1) },
	{ id: "011f", rect: rect(199.1, 413.7, 166.5, 10.1) },
	{ id: "0122", rect: rect(265.0, 321.0, 246.6, 10.1) },
	{ id: "0123", rect: rect(147.4, 242.6, 88.6, 10.4) },
	{ id: "0124", rect: rect(359.4, 174.9, 50.5, 10.1) },
	{ id: "0139", rect: rect(158.1, 121.4, 80.8, 10.1) },
	{ id: "013a", rect: rect(165.8, 43.8, 117.3, 10.1) },
];

/** No text lines: not one of the five notes reaches stage 3, so supplying a text layer here would only hide which stage answered. Stages 3 and 4 have their own tests below. */
const FIXTURE_PAGE: AnchorCandidates = {
	headings: FIXTURE_HEADINGS,
	highlights: FIXTURE_HIGHLIGHTS,
	lines: [],
	lineHeight: FIXTURE_LINE_HEIGHT,
};

/** The fourth note: the one case where the heading is close but wrong. Kept separate because two tests assert against it. */
const NOTE_CLAUDE_VALIDATE = rect(419, 154, 194, 30);

const CALIBRATION: {
	note: string;
	cluster: PdfRect;
	centerY: number;
	nearestHeadingY: number;
	delta: number;
	expected: DigestAnchor;
}[] = [
	{
		note: "Basic Rule ①",
		cluster: rect(186, 643, 148, 31),
		centerY: 658.5,
		nearestHeadingY: 653,
		delta: 5.5,
		expected: { kind: "heading", heading: "Sei klar und direkt" },
	},
	{
		note: "②",
		cluster: rect(394, 438, 25, 20),
		centerY: 448,
		nearestHeadingY: 442,
		delta: 6,
		expected: { kind: "heading", heading: "Füge Kontext hinzu, um die Leistung zu verbessern" },
	},
	{
		note: "③",
		cluster: rect(234, 337, 27, 26),
		centerY: 350,
		nearestHeadingY: 350,
		delta: 0,
		expected: { kind: "heading", heading: "Verwende Beispiele effektiv" },
	},
	{
		note: "→ Claude validate Examples",
		cluster: NOTE_CLAUDE_VALIDATE,
		centerY: 169,
		nearestHeadingY: 151,
		delta: 18,
		expected: { kind: "highlight", highlightId: "0124" },
	},
	{
		note: "④ →Widerspruch zum Artikel allg. PE",
		cluster: rect(291, 132, 322, 43),
		centerY: 153.5,
		nearestHeadingY: 151,
		delta: 2.5,
		expected: { kind: "heading", heading: "Strukturiere Prompts mit XML-Tags" },
	},
];

describe("resolveAnchor on the calibration page", () => {
	it.each(CALIBRATION)("anchors $note", ({ cluster, centerY, nearestHeadingY, delta, expected }) => {
		// The table's own arithmetic, so a mistyped rect fails here rather than skewing the cascade.
		expect(cluster.y + cluster.height / 2).toBe(centerY);
		expect(Math.abs(centerY - nearestHeadingY)).toBeCloseTo(delta, 6);

		expect(resolveAnchor(cluster, FIXTURE_PAGE)).toEqual(expected);
	});

	it("keeps the heading tolerance at exactly one line height: at 1.5 the fourth note would grab the heading", () => {
		// Center y 169, nearest heading y 151, body line height 13.5 pt -- 18 pt, i.e. 1.33 line
		// heights. Inside a 1.5 tolerance, outside a 1.0 one. The note belongs to the highlight
		// `generieren.` at y 175, which stage 2 finds 9.1 pt away, so a wider stage 1 would not just
		// be vague, it would label the note "at the heading" and be wrong.
		const delta = 169 - 151;
		expect(delta).toBeGreaterThan(1.0 * FIXTURE_LINE_HEIGHT);
		expect(delta).toBeLessThanOrEqual(1.5 * FIXTURE_LINE_HEIGHT);

		expect(resolveAnchor(NOTE_CLAUDE_VALIDATE, FIXTURE_PAGE)).toEqual({ kind: "highlight", highlightId: "0124" });
	});
});

describe("resolveAnchor cascade", () => {
	it("falls back to the page when there is nothing to anchor to", () => {
		expect(resolveAnchor(rect(100, 100, 20, 20), page())).toEqual({ kind: "page" });
	});

	it("takes a highlight exactly at the distance threshold", () => {
		const candidates = page({ highlights: [{ id: "h1", rect: rect(150, 100, 10, 20) }] });

		expect(resolveAnchor(rect(100, 100, 20, 20), candidates)).toEqual({ kind: "highlight", highlightId: "h1" });
	});

	it("drops a highlight just past the distance threshold", () => {
		const candidates = page({ highlights: [{ id: "h1", rect: rect(150.1, 100, 10, 20) }] });

		expect(resolveAnchor(rect(100, 100, 20, 20), candidates)).toEqual({ kind: "page" });
	});

	it("takes the nearest line when neither a heading nor a highlight qualifies", () => {
		const candidates = page({
			headings: [{ title: "far above", y: 400 }],
			highlights: [{ id: "h1", rect: rect(300, 300, 50, 10) }],
			lines: [textLine("the far line", 0, 300, 80, 10), textLine("the near line", 0, 130, 80, 10)],
		});

		expect(resolveAnchor(rect(100, 100, 20, 20), candidates)).toEqual({ kind: "line", line: "the near line" });
	});

	it("prefers a heading over a line that sits closer", () => {
		const candidates = page({
			headings: [{ title: "level heading", y: 108 }],
			lines: [textLine("touching line", 0, 120, 80, 10)],
		});

		expect(resolveAnchor(rect(100, 100, 20, 20), candidates)).toEqual({ kind: "heading", heading: "level heading" });
	});

	it("prefers a highlight over a line that sits closer", () => {
		const candidates = page({
			highlights: [{ id: "h1", rect: rect(150, 100, 10, 20) }],
			lines: [textLine("touching line", 0, 120, 80, 10)],
		});

		expect(resolveAnchor(rect(100, 100, 20, 20), candidates)).toEqual({ kind: "highlight", highlightId: "h1" });
	});

	it("ignores the horizontal distance of a heading: only its y decides", () => {
		const candidates = page({ headings: [{ title: "same line, other column", y: 108 }] });

		expect(resolveAnchor(rect(500, 100, 20, 20), candidates)).toEqual({
			kind: "heading",
			heading: "same line, other column",
		});
	});

	it("scores a highlight the cluster overlaps as zero distance on that axis", () => {
		// The note reaches across its highlight's line band, so only the horizontal gap counts.
		const candidates = page({
			highlights: [
				{ id: "near", rect: rect(129, 105, 10, 10) },
				{ id: "far", rect: rect(90, 135, 10, 10) },
			],
		});

		expect(resolveAnchor(rect(100, 100, 20, 20), candidates)).toEqual({ kind: "highlight", highlightId: "near" });
	});
});

describe("resolveAnchor tie-breaking", () => {
	it("gives two equally distant headings to the earlier one", () => {
		const cluster = rect(100, 95, 20, 10);
		const above = { title: "above", y: 105 };
		const below = { title: "below", y: 95 };

		expect(resolveAnchor(cluster, page({ headings: [above, below] }))).toEqual({ kind: "heading", heading: "above" });
		expect(resolveAnchor(cluster, page({ headings: [below, above] }))).toEqual({ kind: "heading", heading: "below" });
	});

	it("gives two equally distant highlights to the earlier one", () => {
		const cluster = rect(100, 100, 20, 20);
		const left = { id: "left", rect: rect(70, 100, 10, 20) };
		const right = { id: "right", rect: rect(140, 100, 10, 20) };

		expect(resolveAnchor(cluster, page({ highlights: [left, right] }))).toEqual({
			kind: "highlight",
			highlightId: "left",
		});
		expect(resolveAnchor(cluster, page({ highlights: [right, left] }))).toEqual({
			kind: "highlight",
			highlightId: "right",
		});
	});

	it("gives two equally distant lines to the earlier one", () => {
		const cluster = rect(100, 100, 20, 20);
		const first = textLine("first", 0, 130, 80, 10);
		const second = textLine("second", 0, 80, 80, 10);

		expect(resolveAnchor(cluster, page({ lines: [first, second] }))).toEqual({ kind: "line", line: "first" });
		expect(resolveAnchor(cluster, page({ lines: [second, first] }))).toEqual({ kind: "line", line: "second" });
	});
});
