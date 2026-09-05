import { describe, expect, it, vi } from "vitest";
import {
	buildNoteContent,
	deriveBaseName,
	isEmptyManagedBlock,
	moveNote,
	renderTranscript,
	sanitizeFilenamePart,
	updateTranscript,
	writeNote,
	type NoteFields,
	type NoteStore,
	type TranscriptPage,
} from "./note-builder";

function fakeStore(files: Record<string, string> = {}): NoteStore & {
	ensureFolder: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
} {
	return {
		read: vi.fn(async (path: string) => files[path] ?? null),
		// Exact-match on purpose. This double is a map, not a filesystem, so it has no case folding
		// to model -- and keeping it exact is what shows that the switch from `read` to `exists`
		// changed nothing anywhere the two agree. Where they disagree is `vault-stores.test.ts`.
		exists: vi.fn(async (path: string) => path in files),
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
		digest: "",
		...overrides,
	};
}

describe("sanitizeFilenamePart", () => {
	it("replaces filesystem-illegal characters", () => {
		expect(sanitizeFilenamePart('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
	});

	it("trims very long names to the cap, rather than to merely something shorter", () => {
		const long = "a".repeat(300);
		expect(sanitizeFilenamePart(long)).toBe("a".repeat(200));
	});

	// The cap counts UTF-8 bytes, not characters: ext4 caps a filename at 255 bytes per component,
	// so 200 accented characters (403 bytes) or 200 CJK characters (603 bytes) fail with
	// ENAMETOOLONG on Linux -- measured 2026-08-23. APFS and NTFS count characters and never were
	// at risk; the three tests below are for the vault synced to a Linux machine.

	it("cuts an overlong CJK title by bytes, since ext4 counts bytes -- 66 whole characters fit the cap, not 200", () => {
		expect(sanitizeFilenamePart("日".repeat(200))).toBe("日".repeat(66));
	});

	it("cuts an overlong accented title by bytes too -- two bytes per character halves the cap", () => {
		expect(sanitizeFilenamePart("ä".repeat(200))).toBe("ä".repeat(100));
	});

	it("keeps a character whole at the cut -- a four-byte character that does not fit is dropped, never split into half a surrogate pair", () => {
		expect(sanitizeFilenamePart("a".repeat(197) + "\u{1D11E}x")).toBe("a".repeat(197));
	});

	it("never strands a combining mark at the cut -- if the mark does not fit, its base character goes with it", () => {
		// U+0335 has no precomposed form, so NFC keeps it a separate mark.
		expect(sanitizeFilenamePart("a".repeat(199) + "e̵")).toBe("a".repeat(199));
		// The base being dropped can itself be a surrogate pair; the step back must clear both halves.
		expect(sanitizeFilenamePart("a".repeat(195) + "\u{1D11E}̵")).toBe("a".repeat(195));
	});

	it("falls back to a dash when a title of nothing but combining marks is cut down to nothing", () => {
		expect(sanitizeFilenamePart("̵".repeat(150))).toBe("-");
	});

	it("leaves ordinary names untouched", () => {
		expect(sanitizeFilenamePart("My Notebook")).toBe("My Notebook");
	});

	// The four below are all one bug seen from four sides: Obsidian's `Vault.create` normalizes the
	// path it writes, while `getFileByPath` compares the raw string. A name left in a form
	// `normalizePath` would change is written once and never found again -- the next sync decides
	// the note was deleted, writes it a second time, and `create` throws "File already exists." on a
	// path that prints identically to the one it just asked for.

	it("writes a non-breaking space as an ordinary one, so the note can be found again after it is written", () => {
		// EPUB title metadata carries these routinely, French typography especially.
		expect(sanitizeFilenamePart("Zu\u00A0tun")).toBe("Zu tun");
		expect(sanitizeFilenamePart("12\u202F°C")).toBe("12 °C");
	});

	it("settles a decomposed umlaut into the composed form Obsidian would have written anyway", () => {
		const decomposed = "Bu\u0308cher";
		expect(decomposed).not.toBe("Bücher");
		expect(sanitizeFilenamePart(decomposed)).toBe("Bücher");
	});

	it("drops a trailing dot, which Windows refuses outright and trim() does not remove", () => {
		expect(sanitizeFilenamePart("To do...")).toBe("To do");
		expect(sanitizeFilenamePart("Notes .")).toBe("Notes");
	});

	it("keeps a title that is nothing but dots from becoming an empty or hidden filename", () => {
		expect(sanitizeFilenamePart("...")).toBe("-");
	});

	it("renames a notebook Windows reserves, on every platform, so one vault does not grow one note per machine", () => {
		expect(sanitizeFilenamePart("CON")).toBe("CON-");
		expect(sanitizeFilenamePart("nul")).toBe("nul-");
		expect(sanitizeFilenamePart("COM3")).toBe("COM3-");
		// Not reserved -- only the bare names are, and this one is a perfectly ordinary title.
		expect(sanitizeFilenamePart("Concert")).toBe("Concert");
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
	it("gives a brand-new note zero frontmatter — it starts straight at the ownership callout", () => {
		const content = buildNoteContent(baseFields(), null);

		expect(content.startsWith("---")).toBe(false);
		// No begin marker: the block starts at the top of the body, and the callout is what says so.
		expect(content.startsWith("> [!info]- Generated by Tagged Sync")).toBe(true);
	});

	it("closes the managed region after the embed and transcript", () => {
		const content = buildNoteContent(baseFields(), null);

		expect(content).toContain("![[tagged-sync/attachments/doc-1.pdf]]");
		expect(content).toContain("## Transcript\nSome OCR text\n<!-- tagged-sync:end -->");
	});

	it("heads the managed block with the ownership callout, above the embed", () => {
		const content = buildNoteContent(baseFields(), null);

		expect(content).toContain(
			"> [!info]- Generated by Tagged Sync — do not edit\n" +
				"> Every sync rewrites this note. Keep your own thoughts in a separate note and link back to this one.\n" +
				"\n![[tagged-sync/attachments/doc-1.pdf]]",
		);
	});

	it("puts the same callout on a digest note", () => {
		const content = buildNoteContent(baseFields({ transcript: "", digest: "\n### Page 1\n" }), null);

		expect(content).toContain("> [!info]- Generated by Tagged Sync — do not edit");
	});

	it("ends a brand-new note at the fence, with nothing inviting the user to write below it", () => {
		const content = buildNoteContent(baseFields(), null);

		expect(content.endsWith("<!-- tagged-sync:end -->\n")).toBe(true);
	});

	it("keeps the blank line between the fence and an existing free area stable across repeated re-syncs", () => {
		let content = `${buildNoteContent(baseFields(), null)}\n## My own thoughts\n`;
		for (let i = 0; i < 3; i++) content = buildNoteContent(baseFields(), content);

		expect(content).toContain("<!-- tagged-sync:end -->\n\n## My own thoughts\n");
	});

	it("preserves the user's free-area content below the fence on re-write", () => {
		const withUserNotes = `${buildNoteContent(baseFields(), null)}\n## My own thoughts\n\nSome annotations I wrote.\n`;

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

	it("renders a per-page heading above the transcript, linking into the embedded page", () => {
		const content = buildNoteContent(
			baseFields({
				highlights: [
					{ pageLabel: 3, embedPage: 3, quotes: ["Reading changes the past.", "Memory is a reconstruction."] },
					{ pageLabel: 7, embedPage: 7, quotes: ["A highlight from a later page."] },
				],
			}),
			null,
		);

		expect(content).toContain(
			"![[tagged-sync/attachments/doc-1.pdf]]\n\n" +
				"## Highlights\n\n" +
				"### [[tagged-sync/attachments/doc-1.pdf#page=3|Page 3]]\n\n" +
				"- Reading changes the past.\n" +
				"- Memory is a reconstruction.\n\n" +
				"### [[tagged-sync/attachments/doc-1.pdf#page=7|Page 7]]\n\n" +
				"- A highlight from a later page.\n\n" +
				"## Transcript\n",
		);
	});

	it("points a page-level note's heading at the sole embedded page while labelling it with the notebook position", () => {
		const content = buildNoteContent(
			baseFields({ pageId: "page-a", pageIndex: 5, highlights: [{ pageLabel: 5, embedPage: 1, quotes: ["A quote."] }] }),
			null,
		);

		expect(content).toContain("### [[tagged-sync/attachments/doc-1.pdf#page=1|Page 5]]\n\n- A quote.");
	});

	it("keeps a highlights section even when the transcript is empty (independent sections)", () => {
		const content = buildNoteContent(baseFields({ transcript: "", highlights: [{ pageLabel: 1, embedPage: 1, quotes: ["Only a highlight."] }] }), null);

		expect(content).toContain("## Highlights\n\n### [[tagged-sync/attachments/doc-1.pdf#page=1|Page 1]]\n\n- Only a highlight.");
		expect(content).not.toContain("## Transcript");
	});

	it("omits the Transcript section entirely when there is no transcript (backend off or nothing found)", () => {
		const content = buildNoteContent(baseFields({ transcript: "" }), null);

		expect(content).not.toContain("## Transcript");
		expect(content).toContain("![[tagged-sync/attachments/doc-1.pdf]]\n\n<!-- tagged-sync:end -->");
	});

	it("renders the digest below the embed, on its own when there is no transcript", () => {
		const digest = "\n### Allgemeine Prinzipien\n\nA ==marked== sentence. · [[tagged-sync/attachments/doc-1.pdf#page=2|p. 2]] ^hl-9f21c4";

		const content = buildNoteContent(baseFields({ digest, transcript: "" }), null);

		expect(content).toContain(`![[tagged-sync/attachments/doc-1.pdf]]\n\n## Digest\n${digest}\n<!-- tagged-sync:end -->`);
		expect(content).not.toContain("## Transcript");
	});

	// The digest still subsumes the highlights -- of the pages it covers. The rest are folded into the
	// transcript by `renderTranscript`, so `## Highlights` never appears beside a digest.
	it("drops the Highlights section when a digest is present", () => {
		const content = buildNoteContent(
			baseFields({ digest: "\n### Prinzipien\n\nA ==marked== sentence.", highlights: [{ pageLabel: 2, embedPage: 2, quotes: ["A marked sentence."] }] }),
			null,
		);

		expect(content).not.toContain("## Highlights");
	});

	// Issue #115: classifying typed text per page rather than per document puts both kinds of page in
	// one notebook, so the note has to be able to hold both sections. It used to hold whichever it
	// rendered first, and dropped the other -- which is the data loss #115 reported.
	it("carries a digest and a transcript side by side, digest first", () => {
		const content = buildNoteContent(baseFields({ digest: "\n### Prinzipien\n\nA ==marked== sentence.", transcript: "Some OCR text" }), null);

		expect(content).toContain("## Digest\n\n### Prinzipien\n\nA ==marked== sentence.\n\n## Transcript\nSome OCR text\n<!-- tagged-sync:end -->");
		expect(content.indexOf("## Digest")).toBeLessThan(content.indexOf("## Transcript"));
	});

	it("preserves the user's free area and an old note's frontmatter when a digest arrives", () => {
		const oldNote =
			"---\ncssclass: mine\n---\n" +
			"<!-- tagged-sync:begin — do not edit inside this block -->\n![[old.pdf]]\n\n## Transcript\nold text\n<!-- tagged-sync:end -->\n\nmy notes\n";

		const rewritten = buildNoteContent(baseFields({ digest: "\n> [!note] on this page\n> A margin note. ^nt-4c8a17", transcript: "" }), oldNote);

		expect(rewritten).toContain("---\ncssclass: mine\n---\n");
		expect(rewritten).toContain("## Digest\n\n> [!note] on this page\n> A margin note. ^nt-4c8a17\n<!-- tagged-sync:end -->");
		expect(rewritten).not.toContain("old text");
		expect(rewritten).toContain("my notes");
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
		await store.write("Old/My Notebook.md", `${await store.read(original)}\n## My own thoughts\n`);

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

	it("leaves a digest note alone — a digest is regenerated by a full sync, not by re-transcribe", async () => {
		const store = fakeStore();
		const path = await writeNote(store, "Work", baseFields({ digest: "\n> [!note] on this page\n> A margin note. ^nt-4c8a17" }));
		const before = (await store.read(path))!;
		store.write.mockClear();

		expect(await updateTranscript(store, path, "fresh vision text")).toBe(false);
		expect(store.write).not.toHaveBeenCalled();
		expect(await store.read(path)).toBe(before);
	});

	it("returns false when the note has no managed transcript block", async () => {
		const store = fakeStore({ "Work/Plain.md": "Just my own note, no fence.\n" });

		expect(await updateTranscript(store, "Work/Plain.md", "x")).toBe(false);
	});
});

describe("isEmptyManagedBlock", () => {
	// The negation of `buildManagedBlock`'s sections, kept beside it so one place owns the question
	// "does this render to anything?" -- the sync engine asking it a second way is how #115 happened.
	it("is true only when none of the three inputs becomes a section", () => {
		expect(isEmptyManagedBlock(baseFields({ transcript: "", digest: "", highlights: [] }))).toBe(true);
		expect(isEmptyManagedBlock(baseFields({ transcript: "some text", digest: "", highlights: [] }))).toBe(false);
		expect(isEmptyManagedBlock(baseFields({ transcript: "", digest: "\n### Page 1\n", highlights: [] }))).toBe(false);
		expect(isEmptyManagedBlock(baseFields({ transcript: "", digest: "", highlights: [{ pageLabel: 1, embedPage: 1, quotes: ["a quote"] }] }))).toBe(false);
	});
});

describe("renderTranscript", () => {
	const EMBED = "Attachments/Meeting Notes 2026.pdf";

	function page(pageLabel: number, status: TranscriptPage["status"], text = ""): TranscriptPage {
		return { pageLabel, embedPage: pageLabel, status, text };
	}

	it("heads each page that produced text with a link into the embedded page", () => {
		const rendered = renderTranscript(EMBED, [page(1, "ok", "Kickoff"), page(2, "ok", "Standup")], "unused");

		expect(rendered).toBe(`### [[${EMBED}#page=1|Page 1]]\n\nKickoff\n\n### [[${EMBED}#page=2|Page 2]]\n\nStandup`);
	});

	// The reported case: a 5-page PDF written on 1, 3 and 5. The numbering has to jump rather than
	// renumber, or the header points at a page the reader never wrote on.
	it("skips pages with no text and lets the numbering jump", () => {
		const rendered = renderTranscript(
			EMBED,
			[page(1, "ok", "first"), page(2, "skipped"), page(3, "ok", "third"), page(4, "skipped"), page(5, "ok", "fifth")],
			"unused",
		);

		expect(rendered).toContain(`### [[${EMBED}#page=3|Page 3]]`);
		expect(rendered).not.toContain("Page 2");
		expect(rendered).toContain("*No text on pages 2, 4.*");
	});

	it("collapses a run of three or more blank pages, and keeps a pair spelled out", () => {
		const pages = [page(1, "ok", "first"), page(2, "skipped"), page(3, "skipped"), page(4, "skipped"), page(5, "skipped"), page(6, "ok", "sixth"), page(7, "skipped"), page(8, "skipped")];

		expect(renderTranscript(EMBED, pages, "unused")).toContain("*No text on pages 2–5, 7, 8.*");
	});

	it("says page, singular, for a single blank page", () => {
		expect(renderTranscript(EMBED, [page(1, "ok", "first"), page(2, "skipped"), page(3, "ok", "third")], "unused")).toContain("*No text on page 2.*");
	});

	// A 29-page notebook drawn on but never written on: the line is the whole transcript, which says
	// more than the empty section it replaces.
	it("is just the summary line when no page produced text", () => {
		const pages = Array.from({ length: 29 }, (_, i) => page(i + 1, "skipped"));

		expect(renderTranscript(EMBED, pages, "unused")).toBe("*No text on pages 1–29.*");
	});

	it("keeps a failed page's heading and says so, and leaves it out of the summary line", () => {
		const rendered = renderTranscript(EMBED, [page(1, "ok", "first"), page(2, "failed"), page(3, "skipped")], "unused");

		expect(rendered).toContain(`### [[${EMBED}#page=2|Page 2]]\n\n> [!warning] Could not read this page`);
		// Named once, on its own page -- not a second time in the blank-page footnote.
		expect(rendered).toContain("*No text on page 3.*");
		expect(rendered).not.toContain("pages 2");
	});

	// The filename already carries "— Page 7" and the highlight callout repeats it; a third would be noise.
	it("renders a single-page unit bare, with no heading", () => {
		expect(renderTranscript(EMBED, [{ pageLabel: 7, embedPage: 1, status: "ok", text: "just this" }], "unused")).toBe("just this");
		expect(renderTranscript(EMBED, [{ pageLabel: 7, embedPage: 1, status: "skipped", text: "" }], "unused")).toBe("");
		expect(renderTranscript(EMBED, [{ pageLabel: 7, embedPage: 1, status: "failed", text: "" }], "unused")).toBe("> [!warning] Could not read this page");
	});

	// Issue #115: a page of typed text is not transcribed and is not blank, and "No text on page 2"
	// printed over a page that is nothing but text would be false.
	it("names a typed page on a line of its own, apart from the blank ones", () => {
		const rendered = renderTranscript(EMBED, [page(1, "ok", "first"), page(2, "typed"), page(3, "skipped")], "unused");

		expect(rendered).toContain("*Page 2 is typed text — see the embedded page.*");
		expect(rendered).toContain("*No text on page 3.*");
		expect(rendered).not.toContain("pages 2");
	});

	it("collapses a run of typed pages the way it collapses blank ones", () => {
		const pages = [page(1, "typed"), page(2, "typed"), page(3, "typed"), page(4, "ok", "handwriting")];

		expect(renderTranscript(EMBED, pages, "unused")).toContain("*Pages 1–3 are typed text — see the embedded pages.*");
	});

	// Ticket 05: the digest carries the quotes of the pages it covers, and the rest sit under the page
	// they were made on. Told apart by their form -- bullets are the device's own words, a paragraph is
	// what was read off the ink -- rather than by a label that would be noise on every ordinary page.
	it("folds a page's quotes in above its transcribed ink", () => {
		const rendered = renderTranscript(EMBED, [page(1, "ok", "first"), page(2, "ok", "Anna fragt nach dem Termin")], "unused", {
			highlights: [{ pageLabel: 2, embedPage: 2, quotes: ["Budget: 12.000 €"] }],
		});

		expect(rendered).toContain(`### [[${EMBED}#page=2|Page 2]]\n\n- Budget: 12.000 €\n\nAnna fragt nach dem Termin`);
		expect(rendered).not.toContain("## Highlights");
	});

	// The quote has to sit somewhere, and "no text on page 2" would be false printed above one.
	it("gives a page with a quote and no ink its heading, and leaves it out of the blank-page line", () => {
		const rendered = renderTranscript(EMBED, [page(1, "ok", "first"), page(2, "skipped"), page(3, "skipped")], "unused", {
			highlights: [{ pageLabel: 2, embedPage: 2, quotes: ["A marked sentence."] }],
		});

		expect(rendered).toContain(`### [[${EMBED}#page=2|Page 2]]\n\n- A marked sentence.`);
		expect(rendered).toContain("*No text on page 3.*");
		expect(rendered).not.toContain("pages 2");
	});

	// A digest takes pages out of the list, so the list is no longer the unit's size. Reading it off
	// the list would drop the heading of the one page left in a notebook whose other four are digested,
	// and leave the reader unable to tell which page they are looking at.
	it("keeps the page heading when a digest has left only one page in the transcript", () => {
		const rendered = renderTranscript(EMBED, [page(5, "ok", "the last page")], "unused", { unitPages: 5 });

		expect(rendered).toBe(`### [[${EMBED}#page=5|Page 5]]\n\nthe last page`);
	});

	// A page tag on a page of typed text: no heading (the filename carries the page), and the naming
	// line instead of a transcript nobody asked a model to guess at.
	it("names the page of a single-page unit whose text was typed", () => {
		expect(renderTranscript(EMBED, [{ pageLabel: 7, embedPage: 1, status: "typed", text: "" }], "unused")).toBe(
			"*Page 7 is typed text — see the embedded page.*",
		);
	});

	it("still renders a genuinely single-page unit bare", () => {
		expect(renderTranscript(EMBED, [page(1, "ok", "just this")], "unused", { unitPages: 1 })).toBe("just this");
	});

	// `off`, an unavailable backend, and any arity violation the sync engine refused to trust.
	it("falls back to the unlabelled text when there is no per-page information", () => {
		expect(renderTranscript(EMBED, null, "one flat blob")).toBe("one flat blob");
	});

	// The managed block is swapped by regex, so a transcript that broke the swap would take the
	// user's own notes below the fence with it.
	it("survives the managed-block swap with every page form in it", async () => {
		const transcript = renderTranscript(EMBED, [page(1, "ok", "first"), page(2, "failed"), page(3, "skipped")], "unused");
		const note = buildNoteContent(baseFields({ embedPath: EMBED, transcript }), null) + "My own notes.\n";
		const store = fakeStore({ "Work/Note.md": note });

		expect(await updateTranscript(store, "Work/Note.md", "REPLACED")).toBe(true);

		const after = (await store.read("Work/Note.md"))!;
		expect(after).toContain("## Transcript\nREPLACED\n<!-- tagged-sync:end -->");
		expect(after).toContain("My own notes.");
	});
});
