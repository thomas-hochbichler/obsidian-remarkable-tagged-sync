import { describe, expect, it } from "vitest";
import {
	deriveLocalModelState,
	formatLock,
	isLockFresh,
	isTranscriptionInProgress,
	localModelPaths,
	LOCK_STALE_MS,
	parseLock,
	type LocalModelSnapshot,
} from "./local-model-store";

const join = (...parts: string[]) => parts.join("/");
const NOW = 1_700_000_000_000;

// The generation under test. Two ship now, so the sizes and the directory are arguments rather than
// constants -- these are the older model's, which is what every existing install still holds.
const MODEL_BYTES = 4_683_072_032;
const MMPROJ_BYTES = 853_119_712;
const MODEL_DIR = "qwen2.5-vl-7b-instruct-q4_k_m";
const EXPECTED = { modelBytes: MODEL_BYTES, mmprojBytes: MMPROJ_BYTES };

describe("isTranscriptionInProgress", () => {
	/**
	 * Two vaults, one 13 GB model: a sync that finds a transcription running must not start beside it.
	 * The lock holds a timestamp and nothing else, so the `.part` is what names the holder's job.
	 */
	it("blocks a second run while a transcription holds the lock", () => {
		expect(isTranscriptionInProgress({ lockHeldAtMs: NOW - 5_000, partPresent: false, runtimePartPresent: false }, NOW)).toBe(true);
	});

	/**
	 * A *download* holds the same lock and must not block anything. Hours with a progress bar: write.
	 * Minutes with nothing on screen: wait. Refusing to sync for the hours a download takes would cost
	 * renders, notes and highlights, which are the plugin's actual job.
	 */
	it("lets a sync run while a download holds it", () => {
		expect(isTranscriptionInProgress({ lockHeldAtMs: NOW - 5_000, partPresent: true, runtimePartPresent: false }, NOW)).toBe(false);
	});

	it("ignores a lock nobody is renewing any more", () => {
		expect(isTranscriptionInProgress({ lockHeldAtMs: NOW - LOCK_STALE_MS - 1, partPresent: false, runtimePartPresent: false }, NOW)).toBe(false);
	});

	/**
	 * The half this guard used to miss. A download fetches the 12 MB engine first and the model second,
	 * under one lock, and the engine's `.part` lands in the engine directory rather than beside the
	 * model -- so for that first minute the lock was held with nothing this looked at. Measured on a
	 * real install: 16:54-16:56 engine, "Another vault is transcribing" on Resume; 16:57 model, gone.
	 */
	it("lets a sync run while the engine half of a download holds it", () => {
		expect(isTranscriptionInProgress({ lockHeldAtMs: NOW - 5_000, partPresent: false, runtimePartPresent: true }, NOW)).toBe(false);
	});

	it("is not busy when there is no lock at all", () => {
		expect(isTranscriptionInProgress({ lockHeldAtMs: null, partPresent: false, runtimePartPresent: false }, NOW)).toBe(false);
	});
});

describe("localModelPaths", () => {
	it("puts the model under Application Support on macOS, never under Caches", () => {
		const paths = localModelPaths("darwin", { home: "/Users/me", pluginId: "tagged-sync", modelDir: MODEL_DIR, join });

		expect(paths.root).toBe("/Users/me/Library/Application Support/tagged-sync");
		// Caches is the one directory the OS is allowed to empty underneath a 5.5 GB download.
		expect(paths.root).not.toContain("Caches");
	});

	// APPDATA roams in domain environments, and 5.5 GB crossing the network at every logon is not a
	// defect anyone forgives.
	it("uses LOCALAPPDATA on Windows", () => {
		const paths = localModelPaths("win32", {
			home: "C:/Users/me",
			localAppData: "C:/Users/me/AppData/Local",
			pluginId: "tagged-sync", modelDir: MODEL_DIR,
			join,
		});

		expect(paths.root).toBe("C:/Users/me/AppData/Local/tagged-sync");
	});

	it("falls back to the standard location when LOCALAPPDATA is missing or empty", () => {
		for (const localAppData of [undefined, ""]) {
			const paths = localModelPaths("win32", { home: "C:/Users/me", localAppData, pluginId: "tagged-sync", modelDir: MODEL_DIR, join });
			expect(paths.root).toBe("C:/Users/me/AppData/Local/tagged-sync");
		}
	});

	// An update lands beside its predecessor and the switch is a rename of a verified directory, which
	// only works while the version is part of the name.
	it("carries the version in both artefact directory names", () => {
		const paths = localModelPaths("darwin", { home: "/h", pluginId: "p", modelDir: MODEL_DIR, join });

		expect(paths.runtimeDir).toContain("b10295");
		expect(paths.modelDir).toContain("qwen2.5-vl-7b");
	});

	it("names the platform's own executable", () => {
		expect(localModelPaths("darwin", { home: "/h", pluginId: "p", modelDir: MODEL_DIR, join }).runtimeExecutable).toMatch(/llama-mtmd-cli$/);
		expect(localModelPaths("win32", { home: "C:/h", pluginId: "p", modelDir: MODEL_DIR, join }).runtimeExecutable).toMatch(/llama-mtmd-cli\.exe$/);
	});

	it("keeps every file it names inside the model directory", () => {
		const paths = localModelPaths("darwin", { home: "/h", pluginId: "p", modelDir: MODEL_DIR, join });

		for (const file of [paths.modelFile, paths.mmprojFile, paths.verifiedMarker, paths.corruptMarker, paths.lockFile, paths.modelPart]) {
			expect(file.startsWith(`${paths.modelDir}/`)).toBe(true);
		}
	});
});

