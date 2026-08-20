import { describe, expect, it } from "vitest";
import { remapNotePath, remapRows, type Renamed } from "./note-rename";

// The decision, without a vault. `vault-rename.test.ts` is the other half: that the shipped handler
// asks this and saves when it says something moved.

const fileRename = (from: string, to: string): Renamed => ({ kind: "file", from, to });
const folderMove = (from: string, to: string): Renamed => ({ kind: "folder", from, to });

const row = (notePath: string) => ({ syncKey: notePath, notePath, status: "active" as const });

describe("remapNotePath", () => {
	it("moves the note that was renamed", () => {
		expect(remapNotePath(fileRename("Notes/A.md", "Notes/B.md"), "Notes/A.md")).toBe("Notes/B.md");
	});

	it("leaves every other note where it is", () => {
		expect(remapNotePath(fileRename("Notes/A.md", "Notes/B.md"), "Notes/C.md")).toBeNull();
	});

	it("moves a note out of a renamed folder, keeping everything below it", () => {
		expect(remapNotePath(folderMove("Notes", "Archive"), "Notes/2026/deep/C.md")).toBe("Archive/2026/deep/C.md");
	});

	it("does not treat a sibling whose name merely starts the same as being inside", () => {
		// `Notes2` is not in `Notes`. The separator is what says so, and without it a rename of one
		// folder rewrites the rows of every sibling whose name it prefixes.
		expect(remapNotePath(folderMove("Notes", "Archive"), "Notes2/Keep.md")).toBeNull();
	});

	it("ignores a folder whose path is exactly what a row holds", () => {
		// A path equal to the folder is the folder, and only what is *under* it moves. A row always
		// holds a file path, so matching here would rewrite a row on an event that never touched its
		// file -- and the same two strings as a *file* rename are that note being renamed.
		expect(remapNotePath(folderMove("Notes", "Archive"), "Notes")).toBeNull();
		expect(remapNotePath(fileRename("Notes", "Archive"), "Notes")).toBe("Archive");
	});

	it("does not read a file rename as a prefix", () => {
		// The exact-match branch is the file one. A note is not inside another note.
		expect(remapNotePath(fileRename("Notes", "Archive"), "Notes/A.md")).toBeNull();
	});

	it("follows a note into a folder that did not exist before", () => {
		expect(remapNotePath(fileRename("Notes/A.md", "Archive/2026/A.md"), "Notes/A.md")).toBe("Archive/2026/A.md");
	});

	it("compares paths exactly, case included", () => {
		// macOS folds case in the filesystem and Obsidian's index does not, so a case-only rename
		// arrives here as two different strings and is a real move of the row.
		expect(remapNotePath(fileRename("Notes/a.md", "Notes/A.md"), "notes/a.md")).toBeNull();
		expect(remapNotePath(fileRename("Notes/a.md", "Notes/A.md"), "Notes/a.md")).toBe("Notes/A.md");
	});
});

describe("remapRows", () => {
	it("says nothing moved when nothing did", () => {
		// Null is what stops `data.json` being rewritten, and almost every rename in a vault lands
		// here -- it is a synced file, so a write per rename is a conflict candidate on every machine.
		const rows = { one: row("Notes/A.md") };

		expect(remapRows(rows, fileRename("Inbox/Scratch.md", "Inbox/Notes.md"))).toBeNull();
	});

	it("says nothing moved when there are no rows at all", () => {
		expect(remapRows({}, folderMove("Notes", "Archive"))).toBeNull();
	});

	it("rewrites every row under a moved folder in one answer", () => {
		const rows = { a: row("Notes/A.md"), b: row("Notes/2026/B.md"), c: row("Elsewhere/C.md") };

		const next = remapRows(rows, folderMove("Notes", "Archive"));

		expect(next).toEqual({
			a: { ...rows.a, notePath: "Archive/A.md" },
			b: { ...rows.b, notePath: "Archive/2026/B.md" },
			c: rows.c,
		});
	});

	it("keeps every row, not only the ones that moved", () => {
		// The answer replaces the whole map. A version that returned only the moved rows would drop
		// every note the user did not touch out of the index.
		const rows = { a: row("Notes/A.md"), b: row("Elsewhere/B.md") };

		expect(Object.keys(remapRows(rows, fileRename("Notes/A.md", "Notes/Z.md")) ?? {})).toEqual(["a", "b"]);
	});

	it("keeps the keys, because the key is the sync key and the path is not", () => {
		// A row is found by its sync key on the next run. Re-keying by the new path would strand it
		// exactly as the stale path would have.
		const rows = { "doc-1#p2": row("Notes/A.md") };

		expect(Object.keys(remapRows(rows, fileRename("Notes/A.md", "Notes/Z.md")) ?? {})).toEqual(["doc-1#p2"]);
	});

	it("carries the rest of the row across untouched", () => {
		// A row holds hashes and a render version the next sync compares against. Rebuilding it
		// around the new path would re-render every note the user ever moved.
		const rows = { a: { ...row("Notes/A.md"), entryHash: "h1", renderVersion: 30, blockHash: "b1" } };

		expect(remapRows(rows, fileRename("Notes/A.md", "Notes/Z.md"))?.a).toEqual({
			...rows.a,
			notePath: "Notes/Z.md",
		});
	});

	it("does not write through the rows it was given", () => {
		// The caller decides whether this is kept. Mutating in place would move the rows even on the
		// path where the answer is discarded.
		const rows = { a: row("Notes/A.md") };

		remapRows(rows, fileRename("Notes/A.md", "Notes/Z.md"));

		expect(rows.a.notePath).toBe("Notes/A.md");
	});

	it("moves an orphaned row too", () => {
		// Orphaned means "no longer on the device", not "no longer in the vault". Its note is still a
		// file the user can move, and a stale path there is what makes the collision below possible.
		const rows = { gone: { ...row("Notes/A.md"), status: "orphaned" as const } };

		expect(remapRows(rows, fileRename("Notes/A.md", "Notes/Z.md"))?.gone.notePath).toBe("Notes/Z.md");
	});

	it("lets two rows end up naming one file", () => {
		// Shipped behaviour, recorded rather than endorsed: nothing here looks at where a row lands.
		// Reachable when the second row is orphaned and its own file deleted, so the vault sees the
		// path as free while the index still points at it. Which row should lose is a product
		// question -- this row exists so the answer cannot change by accident.
		const rows = { a: row("Notes/A.md"), gone: { ...row("Notes/B.md"), status: "orphaned" as const } };

		const next = remapRows(rows, fileRename("Notes/A.md", "Notes/B.md"));

		expect([next?.a.notePath, next?.gone.notePath]).toEqual(["Notes/B.md", "Notes/B.md"]);
	});
});
