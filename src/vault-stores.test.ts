import { describe, expect, it, vi } from "vitest";
import { asApp, asVault, FakeApp, FakeVault } from "../test-stubs/fake-obsidian";
import { type NoteFields, writeNote } from "./note-builder";
import {
	createAttachmentStore,
	createNoteStore,
	ensureFolder,
	resolveFolderCasing,
	resolveTagMapCasing,
} from "./vault-stores";

// Gap G01. Until this file existed, every test that wrote a note wrote it into an in-memory store
// that could not fail -- so the whole collision suite proved the naming logic and nothing about the
// write. These tests run against a vault that refuses what Obsidian refuses, and several of them
// document a refusal the plugin does not yet survive. Where that is so, the test says it.

function vaultWith(paths: Record<string, string> = {}, platform: "macos" | "linux" = "macos"): FakeVault {
	const vault = new FakeVault({ platform });
	for (const [path, content] of Object.entries(paths)) vault.seed(path, content);
	return vault;
}

describe("ensureFolder", () => {
	it("creates a folder that is not there yet", async () => {
		const vault = vaultWith();
		await ensureFolder(asVault(vault), "Work/Notes");
		expect(vault.getFolderByPath("Work/Notes")).not.toBeNull();
	});

	it("does nothing when the folder is already there, so a second sync is not an error", async () => {
		const vault = vaultWith();
		await ensureFolder(asVault(vault), "Work");
		await expect(ensureFolder(asVault(vault), "Work")).resolves.toBeUndefined();
	});

	it("normalizes before it looks and before it creates, so one folder is not created twice", async () => {
		const vault = vaultWith();
		await ensureFolder(asVault(vault), "Work/Notes");
		await ensureFolder(asVault(vault), "/Work//Notes/");
		expect(vault.getAllLoadedFiles().map((f) => f.path)).toEqual(["Work/Notes"]);
	});

	// G01's fourth scenario. The check and the create ask different things: `getFolderByPath` is an
	// exact lookup into the file index, `createFolder` asks the filesystem, and macOS and Windows
	// fold case while the index does not. So a user whose vault already holds `work/` gets an
	// unhandled throw the first time a tag routes to `Work/`.
	it("throws where the vault already holds the same folder under a different case", async () => {
		const vault = vaultWith();
		await ensureFolder(asVault(vault), "work");
		await expect(ensureFolder(asVault(vault), "Work")).rejects.toThrow("Folder already exists.");
	});

	it("does not throw for that same pair on Linux, where the filesystem does not fold case", async () => {
		const vault = vaultWith({}, "linux");
		await ensureFolder(asVault(vault), "work");
		await expect(ensureFolder(asVault(vault), "Work")).resolves.toBeUndefined();
	});
});

// Issue #73's repair. The throw above is deliberate (ticket 18: swallowing it mis-files notes and
// duplicates them later), so the fix is upstream: a configured folder resolves to the casing the
// vault really holds before any path is derived from it, and the throw is never provoked.
describe("resolveFolderCasing", () => {
	it("returns the vault's own casing where the configured one differs", async () => {
		const vault = vaultWith();
		await vault.createFolder("media");
		await expect(resolveFolderCasing(asVault(vault), "Media")).resolves.toBe("media");
	});

	it("returns an exactly-matching path as it is", async () => {
		const vault = vaultWith();
		await vault.createFolder("Media");
		await expect(resolveFolderCasing(asVault(vault), "Media")).resolves.toBe("Media");
	});

	it("keeps the typed casing when nothing is there yet, so the folder is created as typed", async () => {
		const vault = vaultWith();
		await expect(resolveFolderCasing(asVault(vault), "remarkable-media")).resolves.toBe("remarkable-media");
	});

	it("resolves the segments that exist and keeps the typed tail", async () => {
		const vault = vaultWith();
		await vault.createFolder("work");
		await expect(resolveFolderCasing(asVault(vault), "Work/New Notes")).resolves.toBe("work/New Notes");
	});

	it("does not merge two folders that really are two on Linux", async () => {
		const vault = vaultWith({}, "linux");
		await vault.createFolder("work");
		await expect(resolveFolderCasing(asVault(vault), "Work")).resolves.toBe("Work");
	});

	it("leaves the path as typed where a file, not a folder, is in the way", async () => {
		const vault = vaultWith({ media: "a note named like the folder" });
		await expect(resolveFolderCasing(asVault(vault), "Media")).resolves.toBe("Media");
	});

	it("walks through a segment the index knows exactly and still folds the one after it", async () => {
		const vault = vaultWith();
		await vault.createFolder("Work");
		await vault.createFolder("Work/notes");
		await expect(resolveFolderCasing(asVault(vault), "Work/Notes")).resolves.toBe("Work/notes");
	});

	it("keeps a typed segment behind a resolved prefix where a file sits at it", async () => {
		const vault = vaultWith({ "work/Media": "a note where the folder should be" });
		await vault.createFolder("work");
		await expect(resolveFolderCasing(asVault(vault), "Work/Media")).resolves.toBe("work/Media");
	});

	// The pair G15.4 pins as a throw, taken through the repair: resolved first, accepted after.
	it("hands ensureFolder a path it accepts where the typed one threw", async () => {
		const vault = vaultWith();
		await vault.createFolder("media");
		const resolved = await resolveFolderCasing(asVault(vault), "Media");
		await expect(ensureFolder(asVault(vault), resolved)).resolves.toBeUndefined();
		expect(vault.getAllLoadedFiles().map((f) => f.path)).toEqual(["media"]);
	});
});

