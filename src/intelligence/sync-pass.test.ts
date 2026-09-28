import { describe, expect, it } from "vitest";
import type { NoteStore } from "../note-builder";
import { createBaseStore, type BaseFiles } from "./base-store";
import type { ExtractionBackend } from "./extraction-backend";
import { parseExtraction } from "./extraction";
import { defaultSlots, emptyIntelligence, setIntelligenceMode, type IntelligenceSettings } from "./settings";
import { completeScans, type DocPage, followRetargets, type IntelligenceDocument, type IntelligencePassDeps, type IntelligenceState, processDocument, sweepDeletedDocuments } from "./sync-pass";

const ENABLED = new Date("2026-09-28T08:00:00.000Z");
const BEFORE = ENABLED.getTime() - 86_400_000;
const AFTER = ENABLED.getTime() + 3_600_000;
const MAP = { work: "Work" };

function memory() {
	const notes = new Map<string, string>();
	const bases = new Map<string, string>();
	const noteStore: NoteStore = {
		read: async (path) => notes.get(path) ?? null,
		exists: async (path) => notes.has(path),
		write: async (path, content) => void notes.set(path, content),
		ensureFolder: async () => {},
		move: async () => {},
	};
	const files: BaseFiles = { read: async (p) => bases.get(p) ?? null, write: async (p, c) => void bases.set(p, c), remove: async (p) => void bases.delete(p) };
	return { notes, bases, noteStore, baseStore: createBaseStore(files, "plugin") };
}

/** Answers from the transcript: every "todo X" line is a task. */
const reader = (calls: string[] = []): ExtractionBackend => ({
	id: "fake",
	metered: false,
	async extract(input) {
		calls.push(input.transcript);
		if (input.transcript.includes("FAIL")) return { kind: "failed", reason: "model down" };
		const tasks = [...input.transcript.matchAll(/todo (\w+)/g)].map((m) => {
			const known = (input.known.tasks ?? []).find((item) => item.text === m[1]);
			return { source: m[0], reason: "", id: known?.id ?? "new", text: m[1], due: null, done: false };
		});
		return { kind: "ok", result: parseExtraction({ page_date_text: null, tasks, summary: "" }, input.slots, input.referenceDate)! };
	},
});

function settings(on = true): IntelligenceSettings {
	const base = { ...emptyIntelligence(), slots: defaultSlots().map((slot) => (slot.id === "tasks" ? { ...slot, review: false } : slot)) };
	return on ? setIntelligenceMode(base, "work", true, ENABLED) : base;
}

function deps(mem: ReturnType<typeof memory>, overrides: Partial<IntelligencePassDeps> = {}): IntelligencePassDeps {
	let n = 0;
	return {
		settings: settings(),
		tagFolderMap: MAP,
		effectiveSlots: (_profile, slots) => slots,
		pro: false,
		noteStore: mem.noteStore,
		baseStore: mem.baseStore,
		backend: reader(),
		loadTemplate: async () => null,
		createNote: async (path, content) => void mem.notes.set(path, content),
		now: () => new Date(2026, 8, 29, 12),
		newId: () => `i${++n}`,
		newNoteId: () => `note${++n}`,
		formatDate: () => "D",
		formatTime: () => "T",
		reviewLink: "obsidian://review",
		...overrides,
	};
}

const page = (id: string, ordinal: number, hash: string | null, modified: number | null): DocPage => ({ id, ordinal, hash, modified });

function doc(pages: DocPage[], texts: Record<string, string>, extra: Partial<IntelligenceDocument> = {}): IntelligenceDocument {
	return {
		docId: "d1",
		name: "Work log",
		legacy: false,
		pages,
		units: [{ tag: "work", scope: "notebook", pageIds: pages.map((p) => p.id) }],
		transcribe: async (ids) => new Map(ids.filter((id) => texts[id] !== undefined).map((id) => [id, texts[id]])),
		writeRender: async (id) => `attachments/d1-${id}.pdf`,
		...extra,
	};
}

const fresh = (): IntelligenceState => ({ seenPages: {}, rows: {}, scans: {} });

