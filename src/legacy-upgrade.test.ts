import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttachmentStore } from "./attachment-writer";
import type { NoteStore } from "./note-builder";
import { OffOcrBackend } from "./off-ocr-backend";
import { stampRowFolders } from "./settings-store";
import { legacyDevice, TAG_FOLDER_MAP } from "../scripts/legacy-state/device";
import { RENDER_VERSION, runSync, type SyncApi, type SyncIndex } from "./sync-engine";
import { TagRouter } from "./tag-router";

// The upgrade test: today's engine, run against a vault the **last shipped release** actually wrote.
//
// The state in `test-fixtures/legacy-state/` was produced by a shipped release's own build, replayed
// against the fake device beside it (`npm run freeze-state`, run right after that release's tag). It
// is not an invented "old" vault: an invented one only proves the current version copes with
// something we made up, and the assumption about what old looked like is the same assumption that was
// already wrong once -- issue #10 was an ancient notebook nobody had expected.
//
// **What makes an upgrade do any work belongs to the scenario, not to the fixture** (ticket 23). An
// unchanged device, an unchanged mapping and an unchanged renderer add up to an upgrade that really
// does nothing, and `runSync` returns early on exactly that. Each scenario below therefore brings its
// own reason to run: a renderer that moved (`afterARendererBump`), a re-pointed tag, a deleted note,
// a row an interrupted sync never wrote. The freeze itself cannot supply one -- it stamps the
// renderer of the build it froze -- which is why four of these tests used to go red in the very PR
// that ran it.
//
// **Attachment bytes are never asserted.** `pdf-lib` stamps `CreationDate`/`ModDate` from the wall
// clock into a Flate-compressed object stream, so two renders of the same page differ in content
// *and* in length. Paths, existence and page counts are assertable; hashes are not.

const STATE = join(process.cwd(), "test-fixtures", "legacy-state");
const FROZEN_VAULT = join(STATE, "vault");
const DATA_JSON = join(".obsidian", "plugins", "remarkable-tagged-sync", "data.json");
const FENCE = "<!-- tagged-sync:end -->";

interface FrozenData {
	tagFolderMap: Record<string, string>;
	syncIndex: SyncIndex;
}

let vault: string;

/** The vault as the old release left it, copied somewhere this test may write. */
function openFrozenVault(): FrozenData {
	vault = mkdtempSync(join(tmpdir(), "tagged-sync-upgrade-"));
	cpSync(FROZEN_VAULT, vault, { recursive: true });
	return JSON.parse(readFileSync(join(vault, DATA_JSON), "utf8")) as FrozenData;
}

/**
 * The frozen index as the release *after* the one that wrote it sees it: managed notes rendered by a
 * renderer older than today's.
 *
 * This is what a renderer bump does to a real vault, and it is the reason an upgrade re-renders
 * anything at all. It is a scenario, not a repair of the fixture: nothing in the vault is touched --
 * the notes, their block hashes and the attachments stay exactly as the old release wrote them, and
 * `meta.renderVersion` keeps saying which renderer that was.
 *
 * Without it these scenarios would depend on *when* the state was frozen. A freeze stamps today's
 * `RENDER_VERSION`, so between a tag and the next renderer change the frozen state is not stale, and
 * every one of them would quietly assert nothing (ticket 23).
 */
function afterARendererBump(data: FrozenData): SyncIndex {
	const rows = Object.fromEntries(
		Object.entries(data.syncIndex.rows).map(([key, row]) => [key, { ...row, renderVersion: RENDER_VERSION - 1 }]),
	);
	return { ...data.syncIndex, rows };
}

/**
 * The frozen index with today's renderer on every row: a vault with nothing stale in it, for the
 * one scenario whose point is that nothing *but* its own change gets written. The mirror image of
 * `afterARendererBump`, and needed for the same ticket-23 reason: frozen right after a tag the
 * state is current and the scenario holds by accident, one renderer bump later everything is stale
 * and "only the new document is written" fails on rows the scenario never touched.
 */
