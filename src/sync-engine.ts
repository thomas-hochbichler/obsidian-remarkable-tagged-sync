import type { DocumentContent, LegacyDocumentContent, RawRemarkableApi, RemarkableApi } from "rmapi-js";
import { attachmentPath, DEFAULT_ATTACHMENTS_FOLDER, type AttachmentStore, writeAttachment } from "./attachment-writer";
import { buildDigest, type DigestPageInput } from "./digest-pipeline";
import {
	blockHashOf,
	extractManagedBlock,
	type HighlightGroup,
	managedBlockHash,
	moveNote,
	type NoteFields,
	type NoteStore,
	type OcrStatus,
	readEmbedPath,
	readTranscript,
	renderTranscript,
	type TranscriptPage,
	updateTranscript,
	writeNote,
} from "./note-builder";
import type { OcrBackend, OcrPageResult, OcrResult } from "./ocr-backend";
import { getDocumentFiles, type DocumentFiles } from "./page-hash";
import { type AnnotatedPdfPage, renderAnnotatedPdf, renderPagesToPdf } from "./pdf-renderer";
import { validateSourcePdf } from "./pdf-source";
import { tagNames } from "./remarkable-tags";
import { parseRmV6, type RmHighlight, type RmPage } from "./rm-parser";
import { isDocumentText } from "./scene-text";
import type { TagRouter } from "./tag-router";

export type SyncRowStatus = "active" | "orphaned";

/**
 * Bumped whenever a renderer change means an already-synced note's attachment is wrong rather than
 * merely older -- a note rendered under an earlier version is re-rendered on the next sync even
 * though nothing changed on the device, which is otherwise the one thing change detection can't
 * notice. Rows written before this field existed re-render once, which is the intent: version 2
 * fixed where a PDF-backed document's annotations land on the page; version 3 fixed Paper Pro
 * highlights rendering opaque black instead of their palette color; version 4 added the annotation
 * digest, which an already-synced PDF note has no way to grow on its own -- nothing changes on the
 * device when the plugin learns to read a page, so without the bump those notes would keep their
 * bare highlight list forever; version 5 fixed what the digest *says*: a highlight that skips over
 * text quoted everything between its ends (a whole page, in one case), section headings lost the
 * spaces between their words, and two margin notes on one handwritten line came out as two entries
 * in the wrong order; version 6 escaped the markup a quoted passage carries, without which a
 * document that quotes XML emitted an unclosed tag and Obsidian stopped rendering the digest from
 * there on; version 7 sized a margin-note crop from its own raster instead of pinning every one to a
 * fixed width, which had magnified the small marks -- a 116x417 bracket rendered 280x1007; version 8
 * widened the cap that sizing scales down to, because a note written across the page was being held
 * to an aside's width and its handwriting came out too small to read; version 9 turned the digest's
 * section lines into `####` headings, so a section shows up in Obsidian's outline pane instead of
 * only its page; version 10 rebuilt the layout the digest-presentation map decided -- the section is
 * the `###` heading and runs on across page breaks, a highlight is body text instead of a callout,
 * every entry carries its page link, and a crop's paper is transparent so it no longer glares in a
 * dark theme; version 11 measures a page's line spacing over its body text alone, without which a
 * page made mostly of figures took its tick labels for lines and reported a third of the real
 * spacing -- the handwriting beside one paper's last paragraph came through as five margin notes,
 * one per pen stroke, and the highlight above it quoted from the middle of its sentence; version 13
 * reads a pen underline or a circle drawn around a passage as a mark on the printed text (F23) and
 * quotes what it points at, instead of transcribing the line itself -- one underline came through as
 * the margin note `176`; version 14 stopped writing a PNG per margin note altogether -- the entry now
 * carries the page and rectangle its handwriting sits at, and the vault keeps no crop files at all;
 * version 15 grows an annotated page past its paper wherever the ink runs off it, so a note written
 * beside the page is in the PDF at all -- until now every such document was rendered with its margin
 * notes cut off at the paper's edge, and the rectangles are measured from the grown sheet; version 16
 * reads a block written down the margin as the one note it is instead of one note per line, which
 * moves both the entries and their F15 ids; version 17 fits such a page back onto the paper it
 * started with, shrinking page and ink together, because a document whose pages are not all the same
 * size is one a reader may scale by a single page's width -- Obsidian's does, and cut the margin note
 * off on screen at exactly the paper edge the file had just been fixed to reach past; version 18 gives
 * a margin note a callout type of its own (`[!handwritten]`) and stops titling it with the word, so the
 * entry can be styled without touching any other callout in the vault and its title line carries where
 * the note sat instead of what every note in the digest is; version 19 draws the text highlights of a
 * page whose text was typed rather than carried by a source PDF, which the parser had been dropping
 * whole -- every such page in a vault was rendered without a single one of them; version 20 gives such
 * a page a digest instead of a transcript, which -- like version 4 for PDFs -- an already-synced note
 * has no way to grow on its own, because nothing changes on the device when the plugin learns to read
 * a page; version 21 stops charging a width to the separator the "Read on reMarkable" extension opens
 * such a page with, which had been breaking a word off the paragraph's first line and sliding every
 * word after it out from under the highlight drawn over it; version 22 draws the pictures on a page
 * -- an imported article's illustrations, which the parser skipped whole, so every one of them was a
 * blank gap in the attachment.
 */
export const RENDER_VERSION = 22;

/** One row per produced note (spec §7 / ticket 11). */
export interface SyncIndexRow {
	syncKey: string;
	docId: string;
	pageId: string | null;
	tag: string;
	entryHash: string;
	pageHash: string | null;
	notePath: string;
	status: SyncRowStatus;
	syncedAt: string;
	/** The `RENDER_VERSION` this note's attachment was rendered by; absent on rows written before it existed. */
	renderVersion?: number;
	/**
	 * Hash of the managed block exactly as this sync wrote it. A block on disk that hashes differently
	 * has been edited by hand, and is never overwritten. Absent on rows written before this field
	 * existed -- those stay unprotected until their next successful write, which is the same one-round
	 * catch-up `renderVersion` already relies on.
	 */
	blockHash?: string;
}

export interface SyncIndex {
	/** Last root hash the sync ran against -- level-1 change-detection gate. */
	rootHash: string | null;
	/**
	 * Fingerprint of the tag->folder mappings the last sync ran with. The root hash only tracks the
	 * reMarkable side, so without this a mapping change while the device is unchanged -- classically:
	 * first sync before any tag was mapped -- would sit behind the level-1 gate as "up to date"
	 * forever. Optional like `renderVersion`: an older index simply fails the comparison once and
	 * takes one full scan.
	 */
	mappings?: string;
	rows: Record<string, SyncIndexRow>;
}

export const EMPTY_SYNC_INDEX: SyncIndex = { rootHash: null, rows: {} };

export function notebookSyncKey(docId: string, tag: string): string {
	return `${docId}:${tag}`;
}

export function pageSyncKey(docId: string, pageId: string, tag: string): string {
	return `${docId}:${pageId}:${tag}`;
}

export type SyncApi = Pick<RemarkableApi, "listItems" | "getContent" | "getPdf"> & {
	raw: Pick<RawRemarkableApi, "getRootHash" | "getEntries" | "getHash">;
};

/**
 * Progress of a running sync, for UI feedback only -- a sync can spend a long time fetching,
 * rendering and OCR-ing before it produces anything, and silence reads as "nothing happened".
 * `document` is emitted for every document the sync considers, including ones it then skips as
 * unchanged, so the count advances steadily rather than stalling on the changed ones.
 */
export type SyncProgress =
	| { phase: "scanning" }
	| { phase: "document"; index: number; total: number; name: string };

