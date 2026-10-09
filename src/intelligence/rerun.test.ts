import { describe, expect, it } from "vitest";
import type { NoteStore } from "../note-builder";
import type { SyncIndex } from "../sync-engine";
import { parseExtraction } from "./extraction";
import { registerExtractionBackend } from "./extraction-registry";
import { type HostEnvironment, prepareRun } from "./host";
import { isPageNote, markAllForReextract, markForRereading, markNoteForReextract, pageProfile, reextractableKeys, rerunExtraction } from "./rerun";
import { emptyIntelligence, setIntelligenceMode, type IntelligenceSettings } from "./settings";
import type { IntelligenceState } from "./sync-pass";

// Answers with one task per "todo X" in the page text, or fails on "FAIL".
registerExtractionBackend({
	id: "rerunfake",
	label: "Rerun fake",
	metered: false,
	requiresLicence: false,
	measured: false,
	create: () => ({
		id: "rerunfake",
		metered: false,
		extract: async (input) => {
			if (input.transcript.includes("FAIL")) return { kind: "failed", reason: "model down" };
			const tasks = [...input.transcript.matchAll(/todo (\w+)/g)].map((m) => ({ source: m[0], reason: "", id: (input.known.tasks ?? []).find((k) => k.text === m[1])?.id ?? "new", text: m[1], due: null, done: false }));
			return { kind: "ok", result: parseExtraction({ tasks, summary: "" }, input.slots, input.referenceDate)! };
		},
	}),
});

function env(): HostEnvironment & { notes: Map<string, string>; files: HostEnvironment["files"] & { data: Map<string, string> } } {
	const notes = new Map<string, string>();
	const data = new Map<string, string>([["plugin/device-id", "me"]]);
	let n = 0;
	const noteStore: NoteStore = { read: async (p) => notes.get(p) ?? null, exists: async (p) => notes.has(p), write: async (p, c) => void notes.set(p, c), ensureFolder: async () => {}, move: async () => {} };
	return {
		notes,
		pluginDir: "plugin",
		files: { data, read: async (p) => data.get(p) ?? null, write: async (p, c) => void data.set(p, c), remove: async (p) => void data.delete(p), mkdir: async () => {} },
		noteStore,
		readVaultNote: async () => null,
		createNote: async (p, c) => void notes.set(p, c),
		configDir: ".obsidian",
		formatNow: () => "",
		randomId: () => `id-${++n}-xxxxxxxx`,
		now: () => new Date("2026-09-29T10:00:00.000Z"),
	};
}

const ENABLED = new Date("2026-09-01T00:00:00.000Z");
const settings = (): IntelligenceSettings => {
	const s = { ...setIntelligenceMode(emptyIntelligence(), "work", true, ENABLED), backend: "rerunfake", engineDeviceId: "me" };
	return { ...s, slots: s.slots.map((slot) => (slot.id === "tasks" ? { ...slot, review: false } : slot)) };
};
const run = (s = settings()) => ({ settings: s, tagFolderMap: { work: "Work" }, pro: true, transcriptionBackend: "vision", providerSettings: {}, background: false });

/** One insight note written by a sync, and the index it left. */
async function synced(e: ReturnType<typeof env>, text = "todo Call"): Promise<{ index: SyncIndex; path: string }> {
	const prepared = await prepareRun(e, run());
	const state: IntelligenceState = { seenPages: {}, rows: {}, scans: { work: ENABLED.toISOString() } };
	await prepared.hook!.process(
		{ docId: "d", name: "Log", legacy: false, pages: [{ id: "p1", ordinal: 1, hash: "h1", modified: Date.parse("2026-09-02T00:00:00.000Z") }], units: [{ tag: "work", scope: "notebook", pageIds: ["p1"] }], transcribe: async () => new Map([["p1", text]]), writeRender: async () => "a/d-p1.pdf" },
		state,
	);
	return { index: { rootHash: null, rows: {}, seenPages: state.seenPages, intelligenceRows: state.rows, intelligenceScans: state.scans }, path: Object.values(state.rows)[0].notePath };
}

