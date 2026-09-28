import { readFileSync } from "node:fs";
import type { Content, Entry } from "rmapi-js";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentStore } from "./attachment-writer";
import { EMPTY_INTELLIGENCE_FINGERPRINT } from "./intelligence/settings";
import { emptyReport, type IntelligenceDocument, type IntelligenceState } from "./intelligence/sync-pass";
import type { NoteStore } from "./note-builder";
import type { OcrBackend, OcrResult } from "./ocr-backend";
import { EMPTY_SYNC_INDEX, type IntelligenceHook, runSync, type SyncApi, type SyncIndex } from "./sync-engine";
import { isDocumentText } from "./scene-text";
import { mappingFingerprint, TagRouter } from "./tag-router";

// A switch, as in sync-engine.test.ts: which page counts as typed text is scene-text.test.ts's business.
vi.mock("./scene-text", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./scene-text")>();
	return { ...actual, isDocumentText: vi.fn(actual.isDocumentText) };
});

// The engine's own behaviour is pinned in src/intelligence/*.test.ts. This file pins only the seam:
// what the sync engine hands the engine, when it opens documents for it, and what it keeps in the index.

const PAGE_BYTES = new Uint8Array(readFileSync("./test-fixtures/rmv6/normal-a-stroke-2-layers.rm"));
const NOW = "2026-09-28T10:00:00.000Z";

const entry = (overrides: Partial<Entry> = {}): Entry =>
	({ id: "doc-1", hash: "hash-1", visibleName: "Work log", lastModified: "0", parent: "", pinned: false, type: "DocumentType", fileType: "notebook", tags: [{ name: "work", timestamp: 0 }], ...overrides }) as Entry;

function content(pages: { id: string; modifed?: string }[], extra: Partial<Content> = {}): Content {
	return {
		coverPageNumber: 0,
		documentMetadata: {},
		extraMetadata: {},
		fileType: "notebook",
		fontName: "",
		lineHeight: -1,
		orientation: "portrait",
		pageCount: pages.length,
		textAlignment: "",
		textScale: 1,
		cPages: {
			lastOpened: { timestamp: "1:1", value: "" },
			original: { timestamp: "1:1", value: 0 },
			uuids: null,
			pages: pages.map((page, i) => ({ id: page.id, idx: { timestamp: "1:1", value: String.fromCharCode(97 + i) }, ...(page.modifed ? { modifed: page.modifed } : {}) })),
		},
		...extra,
	} as unknown as Content;
}

function api(entries: Entry[], contents: Record<string, Content>, pageHashes: Record<string, Record<string, string>>, root = "root-2"): SyncApi & { getContent: ReturnType<typeof vi.fn> } {
	return {
		listItems: vi.fn().mockResolvedValue(entries),
		getContent: vi.fn(async (id: string) => contents[id]),
		getPdf: vi.fn(),
		raw: {
			getRootHash: vi.fn().mockResolvedValue([root, 1]),
			getEntries: vi.fn(async (fileName: string) => {
				const docId = fileName.replace(/\.docSchema$/, "");
				return { entries: Object.entries(pageHashes[docId] ?? {}).map(([pageId, hash]) => ({ id: `${docId}/${pageId}.rm`, hash, type: 0 as const, subfiles: 0, size: 0 })) };
			}),
			getHash: vi.fn().mockResolvedValue(PAGE_BYTES),
		},
	} as unknown as SyncApi & { getContent: ReturnType<typeof vi.fn> };
}

function noteStore(): NoteStore & { files: Record<string, string> } {
	const files: Record<string, string> = {};
	return {
		files,
		read: async (path) => files[path] ?? null,
		exists: async (path) => path in files,
		write: async (path, text) => void (files[path] = text),
		move: async () => {},
		ensureFolder: async () => {},
	};
}

const attachments = (): AttachmentStore => ({ ensureFolder: vi.fn().mockResolvedValue(undefined), writeBinary: vi.fn().mockResolvedValue(undefined) });

/** Reads every page it is given as "ink <n>", n counting calls, so a second read of a page shows. */
function reader(): OcrBackend & { calls: number } {
	const backend = {
		id: "vision",
		metered: false,
		fingerprint: "test",
		calls: 0,
		recognize: vi.fn(async (pages: unknown[]): Promise<OcrResult> => {
			backend.calls++;
			return { status: "ok", pages: pages.map(() => ({ status: "ok" as const, text: `ink ${backend.calls}` })), text: "", confidence: null };
		}),
	};
	return backend;
}

