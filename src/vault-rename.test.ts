import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../test-stubs/fake-clock";
import { FakeApp, FakeVault } from "../test-stubs/fake-obsidian";
import { DEFAULT_ATTACHMENTS_FOLDER } from "./attachment-writer";
import { EMPTY_SYNC_INDEX } from "./sync-engine";

// Gap G16 -- keeping `data.json` pointed at notes the user moved.
//
// A synced note carries no frontmatter to re-find it by: the sync index is the only link between a
// reMarkable page and the file it was written to. Move the file and that link is the row's
// `notePath` and nothing else. If it goes stale the row strands, the next sync decides the note was
// never written, and the user gets a duplicate -- silently, with the original still sitting where
// they put it.
//
// This is the characterisation, written against the unmodified `main.ts` and kept afterwards. It
// drives the shipped `vault.on("rename")` handler the way the file explorer does: through
// `fileManager.renameFile`, which fires the same events Obsidian fires, including the fan-out a
// folder move produces.

vi.mock("rmapi-js", () => ({
	session: () => ({ raw: {} }),
	auth: async () => "session-token",
	register: async () => "device-token",
}));

/** The engine, replaced: a rename during a run is one of the cases, and a run has to be holdable. */
const engine = vi.hoisted(() => ({ hold: null as Promise<void> | null }));

vi.mock("./sync-engine", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./sync-engine")>();
	return {
		...actual,
		runSync: async (_deps: unknown, index: unknown) => {
			if (engine.hold) await engine.hold;
			return {
				index,
				stopped: false,
				notesWritten: 0,
				unavailableOcrUnits: 0,
				failedOcrUnits: 0,
				editedNotesSkipped: 0,
				documentsSkipped: 0,
				shrunkNotes: 0,
				relaidDocuments: 0,
				skipErrors: [],
			};
		},
	};
});

interface Plugin {
	app: FakeApp;
	data: { syncIndex: { rows: Record<string, { notePath: string; status: string }> } };
	saves: unknown[];
	syncNow(): Promise<void>;
}

function row(notePath: string, status = "active") {
	return { syncKey: notePath, docId: "doc-1", pageId: null, notePath, status };
}

async function loadWith(paths: string[], extra: Record<string, ReturnType<typeof row>> = {}): Promise<Plugin> {
	const vault = new FakeVault();
	const rows: Record<string, ReturnType<typeof row>> = { ...extra };
	for (const path of paths) {
		vault.seed(path, "body");
		rows[path] = row(path);
	}

	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin & { saved: unknown })(
		new FakeApp(vault),
		{ id: "tagged-sync", name: "Tagged Sync", version: "0.0.0" },
	);
	plugin.saved = { deviceToken: "device-token", ocrBackend: "off", syncIndex: { ...EMPTY_SYNC_INDEX, rows } };
	// A clock nobody moves: the launch sync never comes due, so nothing runs behind these renames.
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	plugin.saves.length = 0;
	return plugin;
}

