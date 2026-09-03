import type { DocumentContent, Entry, LegacyDocumentContent, RawRemarkableApi, RemarkableApi } from "rmapi-js";
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
import { readEpubBook, type EpubBook } from "./epub-text";
import { validateSourcePdf } from "./pdf-source";
import { applyFrontmatter, deviceModified, formatLocalMinute, namespacedTags, type NoteFrontmatter } from "./frontmatter";
import { folderPathOf, inheritedFolderTagNames, isInTrash, tagNames } from "./remarkable-tags";
import { parseRmV6, type RmHighlight, type RmPage } from "./rm-parser";
import { isDocumentText } from "./scene-text";
import type { TagRouter } from "./tag-router";
import { mapWithConcurrency } from "./concurrency";

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
 * blank gap in the attachment; version 23 quotes a passage the reader swiped the marker across
 * freehand, which the device records as a stroke rather than as a highlight and the digest named
 * nowhere, and stops a mark that ends in the space after a word from taking the next word with it;
 * version 24 reads a tagged EPUB through the PDF path, so a book already synced as a notebook --
 * ink on blank pages, none of its text under it -- is re-rendered as the book itself; version 25
 * spells a book's quotes the way the book does, correcting the letters its conversion to a PDF lost;
 * version 26 reads a heading a renderer faked bold by drawing twice as the one heading it is, which
 * had been doubling every such title and halving the text a rectangle on that line addressed;
 * version 27 repairs the colourless paint operator a device leaves in a page it rendered from an
 * EPUB, which had been arriving in the vault as a book printed white on white; version 28 names a
 * book's sections the way its own navigation names them, so a digest says "CHAPTER I. Down the
 * Rabbit-Hole" where the render could only say "CHAPTER I."; version 29 stops heading a page added on
 * the device with the number of the source page it happens to sit at -- inserted after page 8, it
 * used to call itself page 9, which is a page of the book that exists somewhere else; version 30
 * draws such a page on a blank sheet instead of on that source page, which had been printing a page
 * of the book the reader never wrote on underneath their handwriting; version 31 prints one marker
 * gesture across wrapped lines as the one entry the reader drew -- the per-line runs the device
 * records are rejoined, and closing punctuation stays with the sentence it ends, which had been
 * printing a parenthetical twice, once behind a stranded closing quote -- and a margin note's clip
 * now spans the paragraph the ink sits beside, so the picture carries the context the note is about.
 */
export const RENDER_VERSION = 31;

