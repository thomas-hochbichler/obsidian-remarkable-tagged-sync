import type { DocumentContent, LegacyDocumentContent, RawRemarkableApi, RemarkableApi } from "rmapi-js";
import { DEFAULT_ATTACHMENTS_FOLDER, type AttachmentStore, writeAttachment } from "./attachment-writer";
import {
	blockHashOf,
	extractManagedBlock,
	type HighlightGroup,
	managedBlockHash,
	moveNote,
	type NoteFields,
	type NoteStore,
	updateTranscript,
	writeNote,
} from "./note-builder";
import type { OcrBackend, OcrResult } from "./ocr-backend";
import { getPageHashes } from "./page-hash";
import { type AnnotatedPdfPage, renderAnnotatedPdf, renderPagesToPdf } from "./pdf-renderer";
import { validateSourcePdf } from "./pdf-source";
import { tagNames } from "./remarkable-tags";
import { parseRmV6, type RmHighlight, type RmPage } from "./rm-parser";
import type { TagRouter } from "./tag-router";

export type SyncRowStatus = "active" | "orphaned";

/**
 * Bumped whenever a renderer change means an already-synced note's attachment is wrong rather than
 * merely older -- a note rendered under an earlier version is re-rendered on the next sync even
 * though nothing changed on the device, which is otherwise the one thing change detection can't
 * notice. Rows written before this field existed re-render once, which is the intent: version 2
 * fixed where a PDF-backed document's annotations land on the page; version 3 fixed Paper Pro
 * highlights rendering opaque black instead of their palette color.
 */
export const RENDER_VERSION = 3;

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
	/** Injectable clock -- returns the current time as an ISO string. */
	now: () => string;
	onProgress?: (progress: SyncProgress) => void;
	/**
	 * Persists the index mid-run, after each document. Without it a sync that is interrupted -- quit,
	 * lost network, any throw -- leaves already-written notes with no index row, and the next sync,
	 * refusing to clobber a file it does not own, writes `Notebook (sync).md` beside each of them.
	 * Those duplicates never self-heal, and the first sync is both the longest and the likeliest to be
	 * interrupted. The checkpoint carries the *previous* `rootHash` on purpose: the new one is written
	 * only by the final result, so an interrupted run never looks complete to the next one.
	 */
	saveIndex?: (index: SyncIndex) => Promise<void>;
}

export interface SyncResult {
	index: SyncIndex;
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
	 */
	skipErrors: string[];
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
			.map((page, i) => ({ id: page.id, sourceIndex: page.redir?.value ?? i }));
	}
	const pages = Array.isArray(doc.pages) ? doc.pages : [];
	const filtered = isPdf ? pages : pages.filter((id) => liveIds.has(id));
	return filtered.map((id, i) => ({ id, sourceIndex: i }));
}

