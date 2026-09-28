import { describe, expect, it } from "vitest";
import type { NoteStore } from "../note-builder";
import type { SyncIndex } from "../sync-engine";
import { parseExtraction } from "./extraction";
import { registerExtractionBackend } from "./extraction-registry";
import { type HostEnvironment, prepareRun } from "./host";
import { isPageNote, markForRereading, rerunExtraction } from "./rerun";
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

/** One page note written by a sync, and the index it left. */
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

	it("marks the page for reading on the next sync when its base is gone", async () => {
		const e = env();
		const { index, path } = await synced(e);
		e.files.data.delete(`plugin/base/${index.intelligenceRows!["d:p1:work"].noteId}.json`);
		const out = await rerunExtraction(e, run(), index, path, "a");
		expect(out.message).toContain("read again on the next sync");
		expect(out.index!.seenPages!["d:p1:work"]).toMatchObject({ pageHash: null, noteId: index.intelligenceRows!["d:p1:work"].noteId });
	});

	it("refuses on a note that is not a page note, and off the engine device", async () => {
		const e = env();
		const { index, path } = await synced(e);
		expect((await rerunExtraction(e, run(), index, "Other.md", "a")).message).toBe("This note is not a page note from the Intelligence Engine.");
		expect((await rerunExtraction(e, run({ ...settings(), engineDeviceId: "elsewhere" }), index, path, "a")).message).toContain("runs on another device");
		expect((await rerunExtraction(e, run({ ...settings(), backend: "none-such" }), index, path, "a")).message).toContain("No extraction backend is set");
	});
});

describe("markForRereading and isPageNote", () => {
	it("clears the seen hash of a page note, keeping its id; says so for any other note", async () => {
		const e = env();
		const { index, path } = await synced(e);
		expect([isPageNote(index, path), isPageNote(index, "Other.md"), isPageNote({ rootHash: null, rows: {} }, path)]).toEqual([true, false, false]);
		expect(markForRereading(index, path).index!.seenPages!["d:p1:work"].pageHash).toBeNull();
		const bare = { ...index, seenPages: undefined };
		expect(markForRereading(bare, path).index!.seenPages!["d:p1:work"]).toMatchObject({ pageHash: null, firstSeen: null });
		expect(markForRereading(index, "Other.md")).toEqual({ message: "This note is not a page note from the Intelligence Engine." });
	});
});