describe("isLockFresh", () => {
	it("treats no lock as free", () => {
		expect(isLockFresh(null, NOW)).toBe(false);
	});

	it("holds a lock that was stamped a heartbeat ago", () => {
		expect(isLockFresh(NOW - 10_000, NOW)).toBe(true);
	});

	it("abandons one older than the stale bound, so a crashed download does not block the card forever", () => {
		expect(isLockFresh(NOW - LOCK_STALE_MS - 1, NOW)).toBe(false);
	});

	// A clock that jumped forward is not evidence that nobody is writing 5.5 GB into the directory.
	it("holds a lock stamped in the future rather than stealing the directory", () => {
		expect(isLockFresh(NOW + 60_000, NOW)).toBe(true);
	});
});

describe("the lock file's body", () => {
	it("round-trips a timestamp", () => {
		expect(parseLock(formatLock(NOW))).toBe(NOW);
	});

	// Two vaults commonly run in one Obsidian process, where the PID is identical and proves nothing.
	it("carries a timestamp and nothing else, deliberately no PID", () => {
		expect(formatLock(NOW).trim()).toBe(String(NOW));
	});

	it("reads anything else as no lock at all", () => {
		for (const body of ["", "   ", "not a number", "0", "-1"]) expect(parseLock(body)).toBeNull();
	});
});

describe("deriveLocalModelState", () => {
	function snapshot(overrides: Partial<LocalModelSnapshot> = {}): LocalModelSnapshot {
		return {
			modelBytes: null,
			mmprojBytes: null,
			partPresent: false,
			verifiedPresent: false,
			runtimeExecutablePresent: false,
			lockHeldAtMs: null,
			corruptMarked: false,
			...overrides,
		};
	}

	const complete = { modelBytes: MODEL_BYTES, mmprojBytes: MMPROJ_BYTES };

	it("is absent with nothing on disk", () => {
		expect(deriveLocalModelState(snapshot(), NOW, EXPECTED)).toBe("absent");
	});

	it("is downloading while a part file and a fresh lock are both there", () => {
		expect(deriveLocalModelState(snapshot({ partPresent: true, lockHeldAtMs: NOW - 5_000 }), NOW, EXPECTED)).toBe("downloading");
	});

	it("is partial when the part file outlived its lock", () => {
		expect(deriveLocalModelState(snapshot({ partPresent: true, lockHeldAtMs: NOW - LOCK_STALE_MS - 1 }), NOW, EXPECTED)).toBe("partial");
	});

	it("is verifying once the files are complete but nothing has confirmed them", () => {
		expect(deriveLocalModelState(snapshot(complete), NOW, EXPECTED)).toBe("verifying");
	});

	it("is ready with the marker, the right sizes and the engine present", () => {
		const state = deriveLocalModelState(snapshot({ ...complete, verifiedPresent: true, runtimeExecutablePresent: true }), NOW, EXPECTED);
		expect(state).toBe("ready");
	});

	/**
	 * The state the card exists to explain: antivirus takes the 12 MB engine and leaves the 5.5 GB
	 * model alone. Reading it as "absent" would tell the user to download everything again.
	 */
	/**
	 * A second attempt that lost a race with the one that finished leaves its `.part` beside the
	 * verified pair. Read as "partial", that put a *Discard 6.5 GB* button under a model that had just
	 * been verified -- and it would have deleted it.
	 */
	it("is ready when a stray part file sits beside a verified model", () => {
		const stray = snapshot({ ...complete, verifiedPresent: true, runtimeExecutablePresent: true, partPresent: true });
		expect(deriveLocalModelState(stray, NOW, EXPECTED)).toBe("ready");
	});

	it("is removed when the model survived but the engine was taken", () => {
		const state = deriveLocalModelState(snapshot({ ...complete, verifiedPresent: true, runtimeExecutablePresent: false }), NOW, EXPECTED);
		expect(state).toBe("removed");
	});

	// The readiness check is a size check, never a re-hash: hashing 5.5 GB on every load is not
	// acceptable, and a size still catches the two things that happen -- deletion and truncation.
	it("refuses a verified model whose file has been truncated", () => {
		const truncated = snapshot({ ...complete, modelBytes: MODEL_BYTES - 1, verifiedPresent: true, runtimeExecutablePresent: true });
		expect(deriveLocalModelState(truncated, NOW, EXPECTED)).toBe("absent");
	});

	it("is corrupt once two verification passes have failed, whatever else is on disk", () => {
		const marked = snapshot({ ...complete, verifiedPresent: true, runtimeExecutablePresent: true, corruptMarked: true });
		expect(deriveLocalModelState(marked, NOW, EXPECTED)).toBe("corrupt");
	});

	// Terminal means terminal across a restart, which is why the marker is a file rather than a counter
	// held in memory: otherwise a reload silently buys a third 5.5 GB attempt.
	it("stays corrupt after a restart, with no lock and no part file left", () => {
		expect(deriveLocalModelState(snapshot({ corruptMarked: true }), NOW, EXPECTED)).toBe("corrupt");
	});

	it("reports an incomplete pair as absent rather than half-ready", () => {
		expect(deriveLocalModelState(snapshot({ modelBytes: MODEL_BYTES }), NOW, EXPECTED)).toBe("absent");
	});
});