/** Renders one handwritten page, or a blank page when it has no `.rm` file yet (`pageHash` undefined) -- a real, still-live page the user simply never drew on. */
async function renderPage(api: SyncApi, docId: string, pageId: string, pageHash: string | undefined): Promise<RmPage> {
	if (pageHash === undefined) return { formatVersion: 6, layers: [] };
	const bytes = await api.raw.getHash(`${docId}/${pageId}.rm`, pageHash);
	return parseRmV6(bytes);
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

/** The annotation scenes among composite pages -- the handwriting worth OCR-ing (the source PDF's own text is not re-transcribed). */
function annotationScenes(pages: AnnotatedPdfPage[]): RmPage[] {
	return pages.map((page) => page.annotations).filter((scene): scene is RmPage => scene !== null);
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

/** OCR must never block or lose a sync (spec §6): a throwing backend degrades to "failed" rather than aborting the unit's render+note write. */
async function runOcr(backend: OcrBackend, pages: RmPage[]): Promise<OcrResult> {
	try {
		return await backend.recognize(pages);
	} catch (error) {
		console.warn(`Tagged Sync: OCR backend "${backend.id}" failed, note will ship with render only`, error);
		return { status: "failed", text: "", confidence: null };
	}
}

interface UnitParams {
	/** Finished attachment bytes: a `.rm` render for handwritten docs, the embedded source for PDF-backed ones. */
	pdfBytes: Uint8Array;
	/** Pages to run OCR over -- empty for a PDF-backed doc, whose source is embedded rather than transcribed. */
	ocrPages: RmPage[];
	/** Render-ready highlighted quotes, grouped by page (empty when the unit has no text highlights). */
	highlights: HighlightGroup[];
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
): Promise<{ row: SyncIndexRow; ocr: OcrResult["status"] }> {
	const embedPath = await writeAttachment(deps.attachmentStore, deps.attachmentsFolder, params.docId, params.pageId, params.pdfBytes);
	const ocr = await runOcr(deps.ocrBackend, params.ocrPages);

	const synced = deps.now();
	const fields: NoteFields = {
		docId: params.docId,
		pageId: params.pageId,
		pageIndex: params.pageIndex,
		tag: params.tag,
		source: params.source,
		embedPath,
		highlights: params.highlights,
		transcript: ocr.text,
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
		return { index: previousIndex, notesWritten: 0, unavailableOcrUnits: 0, failedOcrUnits: 0, editedNotesSkipped: 0, documentsSkipped: 0, skipErrors: [] };
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

	const entries = await api.listItems();
	const documents = entries.filter((entry) => entry.type === "DocumentType");
	for (const [position, entry] of documents.entries()) {
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
		const pageHashes = await getPageHashes(api, entry.id, entry.hash);
		const liveIds = new Set(pageHashes.keys());
		const docPages = orderedPages(content, liveIds, isPdf);
		const pageOrder = docPages.map((page) => page.id);
		const livePageIds = new Set(pageOrder);
		const sourceIndexById = new Map(docPages.map((page) => [page.id, page.sourceIndex]));

		// Fetched once per doc, only if some unit actually needs it (a doc may open just to orphan rows).
		let sourcePdf: Promise<Uint8Array> | null = null;
		const getSourcePdf = () => (sourcePdf ??= api.getPdf(entry.id, entry.hash).then(validateSourcePdf));

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
			let ocrPages: RmPage[];
			let highlights: HighlightGroup[];
			try {
				if (isPdf) {
					// The unfiltered `composite` (nulls kept) preserves page ordinals, unlike `ocrPages` which drops null scenes.
					const composite = await annotatedPdfPages(api, entry.id, docPages, pageHashes);
					pdfBytes = await renderAnnotatedPdf(await getSourcePdf(), composite);
					ocrPages = annotationScenes(composite);
					highlights = collectHighlights(composite.map((page, i) => ({ pageLabel: i + 1, embedPage: i + 1, highlights: page.annotations?.highlights ?? [] })));
				} else {
					ocrPages = await Promise.all(pageOrder.map((pageId) => renderPage(api, entry.id, pageId, pageHashes.get(pageId))));
					pdfBytes = await renderPagesToPdf(ocrPages); // throws on an empty notebook -- surfaced, not written as a blank note
					highlights = collectHighlights(ocrPages.map((scene, i) => ({ pageLabel: i + 1, embedPage: i + 1, highlights: scene.highlights ?? [] })));
				}
			} catch (error) {
				console.warn(`Tagged Sync: failed to render "${entry.visibleName}" for tag "${tag}", skipping`, error);
				skipErrors.push(`failed to render "${entry.visibleName}" for tag "${tag}": ${errorText(error)}`);
				skippedDocIds.add(entry.id);
				continue;
			}

			const { row, ocr } = await writeUnit(
				writeDeps,
				{
					pdfBytes,
					ocrPages,
					highlights,
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
			if (ocr === "unavailable") unavailableOcrUnits++;
			if (ocr === "failed") failedOcrUnits++;
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
			if (!livePageIds.has(pageTag.pageId)) continue; // tagged page no longer exists on the device
			const pageHash = pageContentHash(pageTag.pageId);

			const rename = pageRenames.get(pageTag.pageId)?.newTag === pageTag.name ? pageRenames.get(pageTag.pageId)! : null;
			const syncKey = pageSyncKey(entry.id, pageTag.pageId, pageTag.name);
			const existingRow = rows[syncKey];
			// level 3: page unchanged, don't re-render it -- unless it's currently orphaned (revive), a
			// rename target, or its note went missing from the vault (deleted by hand).
			if (
				!rename &&
				existingRow?.status === "active" &&
				existingRow.pageHash === pageHash &&
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
			let ocrPages: RmPage[];
			let highlights: HighlightGroup[];
			try {
				if (isPdf) {
					const composite = await annotatedPdfPages(api, entry.id, [{ id: pageTag.pageId, sourceIndex: sourceIndexById.get(pageTag.pageId)! }], pageHashes);
					pdfBytes = await renderAnnotatedPdf(await getSourcePdf(), composite);
					ocrPages = annotationScenes(composite);
					highlights = collectHighlights([{ pageLabel: pageIndex, embedPage: 1, highlights: composite[0]?.annotations?.highlights ?? [] }]);
				} else {
					ocrPages = [await renderPage(api, entry.id, pageTag.pageId, pageHashes.get(pageTag.pageId))];
					pdfBytes = await renderPagesToPdf(ocrPages);
					highlights = collectHighlights([{ pageLabel: pageIndex, embedPage: 1, highlights: ocrPages[0].highlights ?? [] }]);
				}
			} catch (error) {
				console.warn(`Tagged Sync: failed to render page ${pageIndex} of "${entry.visibleName}" for tag "${pageTag.name}", skipping`, error);
				skipErrors.push(`failed to render page ${pageIndex} of "${entry.visibleName}" for tag "${pageTag.name}": ${errorText(error)}`);
				skippedDocIds.add(entry.id);
				continue;
			}

			const { row, ocr } = await writeUnit(
				writeDeps,
				{
					pdfBytes,
					ocrPages,
					highlights,
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
			if (ocr === "unavailable") unavailableOcrUnits++;
			if (ocr === "failed") failedOcrUnits++;
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

	return { index: { rootHash, mappings, rows }, notesWritten, unavailableOcrUnits, failedOcrUnits, editedNotesSkipped, documentsSkipped: skippedDocIds.size, skipErrors };
}

export interface ReTranscribeDeps {
	api: SyncApi;
	noteStore: NoteStore;
	ocrBackend: OcrBackend;
	onProgress?: (progress: SyncProgress) => void;
}

/** The OCR input for one already-synced unit: annotation scenes for a PDF-backed doc, every live page's scene otherwise. */
async function ocrPagesForRow(api: SyncApi, docId: string, row: SyncIndexRow, docPages: DocPageRef[], pageHashes: Map<string, string>, isPdf: boolean): Promise<RmPage[] | null> {
	if (row.pageId === null) {
		return isPdf
			? annotationScenes(await annotatedPdfPages(api, docId, docPages, pageHashes))
			: Promise.all(docPages.map((page) => renderPage(api, docId, page.id, pageHashes.get(page.id))));
	}
	const page = docPages.find((candidate) => candidate.id === row.pageId);
	if (!page) return null; // the tagged page no longer exists on the device
	return isPdf
		? annotationScenes(await annotatedPdfPages(api, docId, [page], pageHashes))
		: [await renderPage(api, docId, row.pageId, pageHashes.get(row.pageId))];
}

/**
 * Re-runs OCR over every active note and rewrites just its transcript (spec §8.4). Re-fetches each
 * doc's current content once and re-derives the same OCR input the sync would produce, so a note's
 * transcript is refreshed to match the backend now selected -- typically to replace a garbage
 * transcript from an earlier backend. The embed and the user's free area are never touched.
 */
export async function reTranscribeAll(deps: ReTranscribeDeps, index: SyncIndex): Promise<{ updated: number; index: SyncIndex }> {
	const { api, noteStore, ocrBackend } = deps;
	const report = deps.onProgress ?? (() => {});
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
	for (const [position, docId] of docIds.entries()) {
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
		const pageHashes = await getPageHashes(api, entry.id, entry.hash);
		const docPages = orderedPages(content, new Set(pageHashes.keys()), isPdf);

		for (const row of rowsByDoc.get(docId)!) {
			let ocrPages: RmPage[] | null;
			try {
				ocrPages = await ocrPagesForRow(api, entry.id, row, docPages, pageHashes, isPdf);
			} catch (error) {
				console.warn(`Tagged Sync: failed to re-fetch "${entry.visibleName}" for re-transcribe, skipping`, error);
				continue;
			}
			if (ocrPages === null) continue;

			const ocr = await runOcr(ocrBackend, ocrPages);
			if (!(await updateTranscript(noteStore, row.notePath, ocr.text))) continue;
			updated++;

			const block = extractManagedBlock((await noteStore.read(row.notePath)) ?? "");
			if (block !== null) rows[row.syncKey] = { ...row, blockHash: blockHashOf(block) };
		}
	}
	return { updated, index: { ...index, rows } };
}
