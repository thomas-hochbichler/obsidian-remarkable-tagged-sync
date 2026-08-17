// The assembly of the annotation digest (spec F11-F15, F18): it measures, transcribes and writes,
// and hands the result to `renderDigest` for the markdown. Nothing here decides what the digest
// *looks* like, and nothing in `digest-builder.ts` touches a file or an OCR backend.
//
// Every dependency that reaches outside this process -- pdf.js, the OCR backend, the vault -- is
// injected, so the whole pipeline runs in a unit test without Obsidian.
//
// Determinism is a hard requirement (F16): the digest is regenerated inside the managed fence on
// every sync and must come out byte-identical for identical input. So no clock, no randomness, and
// the clusters are transcribed one after another rather than in parallel.

import { resolveAnchor, type DigestAnchor } from "./digest-anchoring";
import { digestId, renderDigest, type DigestHighlight, type DigestNote, type DigestPage, type NoteRegion } from "./digest-builder";
import { findInkMarks, findMarkerMarks, type InkMark, readsAsMark } from "./ink-marks";
import { clusterStrokes, type StrokeCluster, type TextColumn } from "./margin-notes";
import type { OcrStatus } from "./note-builder";
import type { OcrBackend } from "./ocr-backend";
import {
	annotatedPageFit,
	isHighlighterOrShader,
	notebookPageFrame,
	pageFrame,
	resolveDeviceCanvas,
	sceneRectToPdf,
	type DeviceCanvas,
	type PageFit,
	type PdfRect,
} from "./pdf-renderer";
import { sceneHeadings, sceneTextPage } from "./scene-text";
import { bodyLineSpacing, loadPdfText, quoteForRects, readingIndex, type PdfHeading, type PdfPageText, type PdfTextDocument } from "./pdf-text";
import { correctQuote } from "./quote-correction";
import type { RmPage, RmStroke } from "./rm-parser";

export interface DigestPipelineDeps {
	ocrBackend: OcrBackend;
	/**
	 * F20. False drops margin notes whole -- no callout, no transcription -- and stops the work rather
	 * than the rendering: the clusters are never formed, so no OCR process starts. Deliberately not
	 * optional: a default here would decide a shipped product question in a place nobody looks.
	 */
	marginNotes: boolean;
	/** Injected so tests can drive it without Obsidian; defaults to `loadPdfText`. */
	loadText?: (bytes: Uint8Array) => Promise<PdfTextDocument | null>;
	/**
	 * Called once per page of the digest, for the progress bar. It exists here rather than being
	 * handed to `recognize` because this pipeline transcribes *per cluster* -- finer than a page --
	 * and the bar counts pages: the ticks are aggregated by being emitted from the page loop instead.
	 */
	onPage?: () => void;
}

export interface DigestPageInput {
	pageId: string;
	/** 0-based source-PDF page index. */
	sourceIndex: number;
	/** `#page=` anchor into the embed. */
	embedPage: number;
	scene: RmPage | null;
	/**
	 * True for a page the user added on the device behind the PDF's own pages -- its `cPages` entry
	 * carries no `redir`, so it maps to no source page at all (F21).
	 *
	 * Carried here as a fact rather than inferred from `sourceIndex >= document.pageCount`, which looks
	 * equivalent and is not: a PDF that fails to open reports a page count of 0, and every page of the
	 * document would then read as added on the device.
	 */
	appended?: boolean;
}

export interface DigestBuild {
	/** The rendered `## Digest` body, "" when the document has no annotations at all. */
	markdown: string;
	/** Non-fatal problems, surfaced in `SyncResult.skipErrors` -- never silent. */
	warnings: string[];
	/**
	 * What transcribing this document's margin notes came to, worst outcome first. The sync engine
	 * takes its OCR accounting from here instead of running a second pass over the whole scenes: the
	 * clusters have already been through the backend, and the platform notice still needs to know
	 * that Vision could not run.
	 */
	ocr: OcrStatus;
}

/**
 * The line height assumed for a page with no text layer, in PDF points. It is the tolerance unit for
 * both the clustering and the anchor cascade, so there has to be one: 13.5 pt is the body spacing
 * measured on the fixture document and a typical value for 9-11 pt prose.
 */
const FALLBACK_LINE_HEIGHT_PT = 13.5;

function describeError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Whitespace-collapsed, because a callout body is one line: a raw newline from OCR or from the `.rm` text would end it. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function unionRect(rects: PdfRect[]): PdfRect | null {
	if (rects.length === 0) return null;
	const x = Math.min(...rects.map((rect) => rect.x));
	const y = Math.min(...rects.map((rect) => rect.y));
	const right = Math.max(...rects.map((rect) => rect.x + rect.width));
	const top = Math.max(...rects.map((rect) => rect.y + rect.height));
	return { x, y, width: right - x, height: top - y };
}

