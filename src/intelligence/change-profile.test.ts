import { describe, expect, it } from "vitest";
import type { NoteStore } from "../note-builder";
import type { SyncIndex } from "../sync-engine";
import { changeProfile } from "./change-profile";
import { parseExtraction } from "./extraction";
import { registerExtractionBackend } from "./extraction-registry";
import { type HostEnvironment, prepareRun } from "./host";
import { uneditedSinceBase } from "./review";
import { emptyIntelligence, setIntelligenceMode, type IntelligenceSettings } from "./settings";
import type { IntelligenceState } from "./sync-pass";

registerExtractionBackend({
	id: "changefake",
	label: "Change fake",
	metered: false,
	requiresLicence: false,
	measured: false,
	create: () => ({
		id: "changefake",
		metered: false,
		extract: async (input) => {
			if (input.transcript.includes("FAIL")) return { kind: "failed", reason: "model down" };
			const tasks = [...input.transcript.matchAll(/todo (\w+)/g)].map((m) => ({ source: m[0], reason: "", id: "new", text: m[1], due: null, done: false }));
			return { kind: "ok", result: parseExtraction({ tasks, summary: "A page.", decisions: [] }, input.slots, input.referenceDate)! };
		},
	}),
});

function env() {
	const notes = new Map<string, string>();
	const data = new Map<string, string>([["plugin/device-id", "me"]]);
	let n = 0;
	const noteStore: NoteStore = { read: async (p) => notes.get(p) ?? null, exists: async (p) => notes.has(p), write: async (p, c) => void notes.set(p, c), ensureFolder: async () => {}, move: async () => {} };
	const e: HostEnvironment & { notes: Map<string, string>; data: Map<string, string> } = {
		notes,
		data,
		pluginDir: "plugin",
		files: { read: async (p) => data.get(p) ?? null, write: async (p, c) => void data.set(p, c), remove: async (p) => void data.delete(p), mkdir: async () => {} },
		noteStore,
		readVaultNote: async () => null,
		createNote: async (p, c) => void notes.set(p, c),
		configDir: ".obsidian",
		formatNow: () => "",
		randomId: () => `id-${++n}-xxxxxxxx`,
		now: () => new Date("2026-09-29T10:00:00.000Z"),
	};
	return e;
}

const ENABLED = new Date("2026-09-01T00:00:00.000Z");
function settings(): IntelligenceSettings {
	const s = { ...setIntelligenceMode(emptyIntelligence(), "work", true, ENABLED), backend: "changefake", engineDeviceId: "me" };
	return {
		...s,
		mappings: { work: { ...s.mappings.work, profiles: ["tasks-only"] } },
		profiles: [
			{ id: "tasks-only", name: "Tasks only", description: "", template: null, slots: ["tasks"] },
			{ id: "decided", name: "Decisions", description: "", template: null, slots: ["summary", "decisions"] },
		],
	};
}
const run = (s = settings()) => ({ settings: s, tagFolderMap: { work: "Work" }, pro: true, transcriptionBackend: "vision", providerSettings: {}, background: false });

async function synced(e: ReturnType<typeof env>, text = "todo Call"): Promise<{ index: SyncIndex; path: string }> {
	const prepared = await prepareRun(e, run());
	const state: IntelligenceState = { seenPages: {}, rows: {}, scans: { work: ENABLED.toISOString() } };
	await prepared.hook!.process(
		{ docId: "d", name: "Log", legacy: false, pages: [{ id: "p1", ordinal: 1, hash: "h1", modified: Date.parse("2026-09-02T00:00:00.000Z") }], units: [{ tag: "work", scope: "notebook", pageIds: ["p1"] }], transcribe: async () => new Map([["p1", text]]), writeRender: async () => "a/d-p1.pdf" },
		state,
	);
	return { index: { rootHash: null, rows: {}, seenPages: state.seenPages, intelligenceRows: state.rows, intelligenceScans: state.scans }, path: Object.values(state.rows)[0].notePath };
}