/** A hook that records what it was handed and, when asked, reads the pages through the closures. */
function hook(options: { due?: string[]; read?: boolean } = {}) {
	const docs: IntelligenceDocument[] = [];
	const texts: Map<string, string>[] = [];
	const renders: string[] = [];
	const completed = vi.fn((state: IntelligenceState) => void (state.scans.work = "enabled-1"));
	const before = vi.fn(async () => {});
	const value: IntelligenceHook = {
		fingerprint: "modes-1",
		scansDue: () => options.due ?? [],
		process: async (doc, state) => {
			docs.push(doc);
			if (options.read) {
				texts.push(await doc.transcribe(doc.pages.map((page) => page.id)));
				renders.push(await doc.writeRender(doc.pages[0].id));
			}
			state.seenPages[`${doc.docId}:x:work`] = { scope: "notebook", pageHash: "h", firstSeen: null };
			return { ...emptyReport(), notesWritten: 1, failures: ["page 1: slow"] };
		},
		completeScans: completed,
		beforeRun: before,
	};
	return { value, docs, texts, renders, completed, before };
}

function deps(a: SyncApi, overrides: Record<string, unknown> = {}) {
	return {
		api: a,
		tagRouter: new TagRouter({ work: "Work" }),
		noteStore: noteStore(),
		attachmentStore: attachments(),
		ocrBackend: reader(),
		now: () => NOW,
		...overrides,
	};
}

const settled = (rows: SyncIndex["rows"] = {}): SyncIndex => ({ rootHash: "root-1", mappings: mappingFingerprint({ work: "Work" }), rows, intelligenceMappings: "modes-1" });