function clusterRect(cluster: StrokeCluster, frame: DeviceCanvas): PdfRect {
	const { minX, minY, maxX, maxY } = cluster.bounds;
	return sceneRectToPdf({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, frame);
}

/**
 * How far the printed text reaches across the page, in the scene's own frame.
 *
 * The outermost text there is, not the body column: a page number or a running head sits further out
 * than the paragraphs, and taking the paragraphs alone would call the strip they stand in a margin.
 * Null for a page whose text layer holds nothing -- there is no column to speak of, and the clustering
 * falls back to leaving every line its own note.
 */
function textColumn(pageText: PdfPageText, frame: DeviceCanvas): TextColumn | null {
	let left = Infinity;
	let right = -Infinity;
	for (const line of pageText.lines) {
		if (line.text.trim() === "") continue;
		left = Math.min(left, line.x);
		right = Math.max(right, line.x + line.width);
	}
	if (left > right) return null;
	const toScene = (pt: number) => pt / frame.pxToPt - frame.widthPx / 2;
	return { left: toScene(left), right: toScene(right) };
}

/** A one-layer scene holding a single cluster's strokes: the unit the OCR backend is handed. */
function clusterScene(strokes: RmStroke[], formatVersion: number): RmPage {
	return { formatVersion, layers: [{ id: strokes[0].layerId, name: null, strokes }] };
}

/** What one page needs to place its annotations: the transform, its text, and the tolerance unit derived from it. */
interface PageGeometry {
	frame: DeviceCanvas;
	pageText: PdfPageText | null;
	/**
	 * Where the renderer put this page's content on the sheet it wrote out (`annotatedPageFit`): the
	 * identity for a page whose ink stays on the paper, and a shrink for one whose ink runs off it.
	 * Null wherever the frame is a guess, which is the same condition that costs a note its region.
	 */
	fit: PageFit | null;
	/** How far the printed text reaches across this page, in scene px, so the clustering can tell a margin from the text. Null without a text layer. */
	column: TextColumn | null;
	/** This page's own headings, for the anchor cascade -- a note can only be anchored to a heading it sits level with. */
	headings: { title: string; y: number }[];
	/** Every heading in the document, in document order, for the section lookup. */
	documentHeadings: OrderedHeading[];
	lineHeightPt: number;
}

/**
 * A highlight and where it sits. Two frames are in play and they are inverted with respect to each
 * other: `pdfRect` is bottom-left origin for the anchor cascade, while `DigestHighlight.top` is a
 * scene coordinate with y growing *down*, which is what `renderDigest` sorts ascending for reading
 * order. Mixing them up prints every page upside down.
 */
interface PlacedHighlight {
	highlight: DigestHighlight;
	pdfRect: PdfRect | null;
	/** True for a pen mark (F23) rather than a marker highlight the device recorded. See `mergeBySentence`. */
	fromInk?: boolean;
}

/** A margin note plus the anchor that decides whether it stands on its own or nests inside a quote. */
interface PlacedNote {
	note: DigestNote;
	anchor: DigestAnchor;
	/** Top-left corner in PDF points, for the section lookup -- the left edge says which column it is in. */
	pdfLeft: number;
	pdfTop: number;
}

/** Everything the per-document work shares; `warnings` is collected across all pages. */
interface BuildState {
	deps: DigestPipelineDeps;
	warnings: string[];
	/** One entry per transcribed cluster, collapsed into `DigestBuild.ocr` at the end. */
	ocrStatuses: OcrStatus[];
}

/**
 * The document's OCR outcome, worst first: a backend that could not run here outranks one that
 * failed, which outranks a success, which outranks a document that had nothing to transcribe.
 * Ordered this way because the counters it feeds drive a *notice* -- the user needs to hear the
 * worst thing that happened, not the commonest.
 */
function worstOcrStatus(statuses: OcrStatus[]): OcrStatus {
	for (const status of ["unavailable", "failed", "ok"] as const) {
		if (statuses.includes(status)) return status;
	}
	return "skipped";
}

interface PageContext extends BuildState {
	page: DigestPageInput;
	geometry: PageGeometry;
	highlights: PlacedHighlight[];
}

function buildHighlights(page: DigestPageInput, geometry: PageGeometry): PlacedHighlight[] {
	const { frame, pageText } = geometry;
	return (page.scene?.highlights ?? []).map((source) => {
		const rects = source.rects.map((rect) => sceneRectToPdf(rect, frame));
		const found = pageText ? quoteForRects(pageText, rects, source.text) : null;
		return {
			pdfRect: unionRect(rects),
			highlight: {
				id: digestId("hl", page.pageId, source.id),
				// F4's soft fail: without a text layer -- or when the rectangles hit no line -- the
				// device's own recorded text is still the truth about what was highlighted.
				sentence: found?.sentence ?? oneLine(source.text),
				marked: found?.marked ?? [],
				color: source.colorRgba ?? null,
				notes: [],
				section: null,
				top: source.rects.length === 0 ? 0 : Math.min(...source.rects.map((rect) => rect.y)),
			},
		};
	});
}

/**
 * The pen marks on this page as highlights (F23), and the handwriting that is left to cluster.
 *
 * A mark renders exactly as a marker highlight does -- same `==...==`, no distinction. The reader
 * wants the passage, not the tool it was marked with, and the alternative is a second markup nobody
 * asked to learn.
 *
 * **Not gated by F20.** That setting governs transcribing the reader's handwriting, and this is not
 * that: the text of a mark entry comes out of the PDF, exactly as a marker highlight's does. It also
 * makes underlines work where no OCR backend exists at all.
 */
function placeMark(page: DigestPageInput, mark: InkMark): PlacedHighlight {
	return {
		pdfRect: mark.pdfRect,
		fromInk: true,
		highlight: {
			id: digestId("hl", page.pageId, mark.strokeId),
			sentence: mark.sentence,
			marked: mark.marked,
			// A pen has no marker colour, and F9 would not render one anyway; a marker swipe has its own.
			color: mark.color ?? null,
			notes: [],
			section: null,
			top: mark.top,
		},
	};
}

function buildInkMarks(page: DigestPageInput, geometry: PageGeometry, ink: RmStroke[]): { marks: PlacedHighlight[]; strokes: RmStroke[] } {
	if (geometry.pageText === null) return { marks: [], strokes: ink };
	const found = findInkMarks(ink, geometry.pageText, geometry.frame, geometry.lineHeightPt);
	return { strokes: found.strokes, marks: found.marks.map((mark) => placeMark(page, mark)) };
}

/**
 * The passages the reader swiped the marker across, as highlights.
 *
 * Not part of {@link buildInkMarks}: a marker stroke is never handwriting, so there is nothing to
 * hand back and nothing to cluster. It is told apart by the tool it was drawn with, not by its shape.
 */
function buildMarkerMarks(page: DigestPageInput, geometry: PageGeometry): PlacedHighlight[] {
	if (geometry.pageText === null) return [];
	const marker = (page.scene?.layers ?? []).flatMap((layer) => layer.strokes).filter((stroke) => isHighlighterOrShader(stroke.penType));
	return findMarkerMarks(marker, geometry.pageText, geometry.frame, geometry.lineHeightPt).map((mark) => placeMark(page, mark));
}

/**
 * True when both highlights cover the same passage. Containment, not equality: a highlight whose
 * rectangles hit fewer text lines gets a shorter context to expand its sentence in, so the same
 * passage comes back truncated for the smaller runs. On page 6 of the fixture document three of the
 * four runs stop at "... mit einem Prompt wie dem" while the largest reaches the sentence's end --
 * equality would still print that sentence twice.
 */
function coversSameSentence(a: string, b: string): boolean {
	return a !== "" && b !== "" && (a.includes(b) || b.includes(a));
}

/**
 * Merges the highlights of one page that cover the same sentence into one entry carrying all of
 * their runs.
 *
 * The device stores every version of a selection the user adjusted, so one passage arrives as
 * several overlapping `glyph_def` runs -- pages 6 and 7 of the fixture document each print the same
 * sentence four times without this. The survivor is the topmost contributing highlight: its id and
 * its position, so reading order and the F15 id stability of the entry that stays are untouched.
 * `survivorOf` maps every merged-away id to it, so a note anchored to one does not dangle.
 */
function mergeBySentence(placed: PlacedHighlight[]): { highlights: PlacedHighlight[]; survivorOf: Map<string, string> } {
	// Connected components, not first-match. A run can be the one that shows two earlier groups belong
	// together -- on page 8 of the acceptance document the widest of three overlapping selections
	// covers both a group formed before it and one formed after -- and dropping it into whichever it
	// met first left the other printing the same sentence a second time.
	const groups: PlacedHighlight[][] = [];
	for (const item of placed) {
		const matching = groups.filter((members) =>
			members.some((member) => coversSameSentence(member.highlight.sentence, item.highlight.sentence)),
		);
		const [first, ...rest] = matching;
		if (!first) groups.push([item]);
		else {
			first.push(item, ...rest.flat());
			for (const other of rest) groups.splice(groups.indexOf(other), 1);
		}
	}

	const survivorOf = new Map<string, string>();
	const highlights = groups.map((members) => {
		// The topmost contributing highlight survives -- but a marker highlight is preferred over a pen
		// mark (F23) whatever their order, because the entry keeps the survivor's id and the marker's is
		// the older one. A reader who underlines a sentence they had already highlighted would otherwise
		// find every `^hl-` link into it broken on the next sync, which is exactly what F15 promises not
		// to do. Their ink usually sits above the text too, so it would win the position test outright.
		const recorded = members.filter((item) => !item.fromInk);
		const survivor = (recorded.length > 0 ? recorded : members).reduce((best, item) => (item.highlight.top < best.highlight.top ? item : best));
		// The longest sentence is the complete one; the others are its truncated context.
		const longest = members.reduce((best, item) =>
			item.highlight.sentence.length > best.highlight.sentence.length ? item : best,
		);
		for (const member of members) survivorOf.set(member.highlight.id, survivor.highlight.id);
		return {
			...survivor,
			highlight: {
				...survivor.highlight,
				sentence: longest.highlight.sentence,
				marked: members.flatMap((member) => member.highlight.marked),
			},
		};
	});
	return { highlights, survivorOf };
}

function anchorFor(rect: PdfRect, { geometry, highlights }: PageContext): DigestAnchor {
	// Without the page's own size the frame is the device screen, i.e. a guess, and every distance
	// measured in it is a guess too. "On this page" is then the whole truth, and the cascade is not
	// asked a question it cannot answer.
	if (geometry.pageText === null) return { kind: "page" };

	return resolveAnchor(rect, {
		headings: geometry.headings,
		highlights: highlights
			.filter((placed): placed is PlacedHighlight & { pdfRect: PdfRect } => placed.pdfRect !== null)
			.map((placed) => ({ id: placed.highlight.id, rect: placed.pdfRect })),
		lines: geometry.pageText.lines,
		lineHeight: geometry.lineHeightPt,
	});
}

/**
 * Where the reader can be shown this note's handwriting: the embed's page and the ink's box, with y
 * measured from the page top because that is the axis a pdf.js viewport uses. `clusterRect` hands
 * back the PDF's own bottom-left y, which the anchor cascade needs and a viewport does not.
 *
 * Placed by the renderer's own transform rather than read straight off the source page. The two agree
 * for most documents and do not for exactly the notes this feature is for: a page whose ink runs off
 * the paper is drawn shrunk to fit its sheet (`annotatedPageFit`), and a viewport measures what was
 * drawn. Reading the source page's coordinates there would slide every band on such a page sideways.
 *
 * Null without a text layer. The frame is then the *device screen* rather than the page (see
 * `buildDigest`), so the rectangle would not name a place in the PDF at all -- while the embed's own
 * strokes are drawn against the page. Better no button than one that opens the wrong strip of paper;
 * such a document already warns that its text could not be read.
 */
function noteRegion(rect: PdfRect, { page, geometry }: PageContext): NoteRegion | null {
	const { fit } = geometry;
	if (geometry.pageText === null || fit === null) return null;
	const { scale, dx, dy } = fit;
	return {
		page: page.embedPage,
		x: rect.x * scale + dx,
		y: geometry.frame.heightPt - ((rect.y + rect.height) * scale + dy),
		width: rect.width * scale,
		height: rect.height * scale,
	};
}

/** Transcribes one cluster and turns it into a note. Called strictly one cluster at a time -- see `buildNotes`. */
async function buildNote(context: PageContext, cluster: StrokeCluster): Promise<PlacedNote> {
	const { deps, page, geometry, warnings } = context;
	const id = digestId("nt", page.pageId, cluster.anchorStrokeId);
	const scene = clusterScene(cluster.strokes, page.scene?.formatVersion ?? 0);

	let text = "";
	try {
		const result = await deps.ocrBackend.recognize([scene]);
		text = oneLine(result.text);
		context.ocrStatuses.push(result.status);
	} catch (error) {
		context.ocrStatuses.push("failed");
		warnings.push(`Page ${page.embedPage}: a margin note could not be transcribed (${describeError(error)}). Its entry says so and still shows the handwriting on request.`);
	}

	// No image is written, ever: the vault's PDF already has this ink drawn into it, so the entry
	// carries the place instead of a copy. What a reader gets on request is that place, drawn out of
	// the embed -- and a document with no crops in it is the point of the exercise.
	const rect = clusterRect(cluster, geometry.frame);
	const anchor = anchorFor(rect, context);
	return {
		note: { id, anchor, text, region: noteRegion(rect, context), top: cluster.rowTop },
		anchor,
		pdfLeft: rect.x,
		pdfTop: rect.y + rect.height,
	};
}

/**
 * Sequential on purpose. Each `recognize` call spawns its own Vision process, so running the
 * clusters in parallel would multiply the process count by whatever a page happens to contain.
 * Serializing costs one OCR round-trip per margin note and buys a predictable machine load and a
 * deterministic result.
 */
async function buildNotes(context: PageContext, clusters: StrokeCluster[]): Promise<PlacedNote[]> {
	const notes: PlacedNote[] = [];
	for (const cluster of clusters) notes.push(await buildNote(context, cluster));
	return notes;
}

/** A heading placed in document order. A `Fit` destination carries no y and sits at the top of its page, which `Infinity` says. */
interface OrderedHeading {
	pageIndex: number;
	x: number | null;
	y: number;
	title: string;
}

/**
 * Page order, and within a page down the page -- PDF y grows upward, so a larger y comes first.
 *
 * Down-the-page is not reading order on a multi-column page, and `sectionAt` re-decides that part
 * against the page's own lines. What this sort has to get right is the order *across* pages, which
 * is all the rest of the lookup depends on.
 */
function orderHeadings(headings: PdfHeading[]): OrderedHeading[] {
	return headings
		.map((heading) => ({ pageIndex: heading.pageIndex, x: heading.x, y: heading.y ?? Number.POSITIVE_INFINITY, title: heading.title }))
		.sort((a, b) => (a.pageIndex !== b.pageIndex ? a.pageIndex - b.pageIndex : a.y === b.y ? 0 : b.y - a.y));
}

/**
 * How far into a page a point sits, as a number that only has to be comparable with others from the
 * same page. The page's own lines give reading order where there are any; without a text layer
 * there is nothing better than down-the-page, which is what the negated y is.
 */
function pageRank(pageText: PdfPageText | null, x: number | null, y: number): number {
	if (!pageText || pageText.lines.length === 0) return -y;
	// A heading whose destination named no left edge could be in either column; the leftmost one is
	// the better guess, since that is where a section starts.
	return readingIndex(pageText, x ?? Math.min(...pageText.lines.map((line) => line.x)), y);
}

/**
 * The section an entry belongs to: the last heading that comes at or before it *in the document*,
 * not on its page. A page's first annotation usually sits above that page's first heading, and the
 * section it belongs to is then the one still open from an earlier page.
 *
 * Within the entry's own page the comparison runs on reading order rather than on y. On a
 * two-column page the two disagree constantly -- the right column's headings all sit higher than the
 * left column's text while coming after it -- and taking y for the answer mislabelled a third of the
 * acceptance paper, every left-column annotation picking up a heading from the column beside it.
 *
 * Reading order cannot separate an entry from the heading it sits *level with*, though, since the
 * two share a line. That case keeps deciding on y, and deliberately puts the entry in the section
 * above: a note written *at* a heading sits slightly above that heading's baseline, and it has to
 * print before the bold line it belongs under (see `pageEntries` in digest-builder.ts). A
 * heading-anchored note does not come through here at all -- it takes the heading the cascade gave
 * it, for the same reason.
 */
function sectionAt(pageIndex: number, pdfLeft: number, pdfTop: number, headings: OrderedHeading[], pageText: PdfPageText | null): string | null {
	const rank = pageRank(pageText, pdfLeft, pdfTop);
	let carried: string | null = null;
	let best: string | null = null;
	let bestRank = Number.NEGATIVE_INFINITY;

	for (const heading of headings) {
		// Sorted by page, so the first heading on a later page ends the search.
		if (heading.pageIndex > pageIndex) break;
		if (heading.pageIndex < pageIndex) {
			carried = heading.title;
			continue;
		}
		// Not sorted by reading order, so every heading on this page is weighed rather than the first
		// one past the entry ending it: the nearest one at or before the entry wins.
		const at = pageRank(pageText, heading.x, heading.y);
		if (at > rank || (at === rank && heading.y < pdfTop)) continue;
		if (at >= bestRank) {
			best = heading.title;
			bestRank = at;
		}
	}

	return best ?? carried;
}

/**
 * The single entry a page added on the device produces: the whole page transcribed in one pass (F21).
 *
 * None of the margin-note machinery means anything here. There is no source page under the ink, so
 * there is no text to sit beside, no heading to anchor to and no section to belong to -- the cascade
 * would hand all of it the same "on this page" it already has by being printed under the page's own
 * heading. And the page is not annotation of the document, so carrying the last section heading of the
 * PDF onto it would file the reader's own notes under someone else's chapter.
 *
 * **No region.** There is no source page under this ink, so there is no page region to draw it out
 * of. What makes it checkable is the embed, which shows the page whole (`inkCanvas` in
 * `pdf-renderer.ts`).
 */
async function buildPageTranscript(state: BuildState, page: DigestPageInput, ink: RmStroke[]): Promise<DigestNote & { section: string | null }> {
	let text = "";
	try {
		const result = await state.deps.ocrBackend.recognize([clusterScene(ink, page.scene?.formatVersion ?? 0)]);
		// Newlines survive here where a margin note collapses them: the page's line structure is most of
		// what a page of notes says, and `renderNote` gives every line its own callout prefix.
		text = result.text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line !== "").join("\n");
		state.ocrStatuses.push(result.status);
	} catch (error) {
		state.ocrStatuses.push("failed");
		state.warnings.push(`Page ${page.embedPage}: this page was added on the device and could not be transcribed (${describeError(error)}).`);
	}
	return {
		// The entry *is* the page, so the page is its identity -- stable across re-syncs without
		// depending on which stroke happens to carry the smallest CRDT id.
		id: digestId("nt", page.pageId, "page"),
		anchor: { kind: "page" },
		text,
		region: null,
		top: 0,
		wholePage: true,
		section: null,
	};
}

