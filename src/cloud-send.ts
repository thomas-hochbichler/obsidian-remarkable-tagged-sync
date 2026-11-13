/**
 * Putting one PDF into the reMarkable cloud (spec §2.4), and -- for a vault send only -- looking at
 * and clearing away the vault's own earlier copy of it (send spec §3, ADR 0001).
 *
 * The cloud half of Send, and the short one: rmapi-js already knows how to add a document, so this
 * is the folder lookup, the tag, and the one failure that is normal rather than exceptional.
 *
 * **`GenerationError` is not an error here.** The cloud's low-level API is optimistic: an upload
 * carries the generation it read, and anything else adding a document in between -- the tablet
 * itself, a phone, a second Obsidian -- makes ours stale. rmapi-js 14 retries that itself, up to ten
 * times with a growing pause, and only then throws its own error class. The three attempts below
 * are wrapped around those ten: they predate them, and they are three and not unlimited because a
 * generation that keeps moving is a busy account, and a command the user pressed should fail in
 * seconds rather than loop. The trash below gets rmapi-js's ten and nothing more -- it is tidying,
 * and a failed tidy leaves the document where it was.
 */

import { GenerationError, HashNotFoundError, type Entry, type RawRemarkableApi, type RemarkableApi } from "rmapi-js";
import { getDocumentFiles } from "./page-hash";
import { isInTrash } from "./remarkable-tags";
import type { CopyRef, EarlierCopy, EarlierCopyLook, EarlierCopyState, SendDocument } from "./zotero-send";

/**
 * What a send needs of the cloud: two writes and the listing that finds the folder -- and, for the
 * earlier copy of a vault send, the two reads that tell whether it was written on and the one move
 * that takes it to the trash. `delete` and not `move` or `purge`: the trash, which the tablet can
 * restore from, is the only place a send ever takes anything (ADR 0001).
 */
export type CloudSendApi = Pick<RemarkableApi, "listItems" | "putFolder" | "putPdf" | "getContent" | "delete"> & {
	readonly raw: Pick<RawRemarkableApi, "getEntries">;
};

/** How many times a stale generation is retried before the send gives up. */
export const GENERATION_ATTEMPTS = 3;

/**
 * Runs `attempt` again while the cloud says our generation was stale, at most
 * {@link GENERATION_ATTEMPTS} times. Every other failure is the caller's, unchanged.
 *
 * `refresh` is true from the second try on: the first attempt may use the root hash rmapi-js already
 * holds, and a retry that read the same stale value again would fail for the same reason forever.
 */
async function withGenerationRetries<T>(attempt: (refresh: boolean) => Promise<T>): Promise<T> {
	let last: unknown;
	for (let tries = 0; tries < GENERATION_ATTEMPTS; tries++) {
		try {
			return await attempt(tries > 0);
		} catch (error) {
			if (!(error instanceof GenerationError)) throw error;
			last = error;
		}
	}
	throw last;
}

/**
 * The cloud's `Zotero` folder: the one that is there, or a new one.
 *
 * By name, at the top level, and never renamed -- the same rule the SSH side follows, and for the
 * same reason: the folder is the user's. The lowest id wins where there are two, so two sends in a
 * row agree about which one they mean.
 */
async function folderId(api: CloudSendApi, name: string): Promise<string> {
	const existing = existingFolderIds(await api.listItems(), name);
	if (existing.length > 0) return existing[0];
	return (await withGenerationRetries((refresh) => api.putFolder(name, {}, refresh))).id;
}

/** Every top-level folder of that name, lowest id first. */
function existingFolderIds(items: readonly Entry[], name: string): string[] {
	return items
		.filter((item) => item.type === "CollectionType" && item.visibleName === name && item.parent === "")
		.map((item) => item.id)
		.sort();
}

/**
 * The names of the documents in the cloud's `Zotero` folder -- {@link SendTransport.namesIn}.
 *
 * In *every* folder of that name, not only the one a send would use: a second one is the user's
 * arrangement, and a paper they filed there is on the tablet all the same.
 */