describe("resolveTagMapCasing", () => {
	it("resolves every mapped folder and leaves the tags alone", async () => {
		const vault = vaultWith();
		await vault.createFolder("work");
		const mapping = await resolveTagMapCasing(asVault(vault), { sync: "Work", read: "Reading" });
		expect(mapping).toEqual({ sync: "work", read: "Reading" });
	});
});

describe("the note store's read", () => {
	it("returns null rather than throwing when nothing is at the path", async () => {
		const store = createNoteStore(asApp(new FakeApp(vaultWith())));
		await expect(store.read("Work/Missing.md")).resolves.toBeNull();
	});

	it("returns the note's text when it is there", async () => {
		const store = createNoteStore(asApp(new FakeApp(vaultWith({ "Work/A.md": "body" }))));
		await expect(store.read("Work/A.md")).resolves.toBe("body");
	});

	// The vault's lookup does not normalize, so this normalization is the whole of what makes a path
	// stored before the sanitizer landed resolve again. Escaped rather than written literally: the
	// character is invisible, and an earlier draft of this very test lost it in transport and passed.
	it("normalizes the path it is given, so a stored path with an odd space still finds its note", async () => {
		const store = createNoteStore(asApp(new FakeApp(vaultWith({ "Work/Team meeting.md": "body" }))));
		await expect(store.read("Work/Team\u00A0meeting.md")).resolves.toBe("body");
		await expect(store.read("Work/Team\u202Fmeeting.md")).resolves.toBe("body");
	});

	it("returns null when a folder, not a note, sits at the path", async () => {
		const vault = vaultWith();
		await vault.createFolder("Work/A.md");
		const store = createNoteStore(asApp(new FakeApp(vault)));
		await expect(store.read("Work/A.md")).resolves.toBeNull();
	});
});

