// Where the local model lives on disk, what state it is in, and who is allowed to touch it
// (managed-local-llm-ocr spec §5.1, §5.4, §5.5).
//
// Everything that decides is a pure function over a *snapshot* of the directory, so the whole state
// machine is testable without a filesystem. The thin node layer that produces the snapshot lives at
// the bottom of the file and does nothing but read.
//
// The state is derived from disk on every load and **never cached in `data.json`** -- a model deleted
// or truncated by something outside the plugin has to be noticed, and a remembered "ready" would hide
// exactly that.

/** The pinned artefact names. Both carry their version, so an update lands beside its predecessor. */
export const RUNTIME_DIR_MACOS = "llama-b10295-macos-arm64";
export const RUNTIME_DIR_WINDOWS = "llama-b10295-win-cpu-arm64";
export const MODEL_DIR = "qwen2.5-vl-7b-instruct-q4_k_m";

/** The executable the backend spawns, per platform. */
export const RUNTIME_EXECUTABLE_MACOS = "llama-mtmd-cli";
export const RUNTIME_EXECUTABLE_WINDOWS = "llama-mtmd-cli.exe";

export const MODEL_FILE = "model.gguf";
export const MMPROJ_FILE = "mmproj.gguf";
/** Empty marker, written only after both hashes matched. Its presence is half of "ready". */
export const VERIFIED_MARKER = "verified";

/**
 * Written when a second verification pass mismatched, which spec §5.3 makes terminal.
 *
 * **Assembly gap, closed here.** §5.5 requires every state to be derived from disk and never cached in
 * `data.json`, and §5.3 forbids a third automatic attempt -- but §5.1's layout lists no file to record
 * that in. Without one a restart resets the attempt count and the plugin re-downloads 5.5 GB it has
 * already been told twice is wrong. It is a marker rather than a counter for the same reason
 * `verified` is: the only question anyone asks of it is whether it is there.
 */
export const CORRUPT_MARKER = "corrupt";
/** Suffix of a file still being fetched; present only while incomplete. */
export const PART_SUFFIX = ".part";
export const LOCK_FILE = ".lock";

/**
 * The pinned sizes, from spec §5.2. The readiness check is a size check plus the marker and **never a
 * re-hash**: hashing 5.5 GB at every plugin load is not acceptable, and comparing sizes still catches
 * the two things that actually happen -- a file deleted, and a file truncated.
 */
export const MODEL_BYTES = 4_683_072_032;
export const MMPROJ_BYTES = 853_119_712;

/** How often the holder rewrites `.lock` while it holds it. */
export const LOCK_HEARTBEAT_MS = 10_000;

/**
 * How old a lock may be before it is treated as abandoned.
 *
 * Six heartbeats. Generously more than the heartbeat because the alternative is worse in both
 * directions: too tight and a busy machine's missed write lets a second vault start a 13 GB run
 * beside the first; too loose and a crashed download blocks the card for minutes with no way out.
 */
export const LOCK_STALE_MS = 60_000;

/**
 * The model's state, derived from disk. `runtime-broken` and `busy` are deliberately **not** here:
 * they are session-scoped facts about this run, not properties of the directory.
 */
export type LocalModelState =
	| "absent"
	| "partial"
	| "downloading"
	| "verifying"
	| "corrupt"
	| "removed"
	| "ready";

/** What the paths resolve to for one machine. Absolute, and outside the vault (spec §5.1). */
export interface LocalModelPaths {
	root: string;
	runtimeDir: string;
	runtimeExecutable: string;
	modelDir: string;
	modelFile: string;
	mmprojFile: string;
	verifiedMarker: string;
	corruptMarker: string;
	lockFile: string;
	/** The in-progress files, so a resume knows what to measure and a cleanup what to remove. */
	modelPart: string;
	mmprojPart: string;
}

/**
 * The two platforms the backend is offered on. Anything else never reaches here -- §4.1 refuses to
 * attach a setup card on a machine that cannot run the model, so no path is ever computed for it.
 */
export type LocalModelPlatform = "darwin" | "win32";

/**
 * Where the model lives, given a platform and the environment.
 *
 * **`LOCALAPPDATA`, never `APPDATA`**: `APPDATA` roams in domain environments, and 5.5 GB crossing
 * the network at every logon is not a defect anyone forgives. **Never `~/Library/Caches`** on macOS
 * either -- that is the directory the OS is allowed to empty underneath us.
 *
 * `join` is passed in rather than imported so this stays a pure function; the caller hands it
 * `path.join`.
 */
