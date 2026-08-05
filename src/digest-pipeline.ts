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

import { writeCropAttachment, type AttachmentStore } from "./attachment-writer";
import { resolveAnchor, type DigestAnchor } from "./digest-anchoring";
import { digestId, renderDigest, type DigestHighlight, type DigestNote, type DigestPage } from "./digest-builder";
import { clusterStrokes, type StrokeCluster } from "./margin-notes";
import type { OcrStatus } from "./note-builder";
import type { OcrBackend } from "./ocr-backend";
import { rasterizePage, type RasterImage } from "./page-rasterizer";
import {
	isHighlighterOrShader,
	pageFrame,
	resolveDeviceCanvas,
	sceneRectToPdf,
	type DeviceCanvas,
	type PdfRect,
} from "./pdf-renderer";
import { bodyLineSpacing, loadPdfText, quoteForRects, readingIndex, type PdfHeading, type PdfPageText, type PdfTextDocument } from "./pdf-text";
import { encodeGrayscalePng } from "./png-encoder";
import type { RmPage, RmStroke } from "./rm-parser";

export interface DigestPipelineDeps {
	ocrBackend: OcrBackend;
	attachmentStore: AttachmentStore;
	attachmentsFolder: string;
	/**
	 * F20. False drops margin notes whole -- no callout, no transcription, no crop -- and stops the
	 * work rather than the rendering: the clusters are never formed, so no OCR process starts and no
	 * PNG is written. Deliberately not optional: a default here would decide a shipped product
	 * question in a place nobody looks.
	 */
	marginNotes: boolean;
	/** Injected so tests can drive it without Obsidian; defaults to `loadPdfText`. */
	loadText?: (bytes: Uint8Array) => Promise<PdfTextDocument | null>;
}

export interface DigestPageInput {
	pageId: string;
	/** 0-based source-PDF page index. */
	sourceIndex: number;
	/** `#page=` anchor into the embed. */
	embedPage: number;
	scene: RmPage | null;
}

export interface DigestBuild {
	/** The rendered `## Digest` body, "" when the document has no annotations at all. */
	markdown: string;
	/** Crop ids written this run, for `pruneCrops`. */
	cropIds: Set<string>;
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

/**
 * Quiet space around a crop's ink, in device px. OCR reads a few words far better with a margin than
 * with the ink touching the image edge; 12 px is what the Vision calibration below ran with.
 */
const CROP_PADDING_PX = 12;

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

/** A one-layer scene holding a single cluster's strokes: the unit both the OCR backend and the crop are made from. */
function clusterScene(strokes: RmStroke[], formatVersion: number): RmPage {
	return { formatVersion, layers: [{ id: strokes[0].layerId, name: null, strokes }] };
}

/** What one page needs to place its annotations: the transform, its text, and the tolerance unit derived from it. */
interface PageGeometry {
	frame: DeviceCanvas;
	pageText: PdfPageText | null;
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
}

/** A margin note plus the anchor that decides whether it stands on its own or nests inside a quote. */
interface PlacedNote {
	note: DigestNote;
	anchor: DigestAnchor;
	/** Top-left corner in PDF points, for the section lookup -- the left edge says which column it is in. */
	pdfLeft: number;
	pdfTop: number;
}

/** Everything the per-document work shares; `warnings` and `cropIds` are collected across all pages. */
interface BuildState {
	deps: DigestPipelineDeps;
	docSlug: string;
	cropIds: Set<string>;
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
		const survivor = members.reduce((best, item) => (item.highlight.top < best.highlight.top ? item : best));
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

/** Null when the crop could not be written -- with a warning, because a note that loses its crop and has no text would otherwise vanish. */
async function writeCrop(context: PageContext, id: string, image: RasterImage): Promise<string | null> {
	const { deps, docSlug, page, cropIds, warnings } = context;
	try {
		const path = await writeCropAttachment(deps.attachmentStore, deps.attachmentsFolder, docSlug, id, encodeGrayscalePng(image));
		cropIds.add(id);
		return path;
	} catch (error) {
		warnings.push(`Page ${page.embedPage}: the crop for margin note ${id} could not be saved (${describeError(error)}).`);
		return null;
	}
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
		warnings.push(`Page ${page.embedPage}: a margin note could not be transcribed and is shown as a crop (${describeError(error)}).`);
	}