describe("processDocument > switching Intelligence Mode on", () => {
	it("stamps the pages written before the toggle and turns the one written after it into a note", async () => {
		const mem = memory();
		const state = fresh();
		const report = await processDocument(deps(mem), doc([page("p1", 1, "h1", BEFORE), page("p2", 2, "h2", null), page("p3", 3, "h3", AFTER)], { p3: "todo Call" }), state);
		expect(report).toMatchObject({ notesWritten: 1, failures: [], notices: [] });
		expect(Object.keys(state.seenPages)).toEqual(["d1:p1:work", "d1:p2:work", "d1:p3:work"]);
		expect(state.seenPages["d1:p1:work"]).toEqual({ scope: "notebook", pageHash: "h1", firstSeen: BEFORE });
		const path = "Work/Work log/2026-09-28 Work log p3.md";
		expect(mem.notes.get(path)).toContain("## Tasks\n- [ ] Call\n");
		expect(mem.notes.get(path)).toContain("[[attachments/d1-p3.pdf|Page 3]]");
		expect(state.rows["d1:p3:work"]).toMatchObject({ notePath: path, folder: "Work", status: "active", noteId: "note1", profileId: "generic", scope: "notebook" });
		expect(state.seenPages["d1:p3:work"]).toEqual({ scope: "notebook", pageHash: "h3", firstSeen: AFTER, noteId: "note1" });
		expect(mem.bases.has("plugin/base/note1.json")).toBe(true);
	});

	it("says which page it is on before each extraction", async () => {
		const seen: string[] = [];
		await processDocument(deps(memory()), doc([page("p1", 1, "h1", AFTER), page("p2", 2, "h2", AFTER)], { p1: "todo A", p2: "todo B" }, { onProgress: (done, total) => void seen.push(`${done}/${total}`) }), fresh());
		expect(seen).toEqual(["1/2", "2/2"]);
	});

	it("skips a page never drawn on, so its first ink counts as new", async () => {
		const state = fresh();
		await processDocument(deps(memory()), doc([page("p1", 1, null, AFTER)], {}), state);
		expect(state.seenPages).toEqual({});
	});
});

describe("processDocument > after the scan", () => {
	async function synced() {
		const mem = memory();
		const state = fresh();
		const calls: string[] = [];
		const d = deps(mem, { backend: reader(calls) });
		await processDocument(d, doc([page("p1", 1, "h1", BEFORE), page("p3", 3, "h3", AFTER)], { p3: "todo Call" }), state);
		completeScans(d.settings, MAP, ["work"], state);
		return { mem, state, d, calls };
	}

	it("does nothing for pages whose ink did not change", async () => {
		const { mem, state, d, calls } = await synced();
		const report = await processDocument(d, doc([page("p1", 1, "h1", BEFORE), page("p3", 3, "h3", AFTER)], { p3: "todo Call" }), state);
		expect(report).toMatchObject({ notesWritten: 0, notesUpdated: 0 });
		expect(calls).toHaveLength(1);
		expect(mem.notes.size).toBe(1);
	});

	it("merges a changed page into its note, keeping the user's own lines", async () => {
		const { mem, state, d } = await synced();
		const path = state.rows["d1:p3:work"].notePath;
		mem.notes.set(path, mem.notes.get(path)!.replace("- [ ] Call\n", "- [ ] Call\n- [ ] Mine\n"));
		const report = await processDocument(d, doc([page("p1", 1, "h1", BEFORE), page("p3", 3, "h3b", AFTER + 1)], { p3: "todo Call todo Email" }), state);
		expect(report.notesUpdated).toBe(1);
		expect(mem.notes.get(path)).toContain("- [ ] Call\n- [ ] Mine\n- [ ] Email\n");
		expect(state.seenPages["d1:p3:work"].pageHash).toBe("h3b");
	});

	it("counts the notes that hold proposals", async () => {
		const mem = memory();
		const state = fresh();
		const review = { ...settings(), slots: defaultSlots() };
		const d = deps(mem, { settings: review });
		await processDocument(d, doc([page("p3", 3, "h3", AFTER)], { p3: "todo Call" }), state);
		completeScans(review, MAP, ["work"], state);
		const report = await processDocument(d, doc([page("p3", 3, "h3b", AFTER + 1)], { p3: "todo Call todo Email todo Fax" }), state);
		expect(report).toMatchObject({ proposals: 2, proposalNotes: 1 });
	});

	it("brings an old page in once the user writes on it", async () => {
		const { mem, state, d } = await synced();
		const report = await processDocument(d, doc([page("p1", 1, "h1b", AFTER + 5), page("p3", 3, "h3", AFTER)], { p1: "todo Plan" }), state);
		expect(report.notesWritten).toBe(1);
		expect([...mem.notes.keys()]).toContain("Work/Work log/2026-09-27 Work log p1.md");
	});

	it("records an unseen page written before the toggle as old without a note -- a notebook tagged later", async () => {
		const mem = memory();
		const state: IntelligenceState = { seenPages: {}, rows: {}, scans: { work: ENABLED.toISOString() } };
		const report = await processDocument(deps(mem), doc([page("p9", 9, "h9", BEFORE)], { p9: "todo Old" }), state);
		expect(report.notesWritten).toBe(0);
		expect(state.seenPages["d1:p9:work"]).toEqual({ scope: "notebook", pageHash: "h9", firstSeen: BEFORE });
	});

	it("names a legacy notebook once, when its pages are first recorded", async () => {
		const state: IntelligenceState = { seenPages: {}, rows: {}, scans: { work: ENABLED.toISOString() } };
		const legacy = doc([page("p1", 1, "h1", null)], {}, { legacy: true });
		expect((await processDocument(deps(memory()), legacy, state)).notices).toEqual([expect.stringContaining('"Work log" was written before the tablet stamped page dates')]);
		expect((await processDocument(deps(memory()), legacy, state)).notices).toEqual([]);
	});
});