export interface SyncDeps {
	api: SyncApi;
	tagRouter: TagRouter;
	noteStore: NoteStore;
	attachmentStore: AttachmentStore;
	attachmentsFolder?: string;
	ocrBackend: OcrBackend;
	/**
	 * F20's setting, default **off** -- the same default the plugin ships, so a caller that says
	 * nothing gets the shipped behaviour rather than a second, quieter policy. A PDF unit still runs
	 * its digest build: that is what keeps `digest.ocr` non-null and so keeps the whole-scene OCR pass
	 * switched off, which is the point (a page's handwriting must not come back as a flat transcript).
	 */
	marginNotes?: boolean;
	/** Injectable clock -- returns the current time as an ISO string. */
	now: () => string;
	onProgress?: (progress: SyncProgress) => void;
	/**
	 * Persists the index mid-run: after every note written, and again at the end of each document to
	 * carry the entryHash bump for that document's untouched rows. Without it a sync that is
	 * interrupted -- quit, lost network, any throw -- leaves already-written notes with no index row,
	 * and the next sync, refusing to clobber a file it does not own, writes `Notebook (sync).md` beside
	 * each of them. Those duplicates never self-heal, and the first sync is both the longest and the
	 * likeliest to be interrupted. The checkpoint carries the *previous* `rootHash` on purpose: the new
	 * one is written only by the final result, so an interrupted run never looks complete to the next one.
	 */
	saveIndex?: (index: SyncIndex) => Promise<void>;
	/**
	 * Polled at unit boundaries: `true` ends the run early, in a state the next sync resumes from.
	 * Only ever read, never awaited -- nothing in this path can actually be aborted (the cloud API
	 * goes through Obsidian's `requestUrl`, which takes no AbortSignal, and OCR runs in subprocesses
	 * we deliberately do not kill), so a stop is a decision not to start the *next* unit rather than
	 * an interruption of the current one. A unit already under way always finishes.
	 */
	shouldStop?: () => boolean;
}

export interface SyncResult {
	index: SyncIndex;
	/**
	 * The run ended because `shouldStop` said so, not because it ran out of documents. Its `index`
	 * deliberately carries the *previous* `rootHash`/`mappings` (as a checkpoint does), so a caller
	 * that persists it regardless cannot mark the vault up to date -- the run looks interrupted,
	 * which it is.
	 */
	stopped: boolean;
	notesWritten: number;
	/** Units written whose OCR came back `unavailable` -- drives the plugin's one-time platform notice (spec §6.2). */
	unavailableOcrUnits: number;
	/**
	 * Units written whose OCR came back `failed` -- the backend was available and threw or returned
	 * nothing usable. Reported rather than logged: a failed transcription used to leave an empty
	 * `## Transcript`, a `console.warn` nobody reads, and a notice announcing plain success.
	 */
	failedOcrUnits: number;
	/** Notes left alone because the user had edited inside the managed block (see `isBlockEdited`). */
	editedNotesSkipped: number;
	/** Documents that produced no note because reading or rendering them failed -- reported, not just logged. */
	documentsSkipped: number;
	/**
	 * The raw error text behind each skip, one entry per skipped unit, for "Copy diagnostics" -- the
	 * console.warn alone left diagnostics reporting "Last error: none" after a partially-failed sync.
	 * Also carries a digest build's non-fatal warnings: those cost a sentence or an anchor rather than
	 * a note, but a degraded digest that says so nowhere is exactly the silent loss spec §6 forbids.
	 */
	skipErrors: string[];
}

/**
 * Plain-language notes about what a render knowingly got wrong, one line per page, for
 * `SyncResult.skipErrors`.
 *
 * Both conditions are read off what the parser recorded, never measured back off the geometry: an
 * overlap test flags pages that are fine (it did so on two of six while this was being diagnosed)
 * and misses pages that are not, and a flag users learn to ignore is worse than no flag. What the
 * parser knew it could not do, it says.
 *
 * Silent on the common case by construction -- across the 80-page corpus every node places and every
 * layer is visible, so neither line appears.
 */
export function renderNotes(scenes: RmPage[], label: (pageIndex: number) => string): string[] {
	const notes: string[] = [];
	scenes.forEach((scene, index) => {
		// Per page, not per layer: eleven unplaceable nodes are still one thing the reader can act on.
		if (scene.layers.some((layer) => layer.placement !== undefined && layer.placement !== "applied")) {
			notes.push(`${label(index)}: some handwriting could not be placed and may appear overlapped or shifted. Open the page on the device to read it.`);
		}
		if (scene.layers.some((layer) => layer.visible === false)) {
			notes.push(`${label(index)}: a layer hidden on the device is shown in the render.`);
		}
	});
	return notes;
}

/**
 * The transcript a unit can keep rather than re-earn, or undefined when it must be re-run.
 *
 * A `RENDER_VERSION` bump re-renders every note, and `writeUnit` transcribes whatever it renders --
 * so a bump silently bills a metered backend for a whole vault. It need not: a rebuild triggered by
 * the renderer alone is looking at exactly the bytes it looked at last time.
 *
 * The exceptions are the reason the bump exists. Placing anchored ink changes what the OCR rasterizer
 * sees, so a page whose parse *did* place something is genuinely worth re-reading -- that is the
 * ~4% of pages where the old transcript was garbage. A page carrying typed text is the other: its
 * transcript was written before typed text was ever transcribed, so it is missing words the page
 * plainly has. Everything else keeps what it has.
 *
 * Fail-soft: an unreadable note, a missing section or a digest note falls through to running OCR.
 * Never write an empty transcript over a real one.
 */
async function reusableTranscript(
	noteStore: NoteStore,
	row: SyncIndexRow | undefined,
	deviceUnchanged: boolean,
	pages: OcrPage[],
): Promise<string | undefined> {
	if (!row || row.status !== "active" || !deviceUnchanged || !isStaleRender(row)) return undefined;
	if (pages.some(({ scene }) => scene !== null && (scene.text || scene.layers.some((layer) => layer.placement === "applied")))) return undefined;
	const content = await noteStore.read(row.notePath);
	return content === null ? undefined : (readTranscript(content) ?? undefined);
}

/** Raw error text for `SyncResult.skipErrors` -- the same shape main.ts records for a whole-sync failure. */
function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function findEntryHash(rows: Record<string, SyncIndexRow>, docId: string): string | undefined {
	for (const row of Object.values(rows)) {
		if (row.docId === docId) return row.entryHash;
	}
	return undefined;
}

interface DocPageRef {
	id: string;
	/** 0-based index of the source-PDF page this maps to (`cPages.redir`, else document position). Meaningful only for PDF-backed docs. */
	sourceIndex: number;
	/**
	 * True for a page added on the device behind the PDF's own pages: its `cPages` entry has no
	 * `redir`, so `sourceIndex` above is the document position standing in for a source page that does
	 * not exist. The digest transcribes such a page whole instead of hunting margin notes on it (F21).
	 */
	appended: boolean;
}

/**
 * Live, in-document-order pages. `cPages` is authoritative when present: a page is live iff its
 * `deleted` marker is absent or zero -- the marker is a CRDT `{timestamp, value}` record, so a
 * restored page keeps it at `value: 0` and testing the object's truthiness drops live pages,
 * shifting later page indices. Liveness is crucially *not* "iff it has a `.rm` file", which conflated a blank
 * page (never drawn) with a deleted one and silently dropped blanks, shifting later page indices. A
 * PDF-backed doc's pages never have `.rm` files at all, so its blanks must be kept regardless.
 * Legacy `pages[]` docs carry no `deleted` info: keep the old `.rm`-presence filter for handwritten
 * ones (best available signal), but a PDF-backed legacy doc keeps every page (annotations are moot).
 */
