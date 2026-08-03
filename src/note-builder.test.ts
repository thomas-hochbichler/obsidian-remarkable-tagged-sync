import { describe, expect, it, vi } from "vitest";
import {
	buildNoteContent,
	deriveBaseName,
	moveNote,
	sanitizeFilenamePart,
	updateTranscript,
	writeNote,
	type NoteFields,
	type NoteStore,
} from "./note-builder";

function fakeStore(files: Record<string, string> = {}): NoteStore & {
	ensureFolder: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
} {
	return {
		read: vi.fn(async (path: string) => files[path] ?? null),
		write: vi.fn(async (path: string, content: string) => {
			files[path] = content;
		}),
		move: vi.fn(async (fromPath: string, toPath: string) => {
			if (fromPath in files) {
				files[toPath] = files[fromPath];
				delete files[fromPath];
			}
		}),
		ensureFolder: vi.fn().mockResolvedValue(undefined),
	};
}

/** A quote in the collector's output shape, tinted with the palette's yellow fallback. */
function quote(text: string) {
	return { text, rgb: { r: 251, g: 247, b: 25 } };
}

/** The bullet `quote(text)` renders to. */
function mark(text: string): string {
	return `<mark style="background: rgba(251, 247, 25, 0.45); color: inherit">${text}</mark>`;
}

function baseFields(overrides: Partial<NoteFields> = {}): NoteFields {
	return {
		docId: "doc-1",
		pageId: null,
		pageIndex: null,
		tag: "sync",
		source: "My Notebook",
		embedPath: "tagged-sync/attachments/doc-1.pdf",
		highlights: [],
		transcript: "Some OCR text",
		...overrides,
	};
}