/** Null for a page with neither a highlight nor a margin note: an unannotated page is not part of the digest. */
async function buildPage(state: BuildState, page: DigestPageInput, geometry: PageGeometry): Promise<DigestPage | null> {
	const placed = buildHighlights(page, geometry);
	const ink = (page.scene?.layers ?? []).flatMap((layer) => layer.strokes).filter((stroke) => !isHighlighterOrShader(stroke.penType));

	// F21, and gated by F20 exactly as the margin notes are: this is handwriting transcription, which is
	// what the setting governs, and leaving it ungated would put the handwriting back in the note as a
	// flat transcript with the setting off -- the leak ticket 12 closed.
	if (page.appended) {
		if (!state.deps.marginNotes || ink.length === 0) return null;
		const transcript = await buildPageTranscript(state, page, ink);
		return { pageLabel: geometry.pageText?.label ?? String(page.sourceIndex + 1), embedPage: page.embedPage, highlights: [], notes: [transcript] };
	}

	// Before the clustering, so a mark never joins the note beside it: `HORIZONTAL_TOLERANCE` is three
	// line heights, and an underline shares its line with whatever was written in the margin next to it.
	const { marks, strokes: handwriting } = buildInkMarks(page, geometry, ink);
	placed.push(...marks, ...buildMarkerMarks(page, geometry));

	// F18 reaches here too. With F20 off a leftover stroke goes nowhere at all -- no cluster, nothing
	// in the note -- and for handwriting that is the setting working as asked. A stroke shaped
	// like a mark is the exception worth a line: the reader drew it *at* the text and expects to find
	// it quoted, and the reasons it missed (drawn too low, struck through, over a patch the text layer
	// does not cover) are invisible from the note.
	if (!state.deps.marginNotes && geometry.pageText !== null) {
		const missed = handwriting.filter((stroke) => readsAsMark(stroke, geometry.frame, geometry.lineHeightPt)).length;
		if (missed > 0) {
			state.warnings.push(
				missed === 1
					? `Page ${page.embedPage}: a pen mark could not be matched to any text there, so it is not in the digest. The embedded render still shows it.`
					: `Page ${page.embedPage}: ${missed} pen marks could not be matched to any text there, so they are not in the digest. The embedded render still shows them.`,
			);
		}
	}

	// F20 off stops here, before any cluster exists: no cluster, no OCR call, no callout.
	const clusters = state.deps.marginNotes
		? clusterStrokes(handwriting, geometry.lineHeightPt / geometry.frame.pxToPt, geometry.column ?? undefined)
		: [];
	if (placed.length === 0 && clusters.length === 0) return null;

	// Anchored against every highlight there is -- pen marks included -- and merged only afterwards: the cascade
	// measures distances to rectangles, and a run that is about to be merged away is still ink on the
	// page next to which the note was written.
	const notes = await buildNotes({ ...state, page, geometry, highlights: placed }, clusters);
	const { highlights, survivorOf } = mergeBySentence(placed);
	const standalone: (DigestNote & { section: string | null })[] = [];
	for (const { note, anchor, pdfLeft, pdfTop } of notes) {
		const hostId = anchor.kind === "highlight" ? survivorOf.get(anchor.highlightId) : undefined;
		const host = hostId === undefined ? undefined : highlights.find((item) => item.highlight.id === hostId);
		if (host) host.highlight.notes.push({ ...note, anchor: { kind: "highlight", highlightId: host.highlight.id } });
		else {
			const section = anchor.kind === "heading" ? anchor.heading : sectionAt(page.sourceIndex, pdfLeft, pdfTop, geometry.documentHeadings, geometry.pageText);
			standalone.push({ ...note, section });
		}
	}

	for (const { highlight, pdfRect } of highlights) {
		// A highlight without rectangles has no position at all; the page top is the least wrong place
		// for it, and it keeps the entry in the digest instead of dropping it.
		const top = pdfRect ? pdfRect.y + pdfRect.height : geometry.frame.heightPt;
		const left = pdfRect ? pdfRect.x : 0;
		highlight.section = sectionAt(page.sourceIndex, left, top, geometry.documentHeadings, geometry.pageText);
	}

	return {
		pageLabel: geometry.pageText?.label ?? String(page.sourceIndex + 1),
		embedPage: page.embedPage,
		highlights: highlights.map((item) => item.highlight),
		notes: standalone,
	};
}