function orderedPages(doc: DocumentContent | LegacyDocumentContent, liveIds: ReadonlySet<string>, isPdf: boolean): DocPageRef[] {
	const cPages = doc.cPages?.pages ?? [];
	if (cPages.length > 0) {
		return cPages
			.filter((page) => !page.deleted?.value)
			.sort((a, b) => (a.idx.value < b.idx.value ? -1 : a.idx.value > b.idx.value ? 1 : 0))
			.map((page, i) => ({ id: page.id, sourceIndex: page.redir?.value ?? i, appended: isPdf && page.redir === undefined }));
	}
	const pages = Array.isArray(doc.pages) ? doc.pages : [];
	const filtered = isPdf ? pages : pages.filter((id) => liveIds.has(id));
	// A legacy `pages[]` doc records no source mapping at all, so nothing here can be called added on
	// the device -- the position *is* the mapping, for every page alike.
	return filtered.map((id, i) => ({ id, sourceIndex: i, appended: false }));
}

/** Renders one handwritten page, or a blank page when it has no `.rm` file yet (`pageHash` undefined) -- a real, still-live page the user simply never drew on. */
async function renderPage(api: SyncApi, docId: string, pageId: string, pageHash: string | undefined): Promise<RmPage> {
	if (pageHash === undefined) return { formatVersion: 6, layers: [] };
	const bytes = await api.raw.getHash(`${docId}/${pageId}.rm`, pageHash);
	return parseRmV6(bytes);
}

/**
 * Fetches the bytes of every picture the given pages show, keyed by the name each page names it by.
 *
 * One fetch per picture and no cache: an image is only re-fetched when the page it is on is
 * re-rendered, which change detection has already decided is worth a request.
 *
 * A picture that cannot be fetched is left out of the map, and the renderer then draws the page
 * without it -- exactly what every such page looked like before this existed. It is not worth a
 * `skipErrors` line: the note is complete and correct except for one illustration, and the reader
 * can see the gap.
 */
async function fetchPageImages(api: SyncApi, scenes: RmPage[], files: DocumentFiles["images"]): Promise<Map<string, Uint8Array>> {
	const wanted = new Set(scenes.flatMap((scene) => (scene.images ?? []).map((image) => image.fileName)));
	const fetched = new Map<string, Uint8Array>();
	await Promise.all(
		[...wanted].map(async (fileName) => {
			const file = files.get(fileName);
			if (!file) {
				console.warn(`Tagged Sync: a page shows ${fileName}, which the document does not list; it is not drawn`);
				return;
			}
			try {
				fetched.set(fileName, await api.raw.getHash(file.id, file.hash));
			} catch (error) {
				console.warn(`Tagged Sync: couldn't fetch ${fileName}, so the page is drawn without it`, error);
			}
		}),
	);
	return fetched;
}

/** Builds the composite input for a PDF-backed doc's pages: each page's source-PDF index plus its parsed annotation scene (null when the page has no `.rm` file -- i.e. was never drawn on). */
async function annotatedPdfPages(api: SyncApi, docId: string, docPages: DocPageRef[], pageHashes: Map<string, string>): Promise<AnnotatedPdfPage[]> {
	return Promise.all(
		docPages.map(async ({ id, sourceIndex }) => {
			const hash = pageHashes.get(id);
			return { sourceIndex, annotations: hash ? parseRmV6(await api.raw.getHash(`${docId}/${id}.rm`, hash)) : null };
		}),
	);
}

/**
 * One page of a unit, plus the labels its transcript heading needs -- the OCR twin of `HighlightPage`.
 *
 * `scene` is null for a page with no handwriting at all, which is never sent to a backend: cloud
 * providers bill per page, and padding a 40-page PDF annotated on 5 would cost eight times over for
 * nothing. The entry still exists so the note can say the page had nothing to read.
 */
export interface OcrPage {
	scene: RmPage | null;
	/** The notebook page ordinal the human reads. */
	pageLabel: number;
	/** The `#page=` anchor into the embed; `1` for a single-page embed. */
	embedPage: number;
}

/**
 * Every composite page, carrying the ordinal it sits at -- the handwriting worth OCR-ing (the source
 * PDF's own text is not re-transcribed), plus a null scene for each page with none.
 *
 * This used to return bare scenes and `.filter()` the un-annotated pages away, which destroyed the
 * page ordinal *before any backend saw it*: a 5-page PDF written on 1, 3 and 5 arrived as a
 * three-element array indexed 0, 1, 2, and `RmPage` carries no page number to recover it from. That
 * is why a transcript could not say which page a line came from -- the labels were gone upstream of
 * every backend, not lost inside one. The highlights path a few lines below never had the bug,
 * because it maps the unfiltered composite.
 */
function annotationOcrPages(pages: AnnotatedPdfPage[]): OcrPage[] {
	return pages.map((page, index) => ({ scene: page.annotations, pageLabel: index + 1, embedPage: index + 1 }));
}

/** Every page of a notebook unit, which always has a scene -- `renderPage` returns a blank one for a page never drawn on. */
function notebookOcrPages(scenes: RmPage[]): OcrPage[] {
	return scenes.map((scene, index) => ({ scene, pageLabel: index + 1, embedPage: index + 1 }));
}

/** One page's highlights plus the labels its callout needs -- the collection input, one entry per page in document order (a page with no highlights is still passed, and simply yields no group). */
export interface HighlightPage {
	/** Callout-title label: the notebook page ordinal, or the note's `pageIndex` for a page-level note. */
	pageLabel: number;
	/** The `#page=` anchor into the embed: the page ordinal for a notebook-level note, `1` for a single-page embed. */
	embedPage: number;
	highlights: RmHighlight[];
}

/** A highlight's topmost-then-leftmost rect corner, the sort key that reproduces reading order (spec rule 4). */
function rectAnchor(highlight: RmHighlight): { top: number; left: number } {
	if (highlight.rects.length === 0) return { top: 0, left: 0 };
	return { top: Math.min(...highlight.rects.map((rect) => rect.y)), left: Math.min(...highlight.rects.map((rect) => rect.x)) };
}

