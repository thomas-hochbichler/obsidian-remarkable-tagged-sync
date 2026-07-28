export type TagFolderMap = Record<string, string>;

/**
 * Canonical fingerprint of a mapping set, stored in the sync index. The root-hash gate compares it
 * so a settings change (add/remove/re-target a tag) forces a full scan even when nothing changed
 * on the device -- the root hash only tracks the reMarkable side.
 */
export function mappingFingerprint(mapping: TagFolderMap): string {
	return JSON.stringify(Object.entries(mapping).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export class TagRouter {
	constructor(private readonly mapping: TagFolderMap) {}

	resolveFolder(tag: string): string | null {
		return this.mapping[tag] ?? null;
	}

	fingerprint(): string {
		return mappingFingerprint(this.mapping);
	}
}
