// Freezes a reference vault: what *this* build leaves behind after a first sync.
//
//   npm run freeze-state
//
// Run once per release, **immediately after the tag** and in a PR of its own (docs/RELEASING.md
// step 8), so the repo always carries a state produced by the last shipped version. At that moment
// the tree is byte-identical to what shipped. `versionGate` in `release-checks.mjs` fails the *next*
// release if it was skipped, and names the version it expected.
//
// It used to run inside the release PR, and that could never work: the state would then come from
// the build being released rather than the one before it. Cutting 1.5.0 proved it -- freeze and five
// tests go red, skip it and the gate goes red.
//
// **It overwrites in place.** Retirement is not a separate step: only one state ever exists, and git
// holds the previous one in history, where a frozen artefact belongs.
//
// **Running it at any other time is destructive, and this script is the only thing that can say so**
// -- so it refuses unless `HEAD` carries the tag for `manifest.json`'s version. A state frozen
// mid-cycle comes from a tree nobody ever shipped, which quietly voids the one property the whole
// fixture exists for. Nothing downstream can see it: the version gate compares version *strings* and
// the upgrade tests bring their own renderer bump since ticket 23, so both stay green on a state
// that is a lie. `--anyway` overrides the refusal, for the case where a shipped build has to be
// reproduced from a tree the tag does not point at any more.
//
// It never touches Obsidian. `runSync` takes a `SyncDeps` bag and every reach for the vault is behind
// `NoteStore`/`AttachmentStore`, so an fs-backed pair of those is the whole harness -- which is also
// why this runs against an *older* checkout unchanged: `SyncDeps` is the seam, and it is the same
// five interfaces in both trees.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AttachmentStore } from "../../src/attachment-writer";
import type { NoteStore } from "../../src/note-builder";
import { OffOcrBackend } from "../../src/off-ocr-backend";
import { EMPTY_SYNC_INDEX, RENDER_VERSION, runSync } from "../../src/sync-engine";
import { TagRouter } from "../../src/tag-router";
import { legacyDevice, ROOT_HASH, TAG_FOLDER_MAP } from "./device";

/**
 * Where the frozen state lives. Not `test/`: that directory is the gitignored demo vault, which is
 * also why the feature matrix sits in `test-matrix/` rather than under `test/`.
 *
 * Resolved from the working directory rather than from `import.meta.url`, because this file is run
 * as an esbuild bundle in `/tmp` -- the URL of the *bundle* says nothing about where the repo is.
 * `npm run` always sets the working directory to the package root.
 */
const STATE_DIR = join(process.cwd(), "test-fixtures", "legacy-state");
const VAULT = join(STATE_DIR, "vault");
const DATA_JSON = join(VAULT, ".obsidian", "plugins", "remarkable-tagged-sync", "data.json");

/** The clock the state is frozen at. Fixed, so two freezes of the same code differ only in the PDFs. */
const FROZEN_AT = "2026-01-01T00:00:00.000Z";

function write(path: string, data: string | Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, data);
}

function fsNoteStore(root: string): NoteStore {
	return {
		read: async (path) => {
			try {
				return (await import("node:fs")).readFileSync(join(root, path), "utf8");
			} catch {
				return null;
			}
		},
		/**
		 * The filesystem, not a name index -- which is the whole point of the member (ticket 18). An
		 * older checkout of the engine does not call this at all, which is why one driver serves both
		 * trees: a store may offer more than the caller uses, never less.
		 */
		exists: async (path) => (await import("node:fs")).existsSync(join(root, path)),
		write: async (path, content) => write(join(root, path), content),
		ensureFolder: async (path) => {
			mkdirSync(join(root, path), { recursive: true });
		},
		move: async (fromPath, toPath) => {
			const fs = await import("node:fs");
			if (!fs.existsSync(join(root, fromPath))) return;
			mkdirSync(dirname(join(root, toPath)), { recursive: true });
			fs.renameSync(join(root, fromPath), join(root, toPath));
		},
	};
}

function fsAttachmentStore(root: string): AttachmentStore {
	return {
		ensureFolder: async (path) => {
			mkdirSync(join(root, path), { recursive: true });
		},
		writeBinary: async (path, data) => write(join(root, path), new Uint8Array(data)),
	};
}

/**
 * Refuses a freeze from a tree that is not the one a release was tagged at (see the header). Checked
 * before anything is deleted, because the previous state is only recoverable from git.
 */
async function requireTaggedTree(version: string): Promise<void> {
	if (process.argv.includes("--anyway")) {
		console.warn(`freezing from an untagged tree because --anyway was passed; the state will claim to be ${version}`);
		return;
	}
	const { execFileSync } = await import("node:child_process");
	// `--points-at HEAD` and not `git describe`: a tag on an ancestor is precisely the case to refuse.
	const tags = execFileSync("git", ["tag", "--points-at", "HEAD"], { encoding: "utf8" }).split("\n");
	if (tags.includes(version)) return;
	throw new Error(
		`HEAD does not carry the tag ${version}, so this tree is not what release ${version} shipped.\n` +
			"Freeze right after tagging (docs/RELEASING.md step 8), or pass --anyway if you know the tree matches.",
	);
}

async function main(): Promise<void> {
	const manifestVersion = (
		JSON.parse((await import("node:fs")).readFileSync(join(process.cwd(), "manifest.json"), "utf8")) as { version: string }
	).version;
	await requireTaggedTree(manifestVersion);

	rmSync(STATE_DIR, { recursive: true, force: true });
	mkdirSync(VAULT, { recursive: true });

	const result = await runSync(
		{
			api: legacyDevice(),
			tagRouter: new TagRouter(TAG_FOLDER_MAP),
			noteStore: fsNoteStore(VAULT),
			attachmentStore: fsAttachmentStore(VAULT),
			ocrBackend: new OffOcrBackend(),
			now: () => FROZEN_AT,
		},
		EMPTY_SYNC_INDEX,
	);

	// A mis-wired replay does not throw -- every page comes back empty, the engine catches it, and the
	// run reports success over nothing. Refusing an empty freeze is the only thing that catches it.
	if (result.notesWritten === 0) throw new Error("freeze wrote no notes -- the fake device is mis-wired");
	if (result.skipErrors.length > 0) throw new Error(`freeze had skips: ${result.skipErrors.join("; ")}`);

	write(
		DATA_JSON,
		`${JSON.stringify(
			{
				deviceToken: "frozen-device-token",
				tagFolderMap: TAG_FOLDER_MAP,
				syncIndex: result.index,
				ocrBackend: "off",
				llmProviders: {},
				ocrUnavailableNoticeShown: false,
				autoSync: { enabled: false, intervalHours: 6, autoTranscribeMetered: false },
				lastSyncAt: FROZEN_AT,
				attachmentsFolder: "tagged-sync/attachments",
				marginNotes: false,
			},
			null,
			"\t",
		)}\n`,
	);

	write(
		join(STATE_DIR, "meta.json"),
		`${JSON.stringify({ version: manifestVersion, renderVersion: RENDER_VERSION, rootHash: ROOT_HASH, producedAt: FROZEN_AT }, null, "\t")}\n`,
	);

	console.log(`froze ${result.notesWritten} note(s) from ${manifestVersion} (renderVersion ${RENDER_VERSION}) into test-fixtures/legacy-state`);
}

await main();