async function readPageText(document: PdfTextDocument | null, page: DigestPageInput, warnings: string[]): Promise<PdfPageText | null> {
	if (!document) return null;
	// A page added on the device has no source page, so `getPage` throws and the reader returns null --
	// which is not a failure and must not be reported as one. Both halves of the message below would be
	// false for it: nothing failed to be read, and such a page carries no highlights to fall back on.
	if (page.appended) return null;
	try {
		const text = await document.page(page.sourceIndex);
		if (text === null) {
			warnings.push(`Page ${page.embedPage}: the PDF has no readable text there, so highlights quote the text recorded on the device.`);
		}
		return text;
	} catch (error) {
		warnings.push(`Page ${page.embedPage}: the PDF's text could not be read (${describeError(error)}).`);
		return null;
	}
}

/**
 * Where a document's text comes from. Both kinds arrive as the same `PdfPageText` per page, so
 * everything downstream -- quoting, anchoring, the section lookup -- reads one shape and does not
 * know which it was handed.
 *
 * `typed-text` is a page the reader did not write by hand but typed, or had typed for them: an
 * article the "Read on reMarkable" extension sent to the device as a notebook, a page written with
 * the Type Folio. The device stores that text in the scene (`root_text`) rather than in a PDF, and
 * the difference ends there -- it is still a document with somebody's marks on it.
 */