/** One row per produced note (spec §7 / ticket 11). */
export interface SyncIndexRow {
	syncKey: string;
	docId: string;
	pageId: string | null;
	tag: string;
	entryHash: string;
	pageHash: string | null;
	notePath: string;
	/**
	 * The folder the row's tag mapped to when this note was last written -- *not* where the note is
	 * now. `notePath` follows the user's moves (`remapRows`); this does not. Comparing it with the
	 * tag's current folder is what tells a mapping re-targeted in settings from a note the user moved
	 * (#101): only the first changes it. Absent on rows written before it existed; `migrateSettings`
	 * stamps those once at load.
	 */
	folder?: string;
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
	/**
	 * How many highlighted quotes this note was written with, for `shrinkWarning`. Absent on
	 * rows written before this field existed -- those go uncompared once, and are protected from the
	 * sync after that.
	 */
	highlightCount?: number;
	/**
	 * How many pages the source PDF had when this note was written -- for `relaidWarning`. Absent on a
	 * notebook, which has no source PDF, and on rows written before this field existed.
	 */
	sourcePageCount?: number;
	/**
	 * The entries the plugin added to this note's shared `tags` frontmatter key (Pro frontmatter
	 * properties). Tracked so the next write -- and the toggle-off cleanup pass -- removes exactly
	 * these and never a tag the user wrote. Absent when the feature has not written this note.
	 */
	frontmatterTags?: string[];
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
 * What the engine is doing to a unit right now. Named for what the code actually does: fetching a
 * page and drawing it are one indivisible act (`renderPage`), not two.
 */
export type WorkStep = "rendering" | "transcribing" | "writing";

/**
 * Progress of a running sync, for UI feedback only -- a sync can spend a long time fetching,
 * rendering and OCR-ing before it produces anything, and silence reads as "nothing happened".
 *
 * Two phases, because they measure different things. `scanning` counts documents being *looked at*,
 * which is fast and says only that something is happening. `working` counts pages of real work
 * against a total the scan established, which is the only count a user can read as "how much is
 * left": the enumeration position this replaced spent most of its range on documents nothing
 * happened to, then sat still for minutes on the one that mattered.
 *
 * The message deliberately carries more than a status bar can show -- the document, its tag, and the
 * sub-phase -- so the display can choose what fits and put the rest in a tooltip. `done` never
 * decreases and always reaches `total`: every unit contributes exactly the steps the scan counted
 * for it, whether its pages were reported one by one or all at once at the end.
 */
export type SyncProgress =
	| {
			phase: "scanning";
			checked: number;
			candidates: number;
			/**
			 * The document the scan reached most recently. Absent before the first one, and deliberately
			 * the one most recently *begun* rather than the one most recently finished: several are in
			 * flight at once, so `checked` can stand still for a long time, and a name that keeps
			 * changing is the only thing separating a slow scan from a stuck one.
			 */
			document?: string;
	  }
	| {
			phase: "working";
			done: number;
			total: number;
			document: string;
			tag: string;
			step: WorkStep;
			/** Pages of *this* unit -- what explains a bar sitting still on a forty-page notebook. */
			unitDone: number;
			unitTotal: number;
	  };

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
	/**
	 * Frontmatter properties (Pro), default **off** like the shipped setting: each written note gets
	 * the plugin-managed keys of `src/frontmatter.ts`. The caller has already asked the licence gate
	 * (`frontmatterAllowed`) -- the engine only hears the outcome.
	 */
	frontmatter?: boolean;
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
	 * Notes rewritten with fewer highlights than they had (see `shrinkWarning`). Counted rather than
	 * only written into `skipErrors`, because this is the one loss a user can still undo -- from a
	 * backup, and only if they hear about it while it is fresh.
	 */
	shrunkNotes: number;
	/**
	 * Documents whose source PDF was laid out again under marks that were already there (see
	 * `relaidWarning`). Counted for the same reason `shrunkNotes` is: the reader can only act on it
	 * while they still remember changing the font.
	 */
	relaidDocuments: number;
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

/** `sourceIndex` for a page that has no page in the source PDF at all; the renderer draws it on a blank sheet. */
const NO_SOURCE_PAGE = -1;

interface DocPageRef {
	id: string;
	/** 0-based index of the source-PDF page this maps to (`cPages.redir`, else document position), or `NO_SOURCE_PAGE`. Meaningful only for PDF-backed docs. */
	sourceIndex: number;
	/**
	 * True for a page added on the device, anywhere among the PDF's own pages: its `cPages` entry has
	 * no `redir`, because there is no source page for it to point at. The digest transcribes such a
	 * page whole instead of hunting margin notes on it (F21), and gives it no page number.
	 */
	appended: boolean;
}

/**
 * True for a document whose pages are an uploaded or device-rendered PDF with `.rm` annotations
 * layered on top -- an uploaded PDF, or an EPUB, which the device converts to a PDF on-device and
 * keeps that render in the cloud next to the `.epub` (`epub-sync/spec.md` §2). Both reach us through
 * `getPdf`, and everything downstream of this gate is format-agnostic.
 */
function isPdfBacked(doc: DocumentContent | LegacyDocumentContent): boolean {
	return doc.fileType === "pdf" || doc.fileType === "epub";
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
function orderedPages(doc: DocumentContent | LegacyDocumentContent, liveIds: ReadonlySet<string>, pdfBacked: boolean): DocPageRef[] {
	const cPages = doc.cPages?.pages ?? [];
	if (cPages.length > 0) {
		return cPages
			.filter((page) => !page.deleted?.value)
			.sort((a, b) => (a.idx.value < b.idx.value ? -1 : a.idx.value > b.idx.value ? 1 : 0))
			.map((page, i) => {
				// A page inserted on the device has no source page, and must not borrow the one whose
				// position it took: inserted after page 8 of a book, its position is 9, and rendering it
				// against source page 9 printed that page of the book under the reader's handwriting --
				// a page they never wrote on, which sits in a note of its own. Measured on the device.
				const appended = pdfBacked && page.redir === undefined;
				return { id: page.id, sourceIndex: appended ? NO_SOURCE_PAGE : (page.redir?.value ?? i), appended };
			});
	}
	const pages = Array.isArray(doc.pages) ? doc.pages : [];
	const filtered = pdfBacked ? pages : pages.filter((id) => liveIds.has(id));
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
async function runOcr(backend: OcrBackend, pages: OcrPage[], onPage?: () => void): Promise<UnitOcr> {
	const sent = pages.filter((page): page is OcrPage & { scene: RmPage } => page.scene !== null);

	let result: OcrResult;
	try {
		result = await backend.recognize(sent.map((page) => page.scene), onPage);
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
	/** The Pro frontmatter keys this note gets, minus `synced` (stamped at write time) -- or null when the feature is off. */
	frontmatter: Omit<NoteFrontmatter, "synced"> | null;
	/** The row this note was last written with, or undefined for a note that did not exist yet. Read by the shrink warning and the frontmatter merge. */
	previous?: SyncIndexRow;
	/** Progress tick, one per transcribed page. Per unit, which is why it travels with the params. */
	onPage?: () => void;
}

/**
 * The line a document gets when its source PDF has been laid out again since its notes were written.
 *
 * A reMarkable rebuilds a book's PDF when its font, size or margins change -- and leaves the
 * annotations exactly where they were. Measured on the device: after one font change *Alice* went
 * from 116 pages to 149, every highlight rectangle identical to the decimal, and a mark that had read
 * "Why, I wouldn't say anything about it, even if I fell off the top of the house!" now covered "was
 * coming to, but it was too". Nothing was destroyed, so `shrinkWarning` has nothing to report; the
 * marks simply describe other sentences now.
 *
 * That is the worse half of it. A quote the reader never marked reads exactly like one they did, and
 * the vault often only inherits it much later -- an unchanged page is not re-synced at all, so the
 * damage surfaces on whatever re-render comes next, long after the font was changed. The page count
 * is the last moment it is visible: it belongs to the device, unlike anything we could measure about
 * the marks themselves, which our own renderer keeps improving.
 */
function relaidWarning(name: string, before: number, now: number): string {
	return `"${name}" now has ${now} pages where it had ${before} when its notes were written. A book is laid out again when its font, size or margins change, and marks made before that keep their place while the text under them moves -- so a quote in these notes may no longer be the sentence that was marked.`;
}

/**
 * The line a unit gets when this sync found fewer highlights than the last one wrote, or null.
 *
 * A reMarkable regenerates a book's PDF when the reader changes its font or margins, and the
 * annotations made on the old render do not always survive that (spec §4). The sync still mirrors --
 * a vault holding notes no device state explains would be the worse failure -- but it must not
 * mirror a loss in silence: this line is the reader's only chance to notice while a backup of the
 * note is still worth looking for.
 */
function shrinkWarning(params: UnitParams, count: number): string | null {
	const previous = params.previous?.highlightCount;
	if (previous === undefined || count >= previous) return null;
	const unit = params.pageIndex === null ? `"${params.source}"` : `page ${params.pageIndex} of "${params.source}"`;
	return `${unit} now has ${count} highlight${count === 1 ? "" : "s"} where the last sync found ${previous}; the note mirrors the device, so the missing ones are gone from the vault too. On a book, changing the font or the margins makes the device redo its whole conversion, and annotations can be lost with it.`;
}

/** Writes the attachment + note (via `write`) and builds the index row for one produced note (notebook- or page-granularity). Rendering is the caller's job -- see the fileType branch in `runSync`. */
async function writeUnit(
	deps: Pick<SyncDeps, "attachmentStore" | "noteStore" | "now" | "ocrBackend"> & { attachmentsFolder: string },
	params: UnitParams,
	write: (fields: NoteFields) => Promise<string>,
): Promise<{ row: SyncIndexRow; ocr: OcrResult["status"]; ocrWarnings: string[]; shrink: string | null }> {
	const embedPath = await writeAttachment(deps.attachmentStore, deps.attachmentsFolder, params.docId, params.pageId, params.pdfBytes);
	const ocr: UnitOcr =
		params.keepTranscript !== undefined
			? { status: "ok", warnings: [], pages: null, text: params.keepTranscript }
			: await runOcr(deps.ocrBackend, params.ocrPages, params.onPage);

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

	// After the body write, not inside it: the managed block and its hash know nothing about
	// frontmatter, so a hand-edited `---` block never freezes the note the way a block edit does.
	let frontmatterTags: string[] | undefined;
	if (params.frontmatter !== null) {
		const written = await deps.noteStore.read(notePath);
		if (written !== null) {
			const applied = applyFrontmatter(
				written,
				{ ...params.frontmatter, synced: formatLocalMinute(new Date(synced)) },
				params.previous?.frontmatterTags ?? [],
			);
			if (applied.content !== written) await deps.noteStore.write(notePath, applied.content);
			frontmatterTags = applied.ownTags;
		}
	}

	const syncKey =
		params.pageId === null
			? notebookSyncKey(params.docId, params.tag)
			: pageSyncKey(params.docId, params.pageId, params.tag);

	const highlightCount = params.highlights.reduce((count, group) => count + group.quotes.length, 0);

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
			highlightCount,
			frontmatterTags,
		},
		ocr: ocr.status,
		ocrWarnings: ocr.warnings,
		shrink: shrinkWarning(params, highlightCount),
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
 *
 * Asked of orphaned rows too, and that is not incidental. An orphaned row still names a file, and
 * reviving it writes to that name -- while the note behind it spent the whole orphaned period as an
 * ordinary file the user could edit, delete, or replace. Two ways it stops belonging to this row:
 * the user corrected it by hand, or a rename put a *different* synced note there (possible once this
 * row's own note was deleted, so the name looked free). Skipping the active check would overwrite
 * both, silently, and the second one loses a note nobody was warned about.
 */
async function isBlockEdited(noteStore: NoteStore, row: SyncIndexRow | undefined): Promise<boolean> {
	if (row === undefined || row.blockHash === undefined) return false;
	const content = await noteStore.read(row.notePath);
	if (content === null) return false;
	const block = extractManagedBlock(content);
	if (block === null) return false;
	return blockHashOf(block) !== row.blockHash;
}

/**
 * True if an unchanged notebook must still be opened because its currently mapped notebook tags do
 * not match its active rows. This catches both direct tags and inherited folder tags. Folder tag
 * changes only update the collection hash, not each descendant document hash, so the ordinary
 * per-document change gate cannot see additions, removals, or renames on its own.
 */
function hasNotebookTagStateToReconcile(
	rows: Record<string, SyncIndexRow>,
	tagRouter: TagRouter,
	docId: string,
	notebookTags: string[],
): boolean {
	const current = new Set(notebookTags.filter((tag) => tagRouter.resolveFolder(tag) !== null));
	const active = new Set(
		Object.values(rows)
			.filter((row) => row.docId === docId && row.pageId === null && row.status === "active")
			.map((row) => row.tag),
	);
	return current.size !== active.size || [...current].some((tag) => !active.has(tag));
}

function hasRowWithStatus(rows: Record<string, SyncIndexRow>, docId: string, status: SyncRowStatus): boolean {
	return Object.values(rows).some((row) => row.docId === docId && row.status === status);
}

/**
 * True if this row's tag now maps to a different folder than the one its note was written under --
 * the user re-targeted the mapping in settings. Only the mapping fingerprint sees such a change at
 * all (nothing moves on the reMarkable side), so without this the per-document gates would skip the
 * note and it would stay in the old folder forever.
 *
 * Compared against the row's `folder`, never against where the note lies: a note the user moved
 * out of the mapped folder sits outside it too, and reading that as a re-target re-fetched,
 * re-transcribed and dragged home every moved note on the next full scan (#101). A row without the
 * field is not re-targeted -- the load-time stamp gives every row one.
 *
 * A row whose tag is no longer mapped at all is not re-targeted, it is gone: that is the orphan path.
 *
 * Trailing slashes are cosmetic, so both sides are trimmed before comparing: the mapping is stored
 * as the user typed it ("Old/" is legal), while the load-time stamp's dirname branch never produces
 * one -- compared raw, the two spellings of one folder read as a re-target and re-import the whole
 * tag, the very thing this predicate exists to prevent.
 */
function isRetargeted(row: SyncIndexRow, tagRouter: TagRouter): boolean {
	if (row.status !== "active" || row.folder === undefined) return false;
	const folder = tagRouter.resolveFolder(row.tag);
	return folder !== null && row.folder.replace(/\/+$/, "") !== folder.replace(/\/+$/, "");
}

function hasRetargetedRow(rows: Record<string, SyncIndexRow>, tagRouter: TagRouter, docId: string): boolean {
	return Object.values(rows).some((row) => row.docId === docId && isRetargeted(row, tagRouter));
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
 * `existingRow`'s `notePath` making it an in-place overwrite when a row already exists, and a fresh
 * first-free-path write when it doesn't.
 *
 * A re-targeted row moves as well, even without a rename: the tag kept its name and the *mapping*
 * was re-targeted in settings. Moving keeps the note's identity and its backlinks, and when the
 * note is gone (deleted by hand) `move` is a no-op, so it is simply written where the mapping now
 * says it belongs -- rather than back into the folder it was mapped to last time. A note the user
 * merely moved is not re-targeted and is overwritten where it lies (#101).
 */
function resolveWriter(
	noteStore: NoteStore,
	tagRouter: TagRouter,
	rename: TagRename | null,
	folder: string,
	existingRow: SyncIndexRow | undefined,
): (fields: NoteFields) => Promise<string> {
	if (rename) return (fields) => moveNote(noteStore, rename.oldRow.notePath, folder, fields);
	if (existingRow !== undefined && isRetargeted(existingRow, tagRouter)) return (fields) => moveNote(noteStore, existingRow.notePath, folder, fields);
	return (fields) => writeNote(noteStore, folder, fields, existingRow?.notePath ?? null);
}

/** Retires the rename's source row once its note has landed at the new syncKey. */
function consumeRename(rows: Record<string, SyncIndexRow>, rename: TagRename | null): void {
	if (rename) delete rows[rename.oldRow.syncKey];
}

/** A document's own tags plus the ones it inherits from the collections it sits in. */
function entryAndInheritedTagNames(entry: Entry, entriesById: ReadonlyMap<string, Entry>): string[] {
	return [...new Set([...tagNames(entry.tags), ...inheritedFolderTagNames(entry, entriesById)])];
}

/**
 * The level-2 gate: whether this document has to be opened at all.
 *
 * An orphaned row on its own is not a reason. It used to be -- so a doc that reappears after being
 * deleted (whose hash may come back identical) would not stay `orphaned` forever -- but that
 * reopened every doc that had ever lost a tag on every full scan, and for a PDF-backed doc a reopen
 * is a download, a render and a per-cluster transcription on a metered backend (#101). The vanish
 * pass now clears the hash of the rows it orphans, so a doc that comes back fails the hash check
 * instead; a row orphaned per-tag while its doc was open keeps the current hash and costs nothing.
 * A note deleted out from under an active row is still a reason: nothing on the device says so.
 */
async function needsDocumentOpen(
	noteStore: NoteStore,
	rows: Record<string, SyncIndexRow>,
	tagRouter: TagRouter,
	entry: Entry,
	entryAndInheritedTags: string[],
): Promise<boolean> {
	if (findEntryHash(rows, entry.id) !== entry.hash) return true;
	return (
		hasNotebookTagStateToReconcile(rows, tagRouter, entry.id, entryAndInheritedTags) ||
		hasRetargetedRow(rows, tagRouter, entry.id) ||
		hasStaleRender(rows, entry.id) ||
		(await hasMissingActiveNote(noteStore, rows, entry.id))
	);
}

type PageTagRef = NonNullable<DocumentContent["pageTags"]>[number];

/** The tags of a document that resolve to a folder, at both granularities. */
interface MappedTags {
	notebook: string[];
	page: PageTagRef[];
}

function mappedTags(tagRouter: TagRouter, entryAndInheritedTags: string[], content: DocumentContent | LegacyDocumentContent): MappedTags {
	const notebookTags = [...new Set([...entryAndInheritedTags, ...tagNames(content.tags)])];
	return {
		notebook: notebookTags.filter((tag) => tagRouter.resolveFolder(tag) !== null),
		page: (content.pageTags ?? []).filter((pageTag) => tagRouter.resolveFolder(pageTag.name) !== null),
	};
}

/** One note this document would produce, with every decision behind it already made. */
interface UnitPlan {
	/** null for a notebook-tag unit. */
	pageId: string | null;
	tag: string;
	existingRow: SyncIndexRow;
	/** The row this unit overwrites: the rename's source row when the tag moved, otherwise its own. */
	writtenRow: SyncIndexRow;
	rename: TagRename | null;
	/** Set when the unit is reached but not written, so the caller can count it the way it always has. */
	skip: "edited" | null;
	/** Pages of real work: every live page for a notebook tag, 1 for a page tag, 0 when skipped. */
	steps: number;
}

interface DocumentPlan {
	notebook: UnitPlan[];
	pages: (UnitPlan & { pageId: string })[];
	/** Rows whose tag is gone, for the caller to orphan. */
	orphan: SyncIndexRow[];
}

/**
 * Every unit a document produces this round, decided once. Two callers walk this: the pre-scan, which
 * sums `steps` into the progress bar's denominator, and `runSync`, which does the work. Deciding it
 * twice is what would let the bar promise a note the run then skips -- and the tag diff is where such
 * a disagreement would be least visible, because a rename changes *which row* a unit overwrites.
 *
 * Both diffs are computed up front, which is equivalent to `runSync`'s old order: notebook rows carry
 * `pageId === null` and page rows do not, so the two sets are disjoint and neither loop could ever
 * have moved a row the other one reads.
 */
async function planUnits(
	noteStore: NoteStore,
	rows: Record<string, SyncIndexRow>,
	tagRouter: TagRouter,
	entry: Entry,
	mapped: MappedTags,
	docPages: DocPageRef[],
	pageContentHash: (pageId: string) => string,
): Promise<DocumentPlan> {
	const livePageIds = new Set(docPages.map((page) => page.id));
	const plan: DocumentPlan = { notebook: [], pages: [], orphan: [] };

	// Diff against what was last synced for this notebook to catch a tag renamed to a different
	// folder-tag (move, preserving the note's identity/backlinks) vs. a tag that's simply gone
	// (orphan) -- see diffUnitTags. Only previously-*active* rows count: an already-orphaned row
	// has no bearing on what's "removed" this round.
	const previousNotebookRows = Object.values(rows).filter(
		(row) => row.docId === entry.id && row.pageId === null && row.status === "active",
	);
	const notebookDiff = diffUnitTags(previousNotebookRows, mapped.notebook);
	plan.orphan.push(...notebookDiff.orphan);

	// Notebook-tag notes always reassemble every live page once the notebook is opened: rows for
	// these carry no per-page hash (spec §7's row schema), so there's no cheaper way to know which
	// of a reopened notebook's pages are safe to skip -- only page-tag rows track that.
	for (const tag of mapped.notebook) {
		const rename = notebookDiff.rename?.newTag === tag ? notebookDiff.rename : null;
		const existingRow = rows[notebookSyncKey(entry.id, tag)];
		// Checked before rendering and before OCR: a note we will not write must not cost a download,
		// a render, or -- on a metered backend -- money. On a rename the note about to be rewritten is
		// the *old* row's, which has no row at this tag's key yet.
		const writtenRow = rename?.oldRow ?? existingRow;
		const edited = await isBlockEdited(noteStore, writtenRow);
		plan.notebook.push({ pageId: null, tag, existingRow, writtenRow, rename, skip: edited ? "edited" : null, steps: edited ? 0 : docPages.length });
	}

	// Same diff, per tagged (and still-live) page -- a page's tags are their own independent unit.
	const previousPageRows = Object.values(rows).filter(
		(row) => row.docId === entry.id && row.pageId !== null && row.status === "active",
	);
	const liveTagsByPage = new Map<string, string[]>();
	for (const pageTag of mapped.page) {
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
		plan.orphan.push(...pageDiff.orphan);
		if (pageDiff.rename) pageRenames.set(pageId, pageDiff.rename);
	}

	for (const pageTag of mapped.page) {
		if (!livePageIds.has(pageTag.pageId)) continue; // tagged page no longer exists on the device
		const rename = pageRenames.get(pageTag.pageId)?.newTag === pageTag.name ? pageRenames.get(pageTag.pageId)! : null;
		const existingRow = rows[pageSyncKey(entry.id, pageTag.pageId, pageTag.name)];
		// level 3: page unchanged, don't re-render it -- unless it's currently orphaned (revive), a
		// rename target, its tag was re-targeted to another folder, its note went missing from the
		// vault (deleted by hand), or it was rendered by an older renderer. The last two have to be
		// here as well as at the document gate: nothing on the device changes when the renderer or a
		// mapping does, so a page-tag note whose page never changes again would keep an outdated
		// render -- or the old folder -- forever.
		if (
			!rename &&
			existingRow?.status === "active" &&
			!isRetargeted(existingRow, tagRouter) &&
			existingRow.pageHash === pageContentHash(pageTag.pageId) &&
			!isStaleRender(existingRow) &&
			(await noteStore.read(existingRow.notePath)) !== null
		) {
			continue;
		}

		// As above: refuse before spending anything on a note we will not write.
		const writtenRow = rename?.oldRow ?? existingRow;
		const edited = await isBlockEdited(noteStore, writtenRow);
		plan.pages.push({ pageId: pageTag.pageId, tag: pageTag.name, existingRow, writtenRow, rename, skip: edited ? "edited" : null, steps: edited ? 0 : 1 });
	}

	return plan;
}

/**
 * How wide the pre-scan fans out. One round trip per candidate walked serially is seconds of dead air
 * before the bar can appear, and a bound of 6 is strictly more conservative than what already ships:
 * a notebook's pages are rendered with an unbounded `Promise.all`. The scan only reads, so a partial
 * failure costs nothing written.
 */
const SCAN_PARALLELISM = 6;

/** Drives the progress bar through one run. See `progressTicker`. */
interface ProgressTicker {
	/** A unit is starting: `steps` pages of work on `document`, for `tag`. */
	start: (steps: number, document: string, tag: string, step: WorkStep) => void;
	/** The sub-phase changed; the count did not. */
	step: (step: WorkStep) => void;
	/** One page finished transcribing. Handed straight to a backend, so it stands on its own. */
	page: () => void;
	/** The unit is over, one way or another. */
	finish: () => void;
}

/**
 * The progress arithmetic, shared by both engines so they cannot count differently.
 *
 * `done` only ever grows, and a unit contributes exactly the steps the scan counted for it: its pages
 * as each finishes, then everything that never reported individually when the unit ends. That last
 * part is what makes a backend which cannot report per page -- Vision, `off`, a reused transcript --
 * indistinguishable from one that can, as far as the total is concerned.
 *
 * The clamp in `page()` is per unit, and there is deliberately none on `done` itself: a scan that
 * disagreed with the run has to show up as a total that does not add up, rather than being quietly
 * papered over.
 */
function progressTicker(report: (progress: SyncProgress) => void, total: number): ProgressTicker {
	let done = 0;
	let unitDone = 0;
	let unitTotal = 0;
	let document = "";
	let tag = "";

	// A run with nothing to do never enters the working phase at all, so `total: 0` is never sent.
	const emit = (step: WorkStep): void => {
		if (total > 0) report({ phase: "working", done, total, document, tag, step, unitDone, unitTotal });
	};

	return {
		start: (steps, unitDocument, unitTag, step) => {
			unitDone = 0;
			unitTotal = steps;
			document = unitDocument;
			tag = unitTag;
			emit(step);
		},
		step: emit,
		page: () => {
			if (unitDone >= unitTotal) return;
			unitDone++;
			done++;
			emit("transcribing");
		},
		finish: () => {
			done += unitTotal - unitDone;
			unitDone = unitTotal;
			emit("writing");
		},
	};
}

/** What the pre-scan learned before the first note is written. */
interface Workload {
	/** Pages of real work the run will report. 0 means there is nothing to write at all. */
	total: number;
	/** Documents whose content could not be read, by id, with the message the run reports. Binding: the run skips them too. */
	unreadable: Map<string, string>;
	stopped: boolean;
}

/**
 * Counts the work before any of it is done, so the progress bar has an honest denominator.
 *
 * It costs nothing to hold: `rmapi-js` caches hash-addressed and the plugin opens one session per
 * run, so every fetch here is a cache hit when the run repeats it. The scan therefore keeps nothing
 * of its own -- it only fills the cache earlier.
 *
 * A document that cannot be read is **0 steps and skipped by the run as well**, so it is reported
 * once and the denominator stays exact. Its `entryHash` is left alone either way, so the next sync
 * picks it up again.
 */
async function scanWorkload(
	deps: SyncDeps,
	rows: Record<string, SyncIndexRow>,
	documents: Entry[],
	entriesById: ReadonlyMap<string, Entry>,
	report: (progress: SyncProgress) => void,
	shouldStop: () => boolean,
): Promise<Workload> {
	const { api, tagRouter } = deps;
	const unreadable = new Map<string, string>();

	// Local only -- a hash comparison and a few vault reads -- so the candidate count is known almost
	// at once, and the user is not left watching a spinner while the counting itself is counted.
	const candidates: { entry: Entry; tags: string[] }[] = [];
	for (const entry of documents) {
		if (shouldStop()) return { total: 0, unreadable, stopped: true };
		const tags = entryAndInheritedTagNames(entry, entriesById);
		if (await needsDocumentOpen(deps.noteStore, rows, tagRouter, entry, tags)) candidates.push({ entry, tags });
	}

	let checked = 0;
	let stopped = false;
	// Shared across the workers on purpose: it is "the document this scan reached last", which is what
	// a display can honestly say while six of them are open at once.
	let current = "";
	report({ phase: "scanning", checked, candidates: candidates.length });

	const steps = await mapWithConcurrency(candidates, SCAN_PARALLELISM, async ({ entry, tags }) => {
		if (shouldStop()) {
			stopped = true;
			return 0;
		}
		current = entry.visibleName;
		report({ phase: "scanning", checked, candidates: candidates.length, document: current });
		try {
			let content: DocumentContent | LegacyDocumentContent;
			try {
				content = (await api.getContent(entry.id, entry.hash)) as DocumentContent | LegacyDocumentContent;
			} catch (error) {
				console.warn(`Tagged Sync: failed to read "${entry.visibleName}" during sync, skipping`, error);
				unreadable.set(entry.id, `failed to read "${entry.visibleName}" during sync: ${errorText(error)}`);
				return 0;
			}

			const mapped = mappedTags(tagRouter, tags, content);
			// A document opened only to orphan rows writes no note, so it is no steps -- and it does not
			// need its files fetched to say so.
			if (mapped.notebook.length === 0 && mapped.page.length === 0) return 0;

			const pdfBacked = isPdfBacked(content);
			const { pages: pageHashes } = await getDocumentFiles(api, entry.id, entry.hash);
			const docPages = orderedPages(content, new Set(pageHashes.keys()), pdfBacked);
			const plan = await planUnits(deps.noteStore, rows, tagRouter, entry, mapped, docPages, (pageId) =>
				pdfBacked ? entry.hash : (pageHashes.get(pageId) ?? entry.hash),
			);
			return [...plan.notebook, ...plan.pages].reduce((sum, unit) => sum + unit.steps, 0);
		} catch (error) {
			// Anything else that goes wrong while merely counting is left to the run, which meets it
			// exactly as it always has. The denominator is then short by this document -- a bar that
			// jumps, against a sync that behaves as before.
			console.warn(`Tagged Sync: could not measure "${entry.visibleName}" up front`, error);
			return 0;
		} finally {
			report({ phase: "scanning", checked: ++checked, candidates: candidates.length, document: current });
		}
	});

	return { total: steps.reduce((sum, count) => sum + count, 0), unreadable, stopped };
}

/**
 * Runs the full one-way sync pipeline: enumerate -> hash-diff -> download -> render -> OCR -> write note,
 * for every mapped tag at both granularities (spec §7).
 */
export async function runSync(deps: SyncDeps, previousIndex: SyncIndex): Promise<SyncResult> {
	const { api, tagRouter, now, ocrBackend } = deps;
	const attachmentsFolder = deps.attachmentsFolder ?? DEFAULT_ATTACHMENTS_FOLDER;
	const writeDeps = { attachmentStore: deps.attachmentStore, noteStore: deps.noteStore, now, attachmentsFolder, ocrBackend };
	const report = deps.onProgress ?? (() => {});
	const shouldStop = deps.shouldStop ?? (() => false);

	report({ phase: "scanning", checked: 0, candidates: 0 });
	const [rootHash] = await api.raw.getRootHash();
	const mappings = tagRouter.fingerprint();
	// The stale-render check has to happen here too, not just per doc: nothing on the device changes
	// when the renderer does, so an unchanged root hash would otherwise return before any doc is
	// even looked at, and notes rendered by an older version would never be corrected. The mappings
	// fingerprint is here for the same reason from the other side: a settings change moves nothing
	// on the device.
	const staleRenders = Object.values(previousIndex.rows).some(isStaleRender);
	if (rootHash === previousIndex.rootHash && mappings === previousIndex.mappings && !staleRenders && !(await hasMissingActiveNote(deps.noteStore, previousIndex.rows))) {
		return { index: previousIndex, stopped: false, notesWritten: 0, unavailableOcrUnits: 0, failedOcrUnits: 0, editedNotesSkipped: 0, documentsSkipped: 0, shrunkNotes: 0, relaidDocuments: 0, skipErrors: [] };
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
	let shrunkNotes = 0;
	let relaidDocuments = 0;

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
			shrunkNotes,
			relaidDocuments,
			skipErrors,
		};
	};

	const entries = await api.listItems();
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	// A trashed document is not a document any more: it still enumerates (the tombstone only comes
	// with the next cloud sync) and its own tags and page tags are still in its `.content`, so
	// without this it would keep writing notes -- and the orphan sweep below would keep it alive.
	const documents = entries.filter((entry) => entry.type === "DocumentType" && !isInTrash(entry, entriesById));

	const workload = await scanWorkload(deps, rows, documents, entriesById, report, shouldStop);
	// Nothing has been written yet, so there is nothing to checkpoint -- but the caller still has to
	// hear that this run was stopped rather than finished.
	if (workload.stopped) return stopHere();
	for (const [docId, message] of workload.unreadable) {
		skipErrors.push(message);
		skippedDocIds.add(docId);
	}

	const bar = progressTicker(report, workload.total);

	for (const entry of documents) {
		// Also here, not just at the unit loops below: most documents are skipped by the level-2 gate
		// without producing a unit at all, and a stop must not have to walk hundreds of them first.
		if (shouldStop()) return stopHere();
		const entryAndInheritedTags = entryAndInheritedTagNames(entry, entriesById);

		// The scan already failed to read this one, and said so. Trying again would report it twice.
		if (workload.unreadable.has(entry.id)) continue;
		if (!(await needsDocumentOpen(deps.noteStore, rows, tagRouter, entry, entryAndInheritedTags))) continue; // level 2

		let content: DocumentContent | LegacyDocumentContent;
		try {
			content = (await api.getContent(entry.id, entry.hash)) as DocumentContent | LegacyDocumentContent;
		} catch (error) {
			console.warn(`Tagged Sync: failed to read "${entry.visibleName}" during sync, skipping`, error);
			skipErrors.push(`failed to read "${entry.visibleName}" during sync: ${errorText(error)}`);
			skippedDocIds.add(entry.id);
			continue;
		}

		const mapped = mappedTags(tagRouter, entryAndInheritedTags, content);

		// Nothing mapped now, and nothing previously active to potentially orphan -- truly nothing to do.
		const hasPreviouslyActiveRow = hasRowWithStatus(rows, entry.id, "active");
		if (mapped.notebook.length === 0 && mapped.page.length === 0 && !hasPreviouslyActiveRow) continue;

		// A PDF-backed doc's pages are a source PDF with handwritten annotations layered on top. The
		// render composites the two: each page shows the source page with its `.rm` annotation scene
		// drawn over it (see renderAnnotatedPdf). Notebook tag -> every page; page tag -> just that
		// page.
		const pdfBacked = isPdfBacked(content);

		// One base per document; each unit adds its own selector tag and write timestamp. The tags are
		// the document's -- page tags stay out (spec) -- so a page-tag note still carries at least its
		// own selector, which is what keeps `FROM #remarkable` universal.
		const frontmatterBase = deps.frontmatter
			? {
					modified: deviceModified(entry.lastModified),
					folder: folderPathOf(entry, entriesById),
					type: content.fileType === "epub" ? ("epub" as const) : content.fileType === "pdf" ? ("pdf" as const) : ("notebook" as const),
					pinned: entry.pinned,
					uuid: entry.id,
				}
			: null;
		const docTags = [...new Set([...entryAndInheritedTags, ...tagNames(content.tags)])];
		const unitFrontmatter = (tag: string): Omit<NoteFrontmatter, "synced"> | null =>
			frontmatterBase === null ? null : { ...frontmatterBase, tags: namespacedTags([...docTags, tag]) };

		const { pages: pageHashes, images: imageFiles, epub: epubFile } = await getDocumentFiles(api, entry.id, entry.hash);
		const liveIds = new Set(pageHashes.keys());
		const docPages = orderedPages(content, liveIds, pdfBacked);

		// Counted from the pages that have a source page, so a page *added* on the device -- which
		// changes the document's own page count and nothing about the book -- is not mistaken for a
		// re-layout.
		const sourcePageCount = pdfBacked ? docPages.filter((page) => !page.appended).length : null;
		if (sourcePageCount !== null) {
			const before = Object.values(rows).find(
				(row) => row.docId === entry.id && row.status === "active" && row.sourcePageCount !== undefined && row.sourcePageCount !== sourcePageCount,
			)?.sourcePageCount;
			if (before !== undefined) {
				skipErrors.push(relaidWarning(entry.visibleName ?? entry.id, before, sourcePageCount));
				relaidDocuments++;
			}
		}
		const pageOrder = docPages.map((page) => page.id);
		const pageRefById = new Map(docPages.map((page) => [page.id, page]));

		// Fetched once per doc, only if some unit actually needs it (a doc may open just to orphan rows).
		let sourcePdf: Promise<Uint8Array> | null = null;
		const getSourcePdf = () => (sourcePdf ??= api.getPdf(entry.id, entry.hash).then(validateSourcePdf));

		// The book behind a rendered EPUB, on the same terms: at most once per doc, and only when a
		// digest has something whose wording is worth correcting (see `DigestSource.book`).
		let book: Promise<EpubBook | null> | null = null;
		const getBook = epubFile === null ? undefined : () => (book ??= api.raw.getHash(epubFile.id, epubFile.hash).then(readEpubBook));

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
					// The tick comes from the pipeline's page loop rather than from the backend: it
					// transcribes per cluster, which is finer than the page the bar counts.
					{ ocrBackend, marginNotes: deps.marginNotes ?? false, onPage: bar.page },
					{
						source: pdfBacked ? { kind: "pdf", bytes: await getSourcePdf(), book: getBook } : { kind: "typed-text" },
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
		const pageContentHash = (pageId: string): string => (pdfBacked ? entry.hash : (pageHashes.get(pageId) ?? entry.hash));

		const plan = await planUnits(deps.noteStore, rows, tagRouter, entry, mapped, docPages, pageContentHash);
		for (const row of plan.orphan) orphanRow(rows, row);

		for (const unit of plan.notebook) {
			if (shouldStop()) return stopHere();
			const { tag, rename, existingRow } = unit;
			const folder = tagRouter.resolveFolder(tag)!;

			if (unit.skip === "edited") {
				editedKeys.add(unit.writtenRow.syncKey);
				editedNotesSkipped++;
				continue;
			}
			bar.start(unit.steps, entry.visibleName, tag, "rendering");

			let pdfBytes: Uint8Array;
			let ocrPages: OcrPage[];
			let highlights: HighlightGroup[];
			// Non-null exactly for a PDF-backed unit, i.e. the units that get a digest instead of a transcript.
			let digestPages: DigestPageInput[] | null = null;
			try {
				if (pdfBacked) {
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
				// The bar counted these pages before anything went wrong, and the failure is already in
				// the run's own report -- so they count as done rather than stranding the bar short.
				bar.finish();
				continue;
			}
			bar.step("transcribing");

			const digest = digestPages
				? await buildUnitDigest(null, digestPages, `"${entry.visibleName}" for tag "${tag}"`)
				: { markdown: "", ocr: null };

			const { row, ocr, ocrWarnings, shrink } = await writeUnit(
				writeDeps,
				{
					// An empty page list makes `runOcr` return `skipped` without spawning anything -- the
					// digest already transcribed this unit, cluster by cluster.
					ocrPages: digest.ocr === null ? ocrPages : [],
					keepTranscript: await reusableTranscript(deps.noteStore, unit.writtenRow, existingRow?.entryHash === entry.hash, ocrPages),
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
					frontmatter: unitFrontmatter(tag),
					previous: unit.writtenRow,
					onPage: bar.page,
				},
				resolveWriter(deps.noteStore, tagRouter, rename, folder, existingRow),
			);
			consumeRename(rows, rename);
			rows[row.syncKey] = { ...row, folder };
			notesWritten++;
			bar.finish();
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
			if (shrink !== null) {
				skipErrors.push(shrink);
				shrunkNotes++;
			}
			if (unitOcr === "unavailable") unavailableOcrUnits++;
			if (unitOcr === "failed") failedOcrUnits++;
		}

		for (const unit of plan.pages) {
			if (shouldStop()) return stopHere();
			const { tag, rename, existingRow } = unit;
			const pageHash = pageContentHash(unit.pageId);

			if (unit.skip === "edited") {
				editedKeys.add(unit.writtenRow.syncKey);
				editedNotesSkipped++;
				continue;
			}
			bar.start(unit.steps, entry.visibleName, tag, "rendering");

			const pageIndex = pageOrder.indexOf(unit.pageId) + 1;
			const folder = tagRouter.resolveFolder(tag)!;

			let pdfBytes: Uint8Array;
			let ocrPages: OcrPage[];
			let highlights: HighlightGroup[];
			let digestPages: DigestPageInput[] | null = null;
			try {
				if (pdfBacked) {
					const pageRef = pageRefById.get(unit.pageId)!;
					const composite = await annotatedPdfPages(api, entry.id, [pageRef], pageHashes);
					pdfBytes = await renderAnnotatedPdf(await getSourcePdf(), composite);
					// A single-page embed, so the `#page=` anchor is 1 -- the same ordinals `collectHighlights` gets.
					ocrPages = [{ scene: composite[0]?.annotations ?? null, pageLabel: pageIndex, embedPage: 1 }];
					highlights = collectHighlights([{ pageLabel: pageIndex, embedPage: 1, highlights: composite[0]?.annotations?.highlights ?? [] }]);
					digestPages = composite.map((page) => ({ pageId: unit.pageId, sourceIndex: page.sourceIndex, embedPage: 1, scene: page.annotations, appended: pageRef.appended }));
				} else {
					const scenes = [await renderPage(api, entry.id, unit.pageId, pageHashes.get(unit.pageId))];
					ocrPages = [{ scene: scenes[0], pageLabel: pageIndex, embedPage: 1 }];
					pdfBytes = await renderPagesToPdf(scenes, await fetchPageImages(api, scenes, imageFiles));
					highlights = collectHighlights([{ pageLabel: pageIndex, embedPage: 1, highlights: scenes[0].highlights ?? [] }]);
					skipErrors.push(...renderNotes(scenes, () => `Page ${pageIndex} of "${entry.visibleName}"`));
					// A single-page embed, so the `#page=` anchor is 1 -- as in the PDF branch above.
					digestPages = isDocumentText(scenes[0]) ? [{ pageId: unit.pageId, sourceIndex: 0, embedPage: 1, scene: scenes[0] }] : null;
				}
			} catch (error) {
				console.warn(`Tagged Sync: failed to render page ${pageIndex} of "${entry.visibleName}" for tag "${tag}", skipping`, error);
				skipErrors.push(`failed to render page ${pageIndex} of "${entry.visibleName}" for tag "${tag}": ${errorText(error)}`);
				skippedDocIds.add(entry.id);
				bar.finish(); // see the notebook-tag branch
				continue;
			}
			bar.step("transcribing");

			const digest = digestPages
				? await buildUnitDigest(unit.pageId, digestPages, `page ${pageIndex} of "${entry.visibleName}" for tag "${tag}"`)
				: { markdown: "", ocr: null };

			const { row, ocr, ocrWarnings, shrink } = await writeUnit(
				writeDeps,
				{
					// See the notebook-tag branch: a built digest has already transcribed this unit.
					ocrPages: digest.ocr === null ? ocrPages : [],
					keepTranscript: await reusableTranscript(deps.noteStore, unit.writtenRow, existingRow?.pageHash === pageHash, ocrPages),
					pdfBytes,
					highlights,
					digest: digest.markdown,
					docId: entry.id,
					pageId: unit.pageId,
					pageIndex: pageIndex > 0 ? pageIndex : null,
					tag,
					source: entry.visibleName,
					entryHash: entry.hash,
					pageHash,
					frontmatter: unitFrontmatter(tag),
					previous: unit.writtenRow,
					onPage: bar.page,
				},
				resolveWriter(deps.noteStore, tagRouter, rename, folder, existingRow),
			);
			consumeRename(rows, rename);
			rows[row.syncKey] = { ...row, folder };
			notesWritten++;
			bar.finish();
			await checkpoint(); // see the notebook-tag branch
			const unitOcr = digest.ocr ?? ocr;
			// See the notebook-tag branch: without this the lost page leaves no trace at all.
			skipErrors.push(...ocrWarnings);
			if (shrink !== null) {
				skipErrors.push(shrink);
				shrunkNotes++;
			}
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

		// Every row of this document, written this round or not: the warning above is about a layout
		// that has already happened, and saying it on every sync from here on would make it noise.
		if (sourcePageCount !== null) {
			for (const row of Object.values(rows)) {
				if (row.docId === entry.id && row.sourcePageCount !== sourcePageCount) rows[row.syncKey] = { ...rows[row.syncKey], sourcePageCount };
			}
		}

		await checkpoint();
	}

	// Deletion: any unit whose doc no longer appears in the enumeration at all is flagged
	// orphaned, never auto-deleted (spec §7). A doc in the trash counts as gone, same as one whose
	// files have vanished. A doc still present but missing a specific tag was already orphaned
	// above, per-tag, while its content was open.
	//
	// The hash goes with it: a doc restored from the trash comes back with the hash it left with,
	// and the level-2 gate compares against this row -- an empty hash is what makes it reopen the
	// doc and revive the row, now that an orphaned row alone no longer does (see needsDocumentOpen).
	const liveDocIds = new Set(documents.map((entry) => entry.id));
	for (const row of Object.values(rows)) {
		if (row.status === "active" && !liveDocIds.has(row.docId)) rows[row.syncKey] = { ...row, status: "orphaned", entryHash: "" };
	}

	return { index: { rootHash, mappings, rows }, stopped: false, notesWritten, unavailableOcrUnits, failedOcrUnits, editedNotesSkipped, documentsSkipped: skippedDocIds.size, shrunkNotes, relaidDocuments, skipErrors };
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
async function ocrPagesForRow(api: SyncApi, docId: string, row: SyncIndexRow, docPages: DocPageRef[], pageHashes: Map<string, string>, pdfBacked: boolean): Promise<OcrPage[] | null> {
	if (row.pageId === null) {
		return pdfBacked
			? annotationOcrPages(await annotatedPdfPages(api, docId, docPages, pageHashes))
			: notebookOcrPages(await Promise.all(docPages.map((page) => renderPage(api, docId, page.id, pageHashes.get(page.id)))));
	}
	const pageIndex = docPages.findIndex((candidate) => candidate.id === row.pageId);
	if (pageIndex === -1) return null; // the tagged page no longer exists on the device
	// A single-page embed, so the `#page=` anchor is 1 -- matching the page-tag branch of `runSync`.
	const labels = { pageLabel: pageIndex + 1, embedPage: 1 };
	return pdfBacked
		? [{ scene: (await annotatedPdfPages(api, docId, [docPages[pageIndex]], pageHashes))[0]?.annotations ?? null, ...labels }]
		: [{ scene: await renderPage(api, docId, row.pageId, pageHashes.get(row.pageId)), ...labels }];
}

/**
 * How many pages of work one already-synced row is, without doing any of it.
 *
 * Deliberately not `ocrPagesForRow`, which is the obvious-looking way to ask: that function *renders*
 * every page it describes, so counting with it would double the whole run's rendering. A row's page
 * count is structural -- the document's live pages for a notebook row, one for a page row, none for a
 * page that has since disappeared.
 */
function reTranscribeSteps(row: SyncIndexRow, docPages: DocPageRef[]): number {
	if (row.pageId === null) return docPages.length;
	return docPages.some((page) => page.id === row.pageId) ? 1 : 0;
}

/** The pre-scan for `reTranscribeAll`: the same shape as `scanWorkload`, over index rows instead of device documents. */
async function scanReTranscribe(
	deps: ReTranscribeDeps,
	rowsByDoc: Map<string, SyncIndexRow[]>,
	entryById: Map<string, Entry>,
	report: (progress: SyncProgress) => void,
	shouldStop: () => boolean,
): Promise<Workload> {
	const unreadable = new Map<string, string>();
	const candidates = [...rowsByDoc.keys()].filter((docId) => entryById.has(docId));
	let checked = 0;
	let stopped = false;
	let current = ""; // see `scanWorkload`
	report({ phase: "scanning", checked, candidates: candidates.length });

	const steps = await mapWithConcurrency(candidates, SCAN_PARALLELISM, async (docId) => {
		if (shouldStop()) {
			stopped = true;
			return 0;
		}
		const entry = entryById.get(docId)!;
		current = entry.visibleName;
		report({ phase: "scanning", checked, candidates: candidates.length, document: current });
		try {
			let content: DocumentContent | LegacyDocumentContent;
			try {
				content = (await deps.api.getContent(entry.id, entry.hash)) as DocumentContent | LegacyDocumentContent;
			} catch (error) {
				console.warn(`Tagged Sync: failed to read "${entry.visibleName}" during re-transcribe, skipping`, error);
				unreadable.set(docId, "");
				return 0;
			}
			const { pages: pageHashes } = await getDocumentFiles(deps.api, entry.id, entry.hash);
			const docPages = orderedPages(content, new Set(pageHashes.keys()), isPdfBacked(content));
			return (rowsByDoc.get(docId) ?? []).reduce((sum, row) => sum + reTranscribeSteps(row, docPages), 0);
		} catch (error) {
			// See `scanWorkload`: measuring must never be the thing that breaks a run.
			console.warn(`Tagged Sync: could not measure "${entry.visibleName}" up front`, error);
			return 0;
		} finally {
			report({ phase: "scanning", checked: ++checked, candidates: candidates.length, document: current });
		}
	});

	return { total: steps.reduce((sum, count) => sum + count, 0), unreadable, stopped };
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

	const entries = await api.listItems();
	const entryById = new Map(entries.filter((entry) => entry.type === "DocumentType").map((entry) => [entry.id, entry]));

	let updated = 0;
	const docIds = [...rowsByDoc.keys()];
	const checkpoint = deps.saveIndex ? () => deps.saveIndex!({ ...index, rows: { ...rows } }) : async () => {};
	// A stopped run still hands back every `blockHash` it refreshed: those notes were rewritten, and a
	// caller that drops them would leave the next sync reading the plugin's own work as a hand edit.
	const stopHere = (): { updated: number; index: SyncIndex; stopped: boolean } => ({ updated, index: { ...index, rows }, stopped: true });

	const workload = await scanReTranscribe(deps, rowsByDoc, entryById, report, shouldStop);
	if (workload.stopped) return stopHere();
	const bar = progressTicker(report, workload.total);

	for (const docId of docIds) {
		if (shouldStop()) return stopHere();
		const entry = entryById.get(docId);
		if (!entry) continue; // doc no longer on the device -- leave its notes untouched
		if (workload.unreadable.has(docId)) continue; // the scan already failed to read it

		let content: DocumentContent | LegacyDocumentContent;
		try {
			content = (await api.getContent(entry.id, entry.hash)) as DocumentContent | LegacyDocumentContent;
		} catch (error) {
			console.warn(`Tagged Sync: failed to read "${entry.visibleName}" during re-transcribe, skipping`, error);
			continue;
		}

		const pdfBacked = isPdfBacked(content);
		const { pages: pageHashes } = await getDocumentFiles(api, entry.id, entry.hash);
		const docPages = orderedPages(content, new Set(pageHashes.keys()), pdfBacked);

		for (const row of rowsByDoc.get(docId)!) {
			if (shouldStop()) return stopHere();
			// `ocrPagesForRow` renders every page it returns, so this really is the rendering step and
			// not, as it looks, a pure OCR path.
			bar.start(reTranscribeSteps(row, docPages), entry.visibleName, row.tag, "rendering");
			let ocrPages: OcrPage[] | null;
			try {
				ocrPages = await ocrPagesForRow(api, entry.id, row, docPages, pageHashes, pdfBacked);
			} catch (error) {
				console.warn(`Tagged Sync: failed to re-fetch "${entry.visibleName}" for re-transcribe, skipping`, error);
				bar.finish(); // counted before it failed; the bar must still reach its total
				continue;
			}
			if (ocrPages === null) {
				bar.finish();
				continue;
			}
			bar.step("transcribing");

			const ocr = await runOcr(ocrBackend, ocrPages, bar.page);
			// The per-page headings link into the note's own embed, which this path knows only from the
			// note: it holds a row, not the sync's attachment folder. A note without one (hand-broken, or
			// written by a much older version) falls back to the unlabelled transcript rather than
			// emitting links that go nowhere.
			const embedPath = readEmbedPath((await noteStore.read(row.notePath)) ?? "");
			const transcript = embedPath === null ? ocr.text : renderTranscript(embedPath, ocr.pages, ocr.text);
			if (!(await updateTranscript(noteStore, row.notePath, transcript))) {
				bar.finish();
				continue;
			}
			updated++;
			bar.finish();

			const block = extractManagedBlock((await noteStore.read(row.notePath)) ?? "");
			if (block !== null) rows[row.syncKey] = { ...row, blockHash: blockHashOf(block) };
			// Per note, for the same reason the sync checkpoints per unit: the note on disk and the hash
			// that describes it must not be allowed to drift apart across an interruption.
			await checkpoint();
		}
	}
	return { updated, index: { ...index, rows }, stopped: false };
}
