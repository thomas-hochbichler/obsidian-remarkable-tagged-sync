import { toArrayBuffer } from "./bytes";

export const DEFAULT_ATTACHMENTS_FOLDER = "tagged-sync/attachments";

/**
 * Settings input → usable vault folder path; empty or slash-only input falls back to the default.
 * `.`/`..` segments also fall back: a relative segment could resolve outside the vault, and writing
 * outside the vault is out of the question for a sync target.
 */
export function normalizeAttachmentsFolder(input: string): string {
	const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
	if (trimmed === "") return DEFAULT_ATTACHMENTS_FOLDER;
	const segments = trimmed.split("/");
	if (segments.some((segment) => segment === "." || segment === "..")) return DEFAULT_ATTACHMENTS_FOLDER;
	return trimmed;
}

export interface AttachmentStore {
	ensureFolder(path: string): Promise<void>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	/** Bare file names in the folder, not paths; empty when the folder does not exist. */
	list(folder: string): Promise<string[]>;
	remove(path: string): Promise<void>;
}

/** `<docId>[-<pageId>].pdf`, per the note-structure spec (identity-based, not user-facing). */
export function attachmentPath(folder: string, docId: string, pageId: string | null): string {
	const trimmedFolder = folder.replace(/\/+$/, "");
	const filename = pageId ? `${docId}-${pageId}.pdf` : `${docId}.pdf`;
	return `${trimmedFolder}/${filename}`;
}

/** Writes rendered PDF bytes to the vault's attachments folder, overwriting any existing file at that path. */
export async function writeAttachment(
	store: AttachmentStore,
	folder: string,
	docId: string,
	pageId: string | null,
	pdfBytes: Uint8Array,
): Promise<string> {
	const path = attachmentPath(folder, docId, pageId);
	await store.ensureFolder(path.slice(0, path.lastIndexOf("/")));
	await store.writeBinary(path, toArrayBuffer(pdfBytes));
	return path;
}

/** `<docSlug>-<noteId>.png`, per F17: deterministic, so a re-sync overwrites its own crop instead of piling up. */
export function cropAttachmentPath(folder: string, docSlug: string, noteId: string): string {
	return `${folder.replace(/\/+$/, "")}/${docSlug}-${noteId}.png`;
}

/** Writes one margin-note crop to the vault's attachments folder, overwriting any existing file at that path. */
export async function writeCropAttachment(
	store: AttachmentStore,
	folder: string,
	docSlug: string,
	noteId: string,
	png: Uint8Array,
): Promise<string> {
	const path = cropAttachmentPath(folder, docSlug, noteId);
	await store.ensureFolder(path.slice(0, path.lastIndexOf("/")));
	await store.writeBinary(path, toArrayBuffer(png));
	return path;
}

/** Escapes regex metacharacters, so a doc slug can never widen the crop pattern into a wildcard. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deletes this document's crops whose note vanished from the current sync (F17). The name pattern is the
 * safety contract, not an optimization: this runs unattended against the user's vault, so anything the
 * pattern does not match -- the PDF embed, another document's crops, files the user put there by hand --
 * is out of reach by construction.
 */
export async function pruneCrops(
	store: AttachmentStore,
	folder: string,
	docSlug: string,
	keepIds: ReadonlySet<string>,
): Promise<void> {
	const trimmedFolder = folder.replace(/\/+$/, "");
	const cropName = new RegExp(`^${escapeRegExp(docSlug)}-(nt-[0-9a-f]{6})\\.png$`);
	for (const name of await store.list(trimmedFolder)) {
		const match = cropName.exec(name);
		if (match && !keepIds.has(match[1])) await store.remove(`${trimmedFolder}/${name}`);
	}
}