describe("sanitizeFilenamePart", () => {
	it("replaces filesystem-illegal characters", () => {
		expect(sanitizeFilenamePart('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
	});

	it("trims very long names", () => {
		const long = "a".repeat(300);
		expect(sanitizeFilenamePart(long).length).toBeLessThan(300);
	});

	it("leaves ordinary names untouched", () => {
		expect(sanitizeFilenamePart("My Notebook")).toBe("My Notebook");
	});
});

describe("deriveBaseName", () => {
	it("uses the notebook name alone for a notebook-level note", () => {
		expect(deriveBaseName("My Notebook", null)).toBe("My Notebook");
	});

	it("appends the page index for a page-level note", () => {
		expect(deriveBaseName("My Notebook", 3)).toBe("My Notebook — Page 3");
	});

	it("sanitizes illegal characters in the notebook name", () => {
		expect(deriveBaseName("Q3/Q4 Plan", null)).toBe("Q3-Q4 Plan");
	});
});

describe("buildNoteContent", () => {
	it("gives a brand-new note zero frontmatter — it starts straight at the managed fence", () => {
		const content = buildNoteContent(baseFields(), null);

		expect(content.startsWith("---")).toBe(false);
		expect(content.startsWith("<!-- tagged-sync:begin")).toBe(true);
	});

	it("fences the managed region with begin/end markers around the embed and transcript", () => {
		const content = buildNoteContent(baseFields(), null);

		expect(content).toContain("<!-- tagged-sync:begin");
		expect(content).toContain("![[tagged-sync/attachments/doc-1.pdf]]");
		expect(content).toContain("## Transcript\nSome OCR text\n<!-- tagged-sync:end -->");
	});

	it("gives a brand-new note a default free-area hint below the fence", () => {
		const content = buildNoteContent(baseFields(), null);

		expect(content).toContain("<!-- tagged-sync:end -->\n\n<!-- user's own notes/annotations live here, preserved across re-syncs -->\n");
	});

	it("keeps the blank line between the fence and the free area stable across repeated re-syncs", () => {
		let content = buildNoteContent(baseFields(), null);
		for (let i = 0; i < 3; i++) content = buildNoteContent(baseFields(), content);

		expect(content).toContain("<!-- tagged-sync:end -->\n\n<!-- user's own notes/annotations live here, preserved across re-syncs -->\n");
	});

	it("preserves the user's free-area content below the fence on re-write", () => {
		const original = buildNoteContent(baseFields(), null);
		const withUserNotes = original.replace(
			"<!-- user's own notes/annotations live here, preserved across re-syncs -->\n",
			"## My own thoughts\n\nSome annotations I wrote.\n",
		);

		const rewritten = buildNoteContent(baseFields({ transcript: "Updated OCR text" }), withUserNotes);

		expect(rewritten).toContain("## My own thoughts\n\nSome annotations I wrote.\n");
		expect(rewritten).toContain("Updated OCR text");
	});

	it("replaces the managed block's OCR text on re-write, not append", () => {
		const original = buildNoteContent(baseFields({ transcript: "Old OCR text" }), null);

		const rewritten = buildNoteContent(baseFields({ transcript: "New OCR text" }), original);

		expect(rewritten).not.toContain("Old OCR text");
		expect(rewritten).toContain("New OCR text");
	});

	it("leaves an already-synced note's old frontmatter untouched (migration: no strip, no rewrite)", () => {
		// An old note carried plugin frontmatter; the plugin no longer manages any, so it's preserved verbatim.
		const oldNote =
			"---\ntagged-sync:\n  doc-id: doc-1\nsync-status: active\ncssclass: mine\n---\n" +
			"<!-- tagged-sync:begin — do not edit inside this block -->\n![[old.pdf]]\n\n## Transcript\nold text\n<!-- tagged-sync:end -->\n\nmy notes\n";

		const rewritten = buildNoteContent(baseFields({ transcript: "new text" }), oldNote);

		expect(rewritten).toContain("---\ntagged-sync:\n  doc-id: doc-1\nsync-status: active\ncssclass: mine\n---\n");
		expect(rewritten).toContain("new text");
		expect(rewritten).not.toContain("old text");
		expect(rewritten).toContain("my notes");
	});

	it("does not put reMarkable tags under an Obsidian-native tags: key", () => {
		const content = buildNoteContent(baseFields(), null);

		expect(content).not.toMatch(/^tags:/m);
	});

	it("omits the Highlights section entirely when there are no highlights", () => {
		const content = buildNoteContent(baseFields({ highlights: [] }), null);

		expect(content).not.toContain("## Highlights");
		// Fence shape stays exactly as before: embed, blank line, transcript.
		expect(content).toContain("![[tagged-sync/attachments/doc-1.pdf]]\n\n## Transcript\n");
	});

	it("renders a per-page quote callout above the transcript, titled with a page link into the embed", () => {
		const content = buildNoteContent(
			baseFields({
				highlights: [
					{ pageLabel: 3, embedPage: 3, quotes: [quote("Reading changes the past."), quote("Memory is a reconstruction.")] },
					{ pageLabel: 7, embedPage: 7, quotes: [quote("A highlight from a later page.")] },
				],
			}),
			null,
		);

		expect(content).toContain(
			"![[tagged-sync/attachments/doc-1.pdf]]\n\n" +
				"## Highlights\n\n" +
				"> [!quote] [[tagged-sync/attachments/doc-1.pdf#page=3|Page 3]]\n" +
				`> - ${mark("Reading changes the past.")}\n` +
				`> - ${mark("Memory is a reconstruction.")}\n\n` +
				"> [!quote] [[tagged-sync/attachments/doc-1.pdf#page=7|Page 7]]\n" +
				`> - ${mark("A highlight from a later page.")}\n\n` +
				"## Transcript\n",
		);
	});

	it("tints each quote's mark with its own highlighter colour", () => {
		const content = buildNoteContent(
			baseFields({ highlights: [{ pageLabel: 1, embedPage: 1, quotes: [{ text: "a pink one", rgb: { r: 242, g: 158, b: 255 } }] }] }),
			null,
		);

		expect(content).toContain('> - <mark style="background: rgba(242, 158, 255, 0.45); color: inherit">a pink one</mark>');
	});

	it("escapes HTML in quote text so highlighted markup can't break the note", () => {
		const content = buildNoteContent(
			baseFields({ highlights: [{ pageLabel: 1, embedPage: 1, quotes: [quote("a < b & c > d")] }] }),
			null,
		);

		expect(content).toContain(mark("a &lt; b &amp; c &gt; d"));
	});

	it("points a page-level note's callout at the sole embedded page while labelling it with the notebook position", () => {
		const content = buildNoteContent(
			baseFields({ pageId: "page-a", pageIndex: 5, highlights: [{ pageLabel: 5, embedPage: 1, quotes: [quote("A quote.")] }] }),
			null,
		);

		expect(content).toContain(`> [!quote] [[tagged-sync/attachments/doc-1.pdf#page=1|Page 5]]\n> - ${mark("A quote.")}`);
	});

	it("keeps a highlights section even when the transcript is empty (independent sections)", () => {
		const content = buildNoteContent(
			baseFields({ transcript: "", highlights: [{ pageLabel: 1, embedPage: 1, quotes: [quote("Only a highlight.")] }] }),
			null,
		);

		expect(content).toContain(`## Highlights\n\n> [!quote] [[tagged-sync/attachments/doc-1.pdf#page=1|Page 1]]\n> - ${mark("Only a highlight.")}`);
		expect(content).not.toContain("## Transcript");
	});

	it("omits the Transcript section entirely when there is no transcript (backend off or nothing found)", () => {
		const content = buildNoteContent(baseFields({ transcript: "" }), null);

		expect(content).not.toContain("## Transcript");
		expect(content).toContain("![[tagged-sync/attachments/doc-1.pdf]]\n\n<!-- tagged-sync:end -->");
	});
});

describe("writeNote", () => {
	it("writes a notebook-level note to <notebook>.md", async () => {
		const store = fakeStore();

		const path = await writeNote(store, "Work", baseFields());

		expect(path).toBe("Work/My Notebook.md");
		expect(store.ensureFolder).toHaveBeenCalledWith("Work");
		expect(store.write).toHaveBeenCalledWith("Work/My Notebook.md", expect.any(String));
	});

	it("writes a page-level note to <notebook> — Page N.md", async () => {
		const store = fakeStore();

		const path = await writeNote(store, "Work", baseFields({ pageId: "page-a", pageIndex: 3 }));

		expect(path).toBe("Work/My Notebook — Page 3.md");
	});

	it("overwrites in place at the given existingPath (re-sync), ignoring the derived name", async () => {
		const store = fakeStore();
		const first = await writeNote(store, "Work", baseFields());
		store.write.mockClear();

		// The index knows the note's path; a re-sync passes it so the note is rewritten in place even if
		// the source notebook were renamed on the device.
		const path = await writeNote(store, "Work", baseFields({ source: "Renamed On Device", transcript: "fresh" }), first);

		expect(path).toBe("Work/My Notebook.md");
		expect(store.write).toHaveBeenCalledTimes(1);
		expect((await store.read(path))!).toContain("fresh");
	});

	it("suffixes rather than clobbering a file already at the derived path (new unit, no index row)", async () => {
		const store = fakeStore();
		await writeNote(store, "Work", baseFields({ docId: "doc-1", tag: "sync" }));

		// A different unit deriving the same filename, with no existingPath, must not overwrite the first.
		const path = await writeNote(store, "Work", baseFields({ docId: "doc-2-abcdef", tag: "todo" }));

		expect(path).toBe("Work/My Notebook (todo).md");
		expect((await store.read("Work/My Notebook.md"))!).toContain("![[tagged-sync/attachments/doc-1.pdf]]");
	});

	it("folds the tag into the filename on a same-page collision (different tag on the same page)", async () => {
		const store = fakeStore();
		await writeNote(store, "Work", baseFields({ pageId: "page-a", pageIndex: 2, tag: "sync" }));

		const path = await writeNote(store, "Work", baseFields({ pageId: "page-a", pageIndex: 2, tag: "todo", embedPath: "tagged-sync/attachments/doc-1-page-a.pdf" }));

		expect(path).toBe("Work/My Notebook — Page 2 (todo).md");
	});

	it("writes to the vault root without a leading slash when the folder is '/'", async () => {
		const store = fakeStore();

		const path = await writeNote(store, "/", baseFields());

		expect(path).toBe("My Notebook.md");
		expect(store.ensureFolder).not.toHaveBeenCalled();
		expect(store.write).toHaveBeenCalledWith("My Notebook.md", expect.any(String));
	});

	it("suffixes collisions at the vault root like any other folder", async () => {
		const store = fakeStore();
		await writeNote(store, "/", baseFields({ docId: "doc-1", tag: "sync" }));

		const path = await writeNote(store, "/", baseFields({ docId: "doc-2-abcdef", tag: "todo" }));

		expect(path).toBe("My Notebook (todo).md");
	});

	it("escalates to a docId suffix when the tag suffix is also taken", async () => {
		const store = fakeStore();
		await writeNote(store, "Work", baseFields({ docId: "doc-1", tag: "sync" })); // My Notebook.md
		await writeNote(store, "Work", baseFields({ docId: "doc-9", tag: "sync" })); // My Notebook (sync).md

		const path = await writeNote(store, "Work", baseFields({ docId: "doc-2-abcdef", tag: "sync" }));

		expect(path).toBe("Work/My Notebook (doc-2-).md");
	});
});

describe("moveNote", () => {
	it("moves the file to the new folder via the store's move, then rewrites it with fresh fields", async () => {
		const store = fakeStore();
		await writeNote(store, "Old", baseFields({ tag: "school" }));

		const path = await moveNote(store, "Old/My Notebook.md", "New", baseFields({ tag: "work", transcript: "moved text" }));

		expect(path).toBe("New/My Notebook.md");
		expect(store.move).toHaveBeenCalledWith("Old/My Notebook.md", "New/My Notebook.md");
		expect(await store.read("Old/My Notebook.md")).toBeNull();
		expect((await store.read("New/My Notebook.md"))!).toContain("moved text");
	});

	it("preserves the free area across a move", async () => {
		const store = fakeStore();
		const original = await writeNote(store, "Old", baseFields({ tag: "school" }));
		const withUserNotes = (await store.read(original))!.replace(
			"<!-- user's own notes/annotations live here, preserved across re-syncs -->\n",
			"## My own thoughts\n",
		);
		await store.write("Old/My Notebook.md", withUserNotes);

		await moveNote(store, "Old/My Notebook.md", "New", baseFields({ tag: "work" }));

		expect(await store.read("New/My Notebook.md")).toContain("## My own thoughts");
	});

	it("suffixes the target path instead of clobbering an unrelated note already there", async () => {
		const store = fakeStore();
		await writeNote(store, "Old", baseFields({ docId: "doc-1", tag: "school" }));
		await writeNote(store, "New", baseFields({ docId: "doc-other", tag: "unrelated" }));

		const path = await moveNote(store, "Old/My Notebook.md", "New", baseFields({ docId: "doc-1", tag: "work" }));

		expect(path).toBe("New/My Notebook (work).md");
		expect(store.move).toHaveBeenCalledWith("Old/My Notebook.md", "New/My Notebook (work).md");
		expect((await store.read("New/My Notebook.md"))!).toContain("![[tagged-sync/attachments/doc-1.pdf]]"); // the unrelated note's own embed, untouched
	});

	it("moves a note to the vault root without a leading slash when the folder is '/'", async () => {
		const store = fakeStore();
		await writeNote(store, "Old", baseFields({ tag: "school" }));
		store.ensureFolder.mockClear();

		const path = await moveNote(store, "Old/My Notebook.md", "/", baseFields({ tag: "work", transcript: "moved text" }));

		expect(path).toBe("My Notebook.md");
		expect(store.move).toHaveBeenCalledWith("Old/My Notebook.md", "My Notebook.md");
		expect(store.ensureFolder).not.toHaveBeenCalled();
		expect((await store.read("My Notebook.md"))!).toContain("moved text");
	});

	it("doesn't treat the source file's own pre-move content as a collision when two tags share a folder", async () => {
		const store = fakeStore();
		await writeNote(store, "Shared", baseFields({ docId: "doc-1", tag: "school" }));

		// "school" renamed to "personal-school", but both happen to map to the same folder, so the
		// natural target path is the source path itself -- not a foreign note to disambiguate against.
		const path = await moveNote(store, "Shared/My Notebook.md", "Shared", baseFields({ docId: "doc-1", tag: "personal-school", transcript: "renamed" }));

		expect(path).toBe("Shared/My Notebook.md");
		expect(store.move).not.toHaveBeenCalled();
		expect((await store.read("Shared/My Notebook.md"))!).toContain("renamed");
	});
});

describe("updateTranscript", () => {
	it("rewrites only the transcript region, leaving the embed and the user's free area", async () => {
		const store = fakeStore();
		const path = await writeNote(store, "Work", baseFields({ transcript: "old garbage text" }));
		// Simulate a user's own note below the managed fence.
		const withUserArea = (await store.read(path))!.replace(/\n$/, "") + "\n\nMy own annotation.\n";
		await store.write(path, withUserArea);

		const updated = await updateTranscript(store, path, "clean vision text");

		expect(updated).toBe(true);
		const content = (await store.read(path))!;
		expect(content).toContain("## Transcript\nclean vision text\n<!-- tagged-sync:end -->");
		expect(content).not.toContain("old garbage text");
		expect(content).toContain("![[tagged-sync/attachments/doc-1.pdf]]");
		expect(content).toContain("My own annotation.");
	});

	it("removes the whole Transcript section for an unavailable/blank result", async () => {
		const store = fakeStore();
		const path = await writeNote(store, "Work", baseFields({ transcript: "was here" }));

		const updated = await updateTranscript(store, path, "");

		expect(updated).toBe(true);
		const content = (await store.read(path))!;
		expect(content).not.toContain("## Transcript");
		expect(content).toContain("![[tagged-sync/attachments/doc-1.pdf]]\n\n<!-- tagged-sync:end -->");
	});

	it("grows the Transcript section into a note written while transcription was off", async () => {
		const store = fakeStore();
		const path = await writeNote(store, "Work", baseFields({ transcript: "" }));
		// Simulate a user's own note below the managed fence.
		const withUserArea = (await store.read(path))!.replace(/\n$/, "") + "\n\nMy own annotation.\n";
		await store.write(path, withUserArea);

		const updated = await updateTranscript(store, path, "text from a newly enabled backend");

		expect(updated).toBe(true);
		const content = (await store.read(path))!;
		expect(content).toContain("## Transcript\ntext from a newly enabled backend\n<!-- tagged-sync:end -->");
		expect(content).toContain("My own annotation.");
	});

	it("treats a `$` in the transcript literally, not as a replacement pattern", async () => {
		const store = fakeStore();
		const path = await writeNote(store, "Work", baseFields());

		await updateTranscript(store, path, "cost is $5 for $1 each");

		expect((await store.read(path))!).toContain("## Transcript\ncost is $5 for $1 each\n");
	});

	it("returns false and writes nothing when the note is gone", async () => {
		const store = fakeStore();

		expect(await updateTranscript(store, "Work/Gone.md", "x")).toBe(false);
		expect(store.write).not.toHaveBeenCalled();
	});

	it("returns false when the note has no managed transcript block", async () => {
		const store = fakeStore({ "Work/Plain.md": "Just my own note, no fence.\n" });

		expect(await updateTranscript(store, "Work/Plain.md", "x")).toBe(false);
	});
});
