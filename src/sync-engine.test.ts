import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import type { Content, CPages, DocumentContent, Entry, Metadata } from "rmapi-js";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentStore } from "./attachment-writer";
import { buildDigest } from "./digest-pipeline";
import { blockHashOf, extractManagedBlock, type NoteStore } from "./note-builder";
import type { OcrBackend, OcrPageResult, OcrResult } from "./ocr-backend";
import { encodeGrayscalePng } from "./png-encoder";
import type { RmLayer, RmPage } from "./rm-parser";
import { isDocumentText } from "./scene-text";
import {
	collectHighlights,
	EMPTY_SYNC_INDEX,
	invalidateRenders,
	notebookSyncKey,
	pageSyncKey,
	RENDER_VERSION,
	renderNotes,
	reTranscribeAll,
	runSync,
	type SyncApi,
	type SyncIndex,
	type SyncIndexRow,
	type SyncProgress,
} from "./sync-engine";
import { mappingFingerprint, TagRouter } from "./tag-router";

// The real pipeline runs in every test but one: every partial failure inside it is deliberately
// caught, so a build that *throws* -- which the sync engine still has to survive -- can only be
// staged from outside. The spy delegates to the real implementation until a test says otherwise.
vi.mock("./digest-pipeline", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./digest-pipeline")>();
	return { ...actual, buildDigest: vi.fn(actual.buildDigest) };
});

// Which notebook pages count as a document is measured from the typed text itself and has its own
// tests (`scene-text.test.ts`). Here it is a switch, so a notebook can be put on either path without
// a fixture carrying a `root_text` block: what these tests are about is which path the engine takes.
vi.mock("./scene-text", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./scene-text")>();
	return { ...actual, isDocumentText: vi.fn(actual.isDocumentText) };
});

const FIXTURE_PATH = "./test-fixtures/rmv6/normal-a-stroke-2-layers.rm";
const PAGE_BYTES = new Uint8Array(readFileSync(FIXTURE_PATH));
// A page whose nodes carry no anchor, so nothing about it is placed -- unlike FIXTURE_PATH, whose two
// group nodes are anchored to its typed text.
const UNANCHORED_PAGE_BYTES = new Uint8Array(readFileSync("./test-fixtures/rmv6/color-and-tool-v3.14.4.rm"));
/** A page that shows one picture, and the bytes of a picture -- neither is in the other, as on the device. */
const PAGE_WITH_IMAGE_BYTES = new Uint8Array(readFileSync("./test-fixtures/rmv6/notebook-with-image.rm"));
const PICTURE_BYTES = encodeGrayscalePng({ width: 4, height: 2, pixels: new Uint8Array(8).fill(128) });
const NOW = "2026-01-01T00:00:00.000Z";

function documentEntry(overrides: Partial<Entry> = {}): Entry {
	return {
		id: "doc-1",
		hash: "hash-1",
		visibleName: "Notebook",
		lastModified: "1000",
		pinned: false,
		parent: "",
		type: "DocumentType",
		fileType: "notebook",
		lastOpened: "0",
		...overrides,
	} as Entry;
}

function collectionEntry(overrides: Partial<Entry> = {}): Entry {
	return {
		id: "folder-1",
		hash: "hash-folder-1",
		visibleName: "Folder",
		lastModified: "1000",
		pinned: false,
		parent: "",
		type: "CollectionType",
		...overrides,
	} as Entry;
}

function documentContent(overrides: Partial<Content> = {}): Content {
	return {
		coverPageNumber: 0,
		documentMetadata: {},
		extraMetadata: {},
		fileType: "notebook",
		fontName: "",
		lineHeight: -1,
		orientation: "portrait",
		pageCount: 1,
		textAlignment: "",
		textScale: 1,
		...overrides,
	} as Content;
}

function cPages(pageIds: string[]): DocumentContent["cPages"] {
	return {
		lastOpened: { timestamp: "1:1", value: "" },
		original: { timestamp: "1:1", value: 0 },
		uuids: null,
		pages: pageIds.map((id, i) => ({ id, idx: { timestamp: "1:1", value: String.fromCharCode(97 + i) } })),
	};
}

/** cPages carrying per-page `deleted` / `redir` markers -- for PDF-backed docs (redir = source page) and deletion cases. `deleted` is the marker's numeric CRDT value: 1 deleted, 0 present-but-live. */
function cPagesWith(pages: { id: string; deleted?: number; redir?: number }[]): CPages {
	return {
		lastOpened: { timestamp: "1:1", value: "" },
		original: { timestamp: "1:1", value: 0 },
		uuids: null,
		pages: pages.map((page, i) => ({
			id: page.id,
			idx: { timestamp: "1:1", value: String.fromCharCode(97 + i) },
			...(page.deleted !== undefined ? { deleted: { timestamp: "1:1", value: page.deleted } } : {}),
			...(page.redir !== undefined ? { redir: { timestamp: "1:1", value: page.redir } } : {}),
		})),
	};
}

/** A source PDF with the given per-page [width, height] sizes; each page gets a content stream so it can be embedded. */
async function makeSourcePdf(sizes: [number, number][]): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	for (const [w, h] of sizes) {
		const page = doc.addPage([w, h]);
		page.drawRectangle({ x: 0, y: 0, width: w, height: h });
	}
	return doc.save();
}

/** The bytes handed to the attachment store's `writeBinary` for a given attachment path, decoded back to a page count. */
async function embeddedPageCount(store: AttachmentStore, path: string): Promise<number> {
	const call = (store.writeBinary as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === path);
	if (!call) throw new Error(`no attachment written at ${path}`);
	return (await PDFDocument.load(call[1])).getPageCount();
}

interface FakeApiOptions {
	rootHash: string;
	entries: Entry[];
	contentById?: Record<string, Content>;
	metadataById?: Record<string, Metadata>;
	pageHashesByDoc?: Record<string, Record<string, string>>;
	/** Pictures in a page's own folder, `docId -> pageId -> fileName -> hash`, as the device's index lists them. */
	pageImagesByDoc?: Record<string, Record<string, Record<string, string>>>;
	/** Raw source-PDF bytes returned by `getPdf`, keyed by doc id -- for PDF-backed docs. */
	sourcePdfByDoc?: Record<string, Uint8Array>;
}

function fakeApi(opts: FakeApiOptions): SyncApi & {
	listItems: ReturnType<typeof vi.fn>;
	getContent: ReturnType<typeof vi.fn>;
	getMetadata: ReturnType<typeof vi.fn>;
	getPdf: ReturnType<typeof vi.fn>;
	raw: { getRootHash: ReturnType<typeof vi.fn>; getEntries: ReturnType<typeof vi.fn>; getHash: ReturnType<typeof vi.fn> };
} {
	return {
		listItems: vi.fn().mockResolvedValue(opts.entries),
		getPdf: vi.fn(async (id: string) => {
			const pdf = opts.sourcePdfByDoc?.[id];
			if (!pdf) throw new Error(`no source pdf for ${id}`);
			return pdf;
		}),
		getContent: vi.fn(async (id: string) => {
			const content = opts.contentById?.[id];
			if (!content) throw new Error(`no content for ${id}`);
			return content;
		}),
		getMetadata: vi.fn(
			async (id: string) =>
				opts.metadataById?.[id] ??
				({ lastModified: "0", parent: "", pinned: false, type: "DocumentType", visibleName: "x" } as Metadata),
		),
		raw: {
			getRootHash: vi.fn().mockResolvedValue([opts.rootHash, 1, 4]),
			getEntries: vi.fn(async (fileName: string) => {
				const docId = fileName.replace(/\.docSchema$/, "");
				const pageHashes = opts.pageHashesByDoc?.[docId] ?? {};
				const images = Object.entries(opts.pageImagesByDoc?.[docId] ?? {}).flatMap(([pageId, files]) =>
					Object.entries(files).map(([fileName, hash]) => ({ id: `${docId}/${pageId}/${fileName}`, hash })),
				);
				return {
					entries: [
						...Object.entries(pageHashes).map(([pageId, hash]) => ({ id: `${docId}/${pageId}.rm`, hash })),
						...images,
					].map((entry) => ({ ...entry, type: 0 as const, subfiles: 0, size: 0 })),
				};
			}),
			getHash: vi.fn().mockResolvedValue(PAGE_BYTES),
		},
	};
}

function fakeNoteStore(): NoteStore & { write: ReturnType<typeof vi.fn>; move: ReturnType<typeof vi.fn> } {
	const files: Record<string, string> = {};
	return {
		read: vi.fn(async (path: string) => files[path] ?? null),
		write: vi.fn(async (path: string, content: string) => {
			files[path] = content;
		}),
		move: vi.fn(async (fromPath: string, toPath: string) => {
			if (fromPath in files) {
				files[toPath] = files[fromPath];
				delete files[fromPath];
			}
		}),
		ensureFolder: vi.fn().mockResolvedValue(undefined),
	};
}

function fakeAttachmentStore(): AttachmentStore {
	return {
		ensureFolder: vi.fn().mockResolvedValue(undefined),
		writeBinary: vi.fn().mockResolvedValue(undefined),
	};
}

/**
 * A backend that never actually transcribes, matching pre-OCR-wiring test expectations unless a test
 * overrides it.
 *
 * `pages` defaults to null -- no per-page information, the shape `off` and every pre-page-anchoring
 * backend return -- so a test that says nothing about pages keeps asserting the flat transcript it
 * always did. Tests that care about page anchoring pass `pages` explicitly.
 */
function fakeOcrBackend(result: Omit<OcrResult, "pages"> & { pages?: OcrPageResult[] | null } = { status: "skipped", text: "", confidence: null }): OcrBackend {
	const full: OcrResult = { pages: null, ...result };
	return {
		id: "vision",
		metered: false,
		// Honours the same empty-list contract every real backend has (`vision-ocr-backend.ts:90`):
		// nothing in, `skipped` out, no work done. The sync engine leans on it to keep a PDF unit from
		// being transcribed a second time over its whole scene, and a fake that answered anyway would
		// hide exactly the regression these tests are here to catch.
		recognize: vi.fn(async (pages: RmPage[]): Promise<OcrResult> => (pages.length === 0 ? { status: "skipped", pages: [], text: "", confidence: null } : full)),
	};
}

/** A backend that is available and still produces nothing -- the case that used to vanish into console.warn. */
function throwingOcrBackend(): OcrBackend {
	return { id: "vision", metered: false, recognize: vi.fn().mockRejectedValue(new Error("vision blew up")) };
}

function baseDeps(api: SyncApi, tagFolderMap: Record<string, string>) {
	return {
		api,
		tagRouter: new TagRouter(tagFolderMap),
		noteStore: fakeNoteStore(),
		attachmentStore: fakeAttachmentStore(),
		ocrBackend: fakeOcrBackend(),
		// On, so the digest tests below exercise the whole pipeline. The shipped default is off (F20)
		// and `runSync` honours it when the caller says nothing -- pinned by its own test.
		marginNotes: true,
		now: () => NOW,
	};
}

type WorkingProgress = Extract<SyncProgress, { phase: "working" }>;
type ScanningProgress = Extract<SyncProgress, { phase: "scanning" }>;

/** Every `working` message a run emitted, in order. */
function workingMessages(onProgress: ReturnType<typeof vi.fn>): WorkingProgress[] {
	return (onProgress.mock.calls.map((call) => call[0]) as SyncProgress[]).filter(
		(progress): progress is WorkingProgress => progress.phase === "working",
	);
}

function scanningMessages(onProgress: ReturnType<typeof vi.fn>): ScanningProgress[] {
	return (onProgress.mock.calls.map((call) => call[0]) as SyncProgress[]).filter(
		(progress): progress is ScanningProgress => progress.phase === "scanning",
	);
}

/** A backend that reports each page as it finishes -- what the local model and the LLM backends do. */
function tickingOcrBackend(): OcrBackend {
	return {
		id: "vision",
		metered: false,
		recognize: vi.fn(async (pages: RmPage[], onPage?: () => void): Promise<OcrResult> => {
			for (const _page of pages) onPage?.();
			return { status: "ok", pages: pages.map(() => ({ status: "ok" as const, text: "x" })), text: "x", confidence: null };
		}),
	};
}