export function localModelPaths(
	platform: LocalModelPlatform,
	options: { home: string; localAppData?: string; pluginId: string; join: (...parts: string[]) => string },
): LocalModelPaths {
	const { home, localAppData, pluginId, join } = options;
	const root =
		platform === "darwin"
			? join(home, "Library", "Application Support", pluginId)
			: // The fallback matters: a stripped or service account can have no LOCALAPPDATA at all, and
				// this is where Windows itself puts it.
				join(localAppData && localAppData !== "" ? localAppData : join(home, "AppData", "Local"), pluginId);

	const runtimeDir = join(root, "bin", platform === "darwin" ? RUNTIME_DIR_MACOS : RUNTIME_DIR_WINDOWS);
	const modelDir = join(root, "models", MODEL_DIR);
	return {
		root,
		runtimeDir,
		runtimeExecutable: join(runtimeDir, platform === "darwin" ? RUNTIME_EXECUTABLE_MACOS : RUNTIME_EXECUTABLE_WINDOWS),
		modelDir,
		modelFile: join(modelDir, MODEL_FILE),
		mmprojFile: join(modelDir, MMPROJ_FILE),
		verifiedMarker: join(modelDir, VERIFIED_MARKER),
		corruptMarker: join(modelDir, CORRUPT_MARKER),
		lockFile: join(modelDir, LOCK_FILE),
		modelPart: join(modelDir, MODEL_FILE + PART_SUFFIX),
		mmprojPart: join(modelDir, MMPROJ_FILE + PART_SUFFIX),
	};
}

/**
 * What one look at the directory found. Every field is a fact, never a conclusion -- the conclusion is
 * {@link deriveLocalModelState}'s job, and keeping the two apart is what makes the state machine
 * testable without a filesystem.
 */
export interface LocalModelSnapshot {
	/** Byte size of each complete file, or null when it is not there. */
	modelBytes: number | null;
	mmprojBytes: number | null;
	/** True when a `.part` file for either artefact is present. */
	partPresent: boolean;
	verifiedPresent: boolean;
	runtimeExecutablePresent: boolean;
	/** The lock's timestamp in ms, or null when there is no lock. */
	lockHeldAtMs: number | null;
	/** Set by the download after two failed verifications (§5.3); survives a restart. */
	corruptMarked: boolean;
}

/** A lock is only a lock while someone is still writing to it. See {@link LOCK_STALE_MS}. */
export function isLockFresh(lockHeldAtMs: number | null, nowMs: number): boolean {
	if (lockHeldAtMs === null) return false;
	// A timestamp in the future is a clock that moved, not a stale lock -- treat it as held rather than
	// stealing a directory somebody is writing 5.5 GB into.
	return nowMs - lockHeldAtMs < LOCK_STALE_MS;
}

/**
 * The model's state, in the order the checks have to run.
 *
 * The order is the specification. `corrupt` outranks everything because it is terminal and the files
 * it describes are present and wrong. `partial`/`downloading` outrank `verifying` because a `.part`
 * says the set is incomplete whatever the complete files look like. `removed` sits *after* the marker
 * check for a reason worth stating: it is the state where the model is verified and intact and only
 * the 12 MB engine was taken -- by antivirus, most likely -- and telling those two apart is what lets
 * the card say "the 5.5 GB model is untouched" instead of "start over".
 */
export function deriveLocalModelState(snapshot: LocalModelSnapshot, nowMs: number): LocalModelState {
	if (snapshot.corruptMarked) return "corrupt";
	if (snapshot.partPresent) return isLockFresh(snapshot.lockHeldAtMs, nowMs) ? "downloading" : "partial";

	const complete = snapshot.modelBytes !== null && snapshot.mmprojBytes !== null;
	if (!complete) return "absent";
	if (!snapshot.verifiedPresent) return "verifying";
	// Size, not hash: the check runs on every plugin load, and it still catches deletion and truncation.
	if (snapshot.modelBytes !== MODEL_BYTES || snapshot.mmprojBytes !== MMPROJ_BYTES) return "absent";
	if (!snapshot.runtimeExecutablePresent) return "removed";
	return "ready";
}

/** True when the state means a transcription can start right now. */
export function isLocalModelRunnable(state: LocalModelState): boolean {
	return state === "ready";
}

/**
 * Whether a held lock belongs to a *transcription* rather than to a download (§5.4).
 *
 * The two jobs share one lock file and it holds a timestamp and nothing else, so it cannot name its
 * own holder -- but they are still told apart, because a download always has a `.part` open and a
 * transcription never does. That is the same discriminator {@link deriveLocalModelState} already
 * uses, and getting it wrong is not cosmetic in either direction: **a sync that finds a
 * transcription running must not start** (two runs are 27 GB), and **a sync that finds a download
 * running must**, because a download lasts hours and refusing to sync for hours would cost renders,
 * notes and highlights, which are the plugin's actual job.
 */
export function isTranscriptionInProgress(snapshot: Pick<LocalModelSnapshot, "lockHeldAtMs" | "partPresent">, nowMs: number): boolean {
	return isLockFresh(snapshot.lockHeldAtMs, nowMs) && !snapshot.partPresent;
}

/**
 * The `.lock` file's body: a timestamp and nothing else.
 *
 * **No PID, deliberately.** Two vaults commonly run in one Obsidian process, where the PID is
 * identical and proves nothing about who holds the directory -- so the only usable evidence is
 * whether somebody is still writing.
 */
export function formatLock(nowMs: number): string {
	return `${nowMs}\n`;
}

/** The timestamp back out of a `.lock`, or null when it holds anything else. */
export function parseLock(body: string): number | null {
	const value = Number(body.trim());
	return Number.isFinite(value) && value > 0 ? value : null;
}