export async function namesInCloudFolder(api: CloudSendApi, name: string): Promise<string[]> {
	const items = await api.listItems();
	const folders = new Set(existingFolderIds(items, name));
	return items.filter((item) => item.type === "DocumentType" && folders.has(item.parent ?? "")).map((item) => item.visibleName);
}

/** Adds one PDF and answers the id the cloud gave it, and the folder it went into. */
export async function sendToCloud(api: CloudSendApi, document: SendDocument): Promise<{ docId: string; folderId: string }> {
	const parent = await folderId(api, document.folder);
	const entry = await withGenerationRetries((refresh) =>
		api.putPdf(document.visibleName, document.bytes, { parent, tags: [], refresh }),
	);
	return { docId: entry.id, folderId: parent };
}

/**
 * What the vault's earlier copies of one origin are now -- {@link SendTransport.earlierCopies}, send
 * spec §3.
 *
 * One listing for all of them, and for each copy the tests in the order of what they cost: what the
 * listing says comes free (in the trash or not there, moved, renamed, pinned, tagged), and only a
 * copy that passes all of those costs one `getContent` (a page tag) and one `getEntries` (an `.rm`
 * file, which any pen stroke or highlight leaves). The first test it fails decides, and the rest are
 * not asked. Anything the listing cannot vouch for -- no recorded folder or name -- is the user's:
 * the error always falls on the side of asking.
 *
 * A failure anywhere rejects the whole look rather than classing one copy and not another; the send
 * then goes on and clears nothing (P17).
 */
export async function lookAtEarlierCopies(api: CloudSendApi, copies: readonly EarlierCopy[], folder: string, visibleName: string): Promise<EarlierCopyLook> {
	const items = await api.listItems();
	const byId = new Map(items.map((item) => [item.id, item]));

	const classed: EarlierCopyState[] = [];
	for (const copy of copies) {
		const item = byId.get(copy.docId);
		if (item === undefined || isInTrash(item, byId)) {
			classed.push({ docId: copy.docId, state: "gone" });
			continue;
		}
		const ref: CopyRef = { id: item.id, hash: item.hash };
		classed.push({ docId: copy.docId, state: (await isUntouched(api, item, copy)) ? "untouched" : "users", ref });
	}

	// The folder this send puts the new one into, and no other of that name: "beside it" is what the
	// notice says. A copy of this origin is never a stranger, whatever its state.
	const ours = new Set(copies.map((copy) => copy.docId));
	const sendFolder = existingFolderIds(items, folder)[0];
	const strangerNamed =
		sendFolder !== undefined &&
		items.some((item) => item.type === "DocumentType" && item.parent === sendFolder && item.visibleName === visibleName && !ours.has(item.id));

	return { copies: classed, strangerNamed };
}

/** The tests of {@link lookAtEarlierCopies}, cheapest first. */
async function isUntouched(api: CloudSendApi, item: Entry, copy: EarlierCopy): Promise<boolean> {
	if (copy.folderId === undefined || item.parent !== copy.folderId) return false;
	if (copy.name === undefined || item.visibleName !== copy.name) return false;
	if (item.pinned) return false;
	if ((item.tags ?? []).length > 0) return false;
	const content = await api.getContent(item);
	if ("pageTags" in content && (content.pageTags ?? []).length > 0) return false;
	// An `.rm` that outlived its strokes counts as ink: erased ink cannot be told from ink.
	return (await getDocumentFiles(api, item.id, item.hash)).pages.size === 0;
}

/**
 * Moves one earlier copy to the tablet's trash -- {@link SendTransport.moveToTrash}. Answers whether
 * it went.
 *
 * `ref` is the `{id, hash}` of the look's listing, and that is the guard: rmapi-js finds the entry by
 * both, so a copy the tablet changed since -- opened, written on -- is not found, and the copy stays
 * rather than going to the trash as something it no longer is. That is "not cleared", not a failed
 * send. Every other failure is the caller's, unchanged.
 */
export async function moveCopyToTrash(api: CloudSendApi, ref: CopyRef): Promise<boolean> {
	try {
		await api.delete({ id: ref.id, hash: ref.hash });
		return true;
	} catch (error) {
		if (error instanceof HashNotFoundError) return false;
		throw error;
	}
}