export type DigestSource =
	| {
			kind: "pdf";
			bytes: Uint8Array;
			/**
			 * The original book's prose, for a document the device rendered from an `.epub`. That
			 * conversion loses letters, so the text under a highlight is not always what the author
			 * wrote (spec §2); this is the only copy that is. Called at most once, and only when there
			 * is a quote to correct -- a book is a megabyte nobody should fetch for a page of ink.
			 */
			book?: () => Promise<string | null>;
	  }
	| { kind: "typed-text" };

/** What one page's annotations are placed against; the two sources differ in nothing else. */
interface PageGeometrySource {
	/** Every heading in the document, before ordering. */
	headings: PdfHeading[];
	read(page: DigestPageInput): Promise<{ frame: DeviceCanvas; pageText: PdfPageText | null; fit: PageFit | null }>;
}

/** The source PDF's text layer, read through pdf.js -- the original path, unchanged. */
async function pdfTextSource(bytes: Uint8Array, device: DeviceCanvas, state: BuildState): Promise<PageGeometrySource> {
	let document: PdfTextDocument | null = null;
	try {
		document = await (state.deps.loadText ?? loadPdfText)(bytes);
	} catch (error) {
		state.warnings.push(`The PDF's text layer could not be opened (${describeError(error)}).`);
	}
	// A null document is the reader's soft fail (pdf.js unavailable, or a PDF it cannot open). The
	// digest still gets written, but with no sentence context and no anchors, so it is said out loud.
	if (!document) {
		state.warnings.push("The PDF's text could not be read; highlights quote the text recorded on the device and margin notes are not anchored.");
	}

	let headings: PdfHeading[] = [];
	if (document) {
		try {
			headings = await document.headings();
		} catch (error) {
			state.warnings.push(`The PDF's section headings could not be read (${describeError(error)}); margin notes are anchored without them.`);
		}
	}

	return {
		headings,
		read: async (page) => {
			const pageText = await readPageText(document, page, state.warnings);
			const frame = pageText ? pageFrame(pageText.width, pageText.height, device) : device;
			return {
				frame,
				pageText,
				// The same scene the renderer is handed, measured the same way, so a region names the place
				// on the page the embed actually drew rather than the one the source page had.
				fit: pageText ? annotatedPageFit(page.scene, frame) : null,
			};
		},
	};
}

