import { toArrayBuffer } from "./bytes";

export const DEFAULT_ATTACHMENTS_FOLDER = "tagged-sync/attachments";

/** Settings input → usable vault folder path; empty or slash-only input falls back to the default. */
export function normalizeAttachmentsFolder(input: string): string {
	const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
	return trimmed === "" ? DEFAULT_ATTACHMENTS_FOLDER : trimmed;
}

export interface AttachmentStore {
	ensureFolder(path: string): Promise<void>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
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