describe("rerunExtraction", () => {
	it("extracts the page again from its stored transcript, through the merge, keeping the user's lines", async () => {
		const e = env();
		const { index, path } = await synced(e, "todo Call todo Email");
		e.notes.set(path, e.notes.get(path)!.replace("- [ ] Email\n", "- [ ] Email\n- [ ] Mine\n").replace("- [ ] Call\n", ""));
		const out = await rerunExtraction(e, run(), index, path, "a/d-p1.pdf");
		// The user deleted "Call": it stays deleted; their own line stays.
		expect(e.notes.get(path)).toContain("- [ ] Email\n- [ ] Mine\n");
		expect(e.notes.get(path)).not.toContain("Call");
		expect(out.message).toBe("Extracted again; nothing on the page changed what the note says.");
		expect(out.index!.seenPages!["d:p1:work"].pageHash).toBe("h1");
	});

	it("says what it did when the note changed, and what failed when the model did", async () => {
		const e = env();
		const { index, path } = await synced(e, "todo Call");
		const base = JSON.parse(e.files.data.get(`plugin/base/${index.intelligenceRows!["d:p1:work"].noteId}.json`)!) as { transcript: string };
		base.transcript = "todo Call todo Pay";
		e.files.data.set(`plugin/base/${index.intelligenceRows!["d:p1:work"].noteId}.json`, JSON.stringify(base));
		expect((await rerunExtraction(e, run(), index, path, "a")).message).toBe("Extracted again; the note is updated.");
		base.transcript = "FAIL";
		e.files.data.set(`plugin/base/${index.intelligenceRows!["d:p1:work"].noteId}.json`, JSON.stringify(base));
		expect((await rerunExtraction(e, run(), index, path, "a")).message).toBe("Extraction failed: model down");
	});

	it("still runs on an index that lost the page's seen entry", async () => {
		const e = env();
		const { index, path } = await synced(e);
		const out = await rerunExtraction(e, run(), { ...index, seenPages: {} }, path, "a");
		expect(out.index!.seenPages!["d:p1:work"]).toMatchObject({ pageHash: "", firstSeen: null });
	});

	it("has the page read again, by the sync the command starts, when its base is gone", async () => {
		const e = env();
		const { index, path } = await synced(e);
		e.files.data.delete(`plugin/base/${index.intelligenceRows!["d:p1:work"].noteId}.json`);
		const out = await rerunExtraction(e, run(), index, path, "a");
		expect(out.message).toContain("read again now");
		expect(out.sync).toBe(true);
		expect(out.index!.seenPages!["d:p1:work"]).toMatchObject({ pageHash: null, noteId: index.intelligenceRows!["d:p1:work"].noteId });
	});

	it("refuses on a note that is not an insight note, and off the engine device", async () => {
		const e = env();
		const { index, path } = await synced(e);
		expect((await rerunExtraction(e, run(), index, "Other.md", "a")).message).toBe("This note is not an insight note from the Intelligence Engine.");
		expect((await rerunExtraction(e, run({ ...settings(), engineDeviceId: "elsewhere" }), index, path, "a")).message).toContain("runs on another device");
		expect((await rerunExtraction(e, run({ ...settings(), backend: "none-such" }), index, path, "a")).message).toContain("No extraction backend is set");
	});
});

describe("markForRereading and isPageNote", () => {
	it("clears the seen hash of an insight note, keeping its id, and owes its notebook to the next sync; says so for any other note", async () => {
		const e = env();
		const { index, path } = await synced(e);
		expect([isPageNote(index, path), isPageNote(index, "Other.md"), isPageNote({ rootHash: null, rows: {} }, path)]).toEqual([true, false, false]);
		expect([pageProfile(index, path), pageProfile(index, "Other.md")]).toEqual(["generic", null]);
		expect(markForRereading(index, path).index!.seenPages!["d:p1:work"].pageHash).toBeNull();
		expect(markForRereading({ ...index, intelligencePending: ["d", "e"] }, path).index!.intelligencePending).toEqual(["d", "e"]);
		expect(markForRereading(index, path).index!.intelligencePending).toEqual(["d"]);
		const bare = { ...index, seenPages: undefined };
		expect(markForRereading(bare, path).index!.seenPages!["d:p1:work"]).toMatchObject({ pageHash: null, firstSeen: null });
		expect(markForRereading(index, "Other.md")).toEqual({ message: "This note is not an insight note from the Intelligence Engine." });
	});
});