/**
 * The scene's own typed text.
 *
 * Read in the frame `renderPagesToPdf` draws each page in, which is the whole of what makes this
 * work: the text, the highlights over it and the handwriting beside it are one scene in one frame,
 * so there is no source page for them to disagree with. The fit is the identity for the same reason
 * -- such a page is sized to its content and drawn 1:1, never shrunk onto a sheet it has to fit.
 */
function typedTextSource(pages: DigestPageInput[], device: DeviceCanvas): PageGeometrySource {
	const frameOf = (page: DigestPageInput) => (page.scene ? notebookPageFrame(page.scene, device) : device);
	return {
		headings: pages.flatMap((page) => (page.scene ? sceneHeadings(page.scene, frameOf(page), page.sourceIndex) : [])),
		read: async (page) => {
			const frame = frameOf(page);
			const pageText = page.scene ? sceneTextPage(page.scene, frame, String(page.embedPage)) : null;
			return {
				frame,
				pageText,
				fit: pageText ? { box: { x: 0, y: 0, width: frame.widthPt, height: frame.heightPt }, scale: 1, dx: 0, dy: 0 } : null,
			};
		},
	};
}

/**
 * Builds the whole `## Digest` body for one document -- a PDF the reader annotated, or a page whose
 * text was typed rather than drawn (see `DigestSource`).
 *
 * Nothing fails silently (F18): a PDF whose text cannot be opened, a page without a text layer, a
 * cluster whose OCR threw -- each degrades visibly *and* adds a
 * plain-language line to `warnings`, which the sync engine passes on to `SyncResult.skipErrors`. The
 * build itself carries on; a digest missing one sentence beats a digest missing one annotation, and
 * both beat no digest at all.
 */
