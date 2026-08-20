import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttachmentStore } from "./attachment-writer";
import type { NoteStore } from "./note-builder";
import { OffOcrBackend } from "./off-ocr-backend";
import { legacyDevice, TAG_FOLDER_MAP } from "../scripts/legacy-state/device";
import { RENDER_VERSION, runSync, type SyncIndex } from "./sync-engine";
import { TagRouter } from "./tag-router";

// The upgrade test: today's engine, run against a vault the **last shipped release** actually wrote.
//
// The state in `test-fixtures/legacy-state/` was produced by tag 1.4.2's own build, replayed against
// the fake device beside it (`npm run freeze-state`, run at that tag). It is not an invented "old"
// vault: an invented one only proves the current version copes with something we made up, and the
// assumption about what old looked like is the same assumption that was already wrong once -- issue
// #10 was an ancient notebook nobody had expected.
//
// Two properties of the frozen state make this exercise the full write path rather than the
// nothing-to-do path, and both are checked out loud below: its rows carry `renderVersion: 23` where
// today's is 30, and its mapping fingerprint carries the `2:` prefix where today's is `3:`.
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

/** Today's engine, over the frozen state and the same device it was frozen from. */
async function upgrade(index: SyncIndex, mapping: Record<string, string> = TAG_FOLDER_MAP) {
	return runSync(
		{
			api: legacyDevice(),
			tagRouter: new TagRouter(mapping),
			noteStore: fsNoteStore(),
			attachmentStore: fsAttachmentStore(),
			ocrBackend: new OffOcrBackend(),
			now: () => "2026-06-01T00:00:00.000Z",
		},
		index,
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
	it("was produced by the previous release, and is stale in the two ways that make it a test", () => {
		const meta = JSON.parse(readFileSync(join(STATE, "meta.json"), "utf8")) as { version: string; renderVersion: number };
		const data = openFrozenVault();

		expect(meta.version).not.toBe("");
		// Stale renders are what force `runSync` past the root-hash gate even though the device has not
		// moved a byte. Without this the plain upgrade run hits the early return and asserts nothing.
		expect(meta.renderVersion).toBeLessThan(RENDER_VERSION);
		expect(Object.values(data.syncIndex.rows).every((row) => (row.renderVersion ?? 0) < RENDER_VERSION)).toBe(true);
		// And the routing fingerprint's own version moved, which is the second forcing path.
		expect(data.syncIndex.mappings?.startsWith(`${RENDER_VERSION}`)).not.toBe(true);
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
	it("keeps what the user wrote below the fence, across seven renderer versions", async () => {
		const data = openFrozenVault();
		const before = data.syncIndex.rows["doc-notes:sync"].notePath;
		writeNote(before, `${readNote(before)}\n\nMy own thoughts about this notebook.\n`);
		writeNote("Reading/A note of my own.md", "Nothing to do with the plugin.\n");

		const result = await upgrade(data.syncIndex);

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

		const result = await upgrade(data.syncIndex);

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
		// `pdf-lib` stamps the wall clock into a compressed stream, so two renders of the same page
		// differ in content and in length. The path, the existence and the page count are the
		// assertable facts; a hash here would fail on every run for no reason.
		const data = openFrozenVault();
		const attachment = "tagged-sync/attachments/doc-notes.pdf";
		const beforeBytes = readFileSync(join(vault, attachment));

		await upgrade(data.syncIndex);

		const afterBytes = readFileSync(join(vault, attachment));
		expect(afterBytes.length).toBeGreaterThan(0);
		expect(readNote(data.syncIndex.rows["doc-notes:sync"].notePath)).toContain(`![[${attachment}]]`);
		// Stated rather than assumed: they really are different bytes, and that is not a change.
		expect(afterBytes.equals(beforeBytes)).toBe(false);
	});

	it("finds nothing left to do on a second upgrade, which is what a settled vault looks like", async () => {
		const data = openFrozenVault();

		const first = await upgrade(data.syncIndex);
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

		const result = await upgrade(data.syncIndex);

		const owners = ownership(result.index);
		expect(owners.unclaimed).toEqual([stranded]);
		expect(markdownFiles().filter((path) => path.startsWith("Reading/Reading List"))).toHaveLength(2);
	});
});