function withTodaysRenderer(data: FrozenData): SyncIndex {
	const rows = Object.fromEntries(
		Object.entries(data.syncIndex.rows).map(([key, row]) => [key, { ...row, renderVersion: RENDER_VERSION }]),
	);
	return { ...data.syncIndex, rows };
}

/**
 * The frozen device with one more document that just gained the already-mapped tag -- issue #101's
 * step 5. Everything the old release synced is byte-identical (same entry hashes, same pages); only
 * the root hash and the one new entry differ, exactly what a single tag change looks like.
 */
function withNewlyTaggedDocument(api: SyncApi): SyncApi {
	const entry = {
		id: "doc-extra",
		hash: "h-doc-extra",
		visibleName: "Latecomer",
		lastModified: "2000",
		pinned: false,
		parent: "",
		type: "DocumentType",
		fileType: "notebook",
		lastOpened: "0",
		tags: [{ name: "sync", timestamp: 0 }],
	};
	const content = {
		coverPageNumber: 0,
		documentMetadata: {},
		extraMetadata: {},
		fileType: "notebook",
		fontName: "",
		lineHeight: -1,
		orientation: "portrait",
		pageCount: 1,
		textAlignment: "",
		textScale: 1,
		cPages: {
			lastOpened: { timestamp: "1:1", value: "" },
			original: { timestamp: "1:1", value: 0 },
			uuids: null,
			pages: [{ id: "page-extra", idx: { timestamp: "1:1", value: "a" } }],
		},
	};
	return {
		...api,
		listItems: async () => [...(await api.listItems()), entry] as never,
		getContent: async (id) => (id === "doc-extra" ? (content as never) : api.getContent(id)),
		raw: {
			...api.raw,
			getRootHash: async () => ["root-legacy-state-plus-one-tag", 1, 4] as never,
			getEntries: async (fileName) =>
				fileName === "doc-extra.docSchema"
					? ({ entries: [{ id: "doc-extra/page-extra.rm", hash: "h-page-extra", type: 0 as const, subfiles: 0, size: 0 }] } as never)
					: api.raw.getEntries(fileName),
			getHash: async (fileName) =>
				fileName === "doc-extra/page-extra.rm"
					? (new Uint8Array(readFileSync(join(process.cwd(), "test-fixtures", "rmv6", "normal-a-stroke-2-layers.rm"))) as never)
					: api.raw.getHash(fileName),
		},
	};
}

const readNote = (path: string): string => readFileSync(join(vault, path), "utf8");

function writeNote(path: string, content: string): void {
	mkdirSync(dirname(join(vault, path)), { recursive: true });
	writeFileSync(join(vault, path), content);
}

/** Every markdown file in the vault, as vault-relative paths. */
function markdownFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".md")) out.push(relative(vault, full));
		}
	};
	walk(vault);
	return out.sort();
}

function fsNoteStore(): NoteStore {
	return {
		read: async (path) => {
			try {
				return readFileSync(join(vault, path), "utf8");
			} catch {
				return null;
			}
		},
		exists: async (path) => (await import("node:fs")).existsSync(join(vault, path)),
		write: async (path, content) => {
			writeNote(path, content);
		},
		ensureFolder: async (path) => {
			mkdirSync(join(vault, path), { recursive: true });
		},
		move: async (fromPath, toPath) => {
			const fs = await import("node:fs");
			if (!fs.existsSync(join(vault, fromPath))) return;
			mkdirSync(dirname(join(vault, toPath)), { recursive: true });
			fs.renameSync(join(vault, fromPath), join(vault, toPath));
		},
	};
}

function fsAttachmentStore(): AttachmentStore {
	return {
		ensureFolder: async (path) => {
			mkdirSync(join(vault, path), { recursive: true });
		},
		writeBinary: async (path, data) => {
			mkdirSync(dirname(join(vault, path)), { recursive: true });
			writeFileSync(join(vault, path), new Uint8Array(data));
		},
	};
}

/**
 * Today's engine, over the frozen state and the same device it was frozen from.
 *
 * The index goes through the load-time stamp with the *frozen* settings first, as `main.ts` does
 * when the new version starts: the old release wrote no `folder` on its rows, and a scenario that
 * then changes the mapping is the user re-targeting a tag in the new version's settings.
 */
