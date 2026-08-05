// The PDF text layer, as the annotation digest needs it (spec F11): the sentence a highlight sits
// in, and the section headings a margin note can be anchored to. Everything is reachable through
// `PdfTextDocument`, so the extractor behind it (today Obsidian's bundled pdf.js, tomorrow maybe
// `unpdf`) can be swapped without touching a single caller.
//
// Obsidian's pdf.js costs 0 bundle bytes but ships no types and drifts in version with the app, so
// every optional feature is probed at runtime and every failure degrades to null instead of
// throwing: a scanned PDF has no text layer at all, and the digest must still be written (F4).

import * as obsidian from "obsidian";
// A box in PDF user space: bottom-left origin, PDF points. Defined beside `sceneRectToPdf`, the
// function that produces one, and re-exported here so a consumer of the text layer needs only this
// module. Type-only, so nothing of the renderer (or pdf-lib) is pulled in at runtime.
import type { PdfRect } from "./pdf-renderer";

export type { PdfRect };

/** One visual line of the text layer, its box in PDF points. */
export interface PdfTextLine {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PdfPageText {
	/** The page's own label when the PDF numbers its pages (roman front matter, offset chapters), else the 1-based index. */
	label: string;
	width: number;
	height: number;
	/** Top-down; items within a line left-to-right. */
	lines: PdfTextLine[];
}

/** A section heading with the position it points at. `y` is null when the destination names no coordinate (a `Fit` destination means "this page", i.e. its top); `x` is null whenever the destination carries no left edge, and on a multi-column page that leaves the column it sits in unknown. `title` arrives cleaned (see {@link cleanHeadingTitle}), and a title that cleans to nothing is not reported as a heading at all -- so nothing downstream learns about the junk a typeset title can carry. */
export interface PdfHeading {
	pageIndex: number;
	x: number | null;
	y: number | null;
	title: string;
}

/** Control characters, soft hyphen (U+00AD), zero-width space (U+200B), BOM (U+FEFF) and the replacement character (U+FFFD) -- written as escapes because they are invisible in the source too. Deliberately not `\p{Cf}` as a class: that would also strip ZWJ/ZWNJ, which carry meaning in Indic and Arabic scripts. */
const INVISIBLES = /[\p{Cc}\u00ad\u200b\ufeff\ufffd]/gu;
/** Leading ornaments: Unicode symbols plus the bullet characters, repeatedly, with the whitespace behind them. Bullets are named because `•` is punctuation (`Po`), not a symbol, and it is the commonest ornament of all. */
const LEADING_ORNAMENTS = /^(?:[\p{S}•‣⁃·∙◦]+\s*)+/u;

/**
 * A heading title as the digest may print it: the typeset page's ornaments removed, everything that
 * locates the section kept.
 *
 * The title is the digest's only heading (digest-presentation ticket 03), so a `■` the PDF's outline
 * carries for decoration lands as the loudest text on the page. Numbering and punctuation stay --
 * `1.1` is a locator, and a title opening with `»`, `(` or `§` keeps its first character. Known cost:
 * a currency sign is a `\p{S}`, so `€ 5 Budget` loses it; a heading opening with a bare currency sign
 * is rarer than one opening with an ornament.
 *
 * "" means the title held nothing else, and the caller drops the heading entirely: it cannot become a
 * section, cannot be looked up as one, and cannot be an anchor.
 */
export function cleanHeadingTitle(title: string): string {
	return title.replace(INVISIBLES, "").replace(LEADING_ORNAMENTS, "").replace(/\s+/g, " ").trim();
}

/**
 * Where a point sits in the page's reading order: the index of the line nearest it.
 *
 * The lookup that needs this is "which section is this annotation in", and on a two-column page y
 * cannot answer it -- the right column's first heading sits higher on the page than the left
 * column's last line while coming after it in the text. `lines` is already in reading order, so an
 * index into it is the order that question is really asking about.
 */
export function readingIndex(page: PdfPageText, x: number, y: number): number {
	let best = 0;
	let bestDistance = Number.POSITIVE_INFINITY;
	page.lines.forEach((line, index) => {
		const gapX = Math.max(0, line.x - x, x - (line.x + line.width));
		const gapY = Math.max(0, line.y - y, y - (line.y + line.height));
		const distance = Math.hypot(gapX, gapY);
		// Strictly nearer, so a tie goes to the earlier line and the digest stays byte-identical
		// across the rewrite every sync performs (F16).
		if (distance < bestDistance) {
			best = index;
			bestDistance = distance;
		}
	});
	return best;
}

export interface PdfTextDocument {
	pageCount: number;
	/** Null when the page carries no text layer -- a scanned page, or one pdf.js cannot read. */
	page(pageIndex: number): Promise<PdfPageText | null>;
	/** Empty is a valid answer: plenty of PDFs have neither an outline nor recognizably larger headings. */
	headings(): Promise<PdfHeading[]>;
}

/** One `getTextContent()` item reduced to what line building needs: its box in PDF points (pdf.js puts the text origin in `transform[4]`/`transform[5]`). */
export interface RawTextItem {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** How far two items' baselines may sit apart and still be one line, as a fraction of their height. */
const LINE_TOLERANCE = 0.5;
/** The gap that earns a space between two items, as a fraction of their height: kerning stays well under it, a real word gap well over. */
const SPACE_GAP = 0.2;

/** True for an item that carries no glyph of its own -- pdf.js emits these where the PDF draws a space. */
function isBlank(item: RawTextItem): boolean {
	return item.text.trim().length === 0;
}

/**
 * Items arrive in content-stream order, which is not reading order (pdf.js issue 17191), so lines
 * are rebuilt from the geometry: group by baseline, then sort within the line by x.
 *
 * Blank items are kept through the grouping because they are the document's own word boundaries (see
 * `buildLine`); a line that holds nothing else is dropped, since it contributes no text and would
 * otherwise skew the line-spacing and heading measurements that count lines.
 *
 * A baseline group is one *visual* line, which on a multi-column page is one line per column glued
 * together. `findGutters` decides whether that is what happened; where it finds nothing -- every
 * single-column page -- the groups pass through untouched.
 */
export function groupTextLines(items: RawTextItem[]): PdfTextLine[] {
	const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
	const groups: RawTextItem[][] = [];

	for (const item of sorted) {
		const group = groups[groups.length - 1];
		const reference = group?.[0];
		if (reference && Math.abs(reference.y - item.y) <= LINE_TOLERANCE * Math.max(reference.height, item.height)) group.push(item);
		else groups.push([item]);
	}

	const rows = groups.filter((group) => group.some((item) => !isBlank(item)));
	const gutters = findGutters(rows);
	return (gutters.length === 0 ? rows : columnOrder(rows, gutters)).map(buildLine);
}

// --- columns ------------------------------------------------------------------------------------
// A two-column page baselines its columns against each other, so grouping by baseline alone glues
// them into one line: on the acceptance paper the heading `1 Introduction` came out as `1
// Introduction generalization capabilities of LLMs can lead to highly variable`, and every quote
// below it alternated between the columns sentence by sentence.
//
// Nothing in a PDF declares its columns, so they are read off the page's own geometry: a gutter is
// a vertical corridor the text leaves empty. Plenty of things leave one -- a bullet's indent, a
// table of contents' page numbers, a hanging indent -- so a candidate has to survive both tests
// below, and the one that does most of the work is the width: those all break at a consistent x,
// and none of them leaves a column beside it. A page with no gutter comes out exactly as it did
// before columns existed, which is every single-column page in the sample corpus.

/** A vertical band of the page that carries no glyphs, in PDF points. */
interface Gutter {
	start: number;
	end: number;
}

/**
 * How wide a gap must be to be a candidate gutter, as a multiple of the line's height.
 *
 * There is less room here than a gutter's appearance suggests. The acceptance paper sets 9pt type
 * with a 10.9pt gutter, i.e. 1.21 -- so anything at 1.5 misses it entirely, which is how the bug was
 * first missed. Below 0.8 the sample corpus starts splitting single-column pages. One line height is
 * the middle of what is left.
 */
const GUTTER_MIN_RATIO = 1;
/**
 * What share of the lines *reaching across* a band must stop at it for it to be a gutter.
 *
 * The denominator is deliberately not the page's line count. A line that lives entirely in one
 * column cannot break at the gutter and cannot cross it either, so counting it would let a page's
 * layout decide the threshold rather than its columns: page 11 of the acceptance paper is two-column
 * throughout, but only its first line has text at the same baseline in both, and against all 84 lines
 * that one vote is noise. Among the lines that do reach across, it is unanimous.
 */
const GUTTER_QUORUM_RATIO = 0.25;
/** The floor under the quorum: three lines agreeing is the least that can be told apart from an accident of typesetting. */
const GUTTER_MIN_LINES = 3;
/** How much of the page's text width a column must claim. This is what keeps a bullet list, a line-number strip or a hanging indent from passing as a column: each breaks at a consistent x, but leaves nothing worth calling a column beside it. */
const COLUMN_MIN_WIDTH = 0.2;

/** The gaps in one baseline group wide enough to be a column gutter. Blanks are ignored throughout: they carry no glyph, so a blank sitting in the gutter must not bridge it. */
function wideGaps(group: RawTextItem[]): Gutter[] {
	const items = group.filter((item) => !isBlank(item)).sort((a, b) => a.x - b.x);
	const height = Math.max(...items.map((item) => item.height));
	if (!(height > 0)) return [];

	const gaps: Gutter[] = [];
	// Items can overlap, so the running right edge is the maximum so far, not the previous item's.
	let right = items[0].x + items[0].width;
	for (const item of items.slice(1)) {
		if (item.x - right > GUTTER_MIN_RATIO * height) gaps.push({ start: right, end: item.x });
		right = Math.max(right, item.x + item.width);
	}
	return gaps;
}

/**
 * The page's gutters, left to right, or empty when its lines do not agree on one.
 *
 * A band that enough lines break at is proposed, then put to the vote of every line that reaches
 * across it: the ones that stop at the band are for, the ones whose glyphs run through it -- a
 * full-width abstract over a two-column body -- are against. The width test is the last word, and
 * the one that matters most: a bullet list, a hanging indent and a line-number strip all break at a
 * consistent x and would carry the vote, but none of them leaves a column beside it.
 */
function findGutters(rows: RawTextItem[][]): Gutter[] {
	const gaps = rows.flatMap(wideGaps);
	if (gaps.length < GUTTER_MIN_LINES) return [];

	const glyphs = rows.flatMap((row) => row.filter((item) => !isBlank(item)));
	const left = Math.min(...glyphs.map((item) => item.x));
	const right = Math.max(...glyphs.map((item) => item.x + item.width));
	const minColumn = COLUMN_MIN_WIDTH * (right - left);

	const gutters: Gutter[] = [];
	// The columns have to be worth the split, so a band is only taken when it leaves enough room on
	// both sides -- measured against the last band taken, which is what makes three columns work.
	let edge = left;
	for (const band of candidateBands(gaps, GUTTER_MIN_LINES)) {
		if (band.start - edge < minColumn || right - band.end < minColumn) continue;
		if (!carried(rows, band)) continue;
		gutters.push(band);
		edge = band.end;
	}
	return gutters;
}

/**
 * Whether `band` is a column gutter, decided by the lines around it.
 *
 * Two things have to hold. It has to be a corridor -- enough lines have to stand on each side of it,
 * which is what a ragged right margin can never produce (every line starts at the left margin, so
 * the right of any interior band is empty) and what a bullet or a hanging indent produces only on
 * one side. And the lines that do run past it have to respect it: a page whose glyphs cross the band
 * is not two columns, unless enough *other* lines stop at it -- the abstract of a paper's first page
 * runs the full width over a body that is already in columns.
 */
function carried(rows: RawTextItem[][], band: Gutter): boolean {
	let left = 0;
	let right = 0;
	let flanking = 0;
	let crossing = 0;

	for (const row of rows) {
		const glyphs = row.filter((item) => !isBlank(item));
		if (glyphs.some((item) => item.x < band.end && item.x + item.width > band.start)) {
			crossing++;
			continue;
		}
		const before = glyphs.some((item) => item.x + item.width <= band.start);
		const after = glyphs.some((item) => item.x >= band.end);
		if (before) left++;
		if (after) right++;
		if (before && after) flanking++;
	}

	if (left < GUTTER_MIN_LINES || right < GUTTER_MIN_LINES) return false;
	return crossing === 0 || flanking >= GUTTER_QUORUM_RATIO * (flanking + crossing);
}

/**
 * The candidate bands: for each cluster of overlapping gaps, the stretch where the most of them
 * overlap. The peak rather than the whole cluster, because the cluster is as wide as its widest
 * member -- one short line leaves a gap running half across the page, and a band that wide would
 * swallow the column beside it.
 */
function candidateBands(gaps: Gutter[], minimum: number): Gutter[] {
	const edges = [...gaps.map((gap) => ({ x: gap.start, delta: 1 })), ...gaps.map((gap) => ({ x: gap.end, delta: -1 }))].sort((a, b) => a.x - b.x || a.delta - b.delta);

	// One pass builds the overlap count over x as a run of segments, the next reads the peaks off it.
	const segments: { start: number; end: number; count: number }[] = [];
	let count = 0;
	let previous = edges[0].x;
	for (const edge of edges) {
		if (edge.x > previous && count > 0) segments.push({ start: previous, end: edge.x, count });
		count += edge.delta;
		previous = edge.x;
	}

	const bands: Gutter[] = [];
	for (let index = 0; index < segments.length; ) {
		let end = index;
		while (end + 1 < segments.length && segments[end + 1].start === segments[end].end) end++;
		const cluster = segments.slice(index, end + 1);
		index = end + 1;

		const peak = Math.max(...cluster.map((segment) => segment.count));
		if (peak < minimum) continue;
		// The peak can be reached more than once in a cluster; the widest run of it is the gutter.
		let best: Gutter | null = null;
		let start: number | null = null;
		for (const segment of cluster) {
			if (segment.count !== peak) {
				start = null;
				continue;
			}
			start ??= segment.start;
			if (!best || segment.end - start > best.end - best.start) best = { start, end: segment.end };
		}
		if (best) bands.push(best);
	}
	return bands;
}

/** Which column an x falls in. A blank item inside the gutter goes to the column on its left, where the line it ends was. */
function columnOf(x: number, gutters: Gutter[]): number {
	let index = 0;
	while (index < gutters.length && x >= gutters[index].end) index++;
	return index;
}

/** True when the line runs across a gutter instead of stopping at it -- a full-width title, abstract or footer, which is one line and not two. */
function spansGutter(row: RawTextItem[], gutters: Gutter[]): boolean {
	return row.some((item) => !isBlank(item) && gutters.some((gutter) => item.x < gutter.end && item.x + item.width > gutter.start));
}

/**
 * Reading order: the rows regrouped so that each column runs top to bottom before the next one
 * starts, which is what every consumer downstream assumes -- `quoteForRects` treats neighbouring
 * rows as neighbouring text, and `fontSizeHeadings` reads a heading off a single row.
 *
 * A full-width row closes the block above it and opens a new one, so a page that is single-column at
 * the top and two-column below (a paper's first page) comes out in the order it is read in.
 */
function columnOrder(rows: RawTextItem[][], gutters: Gutter[]): RawTextItem[][] {
	const ordered: RawTextItem[][] = [];
	let block: RawTextItem[][][] = [];

	const flush = () => {
		for (const column of block) if (column) ordered.push(...column);
		block = [];
	};

	for (const row of rows) {
		if (spansGutter(row, gutters)) {
			flush();
			ordered.push(row);
			continue;
		}
		const columns = new Map<number, RawTextItem[]>();
		for (const item of row) {
			const index = columnOf(item.x, gutters);
			const column = columns.get(index) ?? [];
			column.push(item);
			columns.set(index, column);
		}
		for (const [index, items] of [...columns].sort((a, b) => a[0] - b[0])) {
			if (!items.some((item) => !isBlank(item))) continue;
			(block[index] ??= []).push(items);
		}
	}
	flush();

	return ordered;
}

/**
 * One line's text and box.
 *
 * The text is joined from every item, blanks included: where the PDF draws an explicit space, that
 * item *is* the word boundary, and it is exact where the gap heuristic below is not. The heuristic
 * scales its threshold with the font size, which silently drops the spaces of any document whose
 * space advance does not scale with it -- on the acceptance document a heading's 2.61 pt word gap
 * fell under the 2.70 pt threshold its 13.5 pt type earned, and every section heading came out as
 * `Seiklarunddirekt`. The heuristic stays for the PDFs that emit no blank items at all.
 *
 * The box is measured over the glyphs alone. A trailing blank would stretch `width` past the text it
 * is supposed to measure, and `markedRange` maps rectangles onto characters by that ratio.
 */
function buildLine(group: RawTextItem[]): PdfTextLine {
	const items = [...group].sort((a, b) => a.x - b.x);
	let text = "";
	let previous: RawTextItem | null = null;
	for (const item of items) {
		// One space per boundary however wide the item is: a run of them says "a word ends here", not
		// "indent by four", and the callers that quote a line read it as prose.
		if (isBlank(item)) {
			if (text.length > 0 && !/\s$/.test(text)) text += " ";
			continue;
		}
		if (previous && needsSpace(previous, item, text)) text += " ";
		text += item.text;
		previous = item;
	}

	const glyphs = items.filter((item) => !isBlank(item));
	const x = Math.min(...glyphs.map((item) => item.x));
	const right = Math.max(...glyphs.map((item) => item.x + item.width));
	const y = Math.min(...glyphs.map((item) => item.y));
	const top = Math.max(...glyphs.map((item) => item.y + item.height));
	return { text: text.trim(), x, y, width: right - x, height: top - y };
}

/** pdf.js splits inconsistently at spaces (issues 14497, 9998), so the gap decides -- unless one side already carries the space. */
function needsSpace(previous: RawTextItem, item: RawTextItem, text: string): boolean {
	if (/\s$/.test(text) || /^\s/.test(item.text)) return false;
	return item.x - (previous.x + previous.width) > SPACE_GAP * Math.max(previous.height, item.height);
}

interface LineSpan {
	start: number;
	end: number;
}

/**
 * Joins lines back into running text and drops the hyphen at a hyphenated line break. pdf.js does
 * no de-hyphenation at all (issue 18201); the hyphen-between-letters rule is a heuristic and gets
 * genuinely hyphenated compounds wrong at exactly the wrong place -- a line end.
 */
export function dehyphenate(lines: string[]): string {
	return joinLines(lines).text;
}

/** `dehyphenate` plus where each line landed, which is how `quoteForRects` keeps the marked run addressable in the joined text. */
function joinLines(lines: string[]): { text: string; spans: LineSpan[] } {
	const spans: LineSpan[] = [];
	let text = "";
	let last: LineSpan | null = null;

	for (const raw of lines) {
		const line = raw.trim();
		if (line.length === 0) {
			spans.push({ start: text.length, end: text.length });
			continue;
		}
		if (text.length > 0) {
			if (/\p{L}-$/u.test(text) && /^\p{L}/u.test(line)) {
				text = text.slice(0, -1);
				if (last) last.end--;
			} else text += " ";
		}
		const span = { start: text.length, end: text.length + line.length };
		text += line;
		spans.push(span);
		last = span;
	}

	return { text, spans };
}

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "…"]);