/** What the file explorer does. The vault fires whatever Obsidian would fire for this move. */
async function move(plugin: Plugin, from: string, to: string): Promise<void> {
	const entry = plugin.app.vault.getAbstractFileByPath(from);
	if (!entry) throw new Error(`nothing at ${from}`);
	await plugin.app.fileManager.renameFile(entry, to);
	// The handler is async and nobody awaits it -- `vault.on` discards the promise, exactly as in
	// Obsidian. Let its `saveData` land before the assertions read it.
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const notePaths = (plugin: Plugin) => Object.values(plugin.data.syncIndex.rows).map((r) => r.notePath);

beforeEach(() => {
	engine.hold = null;
});

describe("when the user moves a synced note", () => {
	it("follows a note renamed by hand, and writes the new path down", async () => {
		const plugin = await loadWith(["Notes/Meeting.md"]);

		await move(plugin, "Notes/Meeting.md", "Notes/Standup.md");

		expect(notePaths(plugin)).toEqual(["Notes/Standup.md"]);
		expect(plugin.saves).toHaveLength(1);
	});

	it("follows a note dragged into another folder", async () => {
		// The same event either way -- Obsidian has no separate "move". Asserted because the row's
		// path is a whole path, not a basename, and a remap that kept the old folder would pass the
		// rename test above.
		const plugin = await loadWith(["Notes/Meeting.md"]);

		await move(plugin, "Notes/Meeting.md", "Archive/2026/Meeting.md");

		expect(notePaths(plugin)).toEqual(["Archive/2026/Meeting.md"]);
	});

	it("leaves a row alone when some other file is renamed", async () => {
		const plugin = await loadWith(["Notes/Meeting.md"]);
		plugin.app.vault.seed("Inbox/Scratch.md", "mine");

		await move(plugin, "Inbox/Scratch.md", "Inbox/Notes.md");

		expect(notePaths(plugin)).toEqual(["Notes/Meeting.md"]);
		// Nothing changed, so nothing is written. `data.json` is a synced file; a write per rename
		// would make every file-explorer tidy-up a conflict candidate on someone else's machine.
		expect(plugin.saves).toEqual([]);
	});
});

describe("when the user moves a folder of synced notes", () => {
	it("rewrites every row under it, however deep", async () => {
		const plugin = await loadWith(["Notes/A.md", "Notes/2026/B.md", "Notes/2026/deep/C.md"]);
		await plugin.app.vault.createFolder("Notes");

		await move(plugin, "Notes", "Archive");

		expect(notePaths(plugin).sort()).toEqual(["Archive/2026/B.md", "Archive/2026/deep/C.md", "Archive/A.md"]);
	});

	it("writes data.json once for the whole move, not once per note", async () => {
		// The reason the handler has a folder branch at all. Obsidian also fires one rename per
		// descendant, so the rows would end up correct without it -- at the cost of one `data.json`
		// write per note moved, which on a folder of two hundred is two hundred writes of a file
		// Obsidian Sync is watching.
		const plugin = await loadWith(["Notes/A.md", "Notes/B.md", "Notes/C.md"]);
		await plugin.app.vault.createFolder("Notes");

		await move(plugin, "Notes", "Archive");

		expect(plugin.saves).toHaveLength(1);
	});

	it("leaves a folder whose name merely starts the same alone", async () => {
		// `Notes2` is not inside `Notes`. The separator is part of the comparison, and without it a
		// rename of `Notes` would drag every sibling whose name it prefixes.
		const plugin = await loadWith(["Notes2/Keep.md"]);
		await plugin.app.vault.createFolder("Notes");

		await move(plugin, "Notes", "Archive");

		expect(notePaths(plugin)).toEqual(["Notes2/Keep.md"]);
		expect(plugin.saves).toEqual([]);
	});

	it("does not mistake a folder for a note that happens to sit at the same path", async () => {
		// A folder event and a file event differ only by the type of the thing renamed, and the
		// exact-match branch is the file one. A row can never hold a folder path, so a folder whose
		// path equals a row's is a shape the plugin must not act on.
		const plugin = await loadWith([]);
		plugin.data.syncIndex.rows["odd"] = row("Notes");
		await plugin.app.vault.createFolder("Notes");

		await move(plugin, "Notes", "Archive");

		expect(notePaths(plugin)).toEqual(["Notes"]);
	});
});

describe("what a rename does not do", () => {
	it("ignores renames while a sync is running", async () => {
		// A sync moves notes itself and replaces the whole index when it finishes. Reacting mid-run
		// would persist a state the sync is about to overwrite anyway.
		const plugin = await loadWith(["Notes/Meeting.md"]);
		let open!: () => void;
		engine.hold = new Promise<void>((resolve) => (open = resolve));

		const run = plugin.syncNow();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await move(plugin, "Notes/Meeting.md", "Notes/Standup.md");

		expect(notePaths(plugin)).toEqual(["Notes/Meeting.md"]);
		open();
		await run;
	});

	it("keeps tracking renames once that sync has finished", async () => {
		// The guard is a flag, and a flag that is set and never cleared looks exactly like a guard
		// that works.
		const plugin = await loadWith(["Notes/Meeting.md"]);

		await plugin.syncNow();
		await move(plugin, "Notes/Meeting.md", "Notes/Standup.md");

		expect(notePaths(plugin)).toEqual(["Notes/Standup.md"]);
	});

	it("does not notice the attachments folder being renamed", async () => {
		// A row holds a note path and nothing else -- the embed lives in the note's own text, which
		// is Obsidian's link-update job, and the folder to write the *next* attachment into is a
		// setting. So renaming it changes no row, and the setting still names the old folder.
		const plugin = await loadWith(["Notes/A.md"]);
		await plugin.app.vault.createFolder(DEFAULT_ATTACHMENTS_FOLDER);
		plugin.app.vault.seed(`${DEFAULT_ATTACHMENTS_FOLDER}/doc-1.pdf`, "bytes");

		await move(plugin, DEFAULT_ATTACHMENTS_FOLDER, "Archive/attachments");

		expect(plugin.saves).toEqual([]);
		expect((plugin.data as unknown as { attachmentsFolder: string }).attachmentsFolder).toBe(
			DEFAULT_ATTACHMENTS_FOLDER,
		);
	});

	it("lets a note be renamed onto a path another row already claims", async () => {
		// Reachable: the second row is orphaned and its file long deleted, so the path is free as far
		// as the vault is concerned while the index still points at it. The handler remaps by old
		// path and never looks at where anything lands, so two rows end up naming one file.
		const plugin = await loadWith(["Notes/A.md"], { gone: row("Notes/B.md", "orphaned") });

		await move(plugin, "Notes/A.md", "Notes/B.md");

		expect(notePaths(plugin).sort()).toEqual(["Notes/B.md", "Notes/B.md"]);
	});
});