describe("runSync > Intelligence Engine seam", () => {
	it("hands a handwritten notebook's pages, stamps and units to the engine, and reports what it did", async () => {
		const c = content([{ id: "p1", modifed: "1759000000000" }, { id: "p2" }], { pageTags: [{ name: "work", pageId: "p2", timestamp: 0 }, { name: "home", pageId: "p1", timestamp: 0 }] } as Partial<Content>);
		const a = api([entry()], { "doc-1": c }, { "doc-1": { p1: "h1", p2: "h2" } });
		const h = hook();
		const router = new TagRouter({ work: "Work", home: "Home" });
		const result = await runSync({ ...deps(a), tagRouter: router, intelligence: h.value, modesFingerprint: "modes-1" }, EMPTY_SYNC_INDEX);

		expect(h.docs).toHaveLength(1);
		expect(h.before).toHaveBeenCalledTimes(1);
		expect(h.docs[0]).toMatchObject({
			docId: "doc-1",
			name: "Work log",
			legacy: false,
			pages: [
				{ id: "p1", ordinal: 1, hash: "h1", modified: 1759000000000 },
				{ id: "p2", ordinal: 2, hash: "h2", modified: null },
			],
			// The page tag "work" duplicates the notebook tag: one unit, not two notes of one page.
			units: [
				{ tag: "work", scope: "notebook", pageIds: ["p1", "p2"] },
				{ tag: "home", scope: "page", pageIds: ["p1"] },
			],
		});
		expect(result.intelligence).toMatchObject({ notesWritten: 1, failures: ["page 1: slow"] });
		expect(result.skipErrors).toContain("page 1: slow");
		expect(result.index).toMatchObject({ intelligenceMappings: "modes-1", seenPages: { "doc-1:x:work": { pageHash: "h" } }, intelligenceRows: {} });
	});

	it("reports the engine's progress as its own phase, with the notebook's name", async () => {
		const a = api([entry()], { "doc-1": content([{ id: "p1" }]) }, { "doc-1": { p1: "h1" } });
		const h = hook();
		const progress: unknown[] = [];
		await runSync({ ...deps(a), intelligence: h.value, onProgress: (p) => void progress.push(p) }, EMPTY_SYNC_INDEX);
		h.docs[0].onProgress!(1, 2);
		expect(progress.at(-1)).toEqual({ phase: "extracting", done: 1, total: 2, document: "Work log" });
	});

	it("gives the engine a page-tag note's frontmatter keys for a page note, and none with the feature off", async () => {
		const a = api([entry()], { "doc-1": content([{ id: "p1" }, { id: "p2" }]) }, { "doc-1": { p1: "h1", p2: "h2" } });
		const on = hook();
		await runSync({ ...deps(a), intelligence: on.value, frontmatter: true }, EMPTY_SYNC_INDEX);
		expect(on.docs[0].frontmatter!("work", "p2")).toMatchObject({ version: 2, fields: { page: 2, pages: 1, uuid: "doc-1", tags: expect.arrayContaining(["remarkable/work"]) } });
		const off = hook();
		await runSync({ ...deps(a), intelligence: off.value }, EMPTY_SYNC_INDEX);
		expect(off.docs[0].frontmatter!("work", "p2")).toBeNull();
	});

	it("gives the engine the page text the transcript note already read, and reads only what is missing", async () => {
		const a = api([entry()], { "doc-1": content([{ id: "p1" }, { id: "p2" }]) }, { "doc-1": { p1: "h1", p2: "h2" } });
		const ocr = reader();
		// Transcript off for "work": the engine is the only reader, so it reads both pages in one call.
		const off = new TagRouter({ work: "Work" }, () => ({ transcript: false, intelligence: true }));
		const h = hook({ read: true });
		await runSync({ ...deps(a), ocrBackend: ocr, tagRouter: off, intelligence: h.value }, EMPTY_SYNC_INDEX);
		expect(ocr.calls).toBe(1);
		expect([...h.texts[0]]).toEqual([
			["p1", "ink 1"],
			["p2", "ink 1"],
		]);
		expect(h.renders).toEqual(["tagged-sync/attachments/doc-1-p1.pdf"]);

		// Transcript on: the note's own read is shared, so the engine costs no second call.
		const shared = reader();
		const h2 = hook({ read: true });
		await runSync({ ...deps(a), ocrBackend: shared, intelligence: h2.value }, EMPTY_SYNC_INDEX);
		expect(shared.calls).toBe(1);
		expect([...h2.texts[0].values()]).toEqual(["ink 1", "ink 1"]);
	});

	it("reads a typed page from its text layer, never through OCR", async () => {
		const a = api([entry()], { "doc-1": content([{ id: "p1" }]) }, { "doc-1": { p1: "h1" } });
		const ocr = reader();
		vi.mocked(isDocumentText).mockReturnValue(true);
		const off = new TagRouter({ work: "Work" }, () => ({ transcript: false, intelligence: true }));
		const h = hook({ read: true });
		await runSync({ ...deps(a), ocrBackend: ocr, tagRouter: off, intelligence: h.value }, EMPTY_SYNC_INDEX);
		vi.mocked(isDocumentText).mockReset();
		expect(ocr.calls).toBe(0);
		expect(h.texts[0].has("p1")).toBe(true);
	});

	it("keeps an empty page's empty text but leaves out a page the backend failed on", async () => {
		const a = api([entry()], { "doc-1": content([{ id: "p1" }, { id: "p2" }]) }, { "doc-1": { p1: "h1", p2: "h2" } });
		const mixed: OcrBackend = {
			id: "vision",
			metered: false,
			fingerprint: "t",
			recognize: vi.fn(async (): Promise<OcrResult> => ({ status: "ok", pages: [{ status: "skipped", text: "" }, { status: "failed", text: "" }], text: "", confidence: null })),
		};
		const off = new TagRouter({ work: "Work" }, () => ({ transcript: false, intelligence: true }));
		const h = hook({ read: true });
		await runSync({ ...deps(a), ocrBackend: mixed, tagRouter: off, intelligence: h.value }, EMPTY_SYNC_INDEX);
		expect([...h.texts[0]]).toEqual([["p1", ""]]);
	});

	it("leaves a page the backend could not read out of the engine's texts", async () => {
		const a = api([entry()], { "doc-1": content([{ id: "p1" }]) }, { "doc-1": { p1: "h1" } });
		const failing: OcrBackend = { id: "vision", metered: false, fingerprint: "t", recognize: vi.fn().mockRejectedValue(new Error("down")) };
		const off = new TagRouter({ work: "Work" }, () => ({ transcript: false, intelligence: true }));
		const h = hook({ read: true });
		await runSync({ ...deps(a), ocrBackend: failing, tagRouter: off, intelligence: h.value }, EMPTY_SYNC_INDEX);
		expect(h.texts[0].size).toBe(0);
	});

	it("hands over a page-tag-only notebook, a page with no ink file, and a legacy notebook without page stamps", async () => {
		const pageTagged = content([{ id: "p1" }, { id: "p2" }], { pageTags: [{ name: "work", pageId: "p2", timestamp: 0 }] } as Partial<Content>);
		const legacy = { ...content([]), cPages: undefined, pages: ["q1"] } as unknown as Content;
		const a = api([entry({ tags: [] }), entry({ id: "doc-2", hash: "hash-2" })], { "doc-1": pageTagged, "doc-2": legacy }, { "doc-1": { p2: "h2" }, "doc-2": { q1: "hq" } });
		const h = hook();
		// Transcript off, so the page-tag transcript note is not planned and only the engine sees the page.
		const off = new TagRouter({ work: "Work" }, () => ({ transcript: false, intelligence: true }));
		const store = noteStore();
		await runSync({ ...deps(a), noteStore: store, tagRouter: off, intelligence: h.value }, EMPTY_SYNC_INDEX);
		expect(store.files).toEqual({});
		expect(h.docs[0]).toMatchObject({ units: [{ tag: "work", scope: "page", pageIds: ["p2"] }], pages: [{ id: "p1", hash: null }, { id: "p2", hash: "h2" }] });
		expect(h.docs[1]).toMatchObject({ docId: "doc-2", legacy: true });
	});

	it("says a notice the engine gave for two documents once", async () => {
		const a = api([entry(), entry({ id: "doc-2", hash: "hash-2" })], { "doc-1": content([{ id: "p1" }]), "doc-2": content([{ id: "q1" }]) }, { "doc-1": { p1: "h1" }, "doc-2": { q1: "h2" } });
		const h = hook();
		h.value.process = async () => ({ ...emptyReport(), notices: ["The engine is paused."] });
		const result = await runSync({ ...deps(a), intelligence: h.value }, EMPTY_SYNC_INDEX);
		expect(result.intelligence.notices).toEqual(["The engine is paused."]);
	});

	it("stops between a notebook's transcript note and its page notes, leaving the pages for the next run", async () => {
		const a = api([entry()], { "doc-1": content([{ id: "p1" }]) }, { "doc-1": { p1: "h1" } });
		const store = noteStore();
		let stop = false;
		const write = store.write;
		store.write = async (path, text) => {
			stop = true;
			return write(path, text);
		};
		const h = hook();
		const result = await runSync({ ...deps(a), noteStore: store, intelligence: h.value, shouldStop: () => stop }, EMPTY_SYNC_INDEX);
		expect(result.stopped).toBe(true);
		expect(h.docs).toEqual([]);
	});

	it("does not give annotated PDFs or EPUBs to the engine", async () => {
		const pdf = api([entry()], { "doc-1": content([{ id: "p1" }], { fileType: "epub" } as Partial<Content>) }, { "doc-1": { p1: "h1" } });
		const h = hook();
		const result = await runSync({ ...deps(pdf), intelligence: h.value }, EMPTY_SYNC_INDEX);
		expect(result.documentsSkipped + result.notesWritten).toBeGreaterThan(0);
		expect(h.docs).toEqual([]);
	});

	it("opens every document while a switch-on scan is due, and marks the scan done only after the whole run", async () => {
		const a = api([entry()], { "doc-1": content([{ id: "p1" }]) }, { "doc-1": { p1: "h1" } }, "root-1");
		const store = noteStore();
		store.files["Work/Work log.md"] = "note";
		const rows = { "doc-1:work": { syncKey: "doc-1:work", docId: "doc-1", pageId: null, tag: "work", entryHash: "hash-1", pageHash: null, notePath: "Work/Work log.md", folder: "Work", status: "active" as const, syncedAt: NOW, renderVersion: 9999 } };
		const h = hook({ due: ["work"] });
		const result = await runSync({ ...deps(a), noteStore: store, intelligence: h.value }, settled(rows));
		expect(a.getContent).toHaveBeenCalled();
		expect(h.docs).toHaveLength(1);
		expect(h.completed).toHaveBeenCalledTimes(1);
		expect(result.index.intelligenceScans).toEqual({ work: "enabled-1" });
	});

	it("keeps the previous modes print and scans when a run is stopped, but keeps what the engine recorded", async () => {
		const a = api([entry(), entry({ id: "doc-2", hash: "hash-2" })], { "doc-1": content([{ id: "p1" }]), "doc-2": content([{ id: "q1" }]) }, { "doc-1": { p1: "h1" }, "doc-2": { q1: "h2" } });
		let stop = false;
		const h = hook({ due: ["work"] });
		const process = h.value.process;
		h.value.process = async (doc, state) => {
			stop = true;
			return process(doc, state);
		};
		const previous: SyncIndex = { ...EMPTY_SYNC_INDEX, intelligenceMappings: "modes-0", intelligenceScans: { work: "old" } };
		const result = await runSync({ ...deps(a), intelligence: h.value, modesFingerprint: "modes-1", shouldStop: () => stop }, previous);
		expect(result.stopped).toBe(true);
		expect(result.index).toMatchObject({ intelligenceMappings: "modes-0", intelligenceScans: { work: "old" }, seenPages: { "doc-1:x:work": { pageHash: "h" } } });
		expect(h.completed).not.toHaveBeenCalled();
	});

	it("sweeps the engine's rows and seen entries of a document gone from the tablet", async () => {
		const a = api([], {}, {}, "root-2");
		const previous: SyncIndex = {
			...EMPTY_SYNC_INDEX,
			seenPages: { "doc-9:p1:work": { scope: "notebook", pageHash: "h", firstSeen: null } },
			intelligenceRows: { "doc-9:p1:work": { syncKey: "doc-9:p1:work", unitKey: "doc-9:p1:work", docId: "doc-9", pageId: "p1", tag: "work", scope: "notebook", notePath: "n", folder: "Work", status: "active", noteId: "x", profileId: "generic", baseHash: "", syncedAt: NOW } },
		};
		const result = await runSync(deps(a), previous);
		expect(result.index.seenPages).toEqual({});
		expect(result.index.intelligenceRows!["doc-9:p1:work"].status).toBe("orphaned");
	});
});