/** Collapses internal whitespace (wrapped-line newlines, runs of spaces) to a single space and trims, so a run reads as one flowing bullet and can't break the `> - ` structure (spec rule 5). */
function normalizeQuote(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Turns a unit's ordered page list into render-ready highlight groups: within each page, sort runs
 * top-to-bottom then left-to-right, normalize their text, and drop empty/whitespace-only ones; emit
 * a group only for pages that keep at least one quote (spec rules 4-7). An all-empty input yields an
 * empty list, so the note-builder renders no `## Highlights` section.
 */
export function collectHighlights(pages: HighlightPage[]): HighlightGroup[] {
	const groups: HighlightGroup[] = [];
	for (const page of pages) {
		const quotes = [...page.highlights]
			.sort((a, b) => {
				const anchorA = rectAnchor(a);
				const anchorB = rectAnchor(b);
				return anchorA.top - anchorB.top || anchorA.left - anchorB.left;
			})
			.map((highlight) => normalizeQuote(highlight.text))
			.filter((quote) => quote.length > 0);
		if (quotes.length > 0) groups.push({ pageLabel: page.pageLabel, embedPage: page.embedPage, quotes });
	}
	return groups;
}

/** A unit's transcription, with the backend's per-page results already zipped back onto the page labels. */
interface UnitOcr {
	status: OcrResult["status"];
	warnings: string[];
	/** One entry per page of the unit, or null when there is no per-page information to render from. */
	pages: TranscriptPage[] | null;
	/** The unlabelled whole-unit transcript -- the fallback when `pages` is null. */
	text: string;
}

/**
 * OCR must never block or lose a sync (spec §6): a throwing backend degrades to "failed" rather than
 * aborting the unit's render+note write.
 *
 * Also the guard point for the per-page contract. A backend returns one result per page it was
 * *handed*; this zips those back onto the unit's labels, filling in the pages that were never sent.
 * If the arity doesn't match, the per-page results are dropped entirely and the unlabelled text is
 * kept: attaching a transcript to the wrong page is worse than an honest unlabelled blob, and no text
 * is lost either way.
 */
async function runOcr(backend: OcrBackend, pages: OcrPage[]): Promise<UnitOcr> {
	const sent = pages.filter((page): page is OcrPage & { scene: RmPage } => page.scene !== null);

	let result: OcrResult;
	try {
		result = await backend.recognize(sent.map((page) => page.scene));
	} catch (error) {
		console.warn(`Tagged Sync: OCR backend "${backend.id}" failed, note will ship with render only`, error);
		return { status: "failed", warnings: [], pages: null, text: "" };
	}

	const warnings = result.warnings ?? [];
	// `?? null` and not `=== null`: an omitted field says the same thing a null one does -- this
	// backend has nothing per-page to report -- and the guard exists precisely not to trust the answer.
	const perPage = result.pages ?? null;
	if (perPage === null) return { status: result.status, warnings, pages: null, text: result.text };
	if (perPage.length !== sent.length) {
		console.warn(`Tagged Sync: OCR backend "${backend.id}" returned ${perPage.length} page result(s) for ${sent.length} page(s); transcript will not be page-anchored`);
		return {
			status: result.status,
			warnings: [...warnings, `the "${backend.id}" backend returned ${perPage.length} page result(s) for ${sent.length} page(s), so the transcript could not be split by page`],
			pages: null,
			text: result.text,
		};
	}

	const bySent = new Map<OcrPage, OcrPageResult>(sent.map((page, index) => [page, perPage[index]]));
	return {
		status: result.status,
		warnings,
		// A page that never reached the backend reads as "nothing to read here", which is what it is.
		pages: pages.map((page) => {
			const outcome = bySent.get(page);
			return { pageLabel: page.pageLabel, embedPage: page.embedPage, status: outcome?.status ?? "skipped", text: outcome?.text ?? "" };
		}),
		text: result.text,
	};
}

interface UnitParams {
	/** Finished attachment bytes: a `.rm` render for handwritten docs, the embedded source for PDF-backed ones. */
	pdfBytes: Uint8Array;
	/** The unit's pages with their labels -- empty for a PDF-backed doc, whose source is embedded rather than transcribed. */
	ocrPages: OcrPage[];
	/**
	 * A transcript to keep instead of producing one, for a unit being rebuilt only because the
	 * renderer changed. Already rendered -- it was read back out of the note -- so it is written
	 * through as-is rather than laid out again. See `reusableTranscript` for when that is safe.
	 */
	keepTranscript?: string;
	/** Render-ready highlighted quotes, grouped by page (empty when the unit has no text highlights). */
	highlights: HighlightGroup[];
	/** The `## Digest` body of a PDF-backed unit; "" for every other unit, and for a digest that failed to build. */
	digest: string;
	docId: string;
	pageId: string | null;
	pageIndex: number | null;
	tag: string;
	source: string;
	entryHash: string;
	pageHash: string | null;
}

/** Writes the attachment + note (via `write`) and builds the index row for one produced note (notebook- or page-granularity). Rendering is the caller's job -- see the fileType branch in `runSync`. */
async function writeUnit(
	deps: Pick<SyncDeps, "attachmentStore" | "now" | "ocrBackend"> & { attachmentsFolder: string },
	params: UnitParams,
	write: (fields: NoteFields) => Promise<string>,
): Promise<{ row: SyncIndexRow; ocr: OcrResult["status"]; ocrWarnings: string[] }> {
	const embedPath = await writeAttachment(deps.attachmentStore, deps.attachmentsFolder, params.docId, params.pageId, params.pdfBytes);
	const ocr: UnitOcr =
		params.keepTranscript !== undefined
			? { status: "ok", warnings: [], pages: null, text: params.keepTranscript }
			: await runOcr(deps.ocrBackend, params.ocrPages);

	const synced = deps.now();
	const fields: NoteFields = {
		docId: params.docId,
		pageId: params.pageId,
		pageIndex: params.pageIndex,
		tag: params.tag,
		source: params.source,
		embedPath,
		highlights: params.highlights,
		transcript: renderTranscript(embedPath, ocr.pages, ocr.text),
		digest: params.digest,
	};
	const notePath = await write(fields);

	const syncKey =
		params.pageId === null
			? notebookSyncKey(params.docId, params.tag)
			: pageSyncKey(params.docId, params.pageId, params.tag);

	return {
		row: {
			syncKey,
			docId: params.docId,
			pageId: params.pageId,
			tag: params.tag,
			entryHash: params.entryHash,
			pageHash: params.pageHash,
			notePath,
			status: "active",
			syncedAt: synced,
			renderVersion: RENDER_VERSION,
			blockHash: managedBlockHash(fields),
		},
		ocr: ocr.status,
		ocrWarnings: ocr.warnings,
	};
}

/**
 * Whether the note behind `row` has been edited inside the managed block. The fence warning is an
 * HTML comment, so it is invisible in Reading and Live Preview: correcting a misread word in
 * `## Transcript` looks like an ordinary edit and used to be erased on the next sync. Losing a user's
 * own words is the one failure that cannot be undone, so a changed block stops the write.
 *
 * Deliberately false when there is nothing to compare -- an unprotected old row, a note that is gone,
 * or a note whose fence the user removed outright. Each of those is already handled elsewhere, and
 * guessing "edited" here would strand a note no sync could ever repair.
 */
async function isBlockEdited(noteStore: NoteStore, row: SyncIndexRow | undefined): Promise<boolean> {
	if (row === undefined || row.status !== "active" || row.blockHash === undefined) return false;
	const content = await noteStore.read(row.notePath);
	if (content === null) return false;
	const block = extractManagedBlock(content);
	if (block === null) return false;
	return blockHashOf(block) !== row.blockHash;
}

/** True if this notebook must be opened even though its device-side hash is unchanged, because a tag freshly mapped in settings already sits on it and has no row yet -- entry.tags costs nothing extra (it comes free with listItems). */
function hasUncoveredMappedNotebookTag(
	rows: Record<string, SyncIndexRow>,
	tagRouter: TagRouter,
	docId: string,
	entryTags: Parameters<typeof tagNames>[0],
): boolean {
	return tagNames(entryTags).some(
		(tag) => tagRouter.resolveFolder(tag) !== null && rows[notebookSyncKey(docId, tag)] === undefined,
	);
}

function hasRowWithStatus(rows: Record<string, SyncIndexRow>, docId: string, status: SyncRowStatus): boolean {
	return Object.values(rows).some((row) => row.docId === docId && row.status === status);
}

/** True if this note was rendered by an older renderer, and so needs re-rendering even though the device side hasn't changed. */
function isStaleRender(row: SyncIndexRow): boolean {
	return row.status === "active" && (row.renderVersion ?? 0) < RENDER_VERSION;
}

function hasStaleRender(rows: Record<string, SyncIndexRow>, docId: string): boolean {
	return Object.values(rows).some((row) => row.docId === docId && isStaleRender(row));
}

/**
 * Marks every active row stale, so the next sync rewrites every note even though nothing changed on
 * the device. Called when a *setting* changes what a note contains -- F20's margin notes -- which
 * `RENDER_VERSION` cannot express: that is a constant, bumped for code changes, and it has no way to
 * say "this vault's output rule changed". Without this the toggle would sit there doing nothing until
 * the device happened to change, which reads as a broken switch.
 */
export function invalidateRenders(index: SyncIndex): SyncIndex {
	const rows: Record<string, SyncIndexRow> = {};
	for (const [key, row] of Object.entries(index.rows)) {
		const { renderVersion: _dropped, ...withoutVersion } = row;
		rows[key] = row.status === "active" ? withoutVersion : row;
	}
	return { ...index, rows };
}

/**
 * True if any active row (optionally narrowed to one doc) points at a note that's gone missing
 * from the vault -- e.g. the user deleted it by hand. A hash-unchanged sync would otherwise never
 * notice, since nothing changed on the reMarkable side to trip the hash gates. Local-only reads,
 * so this stays cheap in the common case (nothing missing).
 */
async function hasMissingActiveNote(noteStore: NoteStore, rows: Record<string, SyncIndexRow>, docId?: string): Promise<boolean> {
	for (const row of Object.values(rows)) {
		if (row.status !== "active") continue;
		if (docId !== undefined && row.docId !== docId) continue;
		if ((await noteStore.read(row.notePath)) === null) return true;
	}
	return false;
}

interface TagRename {
	oldRow: SyncIndexRow;
	newTag: string;
}

/**
 * Diffs a unit's (notebook's, or one page's) previously-active tags against its currently-mapped
 * tags. A clean 1:1 swap is a rename (spec §7 "tag changed to a different folder-tag" -> move);
 * anything messier (0 or 2+ on either side) falls back to orphaning whatever dropped out, and lets
 * the caller create fresh notes for whatever's new (spec §7 "conflicting page->folder tags").
 */
function diffUnitTags(previousRows: SyncIndexRow[], currentTags: string[]): { rename: TagRename | null; orphan: SyncIndexRow[] } {
	const currentSet = new Set(currentTags);
	const previousTagSet = new Set(previousRows.map((row) => row.tag));
	const removed = previousRows.filter((row) => !currentSet.has(row.tag));
	const added = currentTags.filter((tag) => !previousTagSet.has(tag));

	if (removed.length === 1 && added.length === 1) {
		return { rename: { oldRow: removed[0], newTag: added[0] }, orphan: [] };
	}
	return { rename: null, orphan: removed };
}

/**
 * Orphaning is index-only (invisible-sync-state 02): flip the row's status in `data.json`. Nothing
 * is written into the note -- with frontmatter gone there's no `sync-status` to surface, and the
 * user chose to drop the in-note signal. The flip still stops re-creation/duplication and excludes
 * the row from re-transcribe.
 */
function orphanRow(rows: Record<string, SyncIndexRow>, row: SyncIndexRow): void {
	rows[row.syncKey] = { ...row, status: "orphaned" };
}

/**
 * Picks the writer for a unit. A rename moves the existing note into `folder`; otherwise write, with
 * `existingPath` (the row's `notePath`) making it an in-place overwrite when a row already exists,
 * and a fresh first-free-path write when it doesn't.
 */
function resolveWriter(
	noteStore: NoteStore,
	rename: TagRename | null,
	folder: string,
	existingPath: string | null,
): (fields: NoteFields) => Promise<string> {
	return (fields) => (rename ? moveNote(noteStore, rename.oldRow.notePath, folder, fields) : writeNote(noteStore, folder, fields, existingPath));
}

/** Retires the rename's source row once its note has landed at the new syncKey. */
function consumeRename(rows: Record<string, SyncIndexRow>, rename: TagRename | null): void {
	if (rename) delete rows[rename.oldRow.syncKey];
}

/**
 * Runs the full one-way sync pipeline: enumerate -> hash-diff -> download -> render -> OCR -> write note,
 * for every mapped tag at both granularities (spec §7).
 */
export async function runSync(deps: SyncDeps, previousIndex: SyncIndex): Promise<SyncResult> {
	const { api, tagRouter, now, ocrBackend } = deps;
	const attachmentsFolder = deps.attachmentsFolder ?? DEFAULT_ATTACHMENTS_FOLDER;
	const writeDeps = { attachmentStore: deps.attachmentStore, now, attachmentsFolder, ocrBackend };
	const report = deps.onProgress ?? (() => {});
	const shouldStop = deps.shouldStop ?? (() => false);

	report({ phase: "scanning" });
	const [rootHash] = await api.raw.getRootHash();
	const mappings = tagRouter.fingerprint();
	// The stale-render check has to happen here too, not just per doc: nothing on the device changes
	// when the renderer does, so an unchanged root hash would otherwise return before any doc is
	// even looked at, and notes rendered by an older version would never be corrected. The mappings
	// fingerprint is here for the same reason from the other side: a settings change moves nothing
	// on the device.
	const staleRenders = Object.values(previousIndex.rows).some(isStaleRender);
	if (rootHash === previousIndex.rootHash && mappings === previousIndex.mappings && !staleRenders && !(await hasMissingActiveNote(deps.noteStore, previousIndex.rows))) {
		return { index: previousIndex, stopped: false, notesWritten: 0, unavailableOcrUnits: 0, failedOcrUnits: 0, editedNotesSkipped: 0, documentsSkipped: 0, skipErrors: [] };
	}

	const rows: Record<string, SyncIndexRow> = { ...previousIndex.rows };
	let notesWritten = 0;
	let unavailableOcrUnits = 0;
	let failedOcrUnits = 0;
	let editedNotesSkipped = 0;
	// Rows whose note was left alone this round. Their entryHash must NOT be bumped, or the next sync's
	// level-2 check would skip the whole document and the user would never hear about it again.
	const editedKeys = new Set<string>();
	const skippedDocIds = new Set<string>();
	const skipErrors: string[] = [];

	// Keeps the previous rootHash (and mappings fingerprint) so an interrupted run is re-scanned
	// rather than mistaken for done.
	const checkpoint = deps.saveIndex
		? () => deps.saveIndex!({ rootHash: previousIndex.rootHash, mappings: previousIndex.mappings, rows: { ...rows } })
		: async () => {};

	/**
	 * How a stopped run leaves: checkpoint whatever this document has produced so far, then hand back
	 * the *checkpoint's* index rather than the final one. The new `rootHash`/`mappings` stay unwritten,
	 * so a caller that persists this regardless still cannot mark the vault up to date -- the next sync
	 * re-scans instead of short-circuiting at the level-1 gate above. The orphan sweep after the loop is
	 * skipped by construction: a run that walked only part of the enumeration has no business deciding
	 * which units have disappeared.
	 */
	const stopHere = async (): Promise<SyncResult> => {
		await checkpoint();
		return {
			index: { rootHash: previousIndex.rootHash, mappings: previousIndex.mappings, rows },
			stopped: true,
			notesWritten,
			unavailableOcrUnits,
			failedOcrUnits,
			editedNotesSkipped,
			documentsSkipped: skippedDocIds.size,
			skipErrors,
		};
	};

	const entries = await api.listItems();
	const documents = entries.filter((entry) => entry.type === "DocumentType");
	for (const [position, entry] of documents.entries()) {
		// Also here, not just at the unit loops below: most documents are skipped by the level-2 gate
		// without producing a unit at all, and a stop must not have to walk hundreds of them first.
		if (shouldStop()) return stopHere();
		report({ phase: "document", index: position + 1, total: documents.length, name: entry.visibleName });

		const unchanged = findEntryHash(rows, entry.id) === entry.hash;
		// Also reopen a doc with any orphaned row even on an unchanged hash -- otherwise a doc that
		// reappears after being deleted (whose hash may come back identical) would stay `orphaned`
		// forever. Tradeoff: a doc keeps getting reopened on every sync after any one of its tags was
		// ever orphaned, even if that specific tag never comes back -- orphaned rows aren't pruned, so
		// this can't distinguish "doc came back" from "one old tag never will." Bounded to extra
		// network calls, never incorrect data. Same idea for a note deleted out from under an active row.
		if (
			unchanged &&
			!hasUncoveredMappedNotebookTag(rows, tagRouter, entry.id, entry.tags) &&
			!hasRowWithStatus(rows, entry.id, "orphaned") &&
			!hasStaleRender(rows, entry.id) &&
			!(await hasMissingActiveNote(deps.noteStore, rows, entry.id))
		) {
			continue; // level 2
		}

		let content: DocumentContent | LegacyDocumentContent;
		try {
			content = (await api.getContent(entry.id, entry.hash)) as DocumentContent | LegacyDocumentContent;
		} catch (error) {
			console.warn(`Tagged Sync: failed to read "${entry.visibleName}" during sync, skipping`, error);
			skipErrors.push(`failed to read "${entry.visibleName}" during sync: ${errorText(error)}`);
			skippedDocIds.add(entry.id);
			continue;
		}

		const notebookTags = [...new Set([...tagNames(entry.tags), ...tagNames(content.tags)])];
		const mappedNotebookTags = notebookTags.filter((tag) => tagRouter.resolveFolder(tag) !== null);

		const pageTags = content.pageTags ?? [];
		const tagsByPage = new Map<string, string[]>();
		for (const pageTag of pageTags) {
			tagsByPage.set(pageTag.pageId, [...(tagsByPage.get(pageTag.pageId) ?? []), pageTag.name]);
		}
		const mappedPageTags = pageTags.filter((pageTag) => tagRouter.resolveFolder(pageTag.name) !== null);

		// Nothing mapped now, and nothing previously active to potentially orphan -- truly nothing to do.
		const hasPreviouslyActiveRow = hasRowWithStatus(rows, entry.id, "active");
		if (mappedNotebookTags.length === 0 && mappedPageTags.length === 0 && !hasPreviouslyActiveRow) continue;

		// A PDF-backed doc's pages are an uploaded source PDF with handwritten annotations layered on
		// top. The render composites the two: each page shows the source page with its `.rm`
		// annotation scene drawn over it (see renderAnnotatedPdf). Notebook tag -> every page; page
		// tag -> just that page.
		const isPdf = content.fileType === "pdf";
		const { pages: pageHashes, images: imageFiles } = await getDocumentFiles(api, entry.id, entry.hash);
		const liveIds = new Set(pageHashes.keys());
		const docPages = orderedPages(content, liveIds, isPdf);
		const pageOrder = docPages.map((page) => page.id);
		const livePageIds = new Set(pageOrder);
		const pageRefById = new Map(docPages.map((page) => [page.id, page]));

		// Fetched once per doc, only if some unit actually needs it (a doc may open just to orphan rows).
		let sourcePdf: Promise<Uint8Array> | null = null;
		const getSourcePdf = () => (sourcePdf ??= api.getPdf(entry.id, entry.hash).then(validateSourcePdf));

		/**
		 * The `## Digest` body for one unit with document text, or "" when it could not be built. A
		 * failure here costs the digest and never the note: the unit is still written with today's
		 * highlights, because losing an annotation is worse than losing the section that explains it.
		 * Warnings from a build that did succeed travel the same road -- a digest that degraded silently
		 * is what spec §6 forbids.
		 *
		 * `ocr` is the outcome the digest's own per-cluster transcription came to, and `null` means there
		 * is no digest and the unit still needs the whole-scene pass. It exists so such a unit is not
		 * transcribed twice: the clusters have already been through the backend, and running `writeUnit`'s
		 * pass as well would spend a second round of Vision processes on a result that is then discarded.
		 */
		const buildUnitDigest = async (
			pageId: string | null,
			pages: DigestPageInput[],
			unit: string,
		): Promise<{ markdown: string; ocr: OcrStatus | null }> => {
			try {
				const build = await buildDigest(
					{ ocrBackend, marginNotes: deps.marginNotes ?? false },
					{
						source: isPdf ? { kind: "pdf", bytes: await getSourcePdf() } : { kind: "typed-text" },
						// The embed the note is about to carry. It is derived from the same two ids
						// `writeAttachment` derives it from, so the digest can link into it before the
						// attachment is written and `writeUnit` needs no reordering.
						embedPath: attachmentPath(attachmentsFolder, entry.id, pageId),
						pages,
					},
				);
				skipErrors.push(...build.warnings);
				return { markdown: build.markdown, ocr: build.ocr };
			} catch (error) {
				console.warn(`Tagged Sync: failed to build the digest for ${unit}, the note keeps its highlights`, error);
				skipErrors.push(`failed to build the digest for ${unit}: ${errorText(error)}`);
				return { markdown: "", ocr: null };
			}
		};

		// A tagged page's change-detection hash: its own `.rm` hash for handwritten pages, else the
		// whole-doc hash -- for a PDF page (no `.rm`) or a blank page (never drawn), the page changes
		// exactly when the document does.
		const pageContentHash = (pageId: string): string => (isPdf ? entry.hash : (pageHashes.get(pageId) ?? entry.hash));

		// Diff against what was last synced for this notebook to catch a tag renamed to a different
		// folder-tag (move, preserving the note's identity/backlinks) vs. a tag that's simply gone
		// (orphan) -- see diffUnitTags. Only previously-*active* rows count: an already-orphaned row
		// has no bearing on what's "removed" this round.
		const previousNotebookRows = Object.values(rows).filter(
			(row) => row.docId === entry.id && row.pageId === null && row.status === "active",
		);
		const notebookDiff = diffUnitTags(previousNotebookRows, mappedNotebookTags);
		for (const row of notebookDiff.orphan) orphanRow(rows, row);

		// Notebook-tag notes always reassemble every live page once the notebook is opened: rows for
		// these carry no per-page hash (spec §7's row schema), so there's no cheaper way to know which
		// of a reopened notebook's pages are safe to skip -- only page-tag rows track that.
		for (const tag of mappedNotebookTags) {
			if (shouldStop()) return stopHere();
			const rename = notebookDiff.rename?.newTag === tag ? notebookDiff.rename : null;
			const folder = tagRouter.resolveFolder(tag)!;
			const existingRow = rows[notebookSyncKey(entry.id, tag)];
			const existingPath = existingRow?.notePath ?? null;

			// Checked before rendering and before OCR: a note we will not write must not cost a download,
			// a render, or -- on a metered backend -- money. On a rename the note about to be rewritten is
			// the *old* row's, which has no row at this tag's key yet.
			const writtenRow = rename?.oldRow ?? existingRow;
			if (await isBlockEdited(deps.noteStore, writtenRow)) {
				editedKeys.add(writtenRow.syncKey);
				editedNotesSkipped++;
				continue;
			}

			let pdfBytes: Uint8Array;
			let ocrPages: OcrPage[];
			let highlights: HighlightGroup[];
			// Non-null exactly for a PDF-backed unit, i.e. the units that get a digest instead of a transcript.
			let digestPages: DigestPageInput[] | null = null;
			try {
				if (isPdf) {
					const composite = await annotatedPdfPages(api, entry.id, docPages, pageHashes);
					pdfBytes = await renderAnnotatedPdf(await getSourcePdf(), composite);
					ocrPages = annotationOcrPages(composite);
					highlights = collectHighlights(composite.map((page, i) => ({ pageLabel: i + 1, embedPage: i + 1, highlights: page.annotations?.highlights ?? [] })));
					digestPages = composite.map((page, i) => ({ pageId: docPages[i].id, sourceIndex: page.sourceIndex, embedPage: i + 1, scene: page.annotations, appended: docPages[i].appended }));
				} else {
					const scenes = await Promise.all(pageOrder.map((pageId) => renderPage(api, entry.id, pageId, pageHashes.get(pageId))));
					ocrPages = notebookOcrPages(scenes);
					pdfBytes = await renderPagesToPdf(scenes, await fetchPageImages(api, scenes, imageFiles)); // throws on an empty notebook -- surfaced, not written as a blank note
					highlights = collectHighlights(scenes.map((scene, i) => ({ pageLabel: i + 1, embedPage: i + 1, highlights: scene.highlights ?? [] })));
					skipErrors.push(...renderNotes(scenes, (i) => `Page ${i + 1} of "${entry.visibleName}"`));
					digestPages = scenes.some(isDocumentText)
						? scenes.map((scene, i) => ({ pageId: pageOrder[i], sourceIndex: i, embedPage: i + 1, scene }))
						: null;
				}
			} catch (error) {
				console.warn(`Tagged Sync: failed to render "${entry.visibleName}" for tag "${tag}", skipping`, error);
				skipErrors.push(`failed to render "${entry.visibleName}" for tag "${tag}": ${errorText(error)}`);
				skippedDocIds.add(entry.id);
				continue;
			}

			const digest = digestPages
				? await buildUnitDigest(null, digestPages, `"${entry.visibleName}" for tag "${tag}"`)
				: { markdown: "", ocr: null };

			const { row, ocr, ocrWarnings } = await writeUnit(
				writeDeps,
				{
					// An empty page list makes `runOcr` return `skipped` without spawning anything -- the
					// digest already transcribed this unit, cluster by cluster.
					ocrPages: digest.ocr === null ? ocrPages : [],
					keepTranscript: await reusableTranscript(deps.noteStore, writtenRow, existingRow?.entryHash === entry.hash, ocrPages),
					pdfBytes,
					highlights,
					digest: digest.markdown,
					docId: entry.id,
					pageId: null,
					pageIndex: null,
					tag,
					source: entry.visibleName,
					entryHash: entry.hash,
					pageHash: null,
				},
				resolveWriter(deps.noteStore, rename, folder, existingPath),
			);
			consumeRename(rows, rename);
			rows[row.syncKey] = row;
			notesWritten++;
			// Per unit, not just per document: a document is one tagged notebook *plus* one unit for every
			// tagged page in it, so a single document can be dozens of notes and many minutes of work. A
			// note that reaches the vault without its row reaching `data.json` is the duplicate bug the
			// document-level checkpoint was introduced to close -- it was simply never closed *inside* a
			// document. The write costs milliseconds against a unit that just spent a render and an OCR
			// pass, and only units that actually produced a note get here, so the cost tracks the work.
			await checkpoint();
			// The digest's own outcome when it produced one, so the platform notice still fires for a
			// user whose margin notes could not be transcribed here.
			const unitOcr = digest.ocr ?? ocr;
			// A page the backend lost while the rest of the unit read fine: the note is written and the
			// unit counts as ok, so this line is the only trace the loss leaves anywhere.
			skipErrors.push(...ocrWarnings);
			if (unitOcr === "unavailable") unavailableOcrUnits++;
			if (unitOcr === "failed") failedOcrUnits++;
		}

		// Same diff, per tagged (and still-live) page -- a page's tags are their own independent unit.
		const previousPageRows = Object.values(rows).filter(
			(row) => row.docId === entry.id && row.pageId !== null && row.status === "active",
		);
		const liveTagsByPage = new Map<string, string[]>();
		for (const pageTag of mappedPageTags) {
			if (!livePageIds.has(pageTag.pageId)) continue; // tagged page no longer exists on the device
			liveTagsByPage.set(pageTag.pageId, [...(liveTagsByPage.get(pageTag.pageId) ?? []), pageTag.name]);
		}
		const pageRenames = new Map<string, TagRename>();
		const pageIds = new Set([...previousPageRows.map((row) => row.pageId!), ...liveTagsByPage.keys()]);
		for (const pageId of pageIds) {
			const pageDiff = diffUnitTags(
				previousPageRows.filter((row) => row.pageId === pageId),
				liveTagsByPage.get(pageId) ?? [],
			);
			for (const row of pageDiff.orphan) orphanRow(rows, row);
			if (pageDiff.rename) pageRenames.set(pageId, pageDiff.rename);
		}

		for (const pageTag of mappedPageTags) {
			if (shouldStop()) return stopHere();
			if (!livePageIds.has(pageTag.pageId)) continue; // tagged page no longer exists on the device
			const pageHash = pageContentHash(pageTag.pageId);

			const rename = pageRenames.get(pageTag.pageId)?.newTag === pageTag.name ? pageRenames.get(pageTag.pageId)! : null;
			const syncKey = pageSyncKey(entry.id, pageTag.pageId, pageTag.name);
			const existingRow = rows[syncKey];
			// level 3: page unchanged, don't re-render it -- unless it's currently orphaned (revive), a
			// rename target, its note went missing from the vault (deleted by hand), or it was rendered
			// by an older renderer. That last one has to be here as well as at the document gate: nothing
			// on the device changes when the renderer does, so a page-tag note whose page never changes
			// again would keep an outdated render forever -- which is exactly what the digest's
			// RENDER_VERSION bump would otherwise fail to reach.
			if (
				!rename &&
				existingRow?.status === "active" &&
				existingRow.pageHash === pageHash &&
				!isStaleRender(existingRow) &&
				(await deps.noteStore.read(existingRow.notePath)) !== null
			) {
				continue;
			}

			// As above: refuse before spending anything on a note we will not write.
			const writtenRow = rename?.oldRow ?? existingRow;
			if (await isBlockEdited(deps.noteStore, writtenRow)) {
				editedKeys.add(writtenRow.syncKey);
				editedNotesSkipped++;
				continue;
			}

			const pageIndex = pageOrder.indexOf(pageTag.pageId) + 1;
			const folder = tagRouter.resolveFolder(pageTag.name)!;

			let pdfBytes: Uint8Array;
			let ocrPages: OcrPage[];
			let highlights: HighlightGroup[];
			let digestPages: DigestPageInput[] | null = null;
			try {
				if (isPdf) {
					const pageRef = pageRefById.get(pageTag.pageId)!;
					const composite = await annotatedPdfPages(api, entry.id, [pageRef], pageHashes);
					pdfBytes = await renderAnnotatedPdf(await getSourcePdf(), composite);
					// A single-page embed, so the `#page=` anchor is 1 -- the same ordinals `collectHighlights` gets.
					ocrPages = [{ scene: composite[0]?.annotations ?? null, pageLabel: pageIndex, embedPage: 1 }];
					highlights = collectHighlights([{ pageLabel: pageIndex, embedPage: 1, highlights: composite[0]?.annotations?.highlights ?? [] }]);
					digestPages = composite.map((page) => ({ pageId: pageTag.pageId, sourceIndex: page.sourceIndex, embedPage: 1, scene: page.annotations, appended: pageRef.appended }));
				} else {
					const scenes = [await renderPage(api, entry.id, pageTag.pageId, pageHashes.get(pageTag.pageId))];
					ocrPages = [{ scene: scenes[0], pageLabel: pageIndex, embedPage: 1 }];
					pdfBytes = await renderPagesToPdf(scenes, await fetchPageImages(api, scenes, imageFiles));
					highlights = collectHighlights([{ pageLabel: pageIndex, embedPage: 1, highlights: scenes[0].highlights ?? [] }]);
					skipErrors.push(...renderNotes(scenes, () => `Page ${pageIndex} of "${entry.visibleName}"`));
					// A single-page embed, so the `#page=` anchor is 1 -- as in the PDF branch above.
					digestPages = isDocumentText(scenes[0]) ? [{ pageId: pageTag.pageId, sourceIndex: 0, embedPage: 1, scene: scenes[0] }] : null;
				}
			} catch (error) {
				console.warn(`Tagged Sync: failed to render page ${pageIndex} of "${entry.visibleName}" for tag "${pageTag.name}", skipping`, error);
				skipErrors.push(`failed to render page ${pageIndex} of "${entry.visibleName}" for tag "${pageTag.name}": ${errorText(error)}`);
				skippedDocIds.add(entry.id);
				continue;
			}

			const digest = digestPages
				? await buildUnitDigest(pageTag.pageId, digestPages, `page ${pageIndex} of "${entry.visibleName}" for tag "${pageTag.name}"`)
				: { markdown: "", ocr: null };

			const { row, ocr, ocrWarnings } = await writeUnit(
				writeDeps,
				{
					// See the notebook-tag branch: a built digest has already transcribed this unit.
					ocrPages: digest.ocr === null ? ocrPages : [],
					keepTranscript: await reusableTranscript(deps.noteStore, writtenRow, existingRow?.pageHash === pageHash, ocrPages),
					pdfBytes,
					highlights,
					digest: digest.markdown,
					docId: entry.id,
					pageId: pageTag.pageId,
					pageIndex: pageIndex > 0 ? pageIndex : null,
					tag: pageTag.name,
					source: entry.visibleName,
					entryHash: entry.hash,
					pageHash,
				},
				resolveWriter(deps.noteStore, rename, folder, existingRow?.notePath ?? null),
			);
			consumeRename(rows, rename);
			rows[row.syncKey] = row;
			notesWritten++;
			await checkpoint(); // see the notebook-tag branch
			const unitOcr = digest.ocr ?? ocr;
			// See the notebook-tag branch: without this the lost page leaves no trace at all.
			skipErrors.push(...ocrWarnings);
			if (unitOcr === "unavailable") unavailableOcrUnits++;
			if (unitOcr === "failed") failedOcrUnits++;
		}

		// Bump entryHash on any of this doc's rows we didn't touch this round (e.g. a page-tag row
		// whose page was unchanged), so a future sync's level-2 check compares against the current hash.
		for (const row of Object.values(rows)) {
			if (row.docId === entry.id && row.entryHash !== entry.hash && !editedKeys.has(row.syncKey)) {
				rows[row.syncKey] = { ...row, entryHash: entry.hash };
			}
		}

		await checkpoint();
	}

	// Deletion: any unit whose doc no longer appears in the enumeration at all is flagged
	// orphaned, never auto-deleted (spec §7). A doc still present but missing a specific tag was
	// already orphaned above, per-tag, while its content was open.
	const liveDocIds = new Set(entries.filter((entry) => entry.type === "DocumentType").map((entry) => entry.id));
	for (const row of Object.values(rows)) {
		if (row.status === "active" && !liveDocIds.has(row.docId)) orphanRow(rows, row);
	}

	return { index: { rootHash, mappings, rows }, stopped: false, notesWritten, unavailableOcrUnits, failedOcrUnits, editedNotesSkipped, documentsSkipped: skippedDocIds.size, skipErrors };
}

export interface ReTranscribeDeps {
	api: SyncApi;
	noteStore: NoteStore;
	ocrBackend: OcrBackend;
	onProgress?: (progress: SyncProgress) => void;
	/** Polled at note boundaries; see `SyncDeps.shouldStop`. A note already being re-transcribed finishes. */
	shouldStop?: () => boolean;
	/**
	 * Persists the index after every note re-transcribed. Rewriting a note's managed block invalidates
	 * its stored `blockHash`, so a run that dies before the refreshed hashes are saved leaves notes the
	 * next sync reads as hand-edited -- and `isBlockEdited` then refuses to touch them ever again. That
	 * is a worse outcome than the sync checkpoint's duplicates: nothing signals it, and it does not
	 * self-heal. No `rootHash` moves here, so unlike the sync checkpoint this is simply the index.
	 */
	saveIndex?: (index: SyncIndex) => Promise<void>;
}

/** The OCR input for one already-synced unit, labelled: annotation scenes for a PDF-backed doc, every live page's scene otherwise. */
async function ocrPagesForRow(api: SyncApi, docId: string, row: SyncIndexRow, docPages: DocPageRef[], pageHashes: Map<string, string>, isPdf: boolean): Promise<OcrPage[] | null> {
	if (row.pageId === null) {
		return isPdf
			? annotationOcrPages(await annotatedPdfPages(api, docId, docPages, pageHashes))
			: notebookOcrPages(await Promise.all(docPages.map((page) => renderPage(api, docId, page.id, pageHashes.get(page.id)))));
	}
	const pageIndex = docPages.findIndex((candidate) => candidate.id === row.pageId);
	if (pageIndex === -1) return null; // the tagged page no longer exists on the device
	// A single-page embed, so the `#page=` anchor is 1 -- matching the page-tag branch of `runSync`.
	const labels = { pageLabel: pageIndex + 1, embedPage: 1 };
	return isPdf
		? [{ scene: (await annotatedPdfPages(api, docId, [docPages[pageIndex]], pageHashes))[0]?.annotations ?? null, ...labels }]
		: [{ scene: await renderPage(api, docId, row.pageId, pageHashes.get(row.pageId)), ...labels }];
}

/**
 * Re-runs OCR over every active note and rewrites just its transcript (spec §8.4). Re-fetches each
 * doc's current content once and re-derives the same OCR input the sync would produce, so a note's
 * transcript is refreshed to match the backend now selected -- typically to replace a garbage
 * transcript from an earlier backend. The embed and the user's free area are never touched.
 */
export async function reTranscribeAll(deps: ReTranscribeDeps, index: SyncIndex): Promise<{ updated: number; index: SyncIndex; stopped: boolean }> {
	const { api, noteStore, ocrBackend } = deps;
	const report = deps.onProgress ?? (() => {});
	const shouldStop = deps.shouldStop ?? (() => false);
	// Re-transcribing rewrites the managed block, so every refreshed row needs its `blockHash` updated
	// too -- otherwise the next sync would read its own work as a hand edit and refuse to touch the note.
	const rows: Record<string, SyncIndexRow> = { ...index.rows };

	const rowsByDoc = new Map<string, SyncIndexRow[]>();
	for (const row of Object.values(index.rows)) {
		if (row.status === "active") rowsByDoc.set(row.docId, [...(rowsByDoc.get(row.docId) ?? []), row]);
	}

	report({ phase: "scanning" });
	const entries = await api.listItems();
	const entryById = new Map(entries.filter((entry) => entry.type === "DocumentType").map((entry) => [entry.id, entry]));

	let updated = 0;
	const docIds = [...rowsByDoc.keys()];
	const checkpoint = deps.saveIndex ? () => deps.saveIndex!({ ...index, rows: { ...rows } }) : async () => {};
	// A stopped run still hands back every `blockHash` it refreshed: those notes were rewritten, and a
	// caller that drops them would leave the next sync reading the plugin's own work as a hand edit.
	const stopHere = (): { updated: number; index: SyncIndex; stopped: boolean } => ({ updated, index: { ...index, rows }, stopped: true });

	for (const [position, docId] of docIds.entries()) {
		if (shouldStop()) return stopHere();
		const entry = entryById.get(docId);
		report({ phase: "document", index: position + 1, total: docIds.length, name: entry?.visibleName ?? docId });
		if (!entry) continue; // doc no longer on the device -- leave its notes untouched

		let content: DocumentContent | LegacyDocumentContent;
		try {
			content = (await api.getContent(entry.id, entry.hash)) as DocumentContent | LegacyDocumentContent;
		} catch (error) {
			console.warn(`Tagged Sync: failed to read "${entry.visibleName}" during re-transcribe, skipping`, error);
			continue;
		}

		const isPdf = content.fileType === "pdf";
		const { pages: pageHashes } = await getDocumentFiles(api, entry.id, entry.hash);
		const docPages = orderedPages(content, new Set(pageHashes.keys()), isPdf);

		for (const row of rowsByDoc.get(docId)!) {
			if (shouldStop()) return stopHere();
			let ocrPages: OcrPage[] | null;
			try {
				ocrPages = await ocrPagesForRow(api, entry.id, row, docPages, pageHashes, isPdf);
			} catch (error) {
				console.warn(`Tagged Sync: failed to re-fetch "${entry.visibleName}" for re-transcribe, skipping`, error);
				continue;
			}
			if (ocrPages === null) continue;

			const ocr = await runOcr(ocrBackend, ocrPages);
			// The per-page headings link into the note's own embed, which this path knows only from the
			// note: it holds a row, not the sync's attachment folder. A note without one (hand-broken, or
			// written by a much older version) falls back to the unlabelled transcript rather than
			// emitting links that go nowhere.
			const embedPath = readEmbedPath((await noteStore.read(row.notePath)) ?? "");
			const transcript = embedPath === null ? ocr.text : renderTranscript(embedPath, ocr.pages, ocr.text);
			if (!(await updateTranscript(noteStore, row.notePath, transcript))) continue;
			updated++;

			const block = extractManagedBlock((await noteStore.read(row.notePath)) ?? "");
			if (block !== null) rows[row.syncKey] = { ...row, blockHash: blockHashOf(block) };
			// Per note, for the same reason the sync checkpoints per unit: the note on disk and the hash
			// that describes it must not be allowed to drift apart across an interruption.
			await checkpoint();
		}
	}
	return { updated, index: { ...index, rows }, stopped: false };
}