describe("processDocument > failures", () => {
	it("keeps a failed page out of the seen hash so it retries, and says so on the third failure", async () => {
		const mem = memory();
		const state = fresh();
		const d = deps(mem);
		const failing = doc([page("p3", 3, "h3", AFTER)], { p3: "FAIL todo Call" });
		const first = await processDocument(d, failing, state);
		expect(first.failures).toEqual(['page 3 of "Work log": model down']);
		expect(state.seenPages["d1:p3:work"]).toEqual({ scope: "notebook", pageHash: null, firstSeen: AFTER, noteId: "note1" });
		expect(mem.notes.size).toBe(0);
		expect((await processDocument(d, failing, state)).notices).toEqual([]);
		expect((await processDocument(d, failing, state)).notices).toEqual([expect.stringContaining("could not be extracted 3 times: model down")]);
		expect(state.seenPages["d1:p3:work"].noteId).toBe("note1");
	});

	it("reports a page the transcription could not read", async () => {
		const report = await processDocument(deps(memory()), doc([page("p3", 3, "h3", AFTER)], {}), fresh());
		expect(report.failures).toEqual(['page 3 of "Work log": the page could not be read']);
	});
});

describe("processDocument > rows", () => {
	async function withNote() {
		const mem = memory();
		const state = fresh();
		const d = deps(mem);
		await processDocument(d, doc([page("p3", 3, "h3", AFTER)], { p3: "todo Call" }), state);
		completeScans(d.settings, MAP, ["work"], state);
		return { mem, state, d };
	}

	it("orphans a row whose tag left the page on the tablet and leaves its note", async () => {
		const { mem, state, d } = await withNote();
		await processDocument(d, doc([page("p3", 3, "h3", AFTER)], {}, { units: [] }), state);
		expect(state.rows["d1:p3:work"].status).toBe("orphaned");
		expect(mem.notes.size).toBe(1);
	});

	it("leaves rows alone while Intelligence Mode is off", async () => {
		const { mem, state, d } = await withNote();
		const off = setIntelligenceMode(d.settings, "work", false, ENABLED);
		const report = await processDocument({ ...d, settings: off }, doc([page("p3", 3, "h3b", AFTER + 9)], { p3: "todo Other" }), state);
		expect(report.notesUpdated).toBe(0);
		expect(state.rows["d1:p3:work"].status).toBe("active");
		expect(mem.notes.get(state.rows["d1:p3:work"].notePath)).not.toContain("Other");
	});

	it("starts a deleted note over with a fresh id and no old base once the page changes", async () => {
		const { mem, state, d } = await withNote();
		const oldPath = state.rows["d1:p3:work"].notePath;
		mem.notes.delete(oldPath);
		await processDocument(d, doc([page("p3", 3, "h3b", AFTER + 9)], { p3: "todo Again" }), state);
		expect(state.rows["d1:p3:work"]).toMatchObject({ noteId: "note3", status: "active", notePath: oldPath });
		expect(mem.bases.has("plugin/base/note1.json")).toBe(false);
		expect(mem.notes.get(oldPath)).toContain("- [ ] Again");
	});

	it("rebuilds a missing base from the note, so a line typed there is not lost", async () => {
		const { mem, state, d } = await withNote();
		const path = state.rows["d1:p3:work"].notePath;
		mem.notes.set(path, mem.notes.get(path)!.replace("- [ ] Call\n", "- [ ] Call\n- [ ] Mine\n"));
		mem.bases.clear();
		await processDocument(d, doc([page("p3", 3, "h3b", AFTER + 9)], { p3: "todo Call" }), state);
		expect(mem.notes.get(path)).toContain("- [ ] Call\n- [ ] Mine\n");
	});

	it("rebuilds a Slot the template does not place from the heading it was given", async () => {
		const mem = memory();
		const state = fresh();
		const d = deps(mem, { loadTemplate: async () => "## Tasks\n{{ts.tasks}}\n", settings: { ...settings(), profiles: [{ id: "p", name: "P", description: "", template: "T.md", slots: ["tasks", "summary"] }], mappings: { work: { ...settings().mappings.work, profiles: ["p"] } } } });
		await processDocument(d, doc([page("p3", 3, "h3", AFTER)], { p3: "todo Call" }), state);
		completeScans(d.settings, MAP, ["work"], state);
		const path = state.rows["d1:p3:work"].notePath;
		mem.notes.set(path, mem.notes.get(path)!.replace("## Summary\n", "## Summary\nMy words.\n"));
		mem.bases.clear();
		const report = await processDocument(d, doc([page("p3", 3, "h3b", AFTER + 9)], { p3: "todo Call" }), state);
		expect(report.notices).toEqual([]);
		expect(mem.notes.get(path)).toContain("## Summary\nMy words.");
	});

	it("says which region it could not find", async () => {
		const { mem, state, d } = await withNote();
		const path = state.rows["d1:p3:work"].notePath;
		mem.notes.set(path, mem.notes.get(path)!.replace(/## Summary\n/, ""));
		const report = await processDocument(d, doc([page("p3", 3, "h3b", AFTER + 9)], { p3: "todo Call" }), state);
		expect(report.notices).toEqual([`"${path}": the heading for summary is gone, so it was not updated.`]);
	});
});

describe("processDocument > a mapped tag renamed on the tablet", () => {
	it("moves the row and seen entry to the new tag, keeps the note and its id, and takes the new mapping's folder", async () => {
		const mem = memory();
		const state = fresh();
		const map = { work: "Work", job: "Job" };
		const s = setIntelligenceMode(settings(), "job", true, ENABLED);
		const d = deps(mem, { tagFolderMap: map, settings: s });
		await processDocument(d, doc([page("p3", 3, "h3", AFTER)], { p3: "todo Call" }), state);
		completeScans(s, map, ["work", "job"], state);
		const path = state.rows["d1:p3:work"].notePath;
		const renamed = doc([page("p3", 3, "h3b", AFTER + 9)], { p3: "todo Call todo Pay" }, { units: [{ tag: "job", scope: "notebook", pageIds: ["p3"] }] });
		await processDocument(d, renamed, state);
		expect(Object.keys(state.rows)).toEqual(["d1:p3:job"]);
		expect(state.rows["d1:p3:job"]).toMatchObject({ tag: "job", folder: "Job", notePath: path, noteId: "note1", status: "active" });
		expect(Object.keys(state.seenPages)).toEqual(["d1:p3:job"]);
		expect(mem.notes.get(path)).toContain("- [ ] Pay");
	});

	it("moves a row that lost its seen entry too", async () => {
		const mem = memory();
		const state = fresh();
		const s = setIntelligenceMode(settings(), "job", true, ENABLED);
		const map = { work: "Work", job: "Job" };
		const d = deps(mem, { tagFolderMap: map, settings: s });
		await processDocument(d, doc([page("p3", 3, "h3", AFTER)], { p3: "todo Call" }), state);
		delete state.seenPages["d1:p3:work"];
		completeScans(s, map, ["work", "job"], state);
		await processDocument(d, doc([page("p3", 3, "h3", AFTER)], {}, { units: [{ tag: "job", scope: "notebook", pageIds: ["p3"] }] }), state);
		expect(state.rows["d1:p3:job"]).toMatchObject({ tag: "job", noteId: "note1" });
	});

	it("does not read two new tags as a rename, and moves a seen-only page too", async () => {
		const state: IntelligenceState = { seenPages: { "d1:p1:work": { scope: "notebook", pageHash: "h1", firstSeen: BEFORE } }, rows: {}, scans: { work: ENABLED.toISOString(), job: ENABLED.toISOString() } };
		const s = setIntelligenceMode(settings(), "job", true, ENABLED);
		const d = deps(memory(), { tagFolderMap: { work: "Work", job: "Job", home: "Home" }, settings: s });
		await processDocument(d, doc([page("p1", 1, "h1", BEFORE)], {}, { units: [{ tag: "job", scope: "notebook", pageIds: ["p1"] }] }), state);
		expect(Object.keys(state.seenPages)).toEqual(["d1:p1:job"]);
		const two = doc([page("p1", 1, "h1", BEFORE)], {}, { units: [{ tag: "work", scope: "notebook", pageIds: ["p1"] }, { tag: "home", scope: "notebook", pageIds: ["p1"] }] });
		await processDocument(d, two, state);
		// Not a rename: "job" keeps its entry, "work" is recorded afresh, "home" has page notes off.
		expect(Object.keys(state.seenPages).sort()).toEqual(["d1:p1:job", "d1:p1:work"]);
	});
});

describe("followRetargets", () => {
	const row = (notePath: string, folder: string, status: "active" | "orphaned" = "active") => ({ syncKey: notePath, unitKey: notePath, docId: "d1", pageId: "p", tag: "work", scope: "notebook" as const, notePath, folder, status, noteId: "n", profileId: "generic", baseHash: "", syncedAt: "" });

	it("moves a page note still inside the old folder into the new one, keeping its notebook subfolder, and leaves a sorted-away note", async () => {
		const mem = memory();
		mem.notes.set("Work/Log/p1.md", "x");
		mem.notes.set("Job/Log/p1.md", "someone else's");
		const moves: string[] = [];
		const store = { ...mem.noteStore, move: async (from: string, to: string) => void moves.push(`${from} -> ${to}`) };
		const state: IntelligenceState = {
			seenPages: {},
			scans: {},
			rows: { a: row("Work/Log/p1.md", "Work"), b: row("Elsewhere/p2.md", "Work"), c: row("Work/p3.md", "Work/"), d: row("Work/Log/p4.md", "Work", "orphaned"), e: row("Job/Log/p5.md", "Job") },
		};
		expect(await followRetargets(state, { work: "Job/" }, store)).toBe(2);
		expect(moves).toEqual(["Work/Log/p1.md -> Job/Log/p1 (work).md", "Work/p3.md -> Job/p3.md"]);
		expect(state.rows.a).toMatchObject({ notePath: "Job/Log/p1 (work).md", folder: "Job" });
		expect(state.rows.b.notePath).toBe("Elsewhere/p2.md");
		expect(state.rows.d.notePath).toBe("Work/Log/p4.md");
	});

	it("moves a note to the vault root when the mapping points there, and skips a tag that is no longer mapped", async () => {
		const mem = memory();
		const state: IntelligenceState = { seenPages: {}, scans: {}, rows: { a: row("Work/p1.md", "Work"), b: { ...row("Work/p2.md", "Work"), tag: "gone" } } };
		expect(await followRetargets(state, { work: "" }, mem.noteStore)).toBe(1);
		expect(state.rows.a.notePath).toBe("p1.md");
		expect(state.rows.b.notePath).toBe("Work/p2.md");
	});
});

describe("processDocument > frontmatter (Pro)", () => {
	const fields = { tags: ["remarkable/work"], modified: null, folder: null, type: "notebook" as const, pages: 1, page: 3, pinned: false, uuid: "d1" };

	it("writes the plugin's keys into a new page note and into every later write, keeping the user's own tags", async () => {
		const mem = memory();
		const state = fresh();
		const d = deps(mem);
		const withKeys = (text: Record<string, string>, extra: Partial<IntelligenceDocument> = {}) => doc([page("p3", 3, extra.pages?.[0].hash ?? "h3", AFTER)], text, { frontmatter: () => ({ fields, version: 2 }), ...extra });
		await processDocument(d, withKeys({ p3: "todo Call" }), state);
		const path = state.rows["d1:p3:work"].notePath;
		expect(mem.notes.get(path)).toMatch(/^---\n[\s\S]*\n---\n## Tasks/);
		expect(mem.notes.get(path)).toContain("remarkable-note-id: note1");
		expect(mem.notes.get(path)).toContain("remarkable-page: 3");
		expect(state.rows["d1:p3:work"]).toMatchObject({ frontmatterTags: ["remarkable/work"], frontmatterVersion: 2 });

		completeScans(d.settings, MAP, ["work"], state);
		mem.notes.set(path, mem.notes.get(path)!.replace("tags:\n  - remarkable/work", "tags:\n  - remarkable/work\n  - mine"));
		await processDocument(d, withKeys({ p3: "todo Call todo Pay" }, { pages: [page("p3", 3, "h3b", AFTER + 1)] }), state);
		expect(mem.notes.get(path)).toContain("  - mine");
		expect(mem.notes.get(path)).toContain("- [ ] Pay");
	});

	it("writes no keys with the feature off", async () => {
		const mem = memory();
		const state = fresh();
		await processDocument(deps(mem), doc([page("p3", 3, "h3", AFTER)], { p3: "todo Call" }, { frontmatter: () => null }), state);
		expect([...mem.notes.values()][0].startsWith("## Tasks")).toBe(true);
		expect(state.rows["d1:p3:work"].frontmatterTags).toBeUndefined();
	});
});

describe("processDocument > Profiles and templates", () => {
	it("uses the mapping's Profile and its template, and falls back to the starter when the template is gone", async () => {
		const mem = memory();
		const s = settings();
		const withProfile: IntelligenceSettings = {
			...s,
			mappings: { work: { ...s.mappings.work, profiles: ["journal"] } },
			profiles: [{ id: "journal", name: "Journal", description: "Diary", template: "T/Journal.md", slots: ["tasks"] }],
		};
		const state = fresh();
		await processDocument(deps(mem, { settings: withProfile, loadTemplate: async () => "# Journal\n## Tasks\n{{ts.tasks}}\n" }), doc([page("p3", 3, "h3", AFTER)], { p3: "todo Call" }), state);
		expect(state.rows["d1:p3:work"].profileId).toBe("journal");
		expect([...mem.notes.values()][0]).toBe("# Journal\n## Tasks\n- [ ] Call\n");

		const mem2 = memory();
		await processDocument(deps(mem2, { settings: withProfile }), doc([page("p3", 3, "h3", AFTER)], { p3: "todo Call" }), fresh());
		expect([...mem2.notes.values()][0]).toBe("## Tasks\n- [ ] Call\n\n## Page\n[[attachments/d1-p3.pdf|Page 3]]\n");
	});
});

describe("completeScans and sweepDeletedDocuments", () => {
	it("marks scans done only for the given tags that are on, and orphans rows and prunes seen entries of deleted documents", () => {
		const state: IntelligenceState = {
			seenPages: { "d1:p1:work": { scope: "notebook", pageHash: "h", firstSeen: null }, "d2:p1:work": { scope: "notebook", pageHash: "h", firstSeen: null } },
			rows: {
				"d2:p1:work": { syncKey: "d2:p1:work", unitKey: "d2:p1:work", docId: "d2", pageId: "p1", tag: "work", scope: "notebook", notePath: "n", folder: "Work", status: "active", noteId: "x", profileId: "generic", baseHash: "", syncedAt: "" },
				"d3:p1:work": { syncKey: "d3:p1:work", unitKey: "d3:p1:work", docId: "d3", pageId: "p1", tag: "work", scope: "notebook", notePath: "m", folder: "Work", status: "orphaned", noteId: "y", profileId: "generic", baseHash: "", syncedAt: "" },
			},
			scans: {},
		};
		completeScans(settings(), { work: "Work", home: "Home" }, ["work", "home"], state);
		expect(state.scans).toEqual({ work: ENABLED.toISOString() });
		completeScans(settings(), { work: "Work" }, [], state);
		sweepDeletedDocuments(state, new Set(["d1"]));
		expect(Object.keys(state.seenPages)).toEqual(["d1:p1:work"]);
		expect(state.rows["d2:p1:work"].status).toBe("orphaned");
		expect(state.rows["d3:p1:work"].status).toBe("orphaned");
	});
});