async function upgrade(index: SyncIndex, mapping: Record<string, string> = TAG_FOLDER_MAP, api: SyncApi = legacyDevice()) {
	return runSync(
		{
			api,
			tagRouter: new TagRouter(mapping),
			noteStore: fsNoteStore(),
			attachmentStore: fsAttachmentStore(),
			ocrBackend: new OffOcrBackend(),
			now: () => "2026-06-01T00:00:00.000Z",
		},
		stampRowFolders(index, TAG_FOLDER_MAP),
	);
}

/**
 * A1's real form. The naive version reads a fixed path and **crashes** the moment a legitimate
 * re-mapping moves the note, so the note has to be resolved through the row that owns it.
 */
const noteOf = (result: { index: SyncIndex }, syncKey: string): string => readNote(result.index.rows[syncKey].notePath);

/**
 * A6, and the sharpest assertion here: every markdown file carrying the fence marker is the
 * `notePath` of exactly one active row.
 *
 * "No note duplicated" as usually written is "no note added", and that is wrong in both directions:
 * it calls the *intended* recreation of a hand-deleted note damage, and it catches the real
 * duplicate only by accident. This separates them, and its second half catches the collision case
 * too -- two rows writing to one path.
 */
function ownership(index: SyncIndex): { unclaimed: string[]; doubleClaimed: string[] } {
	const active = Object.values(index.rows).filter((row) => row.status === "active");
	const claims = new Map<string, number>();
	for (const row of active) claims.set(row.notePath, (claims.get(row.notePath) ?? 0) + 1);

	const managed = markdownFiles().filter((path) => readNote(path).includes(FENCE));
	return {
		unclaimed: managed.filter((path) => !claims.has(path)),
		doubleClaimed: [...claims].filter(([, count]) => count > 1).map(([path]) => path),
	};
}

beforeEach(() => {
	vault = "";
});

afterEach(() => {
	if (vault) rmSync(vault, { recursive: true, force: true });
});

describe("the frozen state itself", () => {
	it("was produced by a shipped release, and every row carries the renderer that wrote it", () => {
		const meta = JSON.parse(readFileSync(join(STATE, "meta.json"), "utf8")) as { version: string; renderVersion: number };
		const data = openFrozenVault();

		expect(meta.version).not.toBe("");
		// Deliberately not `<`. The state is frozen right after a tag, so its renderer is today's until
		// the next bump -- asserting staleness here made the freeze fail in the PR that ran it, and made
		// the whole suite depend on when that happened (ticket 23). The scenarios age it themselves.
		expect(meta.renderVersion).toBeLessThanOrEqual(RENDER_VERSION);
		// What is worth pinning is that the file and the vault agree: `meta.json` is the only place a
		// reader can see which renderer produced these notes, and a freeze that wrote one and left the
		// other would make every scenario below claim the wrong thing about its own starting point.
		expect(Object.values(data.syncIndex.rows).every((row) => (row.renderVersion ?? 0) === meta.renderVersion)).toBe(true);
	});

	it("holds the three shapes duplication bugs live in", () => {
		const data = openFrozenVault();
		const rows = Object.values(data.syncIndex.rows);

		// One document under two tags -- the "same note written twice" case.
		expect(rows.filter((row) => row.docId === "doc-notes")).toHaveLength(2);
		// One document tagged by folder inheritance rather than directly.
		expect(rows.some((row) => row.docId === "doc-paper" && row.tag === "read")).toBe(true);
		// A nested target folder, so a mapping is more than one path segment.
		expect(data.tagFolderMap.work).toContain("/");
		expect(ownership(data.syncIndex)).toEqual({ unclaimed: [], doubleClaimed: [] });
	});
});

