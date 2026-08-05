import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import type { Content, CPages, DocumentContent, Entry, Metadata } from "rmapi-js";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentStore } from "./attachment-writer";
import { buildDigest } from "./digest-pipeline";
import { blockHashOf, extractManagedBlock, type NoteStore } from "./note-builder";
import type { OcrBackend, OcrResult } from "./ocr-backend";
import type { RmPage } from "./rm-parser";
import {
	collectHighlights,
	EMPTY_SYNC_INDEX,
	invalidateRenders,
	notebookSyncKey,
	pageSyncKey,
	RENDER_VERSION,
	reTranscribeAll,
	runSync,
	type SyncApi,
	type SyncIndex,
	type SyncIndexRow,
} from "./sync-engine";
import { mappingFingerprint, TagRouter } from "./tag-router";

// The real pipeline runs in every test but one: every partial failure inside it is deliberately
// caught, so a build that *throws* -- which the sync engine still has to survive -- can only be
// staged from outside. The spy delegates to the real implementation until a test says otherwise.
vi.mock("./digest-pipeline", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./digest-pipeline")>();
	return { ...actual, buildDigest: vi.fn(actual.buildDigest) };
});

const FIXTURE_PATH = "./test-fixtures/rmv6/normal-a-stroke-2-layers.rm";
const PAGE_BYTES = new Uint8Array(readFileSync(FIXTURE_PATH));
const NOW = "2026-01-01T00:00:00.000Z";

