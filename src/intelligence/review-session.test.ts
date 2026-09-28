import { describe, expect, it } from "vitest";
import type { NoteStore } from "../note-builder";
import { BASE_VERSION, createBaseStore, NO_FAILURES, type PageBase } from "./base-store";
import { applyReview, loadReview } from "./review-session";
import type { IntelligenceRow } from "./sync-pass";

const LINK = "obsidian://tagged-sync-review";

function stores() {
	const files = new Map<string, string>();
	const notes = new Map<string, string>();
	const baseStore = createBaseStore({ read: async (p) => files.get(p) ?? null, write: async (p, c) => void files.set(p, c), remove: async (p) => void files.delete(p) }, "plugin");
	const writes: string[] = [];
	const noteStore: NoteStore = { read: async (p) => notes.get(p) ?? null, exists: async (p) => notes.has(p), write: async (p, c) => void (writes.push(p), notes.set(p, c)), ensureFolder: async () => {}, move: async () => {} };
	return { baseStore, noteStore, notes, writes };
}

const row = (noteId: string, notePath: string, status: "active" | "orphaned" = "active"): IntelligenceRow => ({
	syncKey: noteId,
	unitKey: noteId,
	docId: "d",
	pageId: noteId,
	tag: "work",
	scope: "notebook",
	notePath,
	folder: "Work",
	status,
	noteId,
	profileId: "generic",
	baseHash: "",
	syncedAt: "",
});

function base(noteId: string): PageBase {
	return {
		version: BASE_VERSION,
		noteId,
		syncKey: noteId,
		unitKey: noteId,
		transcript: "",
		settled: [],
		extraction: { ...NO_FAILURES },
		slots: {
			tasks: {
				shape: "checklist",
				heading: { level: 2, text: "Tasks" },
				itemFormat: "- [ ] {{text}} 📅 {{due}}",
				list: {
					items: [{ id: "a", text: "Call Bob", fields: {}, done: false, source: "call bob", origin: "engine" }],
					tombstones: [],
					proposals: [
						{ kind: "add", id: "p1", text: "Email Anna", fields: { due: "2026-10-02", owner: null }, source: "email anna", done: false },
						{ kind: "remove", id: "p2", itemId: "a" },
						{ kind: "remove", id: "p3", itemId: "zz" },
						{ kind: "change", id: "p4", itemId: "a", text: "Call Bob", fields: {}, source: "call bob today" },
					],
				},
			},
			summary: { shape: "text", heading: { level: 2, text: "Summary" }, text: "", proposals: [{ kind: "replace", id: "p5", text: "Met Bob." }] },
			mood: { shape: "value", property: "mood", heading: null, value: null, proposals: [{ kind: "replace", id: "p6", text: "ok", value: "ok" }, { kind: "replace", id: "p7", text: "", value: null }] },
		},
	};
}

describe("loadReview", () => {
	it("lists every pending proposal of every active note with its words and the page's words behind it", async () => {
		const { baseStore } = stores();
		await baseStore.save(base("n1"));
		await baseStore.save(base("n3"));
		const items = await loadReview({ n1: row("n1", "Work/one.md"), n2: row("n2", "Work/two.md"), n3: row("n3", "Work/old.md", "orphaned") }, baseStore);
		expect(items.map((item) => [item.notePath, item.label, item.source])).toEqual([
			["Work/one.md", "Add: Email Anna (2026-10-02)", "email anna"],
			["Work/one.md", "Remove: Call Bob", "call bob"],
			["Work/one.md", "Remove: an item", null],
			["Work/one.md", "Change: Call Bob", "call bob today"],
			["Work/one.md", "Replace the summary with: Met Bob.", null],
			["Work/one.md", "Set mood to: ok", null],
			["Work/one.md", "Set mood to: nothing", null],
		]);
	});
});

describe("applyReview", () => {
	it("writes the note and the base when the decision changes the note", async () => {
		const { baseStore, noteStore, notes, writes } = stores();
		await baseStore.save(base("n1"));
		notes.set("Work/one.md", `## Tasks\n> [!todo] 4 proposals — [Review](${LINK})\n- [ ] Call Bob\n\n## Summary\n> [!todo] 1 proposal — [Review](${LINK})\n`);
		const [add] = await loadReview({ n1: row("n1", "Work/one.md") }, baseStore);
		expect(await applyReview(add, true, { baseStore, noteStore, newId: () => "x", reviewLink: LINK })).toBe("applied");
		expect(notes.get("Work/one.md")).toContain("- [ ] Call Bob\n- [ ] Email Anna 📅 2026-10-02\n");
		expect((await baseStore.load("n1"))!.slots.tasks).toMatchObject({ list: { proposals: [{ id: "p2" }, { id: "p3" }, { id: "p4" }] } });
		expect(writes).toEqual(["Work/one.md"]);
		expect(await applyReview(add, true, { baseStore, noteStore, newId: () => "x", reviewLink: LINK })).toBe("stale");
	});

	it("saves only the base when the note does not change, and says when the note or base is gone or the heading lost", async () => {
		const { baseStore, noteStore, notes, writes } = stores();
		await baseStore.save(base("n1"));
		const note = `## Tasks\n- [ ] Call Bob\n\n## Summary\nMy words.`;
		notes.set("Work/one.md", note);
		const items = await loadReview({ n1: row("n1", "Work/one.md") }, baseStore);
		const summary = items.find((item) => item.slotId === "summary")!;
		// No callout in the note to count down, and ✗ keeps the text: nothing to write.
		expect(await applyReview(summary, false, { baseStore, noteStore, newId: () => "x", reviewLink: LINK })).toBe("applied");
		expect(writes).toEqual([]);
		expect((await baseStore.load("n1"))!.slots.summary).toMatchObject({ text: "Met Bob.", proposals: [] });
		notes.set("Work/one.md", "## Other");
		expect(await applyReview(items[0], true, { baseStore, noteStore, newId: () => "x", reviewLink: LINK })).toBe("no-region");
		notes.delete("Work/one.md");
		expect(await applyReview(items[0], true, { baseStore, noteStore, newId: () => "x", reviewLink: LINK })).toBe("gone");
	});
});