describe("markNoteForReextract and markAllForReextract", () => {
	const transcriptRow = (notePath: string, pageId: string | null) => ({ syncKey: `d:${pageId ?? ""}:work`, docId: "d", pageId, tag: "work", entryHash: "e", pageHash: null, notePath, status: "active" as const, syncedAt: "" });
	const seen = { scope: "notebook" as const, pageHash: "h", firstSeen: 1 };
	const index: SyncIndex = {
		rootHash: null,
		rows: { log: transcriptRow("Log.md", null), one: transcriptRow("Log — Page 2.md", "p2") },
		// p3 was never drawn on; p1 under #home and notebook e are not this note's.
		seenPages: { "d:p1:work": seen, "d:p2:work": seen, "d:p3:work": { ...seen, pageHash: null }, "d:p4:work": seen, "d:p1:home": seen, "e:p1:work": seen },
		intelligencePending: ["x"],
	};
	const marked = (out: SyncIndex) => Object.entries(out.seenPages!).filter(([, entry]) => entry.reextract).map(([key]) => key);

	it("marks every drawn page of a transcript note's notebook under its tag, with an insight note or not, and starts a sync", () => {
		const out = markNoteForReextract(index, "Log.md", () => true);
		expect(out.message).toBe("3 pages of this notebook are extracted again now.");
		expect(out.sync).toBe(true);
		expect(marked(out.index!)).toEqual(["d:p1:work", "d:p2:work", "d:p4:work"]);
		// The hash stays: the page is extracted again, not read again.
		expect(out.index!.seenPages!["d:p1:work"]).toEqual({ ...seen, reextract: true });
		expect(out.index!.intelligencePending).toEqual(["x", "d"]);
		// A page-tag note covers its own page only.
		expect(marked(markNoteForReextract(index, "Log — Page 2.md", () => true).index!)).toEqual(["d:p2:work"]);
	});

	it("says why it does nothing: not the plugin's note, insight notes off, or no page seen yet", () => {
		expect(markNoteForReextract(index, "Other.md", () => true)).toEqual({ message: "This note is not a note from Tagged Sync." });
		expect(markNoteForReextract(index, "Log.md", () => false)).toEqual({ message: 'Insight notes are off for the tag "work". Switch them on under Tag routing first.' });
		expect(markNoteForReextract({ ...index, seenPages: undefined }, "Log.md", () => true)).toEqual({ message: "The engine has not seen this notebook's pages yet. Sync now reads them." });
	});

	it("marks every drawn page under every tag with insight notes on, for Re-extract all", () => {
		const work = (tag: string) => tag === "work";
		expect(reextractableKeys(index, work)).toEqual(["d:p1:work", "d:p2:work", "d:p4:work", "e:p1:work"]);
		const out = markAllForReextract(index, work);
		expect([out.message, out.sync]).toEqual(["4 pages are extracted again now.", true]);
		expect(out.index!.intelligencePending).toEqual(["x", "d", "e"]);
		expect(markAllForReextract(index, () => false)).toEqual({ message: "No page is under a tag with insight notes on yet." });
	});

	it("gets a page left alone at switch-on its first insight note, and extracts a made one again from its base, reading nothing", async () => {
		const e = env();
		const prepared = await prepareRun(e, run());
		const page = { id: "p1", ordinal: 1, hash: "h1", modified: Date.parse("2026-08-01T00:00:00.000Z") };
		let reads: string[] = [];
		const doc = { docId: "d", name: "Log", legacy: false, pages: [page], units: [{ tag: "work", scope: "notebook" as const, pageIds: ["p1"] }], transcribe: async (ids: string[]) => (reads.push(...ids), new Map([["p1", "todo Call"]])), writeRender: async () => "a/d-p1.pdf" };
		// Written before insight notes were switched on: recorded, and left alone.
		const state: IntelligenceState = { seenPages: {}, rows: {}, scans: { work: ENABLED.toISOString() } };
		await prepared.hook!.process(doc, state);
		expect(state.rows).toEqual({});
		const first = markNoteForReextract({ rootHash: null, rows: { log: transcriptRow("Log.md", null) }, seenPages: state.seenPages }, "Log.md", () => true).index!;
		const made: IntelligenceState = { seenPages: first.seenPages!, rows: {}, scans: state.scans };
		await prepared.hook!.process(doc, made);
		expect(Object.values(made.rows).map((row) => row.status)).toEqual(["active"]);
		// Done: the wish is gone, the page is seen at its hash.
		expect(made.seenPages["d:p1:work"]).toMatchObject({ pageHash: "h1" });
		expect(made.seenPages["d:p1:work"].reextract).toBeUndefined();

		reads = [];
		const again = markNoteForReextract({ rootHash: null, rows: { log: transcriptRow("Log.md", null) }, seenPages: made.seenPages, intelligenceRows: made.rows }, "Log.md", () => true).index!;
		const second: IntelligenceState = { seenPages: again.seenPages!, rows: made.rows, scans: state.scans };
		const report = await prepared.hook!.process(doc, second);
		expect(reads).toEqual([]);
		expect(report.failures).toEqual([]);
		expect(second.seenPages["d:p1:work"].reextract).toBeUndefined();
	});
});
