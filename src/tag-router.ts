export type TagFolderMap = Record<string, string>;

// Bump this when routing semantics change in a way that requires every vault to run one full scan.
// The previous unversioned format is treated as version 1.
const MAPPING_FINGERPRINT_VERSION = 3;

/**
 * Canonical fingerprint of a mapping set, stored in the sync index. The root-hash gate compares it
 * so a settings change (add/remove/re-target a tag) forces a full scan even when nothing changed
 * on the device -- the root hash only tracks the reMarkable side.
 */
export function mappingFingerprint(mapping: TagFolderMap): string {
	const entries = Object.entries(mapping).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `${MAPPING_FINGERPRINT_VERSION}:${JSON.stringify(entries)}`;
}

/** What a mapped tag produces: its transcript note, its page notes, or both (Intelligence Engine §3). */
export interface TagModes {
	transcript: boolean;
	intelligence: boolean;
}

const TRANSCRIPT_ONLY: TagModes = { transcript: true, intelligence: false };

export class TagRouter {
	/**
	 * `modes` is absent for every caller that predates the Intelligence Engine, and then every mapped
	 * tag behaves as it always has: a transcript note, no page notes.
	 */
	constructor(
		private readonly mapping: TagFolderMap,
		private readonly modes: (tag: string) => TagModes = () => TRANSCRIPT_ONLY,
	) {}

	resolveFolder(tag: string): string | null {
		return this.mapping[tag] ?? null;
	}

	/** Whether this mapped tag still writes its transcript note. Off, its rows stay active and are not planned. */
	transcribes(tag: string): boolean {
		return this.mapping[tag] !== undefined && this.modes(tag).transcript;
	}

	/** Whether this mapped tag turns its pages into page notes. */
	extracts(tag: string): boolean {
		return this.mapping[tag] !== undefined && this.modes(tag).intelligence;
	}

	fingerprint(): string {
		return mappingFingerprint(this.mapping);
	}
}