/** A terminator only ends a sentence when the text does, or when what follows starts like a new one -- which keeps "Fig. 2" or "no. 4" from splitting a quote in half. */
function isSentenceEnd(text: string, index: number): boolean {
	if (!SENTENCE_TERMINATORS.has(text[index])) return false;
	const rest = text.slice(index + 1);
	if (rest.trim().length === 0) return true;
	return /^["'”’)\]]*\s+["'“„«(]*\p{Lu}/u.test(rest);
}

/** Expands a character range to the sentence containing it, or to the text bounds when no boundary is found. */
export function sentenceAround(text: string, start: number, end: number): { start: number; end: number } {
	let from = 0;
	for (let i = start - 1; i >= 0; i--) {
		if (isSentenceEnd(text, i)) {
			from = i + 1;
			break;
		}
	}
	while (from < start && /\s/.test(text[from])) from++;

	let to = text.length;
	for (let i = Math.max(end - 1, from); i < text.length; i++) {
		if (isSentenceEnd(text, i)) {
			to = i + 1;
			break;
		}
	}

	return { start: from, end: Math.max(to, end) };
}

/**
 * How much of a line's height a rectangle must cover to count as marking it. A reMarkable text
 * highlight is line-snapped on the device, so a true hit covers most of the line; the threshold
 * keeps a rectangle that merely grazes the line above or below from dragging it into the quote.
 */
const MIN_LINE_OVERLAP = 0.3;

/** The part of `line.text` the rectangles cover, sliced by x-overlap and widened to whole words; null when they miss the line. */
function markedRange(line: PdfTextLine, rects: PdfRect[]): { start: number; end: number } | null {
	let left = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;

	for (const rect of rects) {
		const overlap = Math.min(rect.y + rect.height, line.y + line.height) - Math.max(rect.y, line.y);
		if (overlap <= (line.height > 0 ? MIN_LINE_OVERLAP * line.height : 0)) continue;
		if (rect.x >= line.x + line.width || rect.x + rect.width <= line.x) continue;
		left = Math.min(left, Math.max(rect.x, line.x));
		right = Math.max(right, Math.min(rect.x + rect.width, line.x + line.width));
	}
	if (left > right) return null;
	if (line.width <= 0) return { start: 0, end: line.text.length };

	// Proportional, i.e. assuming an even character width: item-level accuracy is enough here, and
	// widening to word boundaries absorbs the error that is left.
	const length = line.text.length;
	const start = clamp(Math.round(((left - line.x) / line.width) * length), 0, length);
	const end = clamp(Math.round(((right - line.x) / line.width) * length), start, length);
	return expandToWords(line.text, start, end);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function expandToWords(text: string, start: number, end: number): { start: number; end: number } {
	let from = start;
	let to = end;
	while (from > 0 && !/\s/.test(text[from - 1])) from--;
	while (to < text.length && !/\s/.test(text[to])) to++;
	return { start: from, end: to };
}

/**
 * How far apart two lines may sit, as a multiple of the page's usual line spacing, and still read as
 * one running paragraph. A heading or a paragraph break leaves a much wider gap than a line break
 * does, and a sentence never runs across one -- but headings carry no terminator, so without this
 * the backward sentence scan runs straight through them and drags them into the quote.
 */
const PARAGRAPH_GAP_RATIO = 1.5;
/**
 * How far apart two line heights may be, in PDF points, and still be the same type size.
 *
 * Measured across the sample documents: of 2696 line pairs close enough to read as one paragraph,
 * 2659 have exactly equal heights and the rest differ by 0.4 pt. Every pair above this threshold is
 * a block boundary -- which makes a change of size a second, sharper test for `separated` than the
 * gap alone. The acceptance paper needs it: its `1 Introduction` sits 13.9 pt above the body it
 * heads, against a 12.8 pt line spacing, so on the gap alone it reads as the paragraph's first line
 * and the quote opens with the heading.
 */
const SAME_SIZE_PT = 0.5;
/**
 * Which gap, from the bottom of the sorted list, is taken to be the line spacing. Not the mode: a
 * page of short paragraphs has more breaks than line breaks (the acceptance page has 19 against 15,
 * so its modal gap is a break). Not the minimum either, which one stray line would set. The lower
 * quartile is the smallest gap that a run of outliers cannot move.
 */
const LINE_SPACING_QUANTILE = 0.25;

/** The type size that carries most of the page's text, weighted by characters. Null for a page with no lines. */
function bodyTextSize(lines: PdfTextLine[]): number | null {
	const sizes: { height: number; chars: number }[] = [];
	for (const line of lines) {
		const size = sizes.find((candidate) => Math.abs(candidate.height - line.height) <= SAME_SIZE_PT);
		if (size) size.chars += line.text.length;
		else sizes.push({ height: line.height, chars: line.text.length });
	}
	return sizes.reduce<{ height: number; chars: number } | null>((best, size) => (best === null || size.chars > best.chars ? size : best), null)?.height ?? null;
}

/**
 * The page's usual baseline-to-baseline distance within a paragraph. Null when the page has no two
 * lines of body text to measure.
 *
 * Only gaps between two body-size lines count. A figure's tick labels, a table's cells and a
 * formula's sub- and superscripts all break into lines of their own that sit a point or two apart,
 * and on a page made mostly of figures they outnumber the body: page 35 of the AHE paper has 88
 * gaps of which 22 fall under 4 pt, so the quartile landed on 3.7 pt where the body sets 10.9. Every
 * tolerance measured in line heights then shrank to a third -- and the handwriting beside that
 * page's last paragraph came through as five margin notes, one per pen stroke.
 */
export function bodyLineSpacing(lines: PdfTextLine[]): number | null {
	const body = bodyTextSize(lines);
	if (body === null) return null;

	const gaps: number[] = [];
	for (let index = 1; index < lines.length; index++) {
		const gap = lines[index - 1].y - lines[index].y;
		if (gap <= 0) continue;
		if (Math.abs(lines[index - 1].height - body) > SAME_SIZE_PT || Math.abs(lines[index].height - body) > SAME_SIZE_PT) continue;
		gaps.push(gap);
	}
	if (gaps.length === 0) return null;

	gaps.sort((a, b) => a - b);
	return gaps[Math.floor((gaps.length - 1) * LINE_SPACING_QUANTILE)];
}

/** True when a heading or a paragraph break separates the two lines, i.e. the quote must not reach across. Either the gap gives it away, or the change of type size does. */
function separated(above: PdfTextLine, below: PdfTextLine, spacing: number | null): boolean {
	if (Math.abs(above.height - below.height) > SAME_SIZE_PT) return true;
	return spacing !== null && above.y - below.y > PARAGRAPH_GAP_RATIO * spacing;
}

/** `text` with every whitespace character removed, and the source offset each kept character came from. */
function stripWhitespace(text: string): { stripped: string; offsets: number[] } {
	let stripped = "";
	const offsets: number[] = [];
	for (let index = 0; index < text.length; index++) {
		if (/\s/.test(text[index])) continue;
		stripped += text[index];
		offsets.push(index);
	}
	return { stripped, offsets };
}

/**
 * Where the `.rm` file's own highlight text sits in the joined context. The rectangles are
 * authoritative for *where* a highlight is, the recorded text for *what* it says -- so wherever the
 * two can be reconciled, the recorded text wins over the proportional x-slice estimate.
 *
 * Matched with whitespace removed from both sides, because neither side's spacing can be trusted:
 * the recorded text carries the document's line wrap, and it also *loses* spaces where the reader
 * concatenated two runs -- it stores `budget_tokenseinen 400-Fehler` for a passage the text layer
 * reads as `budget_tokens einen 400-Fehler`. Collapsing runs was not enough for that, and the
 * mismatch dropped the highlight back to the proportional estimate, which opens its `==` mid-word.
 *
 * Null when it does not occur at all, which leaves the caller its estimate.
 */
function locateHighlight(text: string, highlight: string, near: number): { start: number; end: number } | null {
	const { stripped, offsets } = stripWhitespace(text);
	const needle = stripWhitespace(highlight).stripped;
	if (needle.length === 0) return null;

	let best: { start: number; end: number } | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	// The same words can occur several times in one context; the rectangles say which one is meant.
	for (let at = stripped.indexOf(needle); at >= 0; at = stripped.indexOf(needle, at + 1)) {
		const start = offsets[at];
		const distance = Math.abs(start - near);
		if (distance >= bestDistance) continue;
		best = { start, end: offsets[at + needle.length - 1] + 1 };
		bestDistance = distance;
	}
	return best;
}

/** Joins the passages of a highlight that skips over text; the reader has to see that something was left out. */
const PASSAGE_SEPARATOR = " … ";

interface LineHit {
	index: number;
	range: { start: number; end: number };
}

/**
 * Splits the hit lines into runs of consecutive ones.
 *
 * A `glyph_def` highlight is not necessarily one contiguous selection: the reader records a
 * selection that skips whole blocks as a single run with a rectangle per covered line, so its hit
 * lines can arrive in several groups with unmarked text in between. Treating first-to-last as one
 * span is what let page 7 of the acceptance document -- 20 rectangles over lines 2-8, 13-16 and
 * 36-42 -- quote the entire page, its headings and its unmarked paragraphs included.
 */
function passages(hits: LineHit[]): LineHit[][] {
	const groups: LineHit[][] = [];
	for (const hit of hits) {
		const group = groups[groups.length - 1];
		if (group && hit.index === group[group.length - 1].index + 1) group.push(hit);
		else groups.push([hit]);
	}
	return groups;
}

/**
 * One passage's quote: the sentence around the lines it covers, plus the covered run verbatim. The
 * neighbouring lines come along because a sentence rarely starts and ends on the highlighted line --
 * but only across a normal line break, never across a heading or a paragraph break.
 */
function quoteForPassage(page: PdfPageText, group: LineHit[], spacing: number | null, highlightText?: string): { sentence: string; marked: string } {
	const first = group[0];
	const last = group[group.length - 1];
	const above = page.lines[first.index - 1];
	const below = page.lines[last.index + 1];
	const from = above && !separated(above, page.lines[first.index], spacing) ? first.index - 1 : first.index;
	const to = below && !separated(page.lines[last.index], below, spacing) ? last.index + 1 : last.index;
	const { text, spans } = joinLines(page.lines.slice(from, to + 1).map((line) => line.text));

	const firstSpan = spans[first.index - from];
	const lastSpan = spans[last.index - from];
	const estimateStart = Math.min(firstSpan.start + first.range.start, firstSpan.end);
	const estimateEnd = Math.max(Math.min(lastSpan.start + last.range.end, lastSpan.end), estimateStart);
	const mark = (highlightText ? locateHighlight(text, highlightText, estimateStart) : null) ?? { start: estimateStart, end: estimateEnd };
	const bounds = sentenceAround(text, mark.start, mark.end);

	return { sentence: text.slice(bounds.start, bounds.end).trim(), marked: text.slice(mark.start, mark.end).trim() };
}

/**
 * The quote for one highlight (F4): the sentences around what the rectangles cover, plus the covered
 * runs verbatim so the renderer can mark them. A highlight that skips over text contributes one
 * passage per contiguous run of lines, joined by an ellipsis.
 *
 * `highlightText` is the `.rm` highlight's own recorded text; when it is given and can be found, it
 * replaces the proportional estimate of the marked run. It spans every passage at once, so it only
 * resolves for a single-passage highlight -- which is all but a handful of them. Every entry of
 * `marked` is a verbatim substring of `sentence`, which is what lets the renderer wrap it in
 * `==...==`.
 *
 * Null when no line is hit -- the caller then falls back to the `.rm` highlight's own text.
 */
export function quoteForRects(page: PdfPageText, rects: PdfRect[], highlightText?: string): { sentence: string; marked: string[] } | null {
	const hits = page.lines
		.map((line, index) => ({ index, range: markedRange(line, rects) }))
		.filter((hit): hit is LineHit => hit.range !== null);
	if (hits.length === 0) return null;

	const spacing = bodyLineSpacing(page.lines);
	const quotes = passages(hits).map((group) => quoteForPassage(page, group, spacing, highlightText));

	return {
		sentence: quotes.map((quote) => quote.sentence).join(PASSAGE_SEPARATOR),
		marked: quotes.map((quote) => quote.marked).filter((run) => run !== ""),
	};
}

// --- pdf.js glue ------------------------------------------------------------------------------
// Obsidian ships no pdf.js typings, so these are hand-rolled and deliberately narrow: only what is
// used, everything optional that the bundled version might not have.

interface PdfJsTextContent {
	items?: unknown[];
}

interface PdfJsPage {
	getTextContent(options?: { includeChars?: boolean }): Promise<PdfJsTextContent | null>;
	/** The MediaBox, `[x0, y0, x1, y1]`. */
	view?: unknown;
}

interface PdfJsOutlineItem {
	title?: unknown;
	dest?: unknown;
	items?: unknown;
}

interface PdfJsDocument {
	numPages?: unknown;
	getPage(pageNumber: number): Promise<PdfJsPage>;
	getPageLabels?: () => Promise<unknown>;
	getOutline?: () => Promise<unknown>;
	getDestination?: (name: string) => Promise<unknown>;
	getPageIndex?: (ref: unknown) => Promise<unknown>;
}

interface PdfJsLib {
	getDocument(params: { data: Uint8Array }): { promise: Promise<PdfJsDocument> };
}

/**
 * Obsidian's own pdf.js, through the documented `loadPdfJs()` API. The presence of that API is
 * probed rather than assumed: it is missing from older app versions, and from the module stub the
 * tests run against, and either way "no pdf.js" is a normal outcome here, not a crash.
 */
async function obsidianPdfJs(): Promise<PdfJsLib> {
	const api = obsidian as unknown as { loadPdfJs?: () => Promise<unknown> };
	if (typeof api.loadPdfJs !== "function") throw new Error("this Obsidian version does not expose loadPdfJs");
	return (await api.loadPdfJs()) as PdfJsLib;
}

/**
 * Opens the source PDF's text layer. Returns null when pdf.js is unavailable or the bytes cannot be
 * opened -- the caller soft-fails to the `.rm` highlight text alone (F4).
 *
 * The loader is injectable so the glue is testable without Obsidian.
 */
export async function loadPdfText(bytes: Uint8Array, loadPdfJsFn: () => Promise<PdfJsLib> = obsidianPdfJs): Promise<PdfTextDocument | null> {
	try {
		const pdfjs = await loadPdfJsFn();
		// A copy, because pdf.js transfers the buffer it is handed to its worker and leaves the
		// caller with a detached one -- and these same bytes are still needed for the composited PDF.
		const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
		return createTextDocument(doc);
	} catch (error) {
		console.warn("Tagged Sync: couldn't read the PDF's text layer, the digest falls back to the highlight text alone", error);
		return null;
	}
}

function createTextDocument(doc: PdfJsDocument): PdfTextDocument {
	const pageCount = typeof doc.numPages === "number" ? doc.numPages : 0;
	// Both the digest and the font-size heading fallback walk the same pages, and text extraction is
	// the expensive part of either -- so a page is read once per document, never per question.
	const pages = new Map<number, Promise<PdfPageText | null>>();
	let labels: Promise<string[] | null> | null = null;
	let headings: Promise<PdfHeading[]> | null = null;

	const readPage = async (pageIndex: number): Promise<PdfPageText | null> => {
		try {
			const page = await doc.getPage(pageIndex + 1);
			const size = pageSize(page.view);
			const lines = groupTextLines(await readTextItems(page));
			if (!size || lines.length === 0) return null;
			labels ??= readPageLabels(doc);
			const label = (await labels)?.[pageIndex];
			return { label: typeof label === "string" && label.length > 0 ? label : String(pageIndex + 1), ...size, lines };
		} catch (error) {
			console.warn(`Tagged Sync: couldn't read the text of PDF page ${pageIndex + 1}`, error);
			return null;
		}
	};

	const textDocument: PdfTextDocument = {
		pageCount,
		page(pageIndex) {
			if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) return Promise.resolve(null);
			const pending = pages.get(pageIndex) ?? readPage(pageIndex);
			pages.set(pageIndex, pending);
			return pending;
		},
		headings() {
			headings ??= readHeadings(doc, textDocument);
			return headings;
		},
	};
	return textDocument;
}

/** The MediaBox rather than the viewport: page placement downstream measures against pdf-lib's page size, which ignores page rotation the same way. */
function pageSize(view: unknown): { width: number; height: number } | null {
	if (!Array.isArray(view) || view.length !== 4 || view.some((value) => typeof value !== "number")) return null;
	const [x0, y0, x1, y1] = view as number[];
	return { width: x1 - x0, height: y1 - y0 };
}

/**
 * `includeChars` is an Obsidian-only extension of `getTextContent()` (documented by PDF++), and the
 * bundled pdf.js version moves with the app -- so the option is offered and its absence tolerated,
 * never assumed. The per-character boxes it adds are not consumed yet: reMarkable rectangles are
 * line-snapped, which makes item-level accuracy enough.
 */
async function readTextContent(page: PdfJsPage): Promise<PdfJsTextContent | null> {
	try {
		return await page.getTextContent({ includeChars: true });
	} catch {
		return await page.getTextContent().catch(() => null);
	}
}

async function readTextItems(page: PdfJsPage): Promise<RawTextItem[]> {
	const content = await readTextContent(page);
	const items: RawTextItem[] = [];

	for (const entry of Array.isArray(content?.items) ? content.items : []) {
		const item = entry as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
		if (typeof item.str !== "string" || item.str.length === 0) continue;
		if (!Array.isArray(item.transform) || item.transform.length < 6) continue;
		const [x, y] = [item.transform[4], item.transform[5]] as unknown[];
		if (typeof x !== "number" || typeof y !== "number") continue;
		// `transform[3]` is the vertical font scale, i.e. the font size -- the fallback for the builds
		// that leave `height` at 0.
		const scale = typeof item.transform[3] === "number" ? Math.abs(item.transform[3]) : 0;
		items.push({
			text: item.str,
			x,
			y,
			width: typeof item.width === "number" ? item.width : 0,
			height: typeof item.height === "number" && item.height > 0 ? item.height : scale,
		});
	}

	return items;
}

async function readPageLabels(doc: PdfJsDocument): Promise<string[] | null> {
	if (typeof doc.getPageLabels !== "function") return null;
	const labels = await doc.getPageLabels().catch(() => null);
	return Array.isArray(labels) ? (labels as string[]) : null;
}

/** The outline is the only authoritative source of section headings; the font-size heuristic runs only where there is none. */
async function readHeadings(doc: PdfJsDocument, textDocument: PdfTextDocument): Promise<PdfHeading[]> {
	const outline = await outlineHeadings(doc);
	return outline.length > 0 ? outline : await fontSizeHeadings(textDocument);
}

async function outlineHeadings(doc: PdfJsDocument): Promise<PdfHeading[]> {
	if (typeof doc.getOutline !== "function") return [];
	const roots = await doc.getOutline().catch(() => null);
	const headings: PdfHeading[] = [];

	// Depth-first, which is document order -- the order a "nearest heading above" lookup expects.
	const visit = async (items: unknown): Promise<void> => {
		if (!Array.isArray(items)) return;
		for (const entry of items as PdfJsOutlineItem[]) {
			const title = cleanHeadingTitle(typeof entry?.title === "string" ? entry.title : "");
			const target = title.length > 0 ? await outlineTarget(doc, entry.dest) : null;
			if (target) headings.push({ ...target, title });
			await visit(entry?.items);
		}
	};
	await visit(roots);

	return headings;
}

/** Resolves an outline entry's destination -- named ones through `getDestination`, page refs through `getPageIndex`. */
async function outlineTarget(doc: PdfJsDocument, dest: unknown): Promise<{ pageIndex: number; x: number | null; y: number | null } | null> {
	try {
		const explicit = typeof dest === "string" ? await doc.getDestination?.(dest) : dest;
		if (!Array.isArray(explicit) || explicit.length === 0 || typeof doc.getPageIndex !== "function") return null;
		const pageIndex = await doc.getPageIndex(explicit[0]);
		if (typeof pageIndex !== "number") return null;
		return { pageIndex, x: destinationX(explicit), y: destinationY(explicit) };
	} catch {
		return null;
	}
}

/** An explicit destination is `[pageRef, {name}, ...args]`; only the types that carry a top coordinate give a y -- a `Fit` destination means the whole page. */
function destinationY(dest: unknown[]): number | null {
	const type = dest[1];
	const name = typeof type === "object" && type !== null && "name" in type ? type.name : type;
	if (name === "XYZ") return typeof dest[3] === "number" ? dest[3] : null;
	if (name === "FitH" || name === "FitBH") return typeof dest[2] === "number" ? dest[2] : null;
	return null;
}

/** Only `XYZ` names a left edge, and it is what says which column the heading is in. Every other destination type leaves it null. */
function destinationX(dest: unknown[]): number | null {
	const type = dest[1];
	const name = typeof type === "object" && type !== null && "name" in type ? type.name : type;
	return name === "XYZ" && typeof dest[2] === "number" ? dest[2] : null;
}

/**
 * How much taller than body text a line must be to read as a heading.
 *
 * A journal's subsection headings barely rise above its body: the acceptance paper sets `1.1 Related
 * surveys` in 10pt over 9pt body, a ratio of 1.11, so at 1.15 every subsection of it went undetected
 * and its highlights were labelled with the last chapter heading instead. Measured over the sample
 * corpus, dropping to 1.10 finds all 11 of them and costs one false heading -- an author line on the
 * title page, which is the cover text this heuristic is already documented to misread. The two
 * single-column documents come out with the same headings either way.
 */
const HEADING_SIZE_RATIO = 1.1;
/** A heading is a label, not a paragraph -- the cap keeps a large-print quote or a cover blurb out. */
const HEADING_MAX_CHARS = 80;
/**
 * The fallback for PDFs without an outline: lines clearly larger than the document's body text.
 * Fragile by nature (it misses headings that are bold-only at body size, and misreads cover text),
 * which is why it never overrides an outline.
 */
async function fontSizeHeadings(textDocument: PdfTextDocument): Promise<PdfHeading[]> {
	const pages: (PdfPageText | null)[] = [];
	for (let pageIndex = 0; pageIndex < textDocument.pageCount; pageIndex++) pages.push(await textDocument.page(pageIndex));

	const body = modalLineHeight(pages);
	if (body === null) return [];

	const headings: PdfHeading[] = [];
	pages.forEach((page, pageIndex) => {
		page?.lines.forEach((line, index) => {
			if (line.height < body * HEADING_SIZE_RATIO) return;
			const title = cleanHeadingTitle(line.text);
			if (title.length === 0 || title.length > HEADING_MAX_CHARS) return;
			// Only the first line of a larger block is the heading; the rest of it is its continuation.
			const previous = page.lines[index - 1];
			if (previous && Math.abs(previous.height - line.height) < SAME_SIZE_PT) return;
			headings.push({ pageIndex, x: line.x, y: line.y, title });
		});
	});

	return headings;
}

/** Body text is whatever line height occurs most often; a tie goes to the smaller one, since body text is never the larger size. */
function modalLineHeight(pages: (PdfPageText | null)[]): number | null {
	const counts = new Map<number, number>();
	for (const page of pages) {
		for (const line of page?.lines ?? []) {
			const bucket = Math.round(line.height * 2) / 2;
			if (bucket > 0) counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
		}
	}

	let best: number | null = null;
	let bestCount = 0;
	for (const [height, count] of counts) {
		if (count > bestCount || (count === bestCount && best !== null && height < best)) {
			best = height;
			bestCount = count;
		}
	}
	return best;
}
