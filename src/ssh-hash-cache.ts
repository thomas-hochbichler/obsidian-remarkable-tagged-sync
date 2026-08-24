/**
 * The hashes this vault already knows, so a sync over SSH costs a listing rather than the library.
 *
 * Every sync needs a hash for every file in the account -- that is what the root hash is made of --
 * and hashing 185 MB on the device takes tens of seconds. Keyed by path, size and modification
 * time, so a file that changed is a miss rather than something anyone has to invalidate.
 *
 * The one subtlety is the freshness window. This userland reports modification times in whole
 * seconds, so a file rewritten twice inside one second can keep both its size and its timestamp --
 * and a hash stored for it would then be served forever for bytes that had moved on. So a hash for
 * a file whose timestamp is younger than the window is used for this run and **not** written down.
 * The cost is re-hashing a handful of files on the next sync; the alternative is a page that never
 * updates again, which is the failure mode this whole design refuses (see the deliberate-throws
 * matrix on stale transcripts).
 */

import type { DeviceFileStat, HashCache } from "./device-api";

/** `path|size|mtime` -> hash, as it sits in `data.json`. */
export type StoredHashes = Record<string, string>;

/** How recent a modification time has to be before it stops being evidence of anything. */
const FRESHNESS_WINDOW_MS = 2_000;

function keyOf(stat: DeviceFileStat): string {
	// An explicit separator, spelled out: a path may contain spaces, and this key ends up as a JSON
	// object key in `data.json` where an invisible one would be unreadable and easy to break.
	return [stat.path, stat.size, stat.mtimeMs].join("|");
}

/**
 * A cache over stored hashes that also records what it saw.
 *
 * {@link PersistentHashCache.pruned} is what gets written back: entries for files the device no
 * longer has would otherwise accumulate for the life of the vault, one per page ever deleted.
 */
export class PersistentHashCache implements HashCache {
	private readonly seen = new Map<string, string>();

	constructor(
		private readonly stored: StoredHashes,
		private readonly now: () => number = Date.now,
	) {}

	get(stat: DeviceFileStat): string | undefined {
		const hash = this.stored[keyOf(stat)];
		if (hash !== undefined) this.seen.set(keyOf(stat), hash);
		return hash;
	}

	set(stat: DeviceFileStat, hash: string): void {
		if (this.now() - stat.mtimeMs < FRESHNESS_WINDOW_MS) return;
		this.seen.set(keyOf(stat), hash);
	}

	/** Only what this session actually touched -- which is exactly what the device still has. */
	pruned(): StoredHashes {
		return Object.fromEntries(this.seen);
	}
}