describe("uneditedSinceBase", () => {
	it("is true for a note as the engine wrote it, and false for an added line, an edited summary, or a lost heading", async () => {
		const e = env();
		const { index, path } = await synced(e, "todo Call todo Pay");
		const base = JSON.parse(e.data.get(`plugin/base/${index.intelligenceRows!["d:p1:work"].noteId}.json`)!);
		const note = e.notes.get(path)!;
		expect(uneditedSinceBase(base, note.split("\n"))).toBe(true);
		expect(uneditedSinceBase(base, note.replace("- [ ] Pay", "- [ ] Pay\n- [ ] Mine").split("\n"))).toBe(false);
		expect(uneditedSinceBase(base, note.replace("- [ ] Pay", "- [ ] Pay the rent").split("\n"))).toBe(false);
		expect(uneditedSinceBase(base, note.replace("## Tasks", "## Other").split("\n"))).toBe(false);
		const withText = { ...base, outside: "", slots: { ...base.slots, summary: { shape: "text", heading: { level: 2, text: "Summary" }, text: "A page.", proposals: [] }, mood: { shape: "value", property: null, heading: { level: 2, text: "Mood" }, value: "ok", proposals: [] }, tags: { shape: "value", property: "tags", heading: null, value: null, proposals: [] } } };
		expect(uneditedSinceBase(withText, "## Tasks\n- [ ] Call\n- [ ] Pay\n## Summary\nA page.\n## Mood\nok".split("\n"))).toBe(true);
		expect(uneditedSinceBase(withText, "## Tasks\n- [ ] Call\n- [ ] Pay\n## Summary\nMy words.\n## Mood\nok".split("\n"))).toBe(false);
	});

	it("is false for a section of the user's own, prose between the tasks, a tick, a date, a task the user typed, and a note with no fingerprint", async () => {
		const e = env();
		const { index, path } = await synced(e, "todo Call todo Pay");
		const base = JSON.parse(e.data.get(`plugin/base/${index.intelligenceRows!["d:p1:work"].noteId}.json`)!);
		const note = `---\nremarkable-uuid: d\n---\n${e.notes.get(path)!}`;
		// The plugin's frontmatter and blank lines are not the user's writing.
		expect(uneditedSinceBase(base, `${note}\n\n`.split("\n"))).toBe(true);
		expect(uneditedSinceBase(base, `${note}\n## My thoughts\nAsk Anna about the budget.\n`.split("\n"))).toBe(false);
		expect(uneditedSinceBase(base, note.replace("- [ ] Call", "- [ ] Call\nBob is away until Monday.").split("\n"))).toBe(false);
		expect(uneditedSinceBase(base, note.replace("- [ ] Call", "- [x] Call").split("\n"))).toBe(false);
		expect(uneditedSinceBase(base, note.replace("- [ ] Call", "- [ ] Call 📅 2026-10-05").split("\n"))).toBe(false);
		// A line the user typed is in the base after the next sync, as theirs.
		const typed = { ...base, slots: { tasks: { ...base.slots.tasks, list: { ...base.slots.tasks.list, items: base.slots.tasks.list.items.map((item: object, at: number) => (at === 1 ? { ...item, origin: "user" } : item)) } } } };
		expect(uneditedSinceBase(typed, note.split("\n"))).toBe(false);
		// Made before the fingerprint, or a base rebuilt from the note: nothing says what the engine wrote.
		expect(uneditedSinceBase({ ...base, outside: undefined }, note.split("\n"))).toBe(false);
	});
});

