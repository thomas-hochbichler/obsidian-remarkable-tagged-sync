import type { RawRemarkableApi } from "rmapi-js";

type PageHashApi = { raw: Pick<RawRemarkableApi, "getEntries"> };

/**
 * Level-3 change-detection signal (spec §7): the content-addressed hash of each page's
 * `<docId>/<pageId>.rm` file, read from the document's own entry list. Re-render only pages
 * whose hash changed since the last sync.
 */
export async function getPageHashes(api: PageHashApi, docId: string, docHash: string): Promise<Map<string, string>> {
	const { entries } = await api.raw.getEntries(`${docId}.docSchema`, docHash);
	const prefix = `${docId}/`;
	const suffix = ".rm";

	const hashes = new Map<string, string>();
	for (const entry of entries) {
		if (!entry.id.startsWith(prefix) || !entry.id.endsWith(suffix)) continue;
		const pageId = entry.id.slice(prefix.length, entry.id.length - suffix.length);
		hashes.set(pageId, entry.hash);
	}
	return hashes;
}