export async function buildDigest(
	deps: DigestPipelineDeps,
	params: { source: DigestSource; embedPath: string; pages: DigestPageInput[] },
): Promise<DigestBuild> {
	const { source, embedPath, pages } = params;
	const state: BuildState = { deps, warnings: [], ocrStatuses: [] };

	// One device for the whole document: a book is annotated on one reMarkable, and resolving this per
	// page would let a page whose scene declares no screen disagree with its neighbours.
	const device = resolveDeviceCanvas(pages.map((page) => page.scene).filter((scene): scene is RmPage => scene !== null));

	const text = source.kind === "pdf" ? await pdfTextSource(source.bytes, device, state) : typedTextSource(pages, device);
	const ordered = orderHeadings(text.headings);
	const headings = text.headings;

	const digestPages: DigestPage[] = [];
	for (const page of pages) {
		const { frame, pageText, fit } = await text.read(page);
		const built = await buildPage(state, page, {
			frame,
			fit,
			column: pageText ? textColumn(pageText, frame) : null,
			pageText,
			headings: headings
				.filter((heading): heading is PdfHeading & { y: number } => heading.pageIndex === page.sourceIndex && heading.y !== null)
				.map((heading) => ({ title: heading.title, y: heading.y })),
			documentHeadings: ordered,
			// Not the mode and not the median: on a page of short paragraphs the commonest gap is a
			// paragraph break, which would report roughly twice the real line height and double every
			// tolerance downstream. `bodyLineSpacing` takes the lower quartile instead, the smallest gap
			// a run of outliers cannot move.
			lineHeightPt: (pageText ? bodyLineSpacing(pageText.lines) : null) ?? FALLBACK_LINE_HEIGHT_PT,
		});
		if (built) digestPages.push(built);
		// Every page, including one that produced no digest entry at all: the bar counts the pages the
		// unit went through, and an unannotated page still cost a look.
		deps.onPage?.();
	}

	if (source.kind === "pdf" && source.book) await correctQuotesAgainstBook(digestPages, source.book, state);

	return {
		markdown: renderDigest(embedPath, digestPages),
		warnings: state.warnings,
		ocr: worstOcrStatus(state.ocrStatuses),
	};
}

/**
 * Re-spells every quote in the book's own words, where it can be found there.
 *
 * A quote that cannot be located is left exactly as the device recorded it, without a warning: the
 * device's text is not known to be wrong, and a line per unmatched quote would report a problem the
 * reader mostly does not have. A book that cannot be read at all is different -- that is a source
 * failing, and it is said once.
 */
async function correctQuotesAgainstBook(pages: DigestPage[], book: () => Promise<string | null>, state: BuildState): Promise<void> {
	const highlights = pages.flatMap((page) => page.highlights);
	if (highlights.length === 0) return;

	let text: string | null = null;
	try {
		text = await book();
	} catch (error) {
		state.warnings.push(`The book's own text could not be read (${describeError(error)}); quotes keep the spelling the device recorded.`);
		return;
	}
	if (text === null) {
		state.warnings.push("The book's own text could not be read; quotes keep the spelling the device recorded.");
		return;
	}

	for (const highlight of highlights) {
		const corrected = correctQuote(highlight.sentence, highlight.marked, text);
		if (!corrected) continue;
		highlight.sentence = corrected.sentence;
		highlight.marked = corrected.marked;
	}
}