describe("the note store's write", () => {
	it("creates the note when nothing is at the path", async () => {
		const vault = vaultWith();
		await createNoteStore(asApp(new FakeApp(vault))).write("Work/A.md", "body");
		expect(vault.fileContents()).toEqual({ "Work/A.md": "body" });
	});

	// G01's fifth scenario, and the reason `process()` is there rather than `modify()`: a sync
	// rewrites notes the user may have open in an editor, and `process` is the call that does not
	// discard what the editor is holding.
	it("rewrites an existing note through process(), never through a fresh create", async () => {
		const vault = vaultWith({ "Work/A.md": "old" });
		const process = vi.spyOn(vault, "process");
		const create = vi.spyOn(vault, "create");

		await createNoteStore(asApp(new FakeApp(vault))).write("Work/A.md", "new");

		expect(process).toHaveBeenCalledTimes(1);
		expect(create).not.toHaveBeenCalled();
		expect(vault.fileContents()["Work/A.md"]).toBe("new");
	});

	it("normalizes once, so the note it looks for and the note it writes are the same one", async () => {
		const vault = vaultWith({ "Work/A.md": "old" });
		await createNoteStore(asApp(new FakeApp(vault))).write("/Work//A.md", "new");
		expect(vault.fileContents()).toEqual({ "Work/A.md": "new" });
	});

	// G01's first scenario, and the one that costs a user a sync. `resolveFreePath` calls a path free
	// when `read()` comes back null -- and `read()` asks the file index, which is an exact-string
	// map, while `create()` asks the filesystem, which folds case. So the plugin picks a name it has
	// just proved is free and the write throws on it.
	it("throws Obsidian's own sentence on a path the plugin has just decided was free", async () => {
		const vault = vaultWith({ "Work/My Notebook.md": "the user's note" });
		const store = createNoteStore(asApp(new FakeApp(vault)));

		expect(await store.read("Work/my notebook.md")).toBeNull();
		await expect(store.write("Work/my notebook.md", "the sync's note")).rejects.toThrow("File already exists.");
		expect(vault.fileContents()["Work/My Notebook.md"]).toBe("the user's note");
	});

	// G01's third scenario. A folder is not a file, so the lookup that decides between rewrite and
	// create returns null and the create runs into it.
	it("throws when a folder sits where the note should go", async () => {
		const vault = vaultWith();
		await vault.createFolder("Work/A.md");
		await expect(createNoteStore(asApp(new FakeApp(vault))).write("Work/A.md", "body")).rejects.toThrow(
			"File already exists.",
		);
	});

	// G01's sixth scenario. The sanitizer runs when a name is *built*; a path that reaches the store
	// by another route -- a stored one, a folder the user typed into tag routing -- is refused here.
	it("throws when the path carries a character the platform forbids", async () => {
		const vault = vaultWith();
		await expect(createNoteStore(asApp(new FakeApp(vault))).write("Work/Meeting 14:30.md", "body")).rejects.toThrow(
			/cannot contain/,
		);
		expect(vault.fileContents()).toEqual({});
	});
});

// Both stores expose ensureFolder by delegating to the function above. Asserted through each store
// rather than only on the function, because what a delegation can get wrong is which vault it was
// handed -- and that is invisible to a test that calls the function directly.
describe("each store's own ensureFolder", () => {
	it("creates the note's target folder in the vault the note store was built on", async () => {
		const vault = vaultWith();
		await createNoteStore(asApp(new FakeApp(vault))).ensureFolder("Work/Notes");
		expect(vault.getFolderByPath("Work/Notes")).not.toBeNull();
	});

	it("creates the attachments folder in the vault the attachment store was built on", async () => {
		const vault = vaultWith();
		await createAttachmentStore(asVault(vault)).ensureFolder("tagged-sync/attachments");
		expect(vault.getFolderByPath("tagged-sync/attachments")).not.toBeNull();
	});
});

describe("the note store's move", () => {
	it("renames through the file manager, which is what keeps the vault's backlinks pointing at it", async () => {
		const vault = vaultWith({ "Work/Old.md": "body" });
		const app = new FakeApp(vault);
		const rename = vi.spyOn(app.fileManager, "renameFile");

		await createNoteStore(asApp(app)).move("Work/Old.md", "Archive/New.md");

		expect(rename).toHaveBeenCalledTimes(1);
		expect(vault.fileContents()).toEqual({ "Archive/New.md": "body" });
	});

	it("does nothing when the note it was asked to move is not there", async () => {
		const vault = vaultWith();
		const app = new FakeApp(vault);
		const rename = vi.spyOn(app.fileManager, "renameFile");

		await expect(createNoteStore(asApp(app)).move("Work/Gone.md", "Archive/New.md")).resolves.toBeUndefined();
		expect(rename).not.toHaveBeenCalled();
	});

	it("normalizes both ends, so a stored source path resolves and the destination is not written twice", async () => {
		const vault = vaultWith({ "Work/Old.md": "body" });
		await createNoteStore(asApp(new FakeApp(vault))).move("/Work//Old.md", "Archive//New.md");
		expect(vault.fileContents()).toEqual({ "Archive/New.md": "body" });
	});
});