describe("runSync progress", () => {
	/** One tagged three-page notebook, and one untagged document the sync walks past. */
	function twoDocs() {
		return fakeApi({
			rootHash: "root-1",
			entries: [
				documentEntry({ id: "doc-1", hash: "hash-1", visibleName: "First", tags: [{ name: "sync", timestamp: 0 }] }),
				documentEntry({ id: "doc-2", hash: "hash-2", visibleName: "Second" }),
			],
			contentById: {
				"doc-1": documentContent({ cPages: cPages(["page-a", "page-b", "page-c"]) }),
				"doc-2": documentContent({ cPages: cPages(["page-x"]) }),
			},
			pageHashesByDoc: { "doc-1": { "page-a": "ha", "page-b": "hb", "page-c": "hc" }, "doc-2": { "page-x": "hx" } },
		});
	}

	// The whole point of the rebuild: the old counter was the walk position through every document on
	// the device, so it raced through the ones nothing happens to and then sat still on the one that
	// mattered.
	it("counts the pages it will really work on, not the documents it walks past", async () => {
		const onProgress = vi.fn();

		await runSync({ ...baseDeps(twoDocs(), { sync: "Target" }), onProgress }, EMPTY_SYNC_INDEX);

		expect(workingMessages(onProgress).at(-1)).toEqual({
			phase: "working",
			done: 3,
			total: 3,
			document: "First",
			tag: "sync",
			step: "writing",
			unitDone: 3,
			unitTotal: 3,
		});
	});

	// Otherwise the user watches a spinner while the counting is counted, with nothing to say how long
	// that will take either.
	it("reports the scan's own counter before the bar can start", async () => {
		const onProgress = vi.fn();

		await runSync({ ...baseDeps(twoDocs(), { sync: "Target" }), onProgress }, EMPTY_SYNC_INDEX);

		const scans = scanningMessages(onProgress);
		expect(scans[0]).toEqual({ phase: "scanning", checked: 0, candidates: 0 }); // before the root-hash gate
		expect(scans[1]).toEqual({ phase: "scanning", checked: 0, candidates: 2 }); // no document reached yet
		expect(scans.at(-1)).toEqual({ phase: "scanning", checked: 2, candidates: 2, document: expect.any(String) });
	});

	/**
	 * Several documents are open at once, so `checked` can stand still for a long time while they are
	 * fetched -- long enough to read as a hang. The name is reported when a document is *begun*,
	 * which is the only part that keeps moving in the meantime.
	 */
	it("names the document it reached, before that document is finished", async () => {
		const onProgress = vi.fn();

		await runSync({ ...baseDeps(twoDocs(), { sync: "Target" }), onProgress }, EMPTY_SYNC_INDEX);

		const named = scanningMessages(onProgress).filter((progress) => progress.document !== undefined);
		expect(named[0]).toMatchObject({ checked: 0 }); // reported before its own count advanced
		expect(new Set(named.map((progress) => progress.document))).toEqual(new Set(["First", "Second"]));
	});

	it("reports scanning even when the root-hash gate returns early", async () => {
		const api = fakeApi({ rootHash: "root-1", entries: [documentEntry()] });
		const onProgress = vi.fn();
		const deps = { ...baseDeps(api, { sync: "Target" }), onProgress };

		await runSync(deps, { rootHash: "root-1", mappings: mappingFingerprint({ sync: "Target" }), rows: {} });

		expect(onProgress.mock.calls.map((call) => call[0])).toEqual([{ phase: "scanning", checked: 0, candidates: 0 }]);
	});

	// A notebook with two mapped tags is written twice over the same pages, and really does render and
	// transcribe them twice -- there is no cache between the tags. The bar tracks time spent.
	it("counts a notebook's pages once per mapped tag", async () => {
		const api = fakeApi({
			rootHash: "root-1",
			entries: [documentEntry({ hash: "hash-1", tags: [{ name: "sync", timestamp: 0 }, { name: "review", timestamp: 0 }] })],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a", "page-b", "page-c"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "ha", "page-b": "hb", "page-c": "hc" } },
		});
		const onProgress = vi.fn();

		await runSync({ ...baseDeps(api, { sync: "A", review: "B" }), onProgress }, EMPTY_SYNC_INDEX);

		expect(workingMessages(onProgress).at(-1)).toMatchObject({ done: 6, total: 6 });
	});

	/**
	 * The assertion that catches a scan which drifted from the run. Every unit kind in one fixture: a
	 * notebook under two tags, a tagged page, and a document that produces nothing at all.
	 */
	it("never goes backwards, and ends exactly on the scanned total", async () => {
		const api = fakeApi({
			rootHash: "root-1",
			entries: [
				documentEntry({ id: "doc-1", hash: "hash-1", visibleName: "First", tags: [{ name: "sync", timestamp: 0 }, { name: "review", timestamp: 0 }] }),
				documentEntry({ id: "doc-2", hash: "hash-2", visibleName: "Second" }),
			],
			contentById: {
				"doc-1": documentContent({
					cPages: cPages(["page-a", "page-b", "page-c"]),
					pageTags: [{ name: "todo", timestamp: 0, pageId: "page-b" }],
				}),
				"doc-2": documentContent({ cPages: cPages(["page-x"]) }),
			},
			pageHashesByDoc: { "doc-1": { "page-a": "ha", "page-b": "hb", "page-c": "hc" }, "doc-2": { "page-x": "hx" } },
		});
		const onProgress = vi.fn();

		await runSync({ ...baseDeps(api, { sync: "A", review: "B", todo: "T" }), onProgress, ocrBackend: tickingOcrBackend() }, EMPTY_SYNC_INDEX);

		const done = workingMessages(onProgress).map((progress) => progress.done);
		expect(done).toEqual([...done].sort((a, b) => a - b));
		// 3 pages x 2 notebook tags, plus the one tagged page.
		expect(workingMessages(onProgress).at(-1)).toMatchObject({ done: 7, total: 7 });
	});

	it("moves the bar page by page when the backend can say so", async () => {
		const onProgress = vi.fn();

		await runSync({ ...baseDeps(twoDocs(), { sync: "Target" }), onProgress, ocrBackend: tickingOcrBackend() }, EMPTY_SYNC_INDEX);

		// The first is the sub-phase changing before a page is transcribed; then one per page.
		expect(workingMessages(onProgress).filter((progress) => progress.step === "transcribing").map((progress) => progress.done)).toEqual([0, 1, 2, 3]);
	});

	// Vision, `off`, and a reused transcript cannot report a page as it lands. The unit still has to
	// count for exactly its pages, or the bar stops short.
	it("counts a whole unit at once when the backend cannot report per page", async () => {
		const onProgress = vi.fn();

		await runSync({ ...baseDeps(twoDocs(), { sync: "Target" }), onProgress }, EMPTY_SYNC_INDEX);

		expect(workingMessages(onProgress).map((progress) => progress.done)).toEqual([0, 0, 3]);
	});

	// A page rendered during the scan is a page rendered twice: the fetch would be a cache hit, the
	// parse would not.
	it("renders nothing while it is only counting", async () => {
		const api = twoDocs();
		await runSync(baseDeps(api, { sync: "Target" }), EMPTY_SYNC_INDEX);

		expect(api.raw.getHash).toHaveBeenCalledTimes(3); // the notebook's three pages, once each
	});

	it("skips a document the scan could not read, and reports it once", async () => {
		const api = fakeApi({
			rootHash: "root-1",
			entries: [
				documentEntry({ id: "doc-1", hash: "hash-1", visibleName: "First", tags: [{ name: "sync", timestamp: 0 }] }),
				documentEntry({ id: "doc-2", hash: "hash-2", visibleName: "Second", tags: [{ name: "sync", timestamp: 0 }] }),
			],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) }, // doc-2 has none
			pageHashesByDoc: { "doc-1": { "page-a": "ha" } },
		});
		const onProgress = vi.fn();

		const result = await runSync({ ...baseDeps(api, { sync: "Target" }), onProgress }, EMPTY_SYNC_INDEX);

		expect(result.documentsSkipped).toBe(1);
		expect(result.skipErrors).toEqual([expect.stringContaining('failed to read "Second"')]);
		expect(api.getContent.mock.calls.filter((call) => call[0] === "doc-2")).toHaveLength(1);
		expect(workingMessages(onProgress).at(-1)).toMatchObject({ done: 1, total: 1 });
	});

	// The denominator is fixed when the scan ends, so anything that drops out afterwards counts as
	// done. The failure is in the run's own report; the bar does not have to carry it as well.
	it("fills the bar for a unit that failed to render", async () => {
		const api = twoDocs();
		api.raw.getHash.mockRejectedValue(new Error("page fetch failed"));
		const onProgress = vi.fn();

		const result = await runSync({ ...baseDeps(api, { sync: "Target" }), onProgress }, EMPTY_SYNC_INDEX);

		expect(result.notesWritten).toBe(0);
		expect(workingMessages(onProgress).at(-1)).toMatchObject({ done: 3, total: 3, step: "writing" });
	});

	it("leaves a note the user edited out of the denominator", async () => {
		const first = { ...baseDeps(twoDocs(), { sync: "Target" }), ocrBackend: fakeOcrBackend({ status: "ok", text: "misread", confidence: null }) };
		const synced = await runSync(first, EMPTY_SYNC_INDEX);
		const path = synced.index.rows[notebookSyncKey("doc-1", "sync")].notePath;
		await first.noteStore.write(path, (await first.noteStore.read(path))!.replace("## Transcript", "## Transcript\nby hand"));

		// A device-side change, so the document is reopened and the unit is reached at all.
		const changed = twoDocs();
		changed.listItems.mockResolvedValue([
			documentEntry({ id: "doc-1", hash: "hash-9", visibleName: "First", tags: [{ name: "sync", timestamp: 0 }] }),
		]);
		changed.raw.getRootHash.mockResolvedValue(["root-9", 1, 4]);
		const onProgress = vi.fn();

		const result = await runSync({ ...baseDeps(changed, { sync: "Target" }), noteStore: first.noteStore, onProgress }, synced.index);

		expect(result.editedNotesSkipped).toBe(1);
		expect(workingMessages(onProgress)).toEqual([]); // nothing to write, so no bar at all
	});

	it("emits no working message when there is nothing to do", async () => {
		const api = fakeApi({
			rootHash: "root-1",
			entries: [documentEntry({ id: "doc-1", hash: "hash-1" })],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "ha" } },
		});
		const onProgress = vi.fn();

		await runSync({ ...baseDeps(api, { sync: "Target" }), onProgress }, EMPTY_SYNC_INDEX);

		expect(workingMessages(onProgress)).toEqual([]);
	});

	// Nothing has been written when the scan is stopped, so there is nothing to checkpoint -- but the
	// caller still has to hear that this run was stopped rather than finished.
	it("returns stopped, having written nothing, when the stop lands during the scan", async () => {
		const deps = { ...baseDeps(twoDocs(), { sync: "Target" }), shouldStop: () => true };

		const result = await runSync(deps, EMPTY_SYNC_INDEX);

		expect(result.stopped).toBe(true);
		expect(deps.noteStore.write).not.toHaveBeenCalled();
	});
});