describe("upgrading a vault the last release wrote", () => {
	it("keeps what the user wrote below the fence when the renderer moves under it", async () => {
		const data = openFrozenVault();
		const before = data.syncIndex.rows["doc-notes:sync"].notePath;
		writeNote(before, `${readNote(before)}\n\nMy own thoughts about this notebook.\n`);
		writeNote("Reading/A note of my own.md", "Nothing to do with the plugin.\n");

		const result = await upgrade(afterARendererBump(data));

		expect(result.notesWritten).toBeGreaterThan(0);
		expect(noteOf(result, "doc-notes:sync")).toContain("My own thoughts about this notebook.");
		// A file the plugin never wrote is not the plugin's to touch.
		expect(readNote("Reading/A note of my own.md")).toBe("Nothing to do with the plugin.\n");
	});

	it("refuses to overwrite a managed block the user edited, and counts it", async () => {
		// The one assertion here whose failure is silent data loss rather than clutter.
		const data = openFrozenVault();
		const edited = data.syncIndex.rows["doc-paper:read"].notePath;
		writeNote(edited, readNote(edited).replace(FENCE, `A line I typed inside the block.\n\n${FENCE}`));

		const result = await upgrade(afterARendererBump(data));

		expect(result.editedNotesSkipped).toBe(1);
		expect(readNote(edited)).toContain("A line I typed inside the block.");
	});

	it("moves a re-mapped note rather than leaving a second copy behind", async () => {
		const data = openFrozenVault();
		const wasAt = data.syncIndex.rows["doc-notes:sync"].notePath;
		writeNote(wasAt, `${readNote(wasAt)}\n\nMy own thoughts.\n`);

		const result = await upgrade(data.syncIndex, { ...TAG_FOLDER_MAP, sync: "Reading" });

		const nowAt = result.index.rows["doc-notes:sync"].notePath;
		expect(nowAt).toBe("Reading/Field Notes.md");
		expect(markdownFiles()).not.toContain(wasAt);
		// It moved, so the user's paragraph moved with it.
		expect(readNote(nowAt)).toContain("My own thoughts.");
		expect(ownership(result.index)).toEqual({ unclaimed: [], doubleClaimed: [] });
	});

	it("rewrites a note the user moved out of its folder where it lies, instead of dragging it back (#101)", async () => {
		// The old release wrote no `folder` on its rows, so before the stamp a moved note looked
		// re-targeted to the new version and every full scan pulled it home and re-transcribed it.
		// The renderer bump is what makes this upgrade rewrite the note at all.
		const data = openFrozenVault();
		const wasAt = data.syncIndex.rows["doc-notes:sync"].notePath;
		const movedTo = "Projects/Field Notes.md";
		mkdirSync(join(vault, "Projects"), { recursive: true });
		renameSync(join(vault, wasAt), join(vault, movedTo));
		data.syncIndex.rows["doc-notes:sync"] = { ...data.syncIndex.rows["doc-notes:sync"], notePath: movedTo };

		const result = await upgrade(afterARendererBump(data));

		expect(result.index.rows["doc-notes:sync"].notePath).toBe(movedTo);
		expect(markdownFiles()).toContain(movedTo);
		expect(markdownFiles()).not.toContain(wasAt);
		expect(ownership(result.index)).toEqual({ unclaimed: [], doubleClaimed: [] });
	});

	it("writes only a newly tagged document, and a note the user moved stays put (#101)", async () => {
		// The reporter's exact sequence, at the upgrade boundary (ticket 02): a vault the old release
		// wrote, notes moved into folders of their own, then one more document gains the
		// already-mapped tag on the device. 1.6.0 answered by re-importing all 36 documents and
		// dragging the moved notes home; the new document is the only thing this sync may write.
		const data = openFrozenVault();
		const wasAt = data.syncIndex.rows["doc-notes:sync"].notePath;
		const movedTo = "Projects/Field Notes.md";
		mkdirSync(join(vault, "Projects"), { recursive: true });
		renameSync(join(vault, wasAt), join(vault, movedTo));
		data.syncIndex.rows["doc-notes:sync"] = { ...data.syncIndex.rows["doc-notes:sync"], notePath: movedTo };

		const result = await upgrade(withTodaysRenderer(data), TAG_FOLDER_MAP, withNewlyTaggedDocument(legacyDevice()));

		expect(result.notesWritten).toBe(1);
		expect(result.index.rows["doc-extra:sync"].notePath).toBe("Inbox/Latecomer.md");
		expect(markdownFiles()).toContain("Inbox/Latecomer.md");
		expect(result.index.rows["doc-notes:sync"].notePath).toBe(movedTo);
		expect(markdownFiles()).toContain(movedTo);
		expect(markdownFiles()).not.toContain(wasAt);
		expect(ownership(result.index)).toEqual({ unclaimed: [], doubleClaimed: [] });
	});

	it("recreates a note the user deleted, and does not leave a second one beside it", async () => {
		// The case that "no note added" gets wrong: this recreation is the documented behaviour, and an
		// assertion that forbids new files calls it damage.
		const data = openFrozenVault();
		const deleted = data.syncIndex.rows["doc-paper:read"].notePath;
		rmSync(join(vault, deleted));

		const result = await upgrade(data.syncIndex);

		expect(markdownFiles()).toContain(deleted);
		expect(ownership(result.index)).toEqual({ unclaimed: [], doubleClaimed: [] });
	});

	it("leaves every row pointing at a file that exists, under the folder its tag maps to", async () => {
		const data = openFrozenVault();

		const result = await upgrade(data.syncIndex);

		for (const row of Object.values(result.index.rows)) {
			if (row.status !== "active") continue;
			expect(markdownFiles()).toContain(row.notePath);
			expect(row.notePath.startsWith(`${TAG_FOLDER_MAP[row.tag]}/`)).toBe(true);
		}
	});

	it("keeps the attachment at its path, and never asserts its bytes", async () => {
		// `pdf-lib` stamps the wall clock into a compressed stream, so a hash of the render is not a
		// fact about the render. The path, the existence and the embed are; the bytes are not compared
		// in either direction.
		//
		// Comparing two renders for *inequality* is the same mistake wearing the other hat, and it was
		// here until a freshly frozen state exposed it: the stamp only differs once the clock has moved,
		// so freezing and running in the same second made the two renders identical and the assertion
		// red. That the file was rewritten is provable without the clock -- put bytes there that no
		// render produces, and see them gone.
		const data = openFrozenVault();
		const attachment = "tagged-sync/attachments/doc-notes.pdf";
		writeFileSync(join(vault, attachment), "not a PDF at all");

		await upgrade(afterARendererBump(data));

		const afterBytes = readFileSync(join(vault, attachment));
		expect(afterBytes.subarray(0, 5).toString()).toBe("%PDF-");
		expect(readNote(data.syncIndex.rows["doc-notes:sync"].notePath)).toContain(`![[${attachment}]]`);
	});

	it("finds nothing left to do on a second upgrade, which is what a settled vault looks like", async () => {
		const data = openFrozenVault();

		// The bump is what gives the first run something to do -- without it "nothing left to do" would
		// be true of both runs and the test would pass on a vault nobody had touched.
		const first = await upgrade(afterARendererBump(data));
		const second = await upgrade(first.index);

		expect(second.notesWritten).toBe(0);
		expect(second.editedNotesSkipped).toBe(0);
		expect(ownership(second.index)).toEqual({ unclaimed: [], doubleClaimed: [] });
	});
});

describe("a vault an interrupted sync left behind", () => {
	it("is caught by ownership, where 'no note added' would have missed it", async () => {
		// Reproduced the way it happens: a note on disk with no index row -- what an interrupted first
		// sync leaves. The next sync refuses to clobber a file it does not own and writes
		// "Reading List (read).md" beside it, and those duplicates never self-heal.
		const data = openFrozenVault();
		const stranded = data.syncIndex.rows["doc-paper:read"].notePath;
		delete data.syncIndex.rows["doc-paper:read"];

		// A row that was never written leaves the *device* unchanged, so the missing row alone does not
		// open the per-document gate -- the renderer bump is what makes the sync look at the document.
		const result = await upgrade(afterARendererBump(data));

		const owners = ownership(result.index);
		expect(owners.unclaimed).toEqual([stranded]);
		expect(markdownFiles().filter((path) => path.startsWith("Reading/Reading List"))).toHaveLength(2);
	});
});
