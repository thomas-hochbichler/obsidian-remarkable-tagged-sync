// The three adapters that put every path this plugin computes into the vault. They were the last
// 36 lines of `main.ts` that touched a file, and they are here because nothing could test them
// there: `main.ts` holds the `Plugin` subclass, and a `Plugin` subclass cannot be constructed
// without Obsidian.
//
// This is the whole of gap G01 -- the only gap on the list where what gets destroyed is content the
// *user* wrote. Everything a sync writes is regenerable; a clobbered open note is not.

import { type App, normalizePath, TFolder, type Vault } from "obsidian";
import type { AttachmentStore } from "./attachment-writer";
import type { NoteStore } from "./note-builder";
import type { TagFolderMap } from "./tag-router";

export async function ensureFolder(vault: Vault, path: string): Promise<void> {
	const p = normalizePath(path);
	if (vault.getFolderByPath(p)) return;
	await vault.createFolder(p);
}

/**
 * Resolves a configured folder path to the name the vault actually holds (issue #73).
 *
 * A folder setting is typed text, and on macOS and Windows the filesystem folds case while the
 * file index does not. A user whose vault holds `media/` and whose attachments setting says
 * `Media` therefore fails every index lookup and hits every filesystem write -- `ensureFolder`
 * throws "Folder already exists." on a folder that is, by the only reading that matters, already
 * there. Swallowing that throw is the wrong repair: the notes would land in `media/` while
 * `data.json` records `Media/...`, paths the index can never resolve again (ticket 18). So the
 * configured path is resolved to the vault's real casing *before* anything downstream is derived
 * from it, segment by segment, keeping the typed casing for segments that do not exist yet.
 *
 * The adapter, not a blanket lowercase comparison, decides whether a segment is taken: on Linux
 * nothing folds, `work/` and `Work/` really are two folders, and this function must not merge
 * them. A segment the filesystem calls taken but the index cannot name (a file in the way, say)
 * is left as typed -- the write that follows will refuse it loudly, which is the honest outcome.
 */
export async function resolveFolderCasing(vault: Vault, path: string): Promise<string> {
	const p = normalizePath(path);
	if (p === "/" || vault.getFolderByPath(p)) return p;
	const segments = p.split("/");
	let resolved = "";
	for (let i = 0; i < segments.length; i++) {
		const candidate = resolved === "" ? segments[i] : `${resolved}/${segments[i]}`;
		if (vault.getFolderByPath(candidate)) {
			resolved = candidate;
			continue;
		}
		const typedTail = segments.slice(i).join("/");
		if (!(await vault.adapter.exists(candidate))) return resolved === "" ? p : `${resolved}/${typedTail}`;
		const lower = candidate.toLowerCase();
		const match = vault.getAllLoadedFiles().find((f) => f instanceof TFolder && f.path.toLowerCase() === lower);
		if (!match) return resolved === "" ? p : `${resolved}/${typedTail}`;
		resolved = match.path;
	}
	return resolved;
}

/** {@link resolveFolderCasing} over every folder a tag is mapped to, for the router a sync runs on. */
export async function resolveTagMapCasing(vault: Vault, mapping: TagFolderMap): Promise<TagFolderMap> {
	const resolved: TagFolderMap = {};
	for (const [tag, folder] of Object.entries(mapping)) resolved[tag] = await resolveFolderCasing(vault, folder);
	return resolved;
}

/**
 * Every path crossing into the vault goes through `normalizePath` first, and this is not tidiness.
 *
 * `Vault.create`, `createBinary` and `createFolder` normalize the path they are given; every lookup
 * -- `getFileByPath`, `getFolderByPath` -- does not, and compares the raw string against the file
 * index. So a path carrying a non-breaking space, or standing in NFD, is written under one name and
 * looked up under another. The note is created, the next sync cannot find it, decides the user
 * deleted it, writes it again, and `create` throws "File already exists." on a path that prints
 * identically to the one it just asked for. Every sync of that notebook fails from then on.
 *
 * `sanitizeFilenamePart` stops new names from being built that way. This stops the ones already
 * stored in `data.json` from staying unfindable -- so the repair needs no migration: the same row
 * simply resolves again.
 */
export function createNoteStore(app: App): NoteStore {
	const { vault } = app;
	return {
		read: async (path) => {
			const file = vault.getFileByPath(normalizePath(path));
			return file ? vault.read(file) : null;
		},
		// The adapter, not the file index, and this is the one place in the plugin that reaches past
		// the index on purpose. `Vault.create` decides whether to throw by calling this same method,
		// so asking it here is the only way to ask a question that cannot disagree with the answer.
		//
		// It costs a real difference on macOS and Windows: the filesystem folds case, so a vault
		// holding `Work/My Notebook.md` reports `Work/my notebook.md` as taken and the caller
		// suffixes instead of throwing. On Linux nothing folds and nothing changes. Over-refusing
		// costs one ` (tag)` in a filename; under-refusing costs a notebook its sync, permanently.
		exists: (path) => vault.adapter.exists(normalizePath(path)),
		write: async (path, content) => {
			const p = normalizePath(path);
			const file = vault.getFileByPath(p);
			// process() over modify(): a sync writes notes the user may have open in an editor.
			if (file) await vault.process(file, () => content);
			else await vault.create(p, content);
		},
		move: async (fromPath, toPath) => {
			const file = vault.getFileByPath(normalizePath(fromPath));
			if (file) await app.fileManager.renameFile(file, normalizePath(toPath));
		},
		ensureFolder: (path) => ensureFolder(vault, path),
	};
}

export function createAttachmentStore(vault: Vault): AttachmentStore {
	return {
		ensureFolder: (path) => ensureFolder(vault, path),
		// Normalized for the same reason as the note store above: createBinary normalizes, the lookup
		// that decides between overwrite and create does not.
		writeBinary: async (path, data) => {
			const p = normalizePath(path);
			const file = vault.getFileByPath(p);
			if (file) await vault.modifyBinary(file, data);
			else await vault.createBinary(p, data);
		},
	};
}
