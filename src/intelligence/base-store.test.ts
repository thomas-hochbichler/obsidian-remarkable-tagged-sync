import { describe, expect, it } from "vitest";
import { BASE_VERSION, basePath, createBaseStore, NO_FAILURES, rebuildBase, type BaseFiles, type PageBase } from "./base-store";
import { compileItemFormat } from "./item-format";

function memoryFiles(): BaseFiles & { files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		read: async (path) => files.get(path) ?? null,
		write: async (path, content) => void files.set(path, content),
		remove: async (path) => void files.delete(path),
	};
}

const DIR = ".obsidian/plugins/remarkable-tagged-sync";
const base = (noteId = "n1"): PageBase => ({ version: BASE_VERSION, noteId, syncKey: "doc:page:work", unitKey: "doc:page:work", transcript: "Call Bob", slots: {}, extraction: { ...NO_FAILURES } });

describe("createBaseStore", () => {
	it("keys the file by noteId, never by syncKey, whose colons Windows rejects", () => {
		expect(basePath(DIR, "n1")).toBe(`${DIR}/base/n1.json`);
	});

	it("saves and loads a base", async () => {
		const store = createBaseStore(memoryFiles(), DIR);
		await store.save(base());
		expect(await store.load("n1")).toEqual(base());
	});

	it("treats a missing, garbled, foreign-shaped or misfiled base as missing, so the note is rebuilt", async () => {
		const files = memoryFiles();
		const store = createBaseStore(files, DIR);
		expect(await store.load("n1")).toBeNull();
		files.files.set(basePath(DIR, "n1"), "{not json");
		expect(await store.load("n1")).toBeNull();
		files.files.set(basePath(DIR, "n1"), JSON.stringify({ ...base(), version: BASE_VERSION + 1 }));
		expect(await store.load("n1")).toBeNull();
		files.files.set(basePath(DIR, "n1"), JSON.stringify(base("n2")));
		expect(await store.load("n1")).toBeNull();
		files.files.set(basePath(DIR, "n1"), "null");
		expect(await store.load("n1")).toBeNull();
	});

	it("discards a base", async () => {
		const files = memoryFiles();
		const store = createBaseStore(files, DIR);
		await store.save(base());
		await store.discard("n1");
		expect(files.files.size).toBe(0);
	});
});

describe("rebuildBase", () => {
	const tasksFormat = "- [ ] {{text}} 📅 {{due}}";
	const slots = [
		{ id: "tasks", shape: "checklist" as const, heading: { level: 2, text: "Tasks" }, format: compileItemFormat(tasksFormat), itemFormat: tasksFormat },
		{ id: "summary", shape: "text" as const, heading: { level: 2, text: "Summary" }, format: compileItemFormat("- {{text}}"), itemFormat: "" },
		{ id: "gone", shape: "list" as const, heading: { level: 2, text: "Decisions" }, format: compileItemFormat("- {{text}}"), itemFormat: "- {{text}}" },
		{ id: "tags", shape: "value" as const, heading: { level: 2, text: "Tags" }, format: compileItemFormat("- {{text}}"), itemFormat: "" },
	];
	const note = ["## Tasks", "- [ ] Call Bob 📅 2026-10-02", "- [x] Buy milk", "", "## Summary", "Met Bob.", "", "## Tags", "- x"];

	it("reads the note back as the base: items without a source, fresh ids, ticks kept, no transcript", () => {
		let n = 0;
		const rebuilt = rebuildBase({ lines: note, slots, noteId: "n1", syncKey: "k", newId: () => `r${++n}` });
		expect(rebuilt.transcript).toBeNull();
		expect(rebuilt.slots.tasks).toEqual({
			shape: "checklist",
			heading: { level: 2, text: "Tasks" },
			itemFormat: tasksFormat,
			list: {
				items: [
					{ id: "r1", text: "Call Bob", fields: { due: "2026-10-02" }, done: false, source: null, origin: "engine" },
					{ id: "r2", text: "Buy milk", fields: {}, done: true, source: null, origin: "engine" },
				],
				tombstones: [],
				proposals: [],
			},
		});
		expect(rebuilt.slots.summary).toEqual({ shape: "text", heading: { level: 2, text: "Summary" }, text: "Met Bob.", proposals: [] });
	});

	it("leaves out a region whose heading is gone, and Value Slots, which live in frontmatter", () => {
		const rebuilt = rebuildBase({ lines: note, slots, noteId: "n1", syncKey: "k", newId: () => "r" });
		expect(Object.keys(rebuilt.slots)).toEqual(["tasks", "summary"]);
	});
});
