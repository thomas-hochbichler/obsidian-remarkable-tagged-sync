/**
 * Putting one PDF into the reMarkable cloud (spec §2.4).
 *
 * The cloud half of Send, and the short one: rmapi-js already knows how to add a document, so this
 * is the folder lookup, the tag, and the one failure that is normal rather than exceptional.
 *
 * **`GenerationError` is not an error here.** The cloud's low-level API is optimistic: an upload
 * carries the generation it read, and anything else adding a document in between -- the tablet
 * itself, a phone, a second Obsidian -- makes ours stale. rmapi-js reports that as its own error
 * class and expects the caller to try again, which is what the three attempts below are. They are
 * three and not unlimited because a generation that keeps moving is a busy account, and a command
 * the user pressed should fail in seconds rather than loop.
 */

import { GenerationError, type RemarkableApi } from "rmapi-js";
import type { SendDocument } from "./zotero-send";

/** What a send needs of the cloud: two writes and the listing that finds the folder. */
export type CloudSendApi = Pick<RemarkableApi, "listItems" | "putFolder" | "putPdf">;

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
	const items = await api.listItems();
	const existing = items
		.filter((item) => item.type === "CollectionType" && item.visibleName === name && item.parent === "")
		.map((item) => item.id)
		.sort();
	if (existing.length > 0) return existing[0];
	return (await withGenerationRetries((refresh) => api.putFolder(name, {}, refresh))).id;
}

/** Adds one PDF and answers the id the cloud gave it. */
export async function sendToCloud(api: CloudSendApi, document: SendDocument): Promise<{ docId: string }> {
	const parent = await folderId(api, document.folder);
	const entry = await withGenerationRetries((refresh) =>
		api.putPdf(document.visibleName, document.bytes, { parent, tags: [], refresh }),
	);
	return { docId: entry.id };
}
