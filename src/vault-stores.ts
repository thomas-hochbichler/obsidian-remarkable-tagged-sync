// The three adapters that put every path this plugin computes into the vault. They were the last
// 36 lines of `main.ts` that touched a file, and they are here because nothing could test them
// there: `main.ts` holds the `Plugin` subclass, and a `Plugin` subclass cannot be constructed
// without Obsidian.
//
// This is the whole of gap G01 -- the only gap on the list where what gets destroyed is content the
// *user* wrote. Everything a sync writes is regenerable; a clobbered open note is not.

import { type App, normalizePath, type Vault } from "obsidian";
import type { AttachmentStore } from "./attachment-writer";
import type { NoteStore } from "./note-builder";

export async function ensureFolder(vault: Vault, path: string): Promise<void> {
	const p = normalizePath(path);
	if (vault.getFolderByPath(p)) return;
	await vault.createFolder(p);
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