describe("the attachment store", () => {
	it("creates the PDF when nothing is at the path", async () => {
		const vault = vaultWith();
		await createAttachmentStore(asVault(vault)).writeBinary("Attachments/a.pdf", new ArrayBuffer(4));
		expect(vault.getFileByPath("Attachments/a.pdf")).not.toBeNull();
	});

	it("overwrites the PDF that is already there rather than refusing it", async () => {
		const vault = vaultWith({ "Attachments/a.pdf": "" });
		const store = createAttachmentStore(asVault(vault));
		await expect(store.writeBinary("Attachments/a.pdf", new ArrayBuffer(4))).resolves.toBeUndefined();
	});

	it("normalizes, so the lookup that chooses between overwrite and create sees the written path", async () => {
		const vault = vaultWith();
		const store = createAttachmentStore(asVault(vault));
		await store.writeBinary("Attachments/a.pdf", new ArrayBuffer(4));
		await expect(store.writeBinary("/Attachments//a.pdf", new ArrayBuffer(8))).resolves.toBeUndefined();
		expect(vault.getAllLoadedFiles().map((f) => f.path)).toEqual(["Attachments/a.pdf"]);
	});

	// G01's seventh scenario. An attachment is named from the document id, so it cannot carry an
	// illegal character -- but its *folder* is whatever the user typed into the attachments setting.
	it("throws when the attachments folder the user typed carries a forbidden character", async () => {
		const vault = vaultWith();
		await expect(
			createAttachmentStore(asVault(vault)).writeBinary("Attach:ments/a.pdf", new ArrayBuffer(4)),
		).rejects.toThrow(/cannot contain/);
	});

	it("throws where an attachment of the same name differs only in case", async () => {
		const vault = vaultWith({ "Attachments/A.pdf": "" });
		await expect(
			createAttachmentStore(asVault(vault)).writeBinary("Attachments/a.pdf", new ArrayBuffer(4)),
		).rejects.toThrow("File already exists.");
	});
});

// The seam end to end: the real path resolution, the real store adapter, and a vault that folds
// case the way macOS and Windows do. Everything above tests one side of the boundary; this tests
// that the two sides now ask the same question.
//
// Nothing else in the suite can see this. `note-builder.test.ts` drives resolution through an
// in-memory map, which has no case folding to disagree about -- so the collision suite there stayed
// green through the whole period in which this was broken.
describe("choosing a path for a new note, against a vault that folds case", () => {
	function fields(overrides: Partial<NoteFields> = {}): NoteFields {
		return {
			docId: "doc-1abcdef",
			pageId: null,
			pageIndex: null,
			tag: "sync",
			source: "My Notebook",
			embedPath: "Attachments/doc-1abcdef.pdf",
			highlights: [],
			transcript: "",
			digest: "",
			...overrides,
		};
	}

	it("suffixes rather than throwing when the only note in the way differs in case", async () => {
		const vault = vaultWith({ "Work/my notebook.md": "the user's own note" });
		const store = createNoteStore(asApp(new FakeApp(vault)));

		const path = await writeNote(store, "Work", fields());

		expect(path).toBe("Work/My Notebook (sync).md");
		expect(vault.fileContents()["Work/my notebook.md"]).toBe("the user's own note");
	});

	it("suffixes rather than throwing when a folder sits where the note would go", async () => {
		const vault = vaultWith();
		await vault.createFolder("Work/My Notebook.md");
		const store = createNoteStore(asApp(new FakeApp(vault)));

		await expect(writeNote(store, "Work", fields())).resolves.toBe("Work/My Notebook (sync).md");
	});

	it("keeps escalating through the suffixes when each one is taken too", async () => {
		const vault = vaultWith({
			"Work/my notebook.md": "",
			"Work/MY NOTEBOOK (sync).md": "",
			"Work/My Notebook (doc-1a).md": "",
		});
		const store = createNoteStore(asApp(new FakeApp(vault)));

		await expect(writeNote(store, "Work", fields())).resolves.toBe("Work/My Notebook (2).md");
	});

	it("still takes the plain name on Linux, where nothing folds and nothing is in the way", async () => {
		const vault = vaultWith({ "Work/my notebook.md": "" }, "linux");
		const store = createNoteStore(asApp(new FakeApp(vault)));

		await expect(writeNote(store, "Work", fields())).resolves.toBe("Work/My Notebook.md");
	});
});