describe("runSync > transcript notes switched off", () => {
	const off = () => new TagRouter({ work: "Work" }, () => ({ transcript: false, intelligence: false }));

	it("writes no transcript note, orphans nothing, and keeps the row's entry hash so switching back on re-reads the notebook", async () => {
		const a = api([entry({ hash: "hash-2" })], { "doc-1": content([{ id: "p1" }]) }, { "doc-1": { p1: "h1" } });
		const store = noteStore();
		const rows = { "doc-1:work": { syncKey: "doc-1:work", docId: "doc-1", pageId: null, tag: "work", entryHash: "hash-1", pageHash: null, notePath: "Work/Work log.md", folder: "Work", status: "active" as const, syncedAt: NOW, renderVersion: 9999 } };
		const result = await runSync({ ...deps(a), noteStore: store, tagRouter: off() }, { ...settled(rows), rootHash: "root-0" });
		expect(result.notesWritten).toBe(0);
		expect(store.files).toEqual({});
		expect(result.index.rows["doc-1:work"]).toMatchObject({ status: "active", entryHash: "hash-1" });
	});

	it("does not open anything for a switched-off note the user deleted", async () => {
		const a = api([entry()], {}, {}, "root-1");
		const rows = { "doc-1:work": { syncKey: "doc-1:work", docId: "doc-1", pageId: null, tag: "work", entryHash: "hash-1", pageHash: null, notePath: "Work/gone.md", folder: "Work", status: "active" as const, syncedAt: NOW, renderVersion: 9999 } };
		const previous = { ...settled(rows), intelligenceMappings: EMPTY_INTELLIGENCE_FINGERPRINT };
		const result = await runSync({ ...deps(a), tagRouter: off() }, previous);
		expect(result.index).toBe(previous);
	});

	it("opens the level-1 gate when only the modes changed", async () => {
		const a = api([entry()], { "doc-1": content([{ id: "p1" }]) }, { "doc-1": { p1: "h1" } }, "root-1");
		const result = await runSync({ ...deps(a), modesFingerprint: "modes-2" }, settled());
		expect(result.documentIds).toEqual(["doc-1"]);
		expect(result.index.intelligenceMappings).toBe("modes-2");
	});
});