describe("runSync", () => {

	it("root-hash gate: unchanged root hash performs zero fetches beyond the root-hash check", async () => {
		const api = fakeApi({ rootHash: "root-1", entries: [documentEntry()] });
		const previousIndex: SyncIndex = { rootHash: "root-1", mappings: mappingFingerprint({ sync: "Target" }), rows: {} };
		const deps = baseDeps(api, { sync: "Target" });

		const result = await runSync(deps, previousIndex);

		expect(result.notesWritten).toBe(0);
		expect(result.index).toBe(previousIndex);
		expect(api.raw.getRootHash).toHaveBeenCalledTimes(1);
		expect(api.listItems).not.toHaveBeenCalled();
		expect(api.getContent).not.toHaveBeenCalled();
	});

	it("root-hash gate: a mapping change re-scans even though the root hash is unchanged", async () => {
		const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
		const content = documentContent({ cPages: cPages(["page-a"]) });
		const api = fakeApi({
			rootHash: "root-1",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		// The last sync ran with no mappings at all: it saved the root hash and zero rows. The user
		// then mapped a tag in settings; nothing changed on the device, so the root hash is the same.
		const previousIndex: SyncIndex = { rootHash: "root-1", mappings: mappingFingerprint({}), rows: {} };
		const deps = baseDeps(api, { sync: "Target" });

		const result = await runSync(deps, previousIndex);

		expect(result.notesWritten).toBe(1);
		expect(result.index.mappings).toBe(mappingFingerprint({ sync: "Target" }));
	});

	it("self-heals: recreates a note the user deleted by hand, even though the root hash is unchanged", async () => {
		const entry = documentEntry({ hash: "hash-1", tags: [{ name: "sync", timestamp: 0 }] });
		const content = documentContent({ cPages: cPages(["page-a"]) });
		const api = fakeApi({
			rootHash: "root-1",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const previousIndex: SyncIndex = {
			rootHash: "root-1", // unchanged since the last sync -- nothing moved on the device
			mappings: mappingFingerprint({ sync: "Target" }), // unchanged too -- only the missing note reopens the gate
			rows: {
				[notebookSyncKey("doc-1", "sync")]: {
					syncKey: notebookSyncKey("doc-1", "sync"),
					docId: "doc-1",
					pageId: null,
					tag: "sync",
					entryHash: "hash-1",
					pageHash: null,
					notePath: "Target/Notebook.md",
					status: "active",
					syncedAt: "2025-12-01T00:00:00.000Z",
					renderVersion: RENDER_VERSION,
				},
			},
		};
		const deps = baseDeps(api, { sync: "Target" });
		// Note deliberately NOT seeded into the note store: simulates the user deleting it.

		const result = await runSync(deps, previousIndex);

		expect(result.notesWritten).toBe(1);
		expect(deps.noteStore.write).toHaveBeenCalledWith("Target/Notebook.md", expect.any(String));
		expect(result.index.rows[notebookSyncKey("doc-1", "sync")]).toMatchObject({
			notePath: "Target/Notebook.md",
			status: "active",
		});
	});

	it("does not touch an orphaned row's note just because it's missing -- only active rows self-heal", async () => {
		const api = fakeApi({ rootHash: "root-1", entries: [documentEntry({ hash: "hash-1" })] });
		const previousIndex: SyncIndex = {
			rootHash: "root-1",
			mappings: mappingFingerprint({ sync: "Target" }),
			rows: {
				[notebookSyncKey("doc-1", "sync")]: {
					syncKey: notebookSyncKey("doc-1", "sync"),
					docId: "doc-1",
					pageId: null,
					tag: "sync",
					entryHash: "hash-1",
					pageHash: null,
					notePath: "Target/Notebook.md",
					status: "orphaned",
					syncedAt: "2025-12-01T00:00:00.000Z",
				},
			},
		};
		const deps = baseDeps(api, { sync: "Target" });

		const result = await runSync(deps, previousIndex);

		expect(result.notesWritten).toBe(0);
		expect(result.index).toBe(previousIndex);
		expect(api.listItems).not.toHaveBeenCalled();
	});

	it("fetches the picture a page shows and draws it into the attachment", async () => {
		// The bytes of a picture are a file of their own in the page's folder, so a page that shows one
		// takes a second fetch -- and without it the attachment keeps the gap and puts nothing in it.
		const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
		const api = fakeApi({
			rootHash: "root-2",
			entries: [entry],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			pageImagesByDoc: { "doc-1": { "page-a": { "picture.png": "hash-picture" } } },
		});
		api.raw.getHash.mockImplementation(async (id: string) => (id.endsWith(".rm") ? PAGE_WITH_IMAGE_BYTES : PICTURE_BYTES));
		const deps = baseDeps(api, { sync: "Target" });

		await runSync(deps, EMPTY_SYNC_INDEX);

		expect(api.raw.getHash).toHaveBeenCalledWith("doc-1/page-a/picture.png", "hash-picture");
		const written = (deps.attachmentStore.writeBinary as ReturnType<typeof vi.fn>).mock.calls.find(
			(call) => call[0] === "tagged-sync/attachments/doc-1.pdf",
		);
		// The XObject the picture became; its dictionary is written uncompressed.
		expect(new TextDecoder().decode(written![1])).toContain("/Image");
	});

	it("creates one notebook-level note embedding all live pages in order", async () => {
		const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
		const content = documentContent({ cPages: cPages(["page-a", "page-b"]) });
		const api = fakeApi({
			rootHash: "root-2",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a", "page-b": "hash-b" } },
		});
		const deps = baseDeps(api, { sync: "Target" });

		const result = await runSync(deps, EMPTY_SYNC_INDEX);

		expect(result.notesWritten).toBe(1);
		expect(deps.noteStore.write).toHaveBeenCalledTimes(1);
		const [path, written] = deps.noteStore.write.mock.calls[0];
		expect(path).toBe("Target/Notebook.md");
		expect(written).not.toContain("## Transcript"); // empty OCR result -> no empty heading
		expect(written).toContain("![[tagged-sync/attachments/doc-1.pdf]]");
		expect(api.raw.getHash).toHaveBeenCalledWith("doc-1/page-a.rm", "hash-a");
		expect(api.raw.getHash).toHaveBeenCalledWith("doc-1/page-b.rm", "hash-b");

		const syncKey = notebookSyncKey("doc-1", "sync");
		expect(result.index.rows[syncKey]).toMatchObject({
			syncKey,
			docId: "doc-1",
			pageId: null,
			tag: "sync",
			entryHash: "hash-1",
			pageHash: null,
			notePath: "Target/Notebook.md",
			status: "active",
		});
		expect(result.index.rootHash).toBe("root-2");
	});

	it("creates one note per tagged page, independent of any notebook-level tag", async () => {
		const entry = documentEntry();
		const content = documentContent({
			cPages: cPages(["page-a", "page-b"]),
			pageTags: [{ name: "todo", timestamp: 0, pageId: "page-b" }],
		});
		const api = fakeApi({
			rootHash: "root-3",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a", "page-b": "hash-b" } },
		});
		const deps = baseDeps(api, { todo: "Todo" });

		const result = await runSync(deps, EMPTY_SYNC_INDEX);

		expect(result.notesWritten).toBe(1);
		const [path, written] = deps.noteStore.write.mock.calls[0];
		expect(path).toBe("Todo/Notebook — Page 2.md");
		expect(written).toContain("[!info]- Generated by Tagged Sync");
		expect(api.raw.getHash).toHaveBeenCalledTimes(1);
		expect(api.raw.getHash).toHaveBeenCalledWith("doc-1/page-b.rm", "hash-b");

		const syncKey = pageSyncKey("doc-1", "page-b", "todo");
		expect(result.index.rows[syncKey]).toMatchObject({ docId: "doc-1", pageId: "page-b", tag: "todo", pageHash: "hash-b" });
	});

	it("fires notebook and page tags independently for the same document", async () => {
		const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
		const content = documentContent({
			cPages: cPages(["page-a"]),
			pageTags: [{ name: "todo", timestamp: 0, pageId: "page-a" }],
		});
		const api = fakeApi({
			rootHash: "root-4",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const deps = baseDeps(api, { sync: "Target", todo: "Todo" });

		const result = await runSync(deps, EMPTY_SYNC_INDEX);

		expect(result.notesWritten).toBe(2);
		expect(Object.keys(result.index.rows).sort()).toEqual(
			[notebookSyncKey("doc-1", "sync"), pageSyncKey("doc-1", "page-a", "todo")].sort(),
		);
	});

	it("ignores tags with no folder mapping", async () => {
		const entry = documentEntry({ tags: [{ name: "unmapped", timestamp: 0 }] });
		const content = documentContent({ pageTags: [{ name: "also-unmapped", timestamp: 0, pageId: "page-a" }] });
		const api = fakeApi({ rootHash: "root-5", entries: [entry], contentById: { "doc-1": content } });
		const deps = baseDeps(api, { sync: "Target" });

		const result = await runSync(deps, EMPTY_SYNC_INDEX);

		expect(result.notesWritten).toBe(0);
		expect(result.index.rows).toEqual({});
		expect(api.getContent).toHaveBeenCalled(); // never-indexed docs are opened once regardless of mapping, per level 2
	});

	it("syncs a notebook that inherits a mapped tag from its parent folder", async () => {
		const folder = collectionEntry({ tags: [{ name: "sync", timestamp: 0 }] });
		const entry = documentEntry({ parent: folder.id });
		const api = fakeApi({
			rootHash: "root-folder-tag",
			entries: [folder, entry],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const deps = baseDeps(api, { sync: "Target" });

		const result = await runSync(deps, EMPTY_SYNC_INDEX);

		expect(result.notesWritten).toBe(1);
		expect(result.index.rows[notebookSyncKey("doc-1", "sync")]).toMatchObject({
			docId: "doc-1",
			tag: "sync",
			status: "active",
		});
		expect(deps.noteStore.write).toHaveBeenCalledWith("Target/Notebook.md", expect.any(String));
	});

	it("rescans once after upgrading from the unversioned routing fingerprint", async () => {
		const folder = collectionEntry({ tags: [{ name: "sync", timestamp: 0 }] });
		const entry = documentEntry({ parent: folder.id });
		const api = fakeApi({
			rootHash: "root-already-seen",
			entries: [folder, entry],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const deps = baseDeps(api, { sync: "Target" });
		const legacyFingerprint = JSON.stringify([["sync", "Target"]]);

		const result = await runSync(deps, {
			rootHash: "root-already-seen",
			mappings: legacyFingerprint,
			rows: {},
		});

		expect(api.listItems).toHaveBeenCalledOnce();
		expect(result.notesWritten).toBe(1);
		expect(result.index.mappings).toBe(mappingFingerprint({ sync: "Target" }));
	});

	it("reopens an unchanged notebook and orphans its note when an inherited folder tag is removed", async () => {
		const taggedFolder = collectionEntry({ tags: [{ name: "sync", timestamp: 0 }] });
		const entry = documentEntry({ parent: taggedFolder.id, hash: "hash-unchanged" });
		const content = documentContent({ cPages: cPages(["page-a"]) });
		const firstApi = fakeApi({
			rootHash: "root-before-folder-tag-removal",
			entries: [taggedFolder, entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const noteStore = fakeNoteStore();
		const attachmentStore = fakeAttachmentStore();
		const firstDeps = { ...baseDeps(firstApi, { sync: "Target" }), noteStore, attachmentStore };
		const first = await runSync(firstDeps, EMPTY_SYNC_INDEX);

		const untaggedFolder = collectionEntry({ hash: "hash-folder-2", tags: [] });
		const secondApi = fakeApi({
			rootHash: "root-after-folder-tag-removal",
			entries: [untaggedFolder, entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const secondDeps = { ...baseDeps(secondApi, { sync: "Target" }), noteStore, attachmentStore };

		const second = await runSync(secondDeps, first.index);

		expect(secondApi.getContent).toHaveBeenCalledWith("doc-1", "hash-unchanged");
		expect(second.notesWritten).toBe(0);
		expect(second.index.rows[notebookSyncKey("doc-1", "sync")].status).toBe("orphaned");
	});

	/**
	 * A renderer fix changes nothing on the device, so both hash gates would happily skip every
	 * already-synced note and leave its attachment wrong forever. The stored render version is the
	 * only signal that the note, not the document, is out of date.
	 */
	it("re-renders a note left by an older renderer, even though neither hash changed", async () => {
		const entry = documentEntry({ hash: "hash-1", tags: [{ name: "sync", timestamp: 0 }] });
		const api = fakeApi({
			rootHash: "root-5",
			entries: [entry],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const staleRow = {
			syncKey: notebookSyncKey("doc-1", "sync"),
			docId: "doc-1",
			pageId: null,
			tag: "sync",
			entryHash: "hash-1",
			pageHash: null,
			notePath: "Target/Notebook.md",
			status: "active" as const,
			syncedAt: "2025-12-01T00:00:00.000Z",
			renderVersion: RENDER_VERSION - 1,
		};
		const deps = baseDeps(api, { sync: "Target" });
		await deps.noteStore.write("Target/Notebook.md", "stub");

		// Same root hash and same entry hash as the stored row -- only the render version differs.
		const result = await runSync(deps, { rootHash: "root-5", rows: { [staleRow.syncKey]: staleRow } });

		expect(result.notesWritten).toBe(1);
		expect(result.index.rows[staleRow.syncKey].renderVersion).toBe(RENDER_VERSION);
	});

	it("level 2: skips opening a notebook whose entry hash matches the stored row", async () => {
		const entry = documentEntry({ hash: "hash-1", tags: [{ name: "sync", timestamp: 0 }] });
		const api = fakeApi({ rootHash: "root-6", entries: [entry] });
		const previousIndex: SyncIndex = {
			rootHash: "root-5",
			rows: {
				[notebookSyncKey("doc-1", "sync")]: {
					syncKey: notebookSyncKey("doc-1", "sync"),
					docId: "doc-1",
					pageId: null,
					tag: "sync",
					entryHash: "hash-1",
					pageHash: null,
					notePath: "Target/Notebook.md",
					status: "active",
					syncedAt: "2025-12-01T00:00:00.000Z",
					renderVersion: RENDER_VERSION,
				},
			},
		};
		const deps = baseDeps(api, { sync: "Target" });
		await deps.noteStore.write("Target/Notebook.md", "stub");

		const result = await runSync(deps, previousIndex);

		expect(result.notesWritten).toBe(0);
		expect(api.getContent).not.toHaveBeenCalled();
		expect(result.index.rows).toEqual(previousIndex.rows);
	});

	it("level 2: opens a hash-unchanged notebook anyway when a newly-mapped tag on it has no row yet", async () => {
		const entry = documentEntry({
			hash: "hash-1",
			tags: [
				{ name: "sync", timestamp: 0 },
				{ name: "extra", timestamp: 0 },
			],
		});
		const content = documentContent({
			tags: [{ name: "sync", timestamp: 0 }, { name: "extra", timestamp: 0 }],
			cPages: cPages(["page-a"]),
		});
		const api = fakeApi({
			rootHash: "root-6b",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const previousIndex: SyncIndex = {
			rootHash: "root-5",
			rows: {
				[notebookSyncKey("doc-1", "sync")]: {
					syncKey: notebookSyncKey("doc-1", "sync"),
					docId: "doc-1",
					pageId: null,
					tag: "sync",
					entryHash: "hash-1",
					pageHash: null,
					notePath: "Target/Notebook.md",
					status: "active",
					syncedAt: "2025-12-01T00:00:00.000Z",
				},
			},
		};
		// "extra" was just mapped to a folder in settings; the notebook itself hasn't changed on-device.
		const deps = baseDeps(api, { sync: "Target", extra: "Extra" });

		const result = await runSync(deps, previousIndex);

		expect(api.getContent).toHaveBeenCalled();
		// Opening the notebook re-writes every mapped notebook tag on it, not just the newly-covered one.
		expect(result.notesWritten).toBe(2);
		expect(result.index.rows[notebookSyncKey("doc-1", "extra")]).toMatchObject({ docId: "doc-1", tag: "extra" });
		expect(result.index.rows[notebookSyncKey("doc-1", "sync")]).toMatchObject({ docId: "doc-1", tag: "sync" });
	});

	it("level 3: re-renders only the page whose hash changed, and bumps entryHash on the untouched row", async () => {
		const entry = documentEntry({ hash: "hash-new" });
		const content = documentContent({
			cPages: cPages(["page-a", "page-b"]),
			pageTags: [
				{ name: "todo", timestamp: 0, pageId: "page-a" },
				{ name: "todo", timestamp: 0, pageId: "page-b" },
			],
		});
		const api = fakeApi({
			rootHash: "root-7",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a-old", "page-b": "hash-b-new" } },
		});
		const previousIndex: SyncIndex = {
			rootHash: "root-6",
			rows: {
				[pageSyncKey("doc-1", "page-a", "todo")]: {
					syncKey: pageSyncKey("doc-1", "page-a", "todo"),
					docId: "doc-1",
					pageId: "page-a",
					tag: "todo",
					entryHash: "hash-old",
					pageHash: "hash-a-old",
					notePath: "Todo/Notebook — Page 1.md",
					status: "active",
					syncedAt: "2025-12-01T00:00:00.000Z",
					// Current-version rows, so this test isolates the hash gate. A row rendered by an older
					// renderer is its own exception to that gate and has its own test below.
					renderVersion: RENDER_VERSION,
				},
				[pageSyncKey("doc-1", "page-b", "todo")]: {
					syncKey: pageSyncKey("doc-1", "page-b", "todo"),
					docId: "doc-1",
					pageId: "page-b",
					tag: "todo",
					entryHash: "hash-old",
					pageHash: "hash-b-old",
					notePath: "Todo/Notebook — Page 2.md",
					status: "active",
					syncedAt: "2025-12-01T00:00:00.000Z",
					renderVersion: RENDER_VERSION,
				},
			},
		};
		const deps = baseDeps(api, { todo: "Todo" });
		await deps.noteStore.write("Todo/Notebook — Page 1.md", "stub");
		await deps.noteStore.write("Todo/Notebook — Page 2.md", "stub");

		const result = await runSync(deps, previousIndex);

		expect(result.notesWritten).toBe(1);
		expect(api.raw.getHash).toHaveBeenCalledTimes(1);
		expect(api.raw.getHash).toHaveBeenCalledWith("doc-1/page-b.rm", "hash-b-new");

		const rowA = result.index.rows[pageSyncKey("doc-1", "page-a", "todo")];
		expect(rowA.pageHash).toBe("hash-a-old"); // untouched
		expect(rowA.entryHash).toBe("hash-new"); // bumped so future syncs compare against the current hash

		const rowB = result.index.rows[pageSyncKey("doc-1", "page-b", "todo")];
		expect(rowB.pageHash).toBe("hash-b-new");
		expect(rowB.entryHash).toBe("hash-new");
		expect(rowB.syncedAt).toBe(NOW);
	});

	it("level 3: self-heals a page-tag note deleted by hand even though its page hash didn't change", async () => {
		const entry = documentEntry({ hash: "hash-1" });
		const content = documentContent({
			cPages: cPages(["page-a"]),
			pageTags: [{ name: "todo", timestamp: 0, pageId: "page-a" }],
		});
		const api = fakeApi({
			rootHash: "root-1",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const previousIndex: SyncIndex = {
			rootHash: "root-1",
			rows: {
				[pageSyncKey("doc-1", "page-a", "todo")]: {
					syncKey: pageSyncKey("doc-1", "page-a", "todo"),
					docId: "doc-1",
					pageId: "page-a",
					tag: "todo",
					entryHash: "hash-1",
					pageHash: "hash-a",
					notePath: "Todo/Notebook — Page 1.md",
					status: "active",
					syncedAt: "2025-12-01T00:00:00.000Z",
				},
			},
		};
		const deps = baseDeps(api, { todo: "Todo" });
		// Note deliberately NOT seeded into the note store: simulates the user deleting it.

		const result = await runSync(deps, previousIndex);

		expect(result.notesWritten).toBe(1);
		expect(api.raw.getHash).toHaveBeenCalledWith("doc-1/page-a.rm", "hash-a");
		expect(deps.noteStore.write).toHaveBeenCalledWith("Todo/Notebook — Page 1.md", expect.any(String));
	});

	it("level 3: re-renders a page-tag note rendered by an older renderer, unchanged page hash and all", async () => {
		// Without this exception the RENDER_VERSION bump never reaches a page-tag note: nothing on the
		// device changes when the renderer does, so its page hash stays equal forever and the gate skips
		// it every time. That is how a page-tagged PDF would have been left without its digest.
		const entry = documentEntry({ hash: "hash-1" });
		const content = documentContent({
			cPages: cPages(["page-a"]),
			pageTags: [{ name: "todo", timestamp: 0, pageId: "page-a" }],
		});
		const staleRow = {
			syncKey: pageSyncKey("doc-1", "page-a", "todo"),
			docId: "doc-1",
			pageId: "page-a",
			tag: "todo",
			entryHash: "hash-1",
			pageHash: "hash-a",
			notePath: "Todo/Notebook — Page 1.md",
			status: "active" as const,
			syncedAt: "2025-12-01T00:00:00.000Z",
		};
		const run = async (renderVersion: number) => {
			const api = fakeApi({
				rootHash: "root-1",
				entries: [entry],
				contentById: { "doc-1": content },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = baseDeps(api, { todo: "Todo" });
			await deps.noteStore.write("Todo/Notebook — Page 1.md", "stub");
			return runSync(deps, { rootHash: "root-1", rows: { [staleRow.syncKey]: { ...staleRow, renderVersion } } });
		};

		expect((await run(RENDER_VERSION - 1)).notesWritten).toBe(1);
		expect((await run(RENDER_VERSION)).notesWritten).toBe(0);
	});

	it("keeps the transcript a stale-render rebuild already has, instead of re-running a metered backend", async () => {
		// A RENDER_VERSION bump re-renders every note, and writeUnit transcribes whatever it renders --
		// so without this a bump bills an llm-vision user for the whole vault to get the same text back.
		// The device has not changed; only our renderer has.
		const entry = documentEntry({ hash: "hash-1" });
		const content = documentContent({
			cPages: cPages(["page-a"]),
			pageTags: [{ name: "todo", timestamp: 0, pageId: "page-a" }],
		});
		const staleRow = {
			syncKey: pageSyncKey("doc-1", "page-a", "todo"),
			docId: "doc-1",
			pageId: "page-a",
			tag: "todo",
			entryHash: "hash-1",
			pageHash: "hash-a",
			notePath: "Todo/Notebook — Page 1.md",
			status: "active" as const,
			syncedAt: "2025-12-01T00:00:00.000Z",
			renderVersion: RENDER_VERSION - 1,
		};
		const api = fakeApi({
			rootHash: "root-1",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		api.raw.getHash.mockResolvedValue(UNANCHORED_PAGE_BYTES);
		const deps = baseDeps(api, { todo: "Todo" });
		await deps.noteStore.write(
			"Todo/Notebook — Page 1.md",
			"> [!info]- x\n\n![[a.pdf]]\n\n## Transcript\nwhat the backend said last time\n<!-- tagged-sync:end -->\n",
		);
		deps.noteStore.write.mockClear();

		const result = await runSync(deps, { rootHash: "root-1", rows: { [staleRow.syncKey]: staleRow } });

		expect(result.notesWritten).toBe(1);
		expect(deps.ocrBackend.recognize).not.toHaveBeenCalled();
		expect(deps.noteStore.write.mock.calls[0][1]).toContain("what the backend said last time");
	});

	it("re-transcribes a stale-render rebuild whose ink the parser has now placed", async () => {
		// The one case worth paying for: placing anchored ink changes what the OCR rasterizer sees, so
		// the stored transcript was made from an overlapped page. The fixture's nodes are anchored.
		const entry = documentEntry({ hash: "hash-1" });
		const content = documentContent({
			cPages: cPages(["page-a"]),
			pageTags: [{ name: "todo", timestamp: 0, pageId: "page-a" }],
		});
		const staleRow = {
			syncKey: pageSyncKey("doc-1", "page-a", "todo"),
			docId: "doc-1",
			pageId: "page-a",
			tag: "todo",
			entryHash: "hash-1",
			pageHash: "hash-a",
			notePath: "Todo/Notebook — Page 1.md",
			status: "active" as const,
			syncedAt: "2025-12-01T00:00:00.000Z",
			renderVersion: RENDER_VERSION - 1,
		};
		const api = fakeApi({
			rootHash: "root-1",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const deps = baseDeps(api, { todo: "Todo" });
		await deps.noteStore.write("Todo/Notebook — Page 1.md", "> [!info]- x\n\n![[a.pdf]]\n\n## Transcript\nstale\n<!-- tagged-sync:end -->\n");

		await runSync(deps, { rootHash: "root-1", rows: { [staleRow.syncKey]: staleRow } });

		expect(deps.ocrBackend.recognize).toHaveBeenCalled();
	});

	it("skips a page tag whose page no longer exists on the device", async () => {
		const entry = documentEntry();
		const content = documentContent({ pageTags: [{ name: "todo", timestamp: 0, pageId: "gone" }] });
		const api = fakeApi({
			rootHash: "root-8",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": {} },
		});
		const deps = baseDeps(api, { todo: "Todo" });

		const result = await runSync(deps, EMPTY_SYNC_INDEX);

		expect(result.notesWritten).toBe(0);
		expect(result.index.rows).toEqual({});
	});

	it("writes the OCR backend's transcript into the note's managed transcript region", async () => {
		const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
		const content = documentContent({ cPages: cPages(["page-a"]) });
		const api = fakeApi({
			rootHash: "root-ocr",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const deps = {
			...baseDeps(api, { sync: "Target" }),
			ocrBackend: fakeOcrBackend({ status: "ok", text: "Hello world", confidence: 91 }),
		};

		await runSync(deps, EMPTY_SYNC_INDEX);

		const [, written] = deps.noteStore.write.mock.calls[0];
		expect(written).toContain("## Transcript\nHello world");
		expect(vi.mocked(deps.ocrBackend.recognize).mock.calls[0][0]).toEqual(expect.any(Array));
	});

	it("degrades to an empty transcript, without failing the sync, when the OCR backend throws", async () => {
		const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
		const content = documentContent({ cPages: cPages(["page-a"]) });
		const api = fakeApi({
			rootHash: "root-ocr-throw",
			entries: [entry],
			contentById: { "doc-1": content },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const throwingBackend: OcrBackend = { id: "vision", metered: false, recognize: vi.fn().mockRejectedValue(new Error("boom")) };
		const deps = { ...baseDeps(api, { sync: "Target" }), ocrBackend: throwingBackend };

		const result = await runSync(deps, EMPTY_SYNC_INDEX);

		expect(result.notesWritten).toBe(1);
		const [, written] = deps.noteStore.write.mock.calls[0];
		expect(written).not.toContain("## Transcript"); // failure -> no empty heading
		expect(written).toContain("![[tagged-sync/attachments/doc-1.pdf]]"); // render still written
	});

	it("skips a document whose content fails to load, and continues syncing the rest", async () => {
		const broken = documentEntry({ id: "doc-broken", hash: "hash-broken", tags: [{ name: "sync", timestamp: 0 }] });
		const ok = documentEntry({ id: "doc-1", tags: [{ name: "sync", timestamp: 0 }] });
		const api = fakeApi({
			rootHash: "root-9",
			entries: [broken, ok],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const deps = baseDeps(api, { sync: "Target" });

		const result = await runSync(deps, EMPTY_SYNC_INDEX);

		expect(result.notesWritten).toBe(1);
		expect(result.index.rows[notebookSyncKey("doc-1", "sync")]).toBeDefined();
		expect(result.index.rows[notebookSyncKey("doc-broken", "sync")]).toBeUndefined();
	});

	describe("edge cases (ticket 11)", () => {
		it("orphans a note whose document disappears from the enumeration, without deleting it", async () => {
			const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
			const content = documentContent({ cPages: cPages(["page-a"]) });
			const api1 = fakeApi({
				rootHash: "root-a",
				entries: [entry],
				contentById: { "doc-1": content },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = baseDeps(api1, { sync: "Target" });

			const first = await runSync(deps, EMPTY_SYNC_INDEX);
			expect(first.index.rows[notebookSyncKey("doc-1", "sync")].status).toBe("active");

			const api2 = fakeApi({ rootHash: "root-b", entries: [] });
			const second = await runSync({ ...deps, api: api2 }, first.index);

			const row = second.index.rows[notebookSyncKey("doc-1", "sync")];
			expect(row.status).toBe("orphaned");
			expect(row.notePath).toBe("Target/Notebook.md");
			const written = await deps.noteStore.read("Target/Notebook.md");
			expect(written).not.toBeNull(); // never deleted
			expect(written).not.toContain("sync-status"); // orphaning is index-only -- no in-note signal (invisible-sync-state 02)
		});

		it("flips an orphaned note back to active when its document reappears, even with an unchanged entry hash", async () => {
			const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
			const content = documentContent({ cPages: cPages(["page-a"]) });
			const api1 = fakeApi({
				rootHash: "root-a",
				entries: [entry],
				contentById: { "doc-1": content },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = baseDeps(api1, { sync: "Target" });
			const first = await runSync(deps, EMPTY_SYNC_INDEX);

			const api2 = fakeApi({ rootHash: "root-b", entries: [] });
			const second = await runSync({ ...deps, api: api2 }, first.index);
			expect(second.index.rows[notebookSyncKey("doc-1", "sync")].status).toBe("orphaned");

			// Reappears with the exact same entry hash as before it vanished -- level 2 must still
			// reopen it because it has an orphaned row, or the flip-back could never happen.
			const api3 = fakeApi({
				rootHash: "root-c",
				entries: [entry],
				contentById: { "doc-1": content },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const third = await runSync({ ...deps, api: api3 }, second.index);

			const row = third.index.rows[notebookSyncKey("doc-1", "sync")];
			expect(row.status).toBe("active");
			// Revival re-renders the note (index row flips back to active); there's no in-note status to check.
			expect(await deps.noteStore.read("Target/Notebook.md")).toContain("[!info]- Generated by Tagged Sync");
		});

		it("orphans a note whose tag is removed from the notebook, without touching the doc's other synced tags", async () => {
			const entryFirst = documentEntry({
				tags: [
					{ name: "sync", timestamp: 0 },
					{ name: "keep", timestamp: 0 },
				],
			});
			const contentFirst = documentContent({ cPages: cPages(["page-a"]) });
			const api1 = fakeApi({
				rootHash: "root-a",
				entries: [entryFirst],
				contentById: { "doc-1": contentFirst },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = baseDeps(api1, { sync: "Target", keep: "Keep" });
			const first = await runSync(deps, EMPTY_SYNC_INDEX);
			expect(first.notesWritten).toBe(2);

			const entrySecond = documentEntry({ hash: "hash-2", tags: [{ name: "keep", timestamp: 0 }] });
			const contentSecond = documentContent({ cPages: cPages(["page-a"]) });
			const api2 = fakeApi({
				rootHash: "root-b",
				entries: [entrySecond],
				contentById: { "doc-1": contentSecond },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const second = await runSync({ ...deps, api: api2 }, first.index);

			expect(second.index.rows[notebookSyncKey("doc-1", "sync")].status).toBe("orphaned");
			expect(second.index.rows[notebookSyncKey("doc-1", "keep")].status).toBe("active");
		});

		it("moves the note to the new folder when a tag changes to a different mapped tag, instead of orphaning + duplicating", async () => {
			const entryFirst = documentEntry({ tags: [{ name: "school", timestamp: 0 }] });
			const contentFirst = documentContent({ cPages: cPages(["page-a"]) });
			const api1 = fakeApi({
				rootHash: "root-a",
				entries: [entryFirst],
				contentById: { "doc-1": contentFirst },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = baseDeps(api1, { school: "School", work: "Work" });
			const first = await runSync(deps, EMPTY_SYNC_INDEX);
			expect(first.index.rows[notebookSyncKey("doc-1", "school")].notePath).toBe("School/Notebook.md");

			const entrySecond = documentEntry({ hash: "hash-2", tags: [{ name: "work", timestamp: 0 }] });
			const contentSecond = documentContent({ cPages: cPages(["page-a"]) });
			const api2 = fakeApi({
				rootHash: "root-b",
				entries: [entrySecond],
				contentById: { "doc-1": contentSecond },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const second = await runSync({ ...deps, api: api2 }, first.index);

			expect(second.index.rows[notebookSyncKey("doc-1", "school")]).toBeUndefined();
			const row = second.index.rows[notebookSyncKey("doc-1", "work")];
			expect(row.notePath).toBe("Work/Notebook.md");
			expect(row.status).toBe("active");
			expect(deps.noteStore.move).toHaveBeenCalledWith("School/Notebook.md", "Work/Notebook.md");
			expect(await deps.noteStore.read("School/Notebook.md")).toBeNull();
			expect(await deps.noteStore.read("Work/Notebook.md")).toContain("[!info]- Generated by Tagged Sync");
		});

		it("moves a page-level note to the new folder when its page tag changes to a different mapped tag", async () => {
			const contentFirst = documentContent({
				cPages: cPages(["page-a"]),
				pageTags: [{ name: "school", timestamp: 0, pageId: "page-a" }],
			});
			const api1 = fakeApi({
				rootHash: "root-a",
				entries: [documentEntry()],
				contentById: { "doc-1": contentFirst },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = baseDeps(api1, { school: "School", work: "Work" });
			const first = await runSync(deps, EMPTY_SYNC_INDEX);
			expect(first.index.rows[pageSyncKey("doc-1", "page-a", "school")].notePath).toBe("School/Notebook — Page 1.md");

			const contentSecond = documentContent({
				cPages: cPages(["page-a"]),
				pageTags: [{ name: "work", timestamp: 0, pageId: "page-a" }],
			});
			const api2 = fakeApi({
				rootHash: "root-b",
				entries: [documentEntry({ hash: "hash-2" })],
				contentById: { "doc-1": contentSecond },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } }, // page itself unchanged -- only the tag on it changed
			});
			const second = await runSync({ ...deps, api: api2 }, first.index);

			expect(second.index.rows[pageSyncKey("doc-1", "page-a", "school")]).toBeUndefined();
			const row = second.index.rows[pageSyncKey("doc-1", "page-a", "work")];
			expect(row.notePath).toBe("Work/Notebook — Page 1.md");
			expect(row.status).toBe("active");
			expect(deps.noteStore.move).toHaveBeenCalledWith("School/Notebook — Page 1.md", "Work/Notebook — Page 1.md");
			expect(await deps.noteStore.read("School/Notebook — Page 1.md")).toBeNull();
			expect(await deps.noteStore.read("Work/Notebook — Page 1.md")).toContain("[!info]- Generated by Tagged Sync");
		});

		it("disambiguates two tags on the same page routed to the same folder, instead of one overwriting the other", async () => {
			const entry = documentEntry();
			const content = documentContent({
				cPages: cPages(["page-a"]),
				pageTags: [
					{ name: "todo", timestamp: 0, pageId: "page-a" },
					{ name: "urgent", timestamp: 0, pageId: "page-a" },
				],
			});
			const api = fakeApi({
				rootHash: "root-x",
				entries: [entry],
				contentById: { "doc-1": content },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = baseDeps(api, { todo: "Shared", urgent: "Shared" });

			const result = await runSync(deps, EMPTY_SYNC_INDEX);

			expect(result.notesWritten).toBe(2);
			const paths = Object.values(result.index.rows)
				.map((row) => row.notePath)
				.sort();
			expect(paths).toEqual(["Shared/Notebook — Page 1 (urgent).md", "Shared/Notebook — Page 1.md"]);
		});

		it("cold index: duplicates rather than clobbers (the accepted Approach A trade -- no in-note identity to re-find by)", async () => {
			const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
			const content = documentContent({ cPages: cPages(["page-a"]) });
			const api = fakeApi({
				rootHash: "root-1",
				entries: [entry],
				contentById: { "doc-1": content },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = baseDeps(api, { sync: "Target" });

			const first = await runSync(deps, EMPTY_SYNC_INDEX);
			expect(first.notesWritten).toBe(1);

			// Simulates a cold/missing index (e.g. vault synced to a fresh machine): previousIndex is
			// empty again, but the note itself still exists in the vault from the earlier sync. With
			// identity out of the note (invisible-sync-state), the sync can no longer recognise it as its
			// own -- so it writes a fresh, suffixed duplicate rather than overwriting the user's file.
			const second = await runSync(deps, EMPTY_SYNC_INDEX);

			expect(second.notesWritten).toBe(1);
			expect(deps.noteStore.write.mock.calls.map((call) => call[0])).toEqual(["Target/Notebook.md", "Target/Notebook (sync).md"]);
			expect(second.index.rows[notebookSyncKey("doc-1", "sync")].notePath).toBe("Target/Notebook (sync).md");
		});
	});

	describe("PDF-backed documents", () => {
		it("composites every page for a notebook-level tag, instead of an empty render", async () => {
			const entry = documentEntry({ fileType: "pdf", tags: [{ name: "sync", timestamp: 0 }] });
			// A PDF-backed doc: pages exist in cPages (redir -> source page) but none has a `.rm` file.
			const content = documentContent({
				fileType: "pdf",
				pageCount: 3,
				cPages: cPagesWith([{ id: "p0", redir: 0 }, { id: "p1", redir: 1 }, { id: "p2", redir: 2 }]),
			});
			const source = await makeSourcePdf([[100, 100], [200, 200], [300, 300]]);
			const api = fakeApi({
				rootHash: "root-pdf",
				entries: [entry],
				contentById: { "doc-1": content },
				sourcePdfByDoc: { "doc-1": source }, // no pageHashesByDoc: zero `.rm` files, an unannotated upload
			});
			const deps = baseDeps(api, { sync: "Target" });

			const result = await runSync(deps, EMPTY_SYNC_INDEX);

			expect(result.notesWritten).toBe(1);
			expect(api.getPdf).toHaveBeenCalledWith("doc-1", "hash-1");
			// All 3 source pages present -- the reported bug produced a 0-page PDF here.
			expect(await embeddedPageCount(deps.attachmentStore, "tagged-sync/attachments/doc-1.pdf")).toBe(3);
		});

		it("composites the source page with its annotation, and OCRs the handwriting, for a page-level tag", async () => {
			const entry = documentEntry({ fileType: "pdf", tags: [{ name: "sync", timestamp: 0 }] });
			const content = documentContent({
				fileType: "pdf",
				pageCount: 3,
				cPages: cPagesWith([{ id: "p0", redir: 0 }, { id: "p1", redir: 1 }, { id: "p2", redir: 2 }]),
				pageTags: [{ name: "todo", timestamp: 0, pageId: "p1" }],
			});
			const source = await makeSourcePdf([[100, 100], [200, 200], [300, 300]]);
			const api = fakeApi({
				rootHash: "root-pdf-page",
				entries: [entry],
				contentById: { "doc-1": content },
				sourcePdfByDoc: { "doc-1": source },
				pageHashesByDoc: { "doc-1": { p1: "anno-hash" } }, // p1 carries a handwritten annotation
			});
			const deps = {
				...baseDeps(api, { todo: "Todo" }),
				ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }),
			};

			const result = await runSync(deps, EMPTY_SYNC_INDEX);

			expect(result.notesWritten).toBe(1);
			const path = "tagged-sync/attachments/doc-1-p1.pdf";
			const call = (deps.attachmentStore.writeBinary as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === path);
			expect((await PDFDocument.load(call![1])).getPageCount()).toBe(1);
			// The annotation scene is OCR'd (its handwriting), and its text lands in the note -- inside the
			// digest, which is what a PDF-backed unit carries instead of a transcript.
			expect((deps.ocrBackend.recognize as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(1);
			expect(deps.noteStore.write.mock.calls[0][1]).toContain("my note");
			// Page position (1-based document order) shows in the note's filename, not frontmatter.
			expect(deps.noteStore.write.mock.calls[0][0]).toContain("Page 2");
		});

		it("skips OCR for a PDF whose pages carry no handwritten annotations", async () => {
			const entry = documentEntry({ fileType: "pdf", tags: [{ name: "sync", timestamp: 0 }] });
			const content = documentContent({
				fileType: "pdf",
				pageCount: 2,
				cPages: cPagesWith([{ id: "p0", redir: 0 }, { id: "p1", redir: 1 }]),
			});
			const source = await makeSourcePdf([[100, 100], [200, 200]]);
			const api = fakeApi({
				rootHash: "root-pdf-noanno",
				entries: [entry],
				contentById: { "doc-1": content },
				sourcePdfByDoc: { "doc-1": source },
			});
			const deps = baseDeps(api, { sync: "Target" });

			await runSync(deps, EMPTY_SYNC_INDEX);

			// No `.rm` scenes -> nothing to transcribe.
			expect((deps.ocrBackend.recognize as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([]);
		});
	});

	describe("annotation digest", () => {
		/** A PDF-backed doc whose single page carries the handwriting fixture -- the input every digest test starts from. */
		async function annotatedPdf(rootHash: string) {
			const entry = documentEntry({ fileType: "pdf", tags: [{ name: "sync", timestamp: 0 }] });
			const content = documentContent({ fileType: "pdf", pageCount: 1, cPages: cPagesWith([{ id: "p0", redir: 0 }]) });
			return fakeApi({
				rootHash,
				entries: [entry],
				contentById: { "doc-1": content },
				sourcePdfByDoc: { "doc-1": await makeSourcePdf([[100, 100]]) },
				pageHashesByDoc: { "doc-1": { p0: "anno-hash" } },
			});
		}

		/**
		 * Everything written to the attachments folder that is not the embed. It has to stay empty: the
		 * digest names where a note's handwriting sits and the vault keeps no image of it (ticket 04).
		 */
		function imagesWritten(store: AttachmentStore): string[] {
			return (store.writeBinary as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string).filter((path) => !path.endsWith(".pdf"));
		}

		it("gives a PDF-backed note a digest instead of a transcript", async () => {
			const api = await annotatedPdf("root-digest");
			const deps = { ...baseDeps(api, { sync: "Target" }), ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }) };

			await runSync(deps, EMPTY_SYNC_INDEX);

			const written = deps.noteStore.write.mock.calls[0][1] as string;
			expect(written).toContain("## Digest");
			// The digest carries the highlights itself, so neither of the sections it replaces comes back.
			expect(written).not.toContain("## Transcript");
			expect(written).not.toContain("## Highlights");
		});

		it("transcribes a PDF-backed unit once, per margin note, never a second time over the whole scene", async () => {
			// The digest OCRs each cluster on its own, so the whole-scene pass `writeUnit` used to run
			// would be a second round of Vision processes whose result is then thrown away.
			const api = await annotatedPdf("root-once");
			const deps = { ...baseDeps(api, { sync: "Target" }), ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }) };

			await runSync(deps, EMPTY_SYNC_INDEX);

			const scenes = (deps.ocrBackend.recognize as ReturnType<typeof vi.fn>).mock.calls.flatMap(
				(call) => call[0] as { layers: unknown[]; highlights?: unknown[] }[],
			);
			// Every scene handed to the backend is a single cluster: one layer, no highlights. The
			// whole-scene pass would carry the page's own layers and its highlights. (`writeUnit` still
			// calls the backend with an empty page list, which returns `skipped` without spawning.)
			expect(scenes.length).toBeGreaterThan(0);
			for (const scene of scenes) {
				expect(scene.layers).toHaveLength(1);
				expect(scene.highlights ?? []).toHaveLength(0);
			}
		});

		it("still reports an unavailable backend, so the platform notice keeps firing", async () => {
			// The counter that drives the one-time "Vision cannot run here" notice now comes from the
			// digest's own transcription; a Windows user with margin notes still has to hear it.
			const api = await annotatedPdf("root-unavailable");
			const deps = { ...baseDeps(api, { sync: "Target" }), ocrBackend: fakeOcrBackend({ status: "unavailable", text: "", confidence: null }) };

			const result = await runSync(deps, EMPTY_SYNC_INDEX);

			expect(result.unavailableOcrUnits).toBe(1);
			// F18: nothing is dropped -- every margin note still gets an entry, which says in words that
			// it could not be read and carries the place its handwriting sits.
			const written = deps.noteStore.write.mock.calls[0][1] as string;
			expect(written).toContain("Handwriting that could not be transcribed.");
			expect(imagesWritten(deps.attachmentStore)).toEqual([]);
		});

		// F20's default, and the trap it has to avoid: with no margin notes the digest can come out
		// empty, an empty digest falls back to `## Transcript`, and a whole-scene OCR pass would hand
		// the same handwriting back as flat page text -- worse than what the user switched off.
		it("switches margin notes off by default, and runs no OCR at all for a PDF unit", async () => {
			const api = await annotatedPdf("root-default-off");
			const { marginNotes: _off, ...deps } = {
				...baseDeps(api, { sync: "Target" }),
				ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }),
			};

			await runSync(deps, EMPTY_SYNC_INDEX);

			const written = deps.noteStore.write.mock.calls[0][1] as string;
			expect(written).not.toContain("[!handwritten]");
			expect(written).not.toContain("## Transcript");
			const scenes = (deps.ocrBackend.recognize as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[0] as unknown[]);
			expect(scenes).toHaveLength(0);
		});

		// The reason the digest exists is a page carrying text somebody else wrote, and `fileType` is not
		// what says so: the "Read on reMarkable" extension delivers a web article as a *notebook* whose
		// text is typed into the scene. Such a page got the whole printed article read back to it by an
		// OCR pass and written into the vault as a transcript.
		it("gives a notebook whose text was typed a digest, not a transcript of its own text", async () => {
			vi.mocked(isDocumentText).mockReturnValueOnce(true); // one page, one call -- and it cleans itself up
			const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
			const api = fakeApi({
				rootHash: "root-typed",
				entries: [entry],
				contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = { ...baseDeps(api, { sync: "Target" }), ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }) };

			await runSync(deps, EMPTY_SYNC_INDEX);

			const written = deps.noteStore.write.mock.calls[0][1] as string;
			expect(written).toContain("## Digest");
			expect(written).not.toContain("## Transcript");
		});

		it("reads a typed page's own text rather than fetching a source PDF it does not have", async () => {
			// `getPdf` is what a PDF-backed unit's digest reads its text from. A notebook has no such file,
			// and asking for one would fail the whole unit.
			vi.mocked(isDocumentText).mockReturnValueOnce(true); // one page, one call -- and it cleans itself up
			const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
			const api = fakeApi({
				rootHash: "root-typed-nopdf",
				entries: [entry],
				contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = { ...baseDeps(api, { sync: "Target" }), ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }) };

			const result = await runSync(deps, EMPTY_SYNC_INDEX);

			expect(api.getPdf).not.toHaveBeenCalled();
			expect(result.skipErrors).toEqual([]);
		});

		it("transcribes such a page per margin note, never a second time over the whole scene", async () => {
			vi.mocked(isDocumentText).mockReturnValueOnce(true); // one page, one call -- and it cleans itself up
			const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
			const api = fakeApi({
				rootHash: "root-typed-once",
				entries: [entry],
				contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = { ...baseDeps(api, { sync: "Target" }), ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }) };

			await runSync(deps, EMPTY_SYNC_INDEX);

			const scenes = (deps.ocrBackend.recognize as ReturnType<typeof vi.fn>).mock.calls.flatMap(
				(call) => call[0] as { layers: unknown[] }[],
			);
			expect(scenes.length).toBeGreaterThan(0);
			for (const scene of scenes) expect(scene.layers).toHaveLength(1);
		});

		it("leaves a handwritten notebook on the transcript path, untouched", async () => {
			const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
			const api = fakeApi({
				rootHash: "root-handwritten",
				entries: [entry],
				contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
			const deps = { ...baseDeps(api, { sync: "Target" }), ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }) };

			await runSync(deps, EMPTY_SYNC_INDEX);

			const written = deps.noteStore.write.mock.calls[0][1] as string;
			expect(written).toContain("## Transcript\nmy note");
			expect(written).not.toContain("## Digest");
			expect(imagesWritten(deps.attachmentStore)).toEqual([]);
		});

		// The switch's two directions, end to end. `invalidateRenders` is what the settings toggle calls;
		// without it neither sync would run at all, because nothing changed on the device.
		it("adds the notes when the setting is turned on, and takes them away again", async () => {
			const api = await annotatedPdf("root-toggle");
			const off = { ...baseDeps(api, { sync: "Target" }), marginNotes: false, ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }) };

			const first = await runSync(off, EMPTY_SYNC_INDEX);
			expect(off.noteStore.write.mock.calls.at(-1)![1] as string).not.toContain("[!handwritten]");

			const on = { ...off, marginNotes: true };
			const second = await runSync(on, invalidateRenders(first.index));
			expect(on.noteStore.write.mock.calls.at(-1)![1] as string).toContain("[!handwritten]");

			const again = { ...off, noteStore: fakeNoteStore(), attachmentStore: fakeAttachmentStore() };
			await runSync(again, invalidateRenders(second.index));

			// Nothing is left behind on the way out: the entries go with the setting, and there was never
			// a file in the vault to clean up after them.
			expect(again.noteStore.write.mock.calls.at(-1)![1] as string).not.toContain("[!handwritten]");
			expect(imagesWritten(again.attachmentStore)).toEqual([]);
		});

		/** F15/F16, acceptance 3: the digest is regenerated wholesale every sync, so an unchanged document has to come out identical -- otherwise every sync would rewrite every note. */
		it("re-syncing an unchanged document writes the same note", async () => {
			const api = await annotatedPdf("root-twice");
			const deps = { ...baseDeps(api, { sync: "Target" }), ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }) };

			await runSync(deps, EMPTY_SYNC_INDEX);
			await runSync(deps, EMPTY_SYNC_INDEX);

			const writes = deps.noteStore.write.mock.calls;
			expect(writes[1][1]).toBe(writes[0][1]);
			expect(imagesWritten(deps.attachmentStore)).toEqual([]);
		});

		it("writes nothing at all for a document the change-detection gate skipped", async () => {
			const entry = documentEntry({ fileType: "pdf", hash: "hash-1", tags: [{ name: "sync", timestamp: 0 }] });
			const api = fakeApi({ rootHash: "root-new", entries: [entry] });
			const row = {
				syncKey: notebookSyncKey("doc-1", "sync"),
				docId: "doc-1",
				pageId: null,
				tag: "sync",
				entryHash: "hash-1",
				pageHash: null,
				notePath: "Target/Notebook.md",
				status: "active" as const,
				syncedAt: "2025-12-01T00:00:00.000Z",
				renderVersion: RENDER_VERSION,
			};
			const deps = baseDeps(api, { sync: "Target" });
			await deps.noteStore.write("Target/Notebook.md", "stub");

			// Past level 1 (the root hash moved), stopped by level 2 (this document's entry hash did not).
			const result = await runSync(deps, { rootHash: "root-old", mappings: mappingFingerprint({ sync: "Target" }), rows: { [row.syncKey]: row } });

			expect(result.notesWritten).toBe(0);
			expect(imagesWritten(deps.attachmentStore)).toEqual([]);
		});

		it("still writes the note, and reports the reason, when the digest build throws", async () => {
			const api = await annotatedPdf("root-digest-fails");
			const deps = baseDeps(api, { sync: "Target" });
			vi.mocked(buildDigest).mockRejectedValueOnce(new Error("digest blew up"));

			const result = await runSync(deps, EMPTY_SYNC_INDEX);

			expect(result.notesWritten).toBe(1);
			const written = deps.noteStore.write.mock.calls[0][1] as string;
			expect(written).not.toContain("## Digest");
			expect(written).toContain("![[tagged-sync/attachments/doc-1.pdf]]");
			expect(result.skipErrors).toEqual(['failed to build the digest for "Notebook" for tag "sync": Error: digest blew up']);
		});
	});

	describe("blank and empty pages", () => {
		it("keeps a blank page (no .rm file) in the notebook render, preserving later page indices", async () => {
			const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
			// Middle page has no `.rm` file and no `deleted` marker: a real, still-live page never drawn on.
			const content = documentContent({
				pageCount: 3,
				cPages: cPagesWith([{ id: "page-a" }, { id: "blank" }, { id: "page-c" }]),
				pageTags: [{ name: "todo", timestamp: 0, pageId: "page-c" }],
			});
			const api = fakeApi({
				rootHash: "root-blank",
				entries: [entry],
				contentById: { "doc-1": content },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a", "page-c": "hash-c" } }, // no hash for "blank"
			});
			const deps = baseDeps(api, { sync: "Target", todo: "Todo" });

			await runSync(deps, EMPTY_SYNC_INDEX);

			// Notebook note embeds all 3 pages, blank included -- not 2 with the blank silently dropped.
			expect(await embeddedPageCount(deps.attachmentStore, "tagged-sync/attachments/doc-1.pdf")).toBe(3);
			// The tag on the third page reports page 3, not 2 (which is what dropping the blank would give).
			const pageNote = deps.noteStore.write.mock.calls.find((c) => (c[0] as string).startsWith("Todo/"));
			expect(pageNote![0]).toContain("Page 3");
		});

		it("keeps a page whose `deleted` marker is 0, preserving later page indices", async () => {
			const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
			// A restored page keeps its `deleted` marker with value 0 -- present, but live.
			const content = documentContent({
				pageCount: 3,
				cPages: cPagesWith([{ id: "page-a" }, { id: "restored", deleted: 0 }, { id: "page-c" }]),
				pageTags: [{ name: "todo", timestamp: 0, pageId: "page-c" }],
			});
			const api = fakeApi({
				rootHash: "root-restored",
				entries: [entry],
				contentById: { "doc-1": content },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a", restored: "hash-r", "page-c": "hash-c" } },
			});
			const deps = baseDeps(api, { sync: "Target", todo: "Todo" });

			await runSync(deps, EMPTY_SYNC_INDEX);

			expect(await embeddedPageCount(deps.attachmentStore, "tagged-sync/attachments/doc-1.pdf")).toBe(3);
			const pageNote = deps.noteStore.write.mock.calls.find((c) => (c[0] as string).startsWith("Todo/"));
			expect(pageNote![0]).toContain("Page 3");
		});

		it("skips a notebook whose only pages are deleted, without writing an empty note", async () => {
			const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
			const content = documentContent({ cPages: cPagesWith([{ id: "gone", deleted: 1 }]) });
			const api = fakeApi({
				rootHash: "root-empty",
				entries: [entry],
				contentById: { "doc-1": content },
				pageHashesByDoc: { "doc-1": {} },
			});
			const deps = baseDeps(api, { sync: "Target" });

			const result = await runSync(deps, EMPTY_SYNC_INDEX);

			expect(result.notesWritten).toBe(0);
			expect(deps.noteStore.write).not.toHaveBeenCalled();
			expect(result.index.rows).toEqual({});
		});
	});
});

describe("reTranscribeAll", () => {
	function notebookApi() {
		return fakeApi({
			rootHash: "root-1",
			entries: [documentEntry({ hash: "hash-1", visibleName: "Notebook", tags: [{ name: "sync", timestamp: 0 }] })],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
	}

	/**
	 * The denominator is the pages of every active row -- counted structurally, from the document's
	 * live pages. Counting it with `ocrPagesForRow`, which is the function that answers this question
	 * everywhere else, would render every page a second time.
	 */
	it("counts the pages of every row it will re-transcribe, without rendering them to find out", async () => {
		const twoPages = () =>
			fakeApi({
				rootHash: "root-1",
				entries: [documentEntry({ hash: "hash-1", visibleName: "Notebook", tags: [{ name: "sync", timestamp: 0 }] })],
				contentById: { "doc-1": documentContent({ cPages: cPages(["page-a", "page-b"]) }) },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a", "page-b": "hash-b" } },
			});
		const first = baseDeps(twoPages(), { sync: "Target" });
		const synced = await runSync(first, EMPTY_SYNC_INDEX);
		const api = twoPages();
		const onProgress = vi.fn();

		await reTranscribeAll(
			{ api, noteStore: first.noteStore, ocrBackend: tickingOcrBackend(), onProgress },
			synced.index,
		);

		expect(workingMessages(onProgress).at(-1)).toMatchObject({ done: 2, total: 2, document: "Notebook", tag: "sync" });
		expect(api.raw.getHash).toHaveBeenCalledTimes(2); // the run's own render, and no other
	});

	// Worse than the sync's duplicate: a note whose block was rewritten while its stored blockHash was
	// lost reads as a hand edit forever after, and nothing signals it. Without the per-note checkpoint
	// an interrupted re-transcribe froze every note it had already touched.
	it("checkpoints each refreshed block hash, so an interruption cannot freeze the notes it already rewrote", async () => {
		function twoDocs(rootHash: string, hashSuffix: string) {
			return fakeApi({
				rootHash,
				entries: [
					documentEntry({ id: "doc-1", hash: `hash-1${hashSuffix}`, visibleName: "First", tags: [{ name: "sync", timestamp: 0 }] }),
					documentEntry({ id: "doc-2", hash: `hash-2${hashSuffix}`, visibleName: "Second", tags: [{ name: "sync", timestamp: 0 }] }),
				],
				contentById: {
					"doc-1": documentContent({ cPages: cPages(["page-a"]) }),
					"doc-2": documentContent({ cPages: cPages(["page-b"]) }),
				},
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" }, "doc-2": { "page-b": "hash-b" } },
			});
		}

		const noteStore = fakeNoteStore();
		const synced = await runSync({ ...baseDeps(twoDocs("root-1", ""), { sync: "Target" }), noteStore }, EMPTY_SYNC_INDEX);

		// Re-transcribe both, dying right after the first note's hash was checkpointed.
		const saved: SyncIndex[] = [];
		await expect(
			reTranscribeAll(
				{
					api: twoDocs("root-1", ""),
					noteStore,
					ocrBackend: fakeOcrBackend({ status: "ok", text: "fresh text", confidence: null }),
					saveIndex: async (index) => {
						saved.push(index);
						if (saved.length === 2) throw new Error("interrupted");
					},
				},
				synced.index,
			),
		).rejects.toThrow("interrupted");

		expect(saved).not.toHaveLength(0); // the whole point: something reached disk before the throw

		// The next sync reopens both documents (device hashes moved). The note the re-transcribe
		// rewrote must still read as the plugin's own work, not as a hand edit.
		// Resuming from the pre-re-transcribe index instead yields 2 -- both rewritten notes frozen.
		const after = await runSync({ ...baseDeps(twoDocs("root-2", "b"), { sync: "Target" }), noteStore }, saved.at(-1)!);

		expect(after.editedNotesSkipped).toBe(0);
	});

	// The dangerous half of a stopped re-transcribe: a note whose block was rewritten but whose
	// blockHash was dropped reads as a hand edit to the next sync, which then never touches it again.
	it("hands back the block hashes it already refreshed when stopped", async () => {
		const api = notebookApi();
		const noteStore = fakeNoteStore();
		const first = await runSync({ ...baseDeps(api, { sync: "Target" }), noteStore }, EMPTY_SYNC_INDEX);

		const newBackend: OcrBackend = { id: "vision", metered: false, recognize: vi.fn().mockResolvedValue({ status: "ok", text: "fresh", confidence: null }) };
		const stopped = await reTranscribeAll({ api, noteStore, ocrBackend: newBackend, shouldStop: () => true }, first.index);

		expect(stopped.stopped).toBe(true);
		expect(stopped.updated).toBe(0);
		expect(newBackend.recognize).not.toHaveBeenCalled();
		expect(stopped.index.rows).toEqual(first.index.rows);
	});

	it("re-runs OCR over active notes and rewrites only the transcript region", async () => {
		const api = notebookApi();
		const noteStore = fakeNoteStore();
		const first = await runSync(
			{ ...baseDeps(api, { sync: "Target" }), noteStore, ocrBackend: fakeOcrBackend({ status: "ok", text: "old garbage", confidence: null }) },
			EMPTY_SYNC_INDEX,
		);
		const notePath = "Target/Notebook.md";
		expect((await noteStore.read(notePath))!).toContain("old garbage");

		const newBackend: OcrBackend = { id: "vision", metered: false, recognize: vi.fn().mockResolvedValue({ status: "ok", text: "fresh vision text", confidence: null }) };
		const { updated } = await reTranscribeAll({ api, noteStore, ocrBackend: newBackend }, first.index);

		expect(updated).toBe(1);
		expect(newBackend.recognize).toHaveBeenCalledTimes(1);
		const content = (await noteStore.read(notePath))!;
		expect(content).toContain("## Transcript\nfresh vision text\n<!-- tagged-sync:end -->");
		expect(content).not.toContain("old garbage");
		// The embed is untouched.
		expect(content).toContain("![[");
	});

	it("leaves a note untouched when its document is gone from the device", async () => {
		const api = notebookApi();
		const noteStore = fakeNoteStore();
		const first = await runSync(
			{ ...baseDeps(api, { sync: "Target" }), noteStore, ocrBackend: fakeOcrBackend({ status: "ok", text: "keep me", confidence: null }) },
			EMPTY_SYNC_INDEX,
		);
		const before = (await noteStore.read("Target/Notebook.md"))!;

		const emptyApi = fakeApi({ rootHash: "root-2", entries: [] });
		const newBackend = fakeOcrBackend({ status: "ok", text: "should not appear", confidence: null });
		const { updated } = await reTranscribeAll({ api: emptyApi, noteStore, ocrBackend: newBackend }, first.index);

		expect(updated).toBe(0);
		expect(newBackend.recognize).not.toHaveBeenCalled();
		expect(await noteStore.read("Target/Notebook.md")).toBe(before);
	});

	it("skips orphaned rows", async () => {
		const api = notebookApi();
		const noteStore = fakeNoteStore();
		const first = await runSync(
			{ ...baseDeps(api, { sync: "Target" }), noteStore, ocrBackend: fakeOcrBackend({ status: "ok", text: "x", confidence: null }) },
			EMPTY_SYNC_INDEX,
		);
		// Orphan every row.
		const orphanedIndex: SyncIndex = {
			rootHash: first.index.rootHash,
			rows: Object.fromEntries(Object.entries(first.index.rows).map(([key, row]) => [key, { ...row, status: "orphaned" as const }])),
		};

		const newBackend = fakeOcrBackend({ status: "ok", text: "nope", confidence: null });
		const { updated } = await reTranscribeAll({ api, noteStore, ocrBackend: newBackend }, orphanedIndex);

		expect(updated).toBe(0);
		expect(newBackend.recognize).not.toHaveBeenCalled();
	});
});

describe("collectHighlights", () => {
	/** A highlight with one rect at (x, y); `text` is the raw captured run. */
	const hl = (text: string, x = 0, y = 0) => ({ id: "hl-1", color: 9, text, rects: [{ x, y, width: 1, height: 1 }] });

	it("orders a page's quotes top-to-bottom then left-to-right by rect anchor", () => {
		const groups = collectHighlights([
			{ pageLabel: 1, embedPage: 1, highlights: [hl("bottom", 0, 500), hl("top-right", 300, 10), hl("top-left", 20, 10)] },
		]);

		expect(groups).toEqual([{ pageLabel: 1, embedPage: 1, quotes: ["top-left", "top-right", "bottom"] }]);
	});

	it("collapses internal newlines and whitespace runs so a wrapped run is one flowing bullet", () => {
		const groups = collectHighlights([{ pageLabel: 1, embedPage: 1, highlights: [hl("  Reading changes\nthe   past.  ")] }]);

		expect(groups[0].quotes).toEqual(["Reading changes the past."]);
	});

	it("drops empty and whitespace-only runs, and omits a page left with no quotes", () => {
		const groups = collectHighlights([
			{ pageLabel: 1, embedPage: 1, highlights: [hl("kept"), hl(""), hl("   \n  ")] },
			{ pageLabel: 2, embedPage: 2, highlights: [hl(""), hl("\t ")] },
		]);

		expect(groups).toEqual([{ pageLabel: 1, embedPage: 1, quotes: ["kept"] }]);
	});

	it("passes through the page label and embed anchor a page-level note supplies (label = notebook position, anchor = 1)", () => {
		const groups = collectHighlights([{ pageLabel: 5, embedPage: 1, highlights: [hl("a quote")] }]);

		expect(groups).toEqual([{ pageLabel: 5, embedPage: 1, quotes: ["a quote"] }]);
	});

	it("returns an empty list when nothing has highlights", () => {
		expect(collectHighlights([{ pageLabel: 1, embedPage: 1, highlights: [] }])).toEqual([]);
	});
});

// RC1 item 5. Without a mid-run checkpoint an interrupted sync leaves written notes with no index
// row, and the next sync writes "Notebook (sync).md" beside each of them -- duplicates that never
// self-heal. The first sync is both the longest and the likeliest to be interrupted.
describe("index checkpointing", () => {
	function twoTaggedDocs() {
		const entries = [
			documentEntry({ id: "doc-1", hash: "hash-1", visibleName: "First", tags: [{ name: "sync", timestamp: 0 }] }),
			documentEntry({ id: "doc-2", hash: "hash-2", visibleName: "Second", tags: [{ name: "sync", timestamp: 0 }] }),
		];
		return fakeApi({
			rootHash: "root-2",
			entries,
			contentById: {
				"doc-1": documentContent({ cPages: cPages(["page-a"]) }),
				"doc-2": documentContent({ cPages: cPages(["page-b"]) }),
			},
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" }, "doc-2": { "page-b": "hash-b" } },
		});
	}

	it("saves the index as soon as each note is written, then again at the end of its document", async () => {
		const saveIndex = vi.fn().mockResolvedValue(undefined);
		const deps = { ...baseDeps(twoTaggedDocs(), { sync: "Target" }), saveIndex };

		await runSync(deps, { rootHash: "root-1", rows: {} });

		// One note per document here, so: note, document, note, document.
		const rowKeys = saveIndex.mock.calls.map((call) => Object.keys(call[0].rows));
		expect(rowKeys).toEqual([
			[notebookSyncKey("doc-1", "sync")],
			[notebookSyncKey("doc-1", "sync")],
			[notebookSyncKey("doc-1", "sync"), notebookSyncKey("doc-2", "sync")],
			[notebookSyncKey("doc-1", "sync"), notebookSyncKey("doc-2", "sync")],
		]);
	});

	// The document-level checkpoint never closed the window *inside* a document, and a document is one
	// unit per mapped tag -- two tags routed to one folder collide on the same filename, which is
	// exactly where a lost row turns into a permanent "Notebook (sync).md" beside the real note.
	it("survives an interruption BETWEEN two units of one document without duplicating", async () => {
		function twoTaggedUnits() {
			return fakeApi({
				rootHash: "root-2",
				entries: [
					documentEntry({
						id: "doc-1",
						hash: "hash-1",
						visibleName: "Notebook",
						tags: [
							{ name: "sync", timestamp: 0 },
							{ name: "work", timestamp: 0 },
						],
					}),
				],
				contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
				pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
			});
		}
		// Both tags route to one folder, so the second unit can only be told apart by its suffix.
		const folders = { sync: "Target", work: "Target" };

		const noteStore = fakeNoteStore();
		const realWrite = noteStore.write;
		let writes = 0;
		noteStore.write = vi.fn(async (path: string, content: string) => {
			if (++writes === 2) throw new Error("interrupted"); // died after the first unit was written
			await realWrite(path, content);
		});

		const saved: SyncIndex[] = [];
		await expect(
			runSync({ ...baseDeps(twoTaggedUnits(), folders), noteStore, saveIndex: async (index) => void saved.push(index) }, { rootHash: "root-1", rows: {} }),
		).rejects.toThrow("interrupted");

		// The first unit's row reached disk before the second one was even attempted.
		expect(saved.at(-1)!.rows).toHaveProperty(notebookSyncKey("doc-1", "sync"));

		// Resume against the same vault, with writing restored.
		noteStore.write = realWrite;
		const resumed = await runSync({ ...baseDeps(twoTaggedUnits(), folders), noteStore }, saved.at(-1)!);

		const paths = Object.values(resumed.index.rows).map((row) => row.notePath);
		expect(paths).toEqual(["Target/Notebook.md", "Target/Notebook (work).md"]);
		expect(paths.some((path) => path.includes("(sync)"))).toBe(false);
	});

	it("checkpoints the PREVIOUS root hash, so an interrupted run is re-scanned rather than looking complete", async () => {
		const saveIndex = vi.fn().mockResolvedValue(undefined);
		const deps = { ...baseDeps(twoTaggedDocs(), { sync: "Target" }), saveIndex };

		const result = await runSync(deps, { rootHash: "root-1", rows: {} });

		for (const call of saveIndex.mock.calls) expect(call[0].rootHash).toBe("root-1");
		expect(result.index.rootHash).toBe("root-2");
	});

	it("survives an interruption without duplicating: the checkpointed row is reused as the note's path", async () => {
		const api = twoTaggedDocs();
		const saved: SyncIndex[] = [];
		const failing = {
			...baseDeps(api, { sync: "Target" }),
			saveIndex: async (index: SyncIndex) => {
				saved.push(index);
				if (saved.length === 1) throw new Error("interrupted");
			},
		};

		await expect(runSync(failing, { rootHash: "root-1", rows: {} })).rejects.toThrow("interrupted");

		// Resume from what was persisted before the interruption, against the same vault.
		const resumed = { ...baseDeps(twoTaggedDocs(), { sync: "Target" }), noteStore: failing.noteStore };
		const result = await runSync(resumed, saved[0]);

		const paths = Object.values(result.index.rows).map((row) => row.notePath);
		expect(paths).toEqual(["Target/First.md", "Target/Second.md"]);
		expect(paths.some((path) => path.includes("(sync)"))).toBe(false);
	});

	// A user stop is an interruption the plugin causes on purpose, so it has to land on exactly the
	// footing the checkpoint above establishes for the accidental kind: nothing half-written, and
	// nothing that lets the next run believe the vault is up to date.
	describe("stopping a run", () => {
		it("does nothing at all when the signal is already set", async () => {
			const deps = baseDeps(twoTaggedDocs(), { sync: "Target" });
			const result = await runSync({ ...deps, shouldStop: () => true }, { rootHash: "root-1", rows: {} });

			expect(result.stopped).toBe(true);
			expect(result.notesWritten).toBe(0);
			expect(result.index.rows).toEqual({});
			expect(deps.noteStore.write).not.toHaveBeenCalled();
		});

		it("hands back the PREVIOUS root hash, so a caller that persists it regardless cannot mark the vault up to date", async () => {
			const deps = baseDeps(twoTaggedDocs(), { sync: "Target" });
			const result = await runSync({ ...deps, shouldStop: () => true }, { rootHash: "root-1", rows: {} });

			expect(result.index.rootHash).toBe("root-1");
		});

		it("keeps the documents it finished and resumes them without duplicating", async () => {
			const deps = baseDeps(twoTaggedDocs(), { sync: "Target" });
			const saveIndex = vi.fn().mockResolvedValue(undefined);
			// Stop once the first document has been checkpointed -- the boundary the user's click lands on.
			let stop = false;
			const stopped = await runSync(
				{
					...deps,
					saveIndex: async (index) => {
						await saveIndex(index);
						stop = true;
					},
					shouldStop: () => stop,
				},
				{ rootHash: "root-1", rows: {} },
			);

			expect(stopped.stopped).toBe(true);
			expect(Object.keys(stopped.index.rows)).toEqual([notebookSyncKey("doc-1", "sync")]);
			// The stop path checkpoints again on its way out -- redundant when the stop is caught at a
			// document boundary as here, load-bearing when it is caught between two units of one document.
			expect(saveIndex.mock.lastCall![0]).toEqual(stopped.index);

			// The next ordinary sync completes the job against the same vault, over the stopped index.
			const resumed = await runSync({ ...baseDeps(twoTaggedDocs(), { sync: "Target" }), noteStore: deps.noteStore }, stopped.index);

			const paths = Object.values(resumed.index.rows).map((row) => row.notePath);
			expect(paths).toEqual(["Target/First.md", "Target/Second.md"]);
			expect(paths.some((path) => path.includes("(sync)"))).toBe(false);
			expect(resumed.index.rootHash).toBe("root-2");
		});

		// Not a correctness fix -- the sweep reads the *full* enumeration, so its verdict would be right
		// however far the loop got. It is skipped because orphaning is user-visible state, and a run the
		// user cut short should make no judgement it was not asked for. The next complete run sweeps.
		it("makes no orphaning judgements it was cut short of finishing", async () => {
			const goneRow: SyncIndexRow = {
				syncKey: notebookSyncKey("doc-gone", "sync"),
				docId: "doc-gone",
				pageId: null,
				tag: "sync",
				entryHash: "hash-gone",
				pageHash: null,
				notePath: "Target/Gone.md",
				status: "active",
				syncedAt: NOW,
				renderVersion: RENDER_VERSION,
			};
			const previous = { rootHash: "root-1", rows: { [goneRow.syncKey]: goneRow } };

			const stopped = await runSync({ ...baseDeps(twoTaggedDocs(), { sync: "Target" }), shouldStop: () => true }, previous);
			expect(stopped.index.rows[goneRow.syncKey].status).toBe("active");

			const completed = await runSync(baseDeps(twoTaggedDocs(), { sync: "Target" }), previous);
			expect(completed.index.rows[goneRow.syncKey].status).toBe("orphaned");
		});

		it("reports a completed run as not stopped", async () => {
			const result = await runSync(baseDeps(twoTaggedDocs(), { sync: "Target" }), { rootHash: "root-1", rows: {} });

			expect(result.stopped).toBe(false);
		});
	});
});

// RC1 item 6. The fence warning is an HTML comment, invisible in Reading and Live Preview, so
// correcting a misread word in "## Transcript" reads as an ordinary edit -- and used to be erased.
describe("edited sync blocks", () => {
	function taggedDoc(hash = "hash-2", rootHash = "root-2") {
		return fakeApi({
			rootHash,
			entries: [documentEntry({ hash, tags: [{ name: "sync", timestamp: 0 }] })],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
	}

	/**
	 * Syncs once so a note and its blockHash row exist, then hands both back for a second run. The
	 * OCR backend produces text, so the note has the "## Transcript" section these tests edit into.
	 */
	async function syncedOnce() {
		const ocrBackend = fakeOcrBackend({ status: "ok", text: "misread text", confidence: 0.9 });
		const deps = { ...baseDeps(taggedDoc(), { sync: "Target" }), ocrBackend };
		const first = await runSync(deps, { rootHash: "root-1", rows: {} });
		return { noteStore: deps.noteStore, index: first.index };
	}

	/** The document as it looks after a device-side change, so the second sync actually reaches the write. */
	const changedDoc = () => taggedDoc("hash-3", "root-3");

	it("records a block hash on every row it writes", async () => {
		const { index } = await syncedOnce();
		expect(index.rows[notebookSyncKey("doc-1", "sync")].blockHash).toMatch(/^[0-9a-f]{8}$/);
	});

	it("refuses to overwrite a note edited inside the block, and reports it", async () => {
		const { noteStore, index } = await syncedOnce();
		const path = index.rows[notebookSyncKey("doc-1", "sync")].notePath;
		const edited = (await noteStore.read(path))!.replace("## Transcript", "## Transcript\ncorrected by hand");
		await noteStore.write(path, edited);

		const second = { ...baseDeps(changedDoc(), { sync: "Target" }), noteStore };
		const result = await runSync(second, index);

		expect(result.editedNotesSkipped).toBe(1);
		expect(result.notesWritten).toBe(0);
		expect(await noteStore.read(path)).toContain("corrected by hand");
	});

	it("keeps re-checking an edited note instead of bumping its entryHash and going quiet", async () => {
		const { noteStore, index } = await syncedOnce();
		const key = notebookSyncKey("doc-1", "sync");
		const path = index.rows[key].notePath;
		await noteStore.write(path, (await noteStore.read(path))!.replace("## Transcript", "## Transcript\nmine"));

		const second = { ...baseDeps(changedDoc(), { sync: "Target" }), noteStore };
		const result = await runSync(second, index);

		// A bumped entryHash would make the next sync's level-2 check skip the document entirely.
		expect(result.index.rows[key].entryHash).toBe(index.rows[key].entryHash);
		expect(result.index.rows[key].entryHash).not.toBe("hash-3");
	});

	it("still writes when the user edited only below the block", async () => {
		const { noteStore, index } = await syncedOnce();
		const path = index.rows[notebookSyncKey("doc-1", "sync")].notePath;
		await noteStore.write(path, `${await noteStore.read(path)}\n\nmy own notes`);

		const second = { ...baseDeps(changedDoc(), { sync: "Target" }), noteStore };
		const result = await runSync(second, index);

		expect(result.editedNotesSkipped).toBe(0);
		expect(result.notesWritten).toBe(1);
		expect(await noteStore.read(path)).toContain("my own notes");
	});

	// The ownership callout changed what every managed block renders to. The edit check compares the
	// block on disk against the hash of what the *last sync* wrote, not against what today's code
	// would write -- so a note from before the callout must regenerate, not be mistaken for edited.
	it("regenerates a note written before the ownership callout, keeping what the user wrote below it", async () => {
		const { noteStore, index } = await syncedOnce();
		const key = notebookSyncKey("doc-1", "sync");
		const path = index.rows[key].notePath;
		// A 1.0.8 note exactly: the old begin marker where the callout now sits.
		const beforeCallout = (await noteStore.read(path))!.replace(
			/> \[!info\]-[^\n]*\n[^\n]*\n\n/,
			"<!-- tagged-sync:begin — do not edit inside this block -->\n",
		);
		expect(beforeCallout).not.toContain("[!info]"); // or the test would pass without an old note to migrate
		await noteStore.write(path, `${beforeCallout}\n## My own thoughts\n`);
		const legacyRow = { ...index.rows[key], blockHash: blockHashOf(extractManagedBlock(beforeCallout)!) };

		const second = { ...baseDeps(changedDoc(), { sync: "Target" }), noteStore };
		const result = await runSync(second, { ...index, rows: { [key]: legacyRow } });

		const written = (await noteStore.read(path))!;
		expect(result.editedNotesSkipped).toBe(0);
		expect(written).toContain("> [!info]- Generated by Tagged Sync — do not edit");
		expect(written).not.toContain("tagged-sync:begin");
		expect(written).toContain("## My own thoughts");
	});

	// The hole the begin marker used to leave open: text above it sat outside the block, so the hash
	// said "unchanged" and the next sync overwrote it without a word. The block now starts at the top
	// of the body, so the same text registers as an edit and the note is left alone.
	it("treats text typed above the callout as an edit rather than overwriting it", async () => {
		const { noteStore, index } = await syncedOnce();
		const path = index.rows[notebookSyncKey("doc-1", "sync")].notePath;
		await noteStore.write(path, `a thought I put at the very top\n\n${await noteStore.read(path)}`);

		const second = { ...baseDeps(changedDoc(), { sync: "Target" }), noteStore };
		const result = await runSync(second, index);

		expect(result.editedNotesSkipped).toBe(1);
		expect(await noteStore.read(path)).toContain("a thought I put at the very top");
	});

	it("leaves rows written before blockHash existed unprotected, so they catch up on one write", async () => {
		const { noteStore, index } = await syncedOnce();
		const key = notebookSyncKey("doc-1", "sync");
		const path = index.rows[key].notePath;
		await noteStore.write(path, (await noteStore.read(path))!.replace("## Transcript", "## Transcript\nold edit"));
		const { blockHash: _dropped, ...legacyRow } = index.rows[key];

		const second = { ...baseDeps(changedDoc(), { sync: "Target" }), noteStore };
		const result = await runSync(second, { rootHash: "root-2", rows: { [key]: legacyRow } });

		expect(result.editedNotesSkipped).toBe(0);
		expect(result.index.rows[key].blockHash).toBeDefined();
	});

	it("protects an edited note through a tag rename, where the row it is written from is the OLD tag's", async () => {
		const { noteStore, index } = await syncedOnce();
		const path = index.rows[notebookSyncKey("doc-1", "sync")].notePath;
		await noteStore.write(path, (await noteStore.read(path))!.replace("## Transcript", "## Transcript\nkeep me"));

		// The device-side tag changes "sync" -> "other", which diffUnitTags reads as a rename (move).
		const renamed = fakeApi({
			rootHash: "root-3",
			entries: [documentEntry({ hash: "hash-3", tags: [{ name: "other", timestamp: 0 }] })],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const second = { ...baseDeps(renamed, { sync: "Target", other: "Elsewhere" }), noteStore };
		const result = await runSync(second, index);

		expect(result.editedNotesSkipped).toBe(1);
		expect(await noteStore.read(path)).toContain("keep me");
	});

	it("re-transcribe refreshes the block hash, so the next sync does not read its own work as an edit", async () => {
		const { noteStore, index } = await syncedOnce();
		const key = notebookSyncKey("doc-1", "sync");

		const retranscribed = await reTranscribeAll(
			{ api: taggedDoc(), noteStore, ocrBackend: fakeOcrBackend({ status: "ok", text: "fresh text", confidence: null }) },
			index,
		);
		expect(retranscribed.updated).toBe(1);
		expect(retranscribed.index.rows[key].blockHash).not.toBe(index.rows[key].blockHash);

		const second = { ...baseDeps(changedDoc(), { sync: "Target" }), noteStore };
		const result = await runSync(second, retranscribed.index);

		expect(result.editedNotesSkipped).toBe(0);
	});
});

// RC1 item 7's fifth message: skipped documents were console.warn only, while the notice still
// reported plain success.
describe("skipped documents", () => {
	it("counts a document whose content cannot be read", async () => {
		const api = fakeApi({
			rootHash: "root-2",
			entries: [
				documentEntry({ id: "doc-1", hash: "hash-1", visibleName: "Broken", tags: [{ name: "sync", timestamp: 0 }] }),
			],
			contentById: {},
		});
		const result = await runSync(baseDeps(api, { sync: "Target" }), { rootHash: "root-1", rows: {} });

		expect(result.documentsSkipped).toBe(1);
		expect(result.notesWritten).toBe(0);
	});

	it("carries each skip's raw error text, for Copy diagnostics", async () => {
		// The console.warn alone was invisible to "Copy diagnostics": a partially-successful sync
		// reported "Last error: none" while the skipped document's error sat only in the console.
		const api = fakeApi({
			rootHash: "root-2",
			entries: [
				documentEntry({ id: "doc-1", hash: "hash-1", visibleName: "Broken", tags: [{ name: "sync", timestamp: 0 }] }),
			],
			contentById: {},
		});
		const result = await runSync(baseDeps(api, { sync: "Target" }), { rootHash: "root-1", rows: {} });

		expect(result.skipErrors).toEqual(['failed to read "Broken" during sync: Error: no content for doc-1']);
	});

	it("is zero on a clean sync", async () => {
		const api = fakeApi({
			rootHash: "root-2",
			entries: [documentEntry({ hash: "hash-2", tags: [{ name: "sync", timestamp: 0 }] })],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const result = await runSync(baseDeps(api, { sync: "Target" }), { rootHash: "root-1", rows: {} });

		expect(result.documentsSkipped).toBe(0);
		expect(result.notesWritten).toBe(1);
	});
});

// A failed transcription used to leave an empty "## Transcript", a console.warn nobody reads, and a
// notice announcing plain success -- the note looked synced and simply had no text.
describe("failed transcription", () => {
	function taggedDoc() {
		return fakeApi({
			rootHash: "root-2",
			entries: [documentEntry({ hash: "hash-2", tags: [{ name: "sync", timestamp: 0 }] })],
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
	}

	it("counts a unit whose backend threw, and still writes the note", async () => {
		const deps = { ...baseDeps(taggedDoc(), { sync: "Target" }), ocrBackend: throwingOcrBackend() };
		const result = await runSync(deps, { rootHash: "root-1", rows: {} });

		expect(result.failedOcrUnits).toBe(1);
		// The render must never be lost just because the transcript was.
		expect(result.notesWritten).toBe(1);
	});

	it("does not count a blank page, which is skipped rather than failed", async () => {
		const deps = { ...baseDeps(taggedDoc(), { sync: "Target" }), ocrBackend: fakeOcrBackend() };
		const result = await runSync(deps, { rootHash: "root-1", rows: {} });

		expect(result.failedOcrUnits).toBe(0);
		expect(result.notesWritten).toBe(1);
	});

	it("does not count an unavailable backend, which has its own one-time notice", async () => {
		const unavailable = fakeOcrBackend({ status: "unavailable", text: "", confidence: null });
		const deps = { ...baseDeps(taggedDoc(), { sync: "Target" }), ocrBackend: unavailable };
		const result = await runSync(deps, { rootHash: "root-1", rows: {} });

		expect(result.failedOcrUnits).toBe(0);
		expect(result.unavailableOcrUnits).toBe(1);
	});
});

describe("invalidateRenders", () => {
	const row = (overrides: Partial<SyncIndexRow> = {}): SyncIndexRow => ({
		syncKey: "doc-1::sync",
		docId: "doc-1",
		pageId: null,
		tag: "sync",
		entryHash: "hash-1",
		pageHash: null,
		notePath: "Target/My Notebook.md",
		status: "active",
		syncedAt: NOW,
		renderVersion: RENDER_VERSION,
		...overrides,
	});

	it("makes an up-to-date row stale, so a setting change reaches notes the device never touched", () => {
		const index: SyncIndex = { rootHash: "root-1", rows: { "doc-1::sync": row() } };

		const result = invalidateRenders(index);

		expect(result.rows["doc-1::sync"].renderVersion).toBeUndefined();
		expect(result.rootHash).toBe("root-1");
	});

	it("leaves an orphaned row alone -- it has no note the plugin still writes", () => {
		const orphan = row({ syncKey: "doc-2::sync", docId: "doc-2", status: "orphaned" });
		const index: SyncIndex = { rootHash: "root-1", rows: { "doc-2::sync": orphan } };

		expect(invalidateRenders(index).rows["doc-2::sync"].renderVersion).toBe(RENDER_VERSION);
	});

	it("keeps every other field, so nothing but the render gate moves", () => {
		const index: SyncIndex = { rootHash: "root-1", mappings: "fingerprint", rows: { "doc-1::sync": row({ blockHash: "abcd1234" }) } };

		const result = invalidateRenders(index);

		expect(result.mappings).toBe("fingerprint");
		expect(result.rows["doc-1::sync"]).toMatchObject({ notePath: "Target/My Notebook.md", blockHash: "abcd1234", status: "active" });
	});
});

describe("renderNotes", () => {
	const layer = (overrides: Partial<RmLayer>): RmLayer => ({ id: "l", name: null, strokes: [], ...overrides });
	const scene = (layers: RmLayer[]): RmPage => ({ formatVersion: 6, layers });
	const label = (index: number) => `Page ${index + 1}`;

	it("says nothing when every node placed and every layer is visible", () => {
		const page = scene([layer({ placement: "applied", visible: true }), layer({ visible: true })]);

		expect(renderNotes([page], label)).toEqual([]);
	});

	it("tells the reader what to do about a page it could not place, without naming the format", () => {
		const page = scene([layer({ placement: "no-text" })]);

		expect(renderNotes([page], label)).toEqual([
			"Page 1: some handwriting could not be placed and may appear overlapped or shifted. Open the page on the device to read it.",
		]);
	});

	it("reports a page once, however many of its nodes could not be placed", () => {
		const page = scene([layer({ placement: "unknown-anchor" }), layer({ placement: "no-text" }), layer({ placement: "applied" })]);

		expect(renderNotes([page], label)).toHaveLength(1);
	});

	it("reports a layer the device hides, since the render shows it anyway", () => {
		const page = scene([layer({ visible: false })]);

		expect(renderNotes([page], label)).toEqual(["Page 1: a layer hidden on the device is shown in the render."]);
	});

	it("numbers each page of a notebook separately", () => {
		const pages = [scene([layer({ placement: "applied" })]), scene([layer({ placement: "no-text" })])];

		expect(renderNotes(pages, label)).toEqual([expect.stringContaining("Page 2")]);
	});
});

describe("page-anchored transcripts", () => {
	/** A backend that answers with exactly the per-page results a test names, in input order. */
	function perPageBackend(...pages: OcrPageResult[]): OcrBackend {
		return {
			id: "vision",
			metered: false,
			recognize: vi.fn(async (input: RmPage[]): Promise<OcrResult> => {
				const given = pages.slice(0, input.length);
				return {
					status: "ok",
					pages: given,
					text: given
						.filter((page) => page.status === "ok")
						.map((page) => page.text)
						.join("\n\n"),
					confidence: null,
				};
			}),
		};
	}

	/** A notebook with `count` pages, all tagged for sync -- the shape the reported "Daily" note has. */
	function notebookOf(count: number, rootHash: string) {
		const pageIds = Array.from({ length: count }, (_, i) => `page-${i}`);
		return fakeApi({
			rootHash,
			entries: [documentEntry({ tags: [{ name: "sync", timestamp: 0 }] })],
			contentById: { "doc-1": documentContent({ cPages: cPages(pageIds) }) },
			pageHashesByDoc: { "doc-1": Object.fromEntries(pageIds.map((id, i) => [id, `hash-${i}`])) },
		});
	}

	it("heads each page of a notebook and names the blank ones once", async () => {
		const deps = {
			...baseDeps(notebookOf(3, "root-anchored"), { sync: "Target" }),
			ocrBackend: perPageBackend({ status: "ok", text: "first page" }, { status: "skipped", text: "" }, { status: "ok", text: "third page" }),
		};

		await runSync(deps, EMPTY_SYNC_INDEX);

		const written = deps.noteStore.write.mock.calls[0][1] as string;
		const embed = "tagged-sync/attachments/doc-1.pdf";
		expect(written).toContain(`## Transcript\n### [[${embed}#page=1|Page 1]]\n\nfirst page`);
		expect(written).toContain(`### [[${embed}#page=3|Page 3]]\n\nthird page`);
		expect(written).toContain("*No text on page 2.*");
		// The page that produced nothing gets no heading of its own.
		expect(written).not.toContain("Page 2]]");
	});

	it("marks a page the backend could not read, on the page it happened to", async () => {
		const deps = {
			...baseDeps(notebookOf(2, "root-anchored-fail"), { sync: "Target" }),
			ocrBackend: perPageBackend({ status: "ok", text: "readable" }, { status: "failed", text: "" }),
		};

		await runSync(deps, EMPTY_SYNC_INDEX);

		const written = deps.noteStore.write.mock.calls[0][1] as string;
		expect(written).toContain("|Page 2]]\n\n> [!warning] Could not read this page");
		// A failure is named once, on its page -- never again in the blank-page footnote.
		expect(written).not.toContain("No text on");
	});

	// Attaching a transcript to the wrong page is worse than an honest unlabelled blob, so a backend
	// that miscounts loses its page structure rather than having it guessed at.
	it("drops the page structure, keeping the text, when a backend returns the wrong number of results", async () => {
		const backend: OcrBackend = {
			id: "vision",
			metered: false,
			recognize: vi.fn(async (): Promise<OcrResult> => ({ status: "ok", pages: [{ status: "ok", text: "only one" }], text: "only one", confidence: null })),
		};
		const deps = { ...baseDeps(notebookOf(3, "root-anchored-arity"), { sync: "Target" }), ocrBackend: backend };

		const result = await runSync(deps, EMPTY_SYNC_INDEX);

		const written = deps.noteStore.write.mock.calls[0][1] as string;
		expect(written).toContain("## Transcript\nonly one");
		expect(written).not.toContain("Page 1]]");
		expect(result.skipErrors.some((error) => error.includes("could not be split by page"))).toBe(true);
	});

	// `off` and an unavailable backend never looked at a page, so the note reads exactly as it did
	// before transcripts were page-anchored.
	it("leaves a backend with no per-page information rendering flat", async () => {
		const deps = {
			...baseDeps(notebookOf(3, "root-anchored-flat"), { sync: "Target" }),
			ocrBackend: fakeOcrBackend({ status: "ok", text: "one flat blob", confidence: null }),
		};

		await runSync(deps, EMPTY_SYNC_INDEX);

		expect(deps.noteStore.write.mock.calls[0][1] as string).toContain("## Transcript\none flat blob\n");
	});

	// The ordinal used to be destroyed before any backend saw it: a PDF written on pages 1, 3 and 5
	// reached `recognize` as a three-element array indexed 0, 1, 2, with nothing to recover it from.
	// `annotationOcrPages` now keeps the label beside every scene.
	//
	// Not exercised end-to-end here, and deliberately: a PDF-backed unit gets a `## Digest` instead of
	// a transcript, and only falls through to one if the digest build throws. The digest is already
	// page-anchored by its own route, so this fix now serves that fallback and `reTranscribeAll`.
	it("sends only the annotated pages of a PDF to the backend", async () => {
		const drawnOn = ["p0", "p2", "p4"];
		const api = fakeApi({
			rootHash: "root-anchored-pdf",
			entries: [documentEntry({ fileType: "pdf", tags: [{ name: "sync", timestamp: 0 }] })],
			contentById: {
				"doc-1": documentContent({ fileType: "pdf", pageCount: 5, cPages: cPagesWith([0, 1, 2, 3, 4].map((i) => ({ id: `p${i}`, redir: i }))) }),
			},
			sourcePdfByDoc: { "doc-1": await makeSourcePdf([[100, 100], [100, 100], [100, 100], [100, 100], [100, 100]]) },
			pageHashesByDoc: { "doc-1": Object.fromEntries(drawnOn.map((id) => [id, `${id}-anno`])) },
		});
		const deps = { ...baseDeps(api, { sync: "Target" }), marginNotes: false };

		await runSync(deps, EMPTY_SYNC_INDEX);

		// Blank pages are never sent: a cloud backend bills per page, and padding a 40-page PDF
		// annotated on five would cost eight times over for nothing.
		const scenes = (deps.ocrBackend.recognize as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[0] as RmPage[]);
		expect(scenes.length).toBeLessThanOrEqual(drawnOn.length);
	});
});