describe("changeProfile", () => {
	it("makes an untouched note again with the new Profile, where it is, keeping its frontmatter", async () => {
		const e = env();
		const { index, path } = await synced(e);
		const oldId = index.intelligenceRows!["d:p1:work"].noteId;
		e.notes.set(path, `---\nremarkable-note-id: ${oldId}\n---\n${e.notes.get(path)!}`);
		const out = await changeProfile(e, run(), index, path, "decided", "a/d-p1.pdf");
		expect(out.message).toBe('The note is made again with "Decisions".');
		expect(e.notes.get(path)).toContain("## Summary\nA page.");
		expect(e.notes.get(path)).toMatch(/^---\nremarkable-note-id/);
		expect(e.notes.get(path)).not.toContain("## Tasks");
		const row = out.index!.intelligenceRows!["d:p1:work"];
		expect(row).toMatchObject({ profileId: "decided", notePath: path });
		expect(row.noteId).not.toBe(oldId);
		expect(e.data.has(`plugin/base/${oldId}.json`)).toBe(false);
		expect(out.index!.seenPages!["d:p1:work"].noteId).toBe(row.noteId);
	});

	it("leaves an edited note as it is and makes a new one beside it", async () => {
		const e = env();
		const { index, path } = await synced(e);
		const edited = e.notes.get(path)!.replace("- [ ] Call", "- [ ] Call\n- [ ] Mine");
		e.notes.set(path, edited);
		const out = await changeProfile(e, run(), index, path, "decided", "a/d-p1.pdf");
		const row = out.index!.intelligenceRows!["d:p1:work"];
		expect(row.notePath).toBe("Work/Log/2026-09-02 Log p1 (work).md");
		expect(e.notes.get(path)).toBe(edited);
		expect(e.notes.get(row.notePath)).toContain("## Summary");
		expect(out.message).toContain("stays as it is");
	});

	it("leaves a note with a section of the user's own as it is, though no Slot's region was touched", async () => {
		const e = env();
		const { index, path } = await synced(e);
		const edited = `${e.notes.get(path)!}\n## My thoughts\nAsk Anna about the budget.\n`;
		e.notes.set(path, edited);
		const out = await changeProfile(e, run(), index, path, "decided", "a/d-p1.pdf");
		expect(e.notes.get(path)).toBe(edited);
		expect(out.index!.intelligenceRows!["d:p1:work"].notePath).not.toBe(path);
		expect(out.message).toContain("stays as it is");
	});

	it("carries an empty frontmatter block over as that, not the body up to its first rule", async () => {
		const e = env();
		const { index, path } = await synced(e);
		e.notes.set(path, `---\n---\n${e.notes.get(path)!}\n---\nMine\n`);
		const out = await changeProfile(e, run(), index, path, "decided", "a/d-p1.pdf");
		const made = e.notes.get(out.index!.intelligenceRows!["d:p1:work"].notePath)!;
		expect(made.startsWith("---\n---\n## Summary")).toBe(true);
		expect(made).not.toContain("## Tasks");
	});

	it("freezes the choice for the next sync when there is no transcript to extract from", async () => {
		const e = env();
		const { index, path } = await synced(e);
		e.data.delete(`plugin/base/${index.intelligenceRows!["d:p1:work"].noteId}.json`);
		const out = await changeProfile(e, run(), index, path, "decided", "a");
		expect(out.message).toContain("follows on the next sync");
		expect(out.index!.intelligenceRows!["d:p1:work"].profileId).toBe("decided");
	});

	it("refuses another note, another device, an unknown Profile, and says when extraction fails", async () => {
		const e = env();
		const { index, path } = await synced(e);
		expect((await changeProfile(e, run(), index, "Other.md", "decided", "a")).message).toContain("not a page note");
		expect((await changeProfile(e, run({ ...settings(), engineDeviceId: "x" }), index, path, "decided", "a")).message).toContain("another device");
		expect((await changeProfile(e, run(), index, path, "nope", "a")).message).toBe("That profile no longer exists.");
		const base = JSON.parse(e.data.get(`plugin/base/${index.intelligenceRows!["d:p1:work"].noteId}.json`)!) as { transcript: string };
		base.transcript = "FAIL";
		e.data.set(`plugin/base/${index.intelligenceRows!["d:p1:work"].noteId}.json`, JSON.stringify(base));
		expect((await changeProfile(e, run(), index, path, "decided", "a")).message).toBe("Extraction failed: model down");
		expect((await changeProfile(e, run(), { rootHash: null, rows: {} }, path, "decided", "a")).message).toContain("not a page note");
	});

	it("still works for a page whose seen entry went missing", async () => {
		const e = env();
		const { index, path } = await synced(e);
		const out = await changeProfile(e, run(), { ...index, seenPages: {} }, path, "decided", "a");
		expect(out.index!.seenPages!["d:p1:work"]).toMatchObject({ pageHash: null, firstSeen: null });
	});
});
