import type { RawRemarkableApi } from "rmapi-js";

type PageHashApi = { raw: Pick<RawRemarkableApi, "getEntries"> };

/** What a document's entry index holds, of the two kinds of file the plugin fetches out of it. */
export interface DocumentFiles {
	/** Page id -> the hash of its `<docId>/<pageId>.rm` scene. */
	pages: Map<string, string>;
	/**
	 * File name -> the entry id and hash of a picture a page shows, which the device keeps in a
	 * folder of the page's own (`<docId>/<pageId>/<fileName>`). The name is what an `RmImage` carries
	 * and it is a uuid, so it needs no page to key it by.
	 */
	images: Map<string, { id: string; hash: string }>;
	/**
	 * The original `.epub` of a book, when this document is one. It is the only place the book's own
	 * wording survives: the device's PDF conversion loses letters (see `quote-correction.ts`).
	 */
	epub: { id: string; hash: string } | null;
}

const IMAGE_SUFFIXES = [".png", ".jpg", ".jpeg"];

/**
 * The document's own entry list, read once: the pages, and the pictures on them.
 *
 * The page hashes are the level-3 change-detection signal (spec §7) -- the content-addressed hash of
 * each `<docId>/<pageId>.rm`, so a page re-renders only when its hash moved. The images ride along
 * because they are in the same index, and reading it twice would be a second request for bytes
 * already in hand.
 */
export async function getDocumentFiles(api: PageHashApi, docId: string, docHash: string): Promise<DocumentFiles> {
	const { entries } = await api.raw.getEntries(`${docId}.docSchema`, docHash);
	const prefix = `${docId}/`;

	const pages = new Map<string, string>();
	const images = new Map<string, { id: string; hash: string }>();
	let epub: { id: string; hash: string } | null = null;
	for (const entry of entries) {
		// The book sits beside the document's folder, not inside it: `<docId>.epub`.
		if (entry.id === `${docId}.epub`) {
			epub = { id: entry.id, hash: entry.hash };
			continue;
		}
		if (!entry.id.startsWith(prefix)) continue;
		const path = entry.id.slice(prefix.length);
		if (path.endsWith(".rm")) {
			pages.set(path.slice(0, -".rm".length), entry.hash);
			continue;
		}
		const name = path.slice(path.lastIndexOf("/") + 1);
		if (IMAGE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix))) images.set(name, { id: entry.id, hash: entry.hash });
	}
	return { pages, images, epub };
}