	// Every note carries its crop (F6). Nothing decides this any more: the two triggers that used to
	// -- a confidence threshold and an ink-per-character drawing guard -- were deleted with ticket 11,
	// because a misread is invisible to both. The image is the only thing that lets a reader check
	// what the transcription claims, so it is never the part that gets left out.
	const image = rasterizePage(scene, { paddingPx: CROP_PADDING_PX });
	const cropPath = await writeCrop(context, id, image);
	// The raster's own size travels with the path: the renderer sizes the embed from it, and it is the
	// only place that knows how much ink the crop actually holds.
	const cropEmbed = cropPath === null ? null : { path: cropPath, width: image.width, height: image.height };

	const rect = clusterRect(cluster, geometry.frame);
	const anchor = anchorFor(rect, context);
	return {
		note: { id, anchor, text, cropEmbed, top: cluster.rowTop },
		anchor,
		pdfLeft: rect.x,
		pdfTop: rect.y + rect.height,
	};
}

/**
 * Sequential on purpose. Each `recognize` call spawns its own Vision process, so running the
 * clusters in parallel would multiply the process count by whatever a page happens to contain, and
 * the crops would be written in completion order rather than in reading order. Serializing costs one
 * OCR round-trip per margin note and buys a predictable machine load and a deterministic result.
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

/** Null for a page with neither a highlight nor a margin note: an unannotated page is not part of the digest. */
async function buildPage(state: BuildState, page: DigestPageInput, geometry: PageGeometry): Promise<DigestPage | null> {
	const placed = buildHighlights(page, geometry);
	const ink = (page.scene?.layers ?? []).flatMap((layer) => layer.strokes).filter((stroke) => !isHighlighterOrShader(stroke.penType));
	// F20 off stops here, before any cluster exists: no cluster, no OCR call, no crop, no callout.
	const clusters = state.deps.marginNotes ? clusterStrokes(ink, geometry.lineHeightPt / geometry.frame.pxToPt) : [];
	if (placed.length === 0 && clusters.length === 0) return null;

	// Anchored against every highlight the device recorded, merged only afterwards: the cascade
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

	const entries = [...highlights.map((item) => item.highlight), ...standalone];
	return {
		pageLabel: geometry.pageText?.label ?? String(page.sourceIndex + 1),
		embedPage: page.embedPage,
		// The same ordering `pageEntries` derives its section order from, so the page heading names the
		// section of the topmost entry and that section never repeats as a bold line right below it.
		topSection: [...entries].sort((a, b) => a.top - b.top)[0]?.section ?? null,
		highlights: highlights.map((item) => item.highlight),
		notes: standalone,
	};
}

async function readPageText(document: PdfTextDocument | null, page: DigestPageInput, warnings: string[]): Promise<PdfPageText | null> {
	if (!document) return null;
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
 * Builds the whole `## Digest` body for one PDF-backed document.
 *
 * Nothing fails silently (F18): a PDF whose text cannot be opened, a page without a text layer, a
 * cluster whose OCR threw, a crop that could not be written -- each degrades visibly *and* adds a
 * plain-language line to `warnings`, which the sync engine passes on to `SyncResult.skipErrors`. The
 * build itself carries on; a digest missing one sentence beats a digest missing one annotation, and
 * both beat no digest at all.
 */
export async function buildDigest(
	deps: DigestPipelineDeps,
	params: { sourcePdfBytes: Uint8Array; docSlug: string; embedPath: string; pages: DigestPageInput[] },
): Promise<DigestBuild> {
	const { sourcePdfBytes, docSlug, embedPath, pages } = params;
	const state: BuildState = { deps, docSlug, cropIds: new Set<string>(), warnings: [], ocrStatuses: [] };

	let document: PdfTextDocument | null = null;
	try {
		document = await (deps.loadText ?? loadPdfText)(sourcePdfBytes);
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

	const ordered = orderHeadings(headings);

	// One device for the whole document: a book is annotated on one reMarkable, and resolving this per
	// page would let a page whose scene declares no screen disagree with its neighbours.
	const device = resolveDeviceCanvas(pages.map((page) => page.scene).filter((scene): scene is RmPage => scene !== null));

	const digestPages: DigestPage[] = [];
	for (const page of pages) {
		const pageText = await readPageText(document, page, state.warnings);
		const built = await buildPage(state, page, {
			frame: pageText ? pageFrame(pageText.width, pageText.height, device) : device,
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
	}

	return {
		markdown: renderDigest(embedPath, digestPages),
		cropIds: state.cropIds,
		warnings: state.warnings,
		ocr: worstOcrStatus(state.ocrStatuses),
	};
}