function documentEntry(overrides: Partial<Entry> = {}): Entry {
	return {
		id: "doc-1",
		hash: "hash-1",
		visibleName: "Notebook",
		lastModified: "1000",
		pinned: false,
		type: "DocumentType",
		fileType: "notebook",
		lastOpened: "0",
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
				return {
					entries: Object.entries(pageHashes).map(([pageId, hash]) => ({
						id: `${docId}/${pageId}.rm`,
						hash,
						type: 0 as const,
						subfiles: 0,
						size: 0,
					})),
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

/** Stateful, because crop pruning reads back what earlier syncs left behind; `existing` seeds files no sync wrote. */
function fakeAttachmentStore(existing: string[] = []): AttachmentStore {
	const names = new Set(existing);
	const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
	return {
		ensureFolder: vi.fn().mockResolvedValue(undefined),
		writeBinary: vi.fn(async (path: string) => {
			names.add(fileName(path));
		}),
		list: vi.fn(async () => [...names]),
		remove: vi.fn(async (path: string) => {
			names.delete(fileName(path));
		}),
	};
}

/** A backend that never actually transcribes, matching pre-OCR-wiring test expectations unless a test overrides it. */
function fakeOcrBackend(result: OcrResult = { status: "skipped", text: "", confidence: null }): OcrBackend {
	return {
		id: "vision",
		metered: false,
		// Honours the same empty-list contract every real backend has (`vision-ocr-backend.ts:90`):
		// nothing in, `skipped` out, no work done. The sync engine leans on it to keep a PDF unit from
		// being transcribed a second time over its whole scene, and a fake that answered anyway would
		// hide exactly the regression these tests are here to catch.
		recognize: vi.fn(async (pages: RmPage[]): Promise<OcrResult> => (pages.length === 0 ? { status: "skipped", text: "", confidence: null } : result)),
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

describe("runSync", () => {
	it("reports progress before the root-hash check and once per document, including skipped ones", async () => {
		const entries = [
			documentEntry({ id: "doc-1", hash: "hash-1", visibleName: "First", tags: [{ name: "sync", timestamp: 0 }] }),
			documentEntry({ id: "doc-2", hash: "hash-2", visibleName: "Second" }),
		];
		const api = fakeApi({
			rootHash: "root-1",
			entries,
			contentById: { "doc-1": documentContent({ cPages: cPages(["page-a"]) }) },
			pageHashesByDoc: { "doc-1": { "page-a": "hash-a" } },
		});
		const onProgress = vi.fn();
		const deps = { ...baseDeps(api, { sync: "Target" }), onProgress };

		await runSync(deps, EMPTY_SYNC_INDEX);

		expect(onProgress.mock.calls.map((call) => call[0])).toEqual([
			{ phase: "scanning" },
			{ phase: "document", index: 1, total: 2, name: "First" },
			{ phase: "document", index: 2, total: 2, name: "Second" },
		]);
	});

	it("reports scanning even when the root-hash gate returns early", async () => {
		const api = fakeApi({ rootHash: "root-1", entries: [documentEntry()] });
		const onProgress = vi.fn();
		const deps = { ...baseDeps(api, { sync: "Target" }), onProgress };

		await runSync(deps, { rootHash: "root-1", mappings: mappingFingerprint({ sync: "Target" }), rows: {} });

		expect(onProgress.mock.calls.map((call) => call[0])).toEqual([{ phase: "scanning" }]);
	});

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
		expect(deps.ocrBackend.recognize).toHaveBeenCalledWith(expect.any(Array));
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

		/** Crop attachments written so far, in write order -- the `.pdf` embed is the only other thing the store sees. */
		function cropsWritten(store: AttachmentStore): string[] {
			return (store.writeBinary as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string).filter((path) => path.endsWith(".png"));
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
			// F18: nothing is dropped -- every margin note still ships as a crop.
			expect(cropsWritten(deps.attachmentStore).length).toBeGreaterThan(0);
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
			expect(written).not.toContain("[!note]");
			expect(written).not.toContain("## Transcript");
			expect(cropsWritten(deps.attachmentStore)).toHaveLength(0);
			const scenes = (deps.ocrBackend.recognize as ReturnType<typeof vi.fn>).mock.calls.flatMap((call) => call[0] as unknown[]);
			expect(scenes).toHaveLength(0);
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
			// The digest path is not entered at all: no crop written, and no prune run against the folder.
			expect(cropsWritten(deps.attachmentStore)).toEqual([]);
			expect(deps.attachmentStore.remove).not.toHaveBeenCalled();
		});

		// The switch's two directions, end to end. `invalidateRenders` is what the settings toggle calls;
		// without it neither sync would run at all, because nothing changed on the device.
		it("adds the notes and their crops when the setting is turned on, and takes both away again", async () => {
			const api = await annotatedPdf("root-toggle");
			const off = { ...baseDeps(api, { sync: "Target" }), marginNotes: false, ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }) };

			const first = await runSync(off, EMPTY_SYNC_INDEX);
			expect(cropsWritten(off.attachmentStore)).toEqual([]);

			const on = { ...off, marginNotes: true };
			const second = await runSync(on, invalidateRenders(first.index));
			const crops = cropsWritten(on.attachmentStore);
			expect(crops.length).toBeGreaterThan(0);
			expect(on.noteStore.write.mock.calls.at(-1)![1] as string).toContain("[!note]");

			const again = { ...off, noteStore: fakeNoteStore(), attachmentStore: fakeAttachmentStore(crops.map((path) => path.slice(path.lastIndexOf("/") + 1))) };
			await runSync(again, invalidateRenders(second.index));

			expect(again.noteStore.write.mock.calls.at(-1)![1] as string).not.toContain("[!note]");
			// Nothing claims those ids any more, so the prune sweeps every crop the "on" run wrote.
			expect((again.attachmentStore.remove as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string)).toEqual(crops);
		});

		/** F15/F16, acceptance 3: the digest is regenerated wholesale every sync, so an unchanged document has to come out identical -- otherwise every sync would rewrite every note. */
		it("re-syncing an unchanged document writes the same note and the same crops", async () => {
			const api = await annotatedPdf("root-twice");
			const deps = { ...baseDeps(api, { sync: "Target" }), ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }) };

			await runSync(deps, EMPTY_SYNC_INDEX);
			const first = cropsWritten(deps.attachmentStore);
			await runSync(deps, EMPTY_SYNC_INDEX);

			expect(first.length).toBeGreaterThan(0);
			expect(cropsWritten(deps.attachmentStore).slice(first.length)).toEqual(first);
			const writes = deps.noteStore.write.mock.calls;
			expect(writes[1][1]).toBe(writes[0][1]);
			// Same ids, so the second run finds no orphan to delete.
			expect(deps.attachmentStore.remove).not.toHaveBeenCalled();
		});

		it("deletes the crop of a vanished annotation and nothing else", async () => {
			const api = await annotatedPdf("root-prune");
			const deps = {
				...baseDeps(api, { sync: "Target" }),
				// A crop left by an annotation that is gone, a crop of a different document, and a file the
				// user put there -- only the first is this document's to delete.
				attachmentStore: fakeAttachmentStore(["notebook-nt-000000.png", "other-doc-nt-000000.png", "notes.png"]),
				ocrBackend: fakeOcrBackend({ status: "ok", text: "my note", confidence: 88 }),
			};

			await runSync(deps, EMPTY_SYNC_INDEX);

			expect((deps.attachmentStore.remove as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([
				"tagged-sync/attachments/notebook-nt-000000.png",
			]);
			expect(cropsWritten(deps.attachmentStore).length).toBeGreaterThan(0);
		});

		/** The failure mode pruning has to survive: a document nobody rebuilt contributes no crop ids, and a prune against that empty set would strip a note that is still perfectly valid. */
		it("keeps the crops of a document the change-detection gate skipped", async () => {
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
			const deps = { ...baseDeps(api, { sync: "Target" }), attachmentStore: fakeAttachmentStore(["notebook-nt-000000.png"]) };
			await deps.noteStore.write("Target/Notebook.md", "stub");

			// Past level 1 (the root hash moved), stopped by level 2 (this document's entry hash did not).
			const result = await runSync(deps, { rootHash: "root-old", mappings: mappingFingerprint({ sync: "Target" }), rows: { [row.syncKey]: row } });

			expect(result.notesWritten).toBe(0);
			expect(deps.attachmentStore.remove).not.toHaveBeenCalled();
		});

		it("still writes the note, and reports the reason, when the digest build throws", async () => {
			const api = await annotatedPdf("root-digest-fails");
			const deps = { ...baseDeps(api, { sync: "Target" }), attachmentStore: fakeAttachmentStore(["notebook-nt-000000.png"]) };
			vi.mocked(buildDigest).mockRejectedValueOnce(new Error("digest blew up"));

			const result = await runSync(deps, EMPTY_SYNC_INDEX);

			expect(result.notesWritten).toBe(1);
			const written = deps.noteStore.write.mock.calls[0][1] as string;
			expect(written).not.toContain("## Digest");
			expect(written).toContain("![[tagged-sync/attachments/doc-1.pdf]]");
			expect(result.skipErrors).toEqual(['failed to build the digest for "Notebook" for tag "sync": Error: digest blew up']);
			// And the crops stay: a run that produced no ids knows nothing about what is still in use.
			expect(deps.attachmentStore.remove).not.toHaveBeenCalled();
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

	it("saves the index once per document, each time carrying that document's new row", async () => {
		const saveIndex = vi.fn().mockResolvedValue(undefined);
		const deps = { ...baseDeps(twoTaggedDocs(), { sync: "Target" }), saveIndex };

		await runSync(deps, { rootHash: "root-1", rows: {} });

		expect(saveIndex).toHaveBeenCalledTimes(2);
		const firstRows = Object.keys(saveIndex.mock.calls[0][0].rows);
		const secondRows = Object.keys(saveIndex.mock.calls[1][0].rows);
		expect(firstRows).toEqual([notebookSyncKey("doc-1", "sync")]);
		expect(secondRows).toEqual([notebookSyncKey("doc-1", "sync"), notebookSyncKey("doc-2", "sync")]);
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
