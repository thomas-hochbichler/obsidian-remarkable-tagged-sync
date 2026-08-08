// The filesystem half of the local model's state (managed-local-llm-ocr spec §5.1, §5.4, §5.5).
//
// Everything that *decides* lives in `local-model-store.ts` as a pure function over a snapshot; this
// file only reads the disk and writes the lock. Keeping the split honest is what lets the state
// machine be tested without a filesystem, and it keeps node out of the module the tests import.

import { Platform } from "obsidian";
import {
	deriveLocalModelState,
	formatLock,
	localModelPaths,
	MMPROJ_BYTES,
	MMPROJ_FILE,
	MODEL_BYTES,
	MODEL_FILE,
	parseLock,
	PART_SUFFIX,
	type LocalModelPaths,
	type LocalModelPlatform,
	type LocalModelSnapshot,
	type LocalModelState,
} from "./local-model-store";

/**
 * Dynamic `require` behind the desktop guard -- never a static top-level node import. Same shape and
 * same reason as `vision-ocr-runtime.ts`: a static import would load node modules on mobile, where
 * they do not exist.
 */
function nodeRequire(id: "os"): typeof import("os");
function nodeRequire(id: "fs"): typeof import("fs");
function nodeRequire(id: "path"): typeof import("path");
function nodeRequire(id: string): unknown {
	if (!Platform.isDesktop) throw new Error("Tagged Sync: node modules are desktop-only");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- Deliberate: see the doc comment.
	const loaded: unknown = require(id);
	return loaded;
}

/** The platform, or null where the local model is not offered at all (§4.1 attaches no card there). */
export function localModelPlatform(): LocalModelPlatform | null {
	if (!Platform.isDesktop) return null;
	const platform = nodeRequire("os").platform();
	return platform === "darwin" || platform === "win32" ? platform : null;
}

/** The paths for this machine, or null where the backend is not offered. */
export function resolveLocalModelPaths(pluginId: string): LocalModelPaths | null {
	const platform = localModelPlatform();
	if (!platform) return null;
	const os = nodeRequire("os");
	const path = nodeRequire("path");
	return localModelPaths(platform, {
		home: os.homedir(),
		localAppData: process.env.LOCALAPPDATA,
		pluginId,
		join: (...parts) => path.join(...parts),
	});
}

/** Byte size, or null when the file is not there. Any other error is also "not usable", by design. */
function sizeOf(file: string): number | null {
	const fs = nodeRequire("fs");
	try {
		const stat = fs.statSync(file);
		return stat.isFile() ? stat.size : null;
	} catch {
		return null;
	}
}

function exists(file: string): boolean {
	const fs = nodeRequire("fs");
	try {
		fs.accessSync(file);
		return true;
	} catch {
		return false;
	}
}

/** The lock's timestamp, or null when there is no lock or it holds something unreadable. */
export function readLock(paths: LocalModelPaths): number | null {
	const fs = nodeRequire("fs");
	try {
		return parseLock(fs.readFileSync(paths.lockFile, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Takes or renews the lock by stamping it with the current time.
 *
 * There is no compare-and-swap here and none is wanted: the lock's job is to stop a *second* 13 GB
 * run from starting beside the first, and the loser of a genuine race loses within one heartbeat. A
 * filesystem-level exclusive create would still not be atomic across the network shares a vault can
 * live on.
 */
export function writeLock(paths: LocalModelPaths, nowMs: number): void {
	const fs = nodeRequire("fs");
	fs.mkdirSync(paths.modelDir, { recursive: true });
	fs.writeFileSync(paths.lockFile, formatLock(nowMs));
}

/** Releases the lock. A lock that is already gone is not an error -- the caller wanted it gone. */
export function releaseLock(paths: LocalModelPaths): void {
	const fs = nodeRequire("fs");
	try {
		fs.unlinkSync(paths.lockFile);
	} catch {
		// Already released, or never held.
	}
}

/** One look at the directory. Facts only; {@link deriveLocalModelState} draws the conclusion. */
export function readLocalModelSnapshot(paths: LocalModelPaths): LocalModelSnapshot {
	return {
		modelBytes: sizeOf(paths.modelFile),
		mmprojBytes: sizeOf(paths.mmprojFile),
		partPresent: exists(paths.modelPart) || exists(paths.mmprojPart),
		verifiedPresent: exists(paths.verifiedMarker),
		runtimeExecutablePresent: exists(paths.runtimeExecutable),
		lockHeldAtMs: readLock(paths),
		corruptMarked: exists(paths.corruptMarker),
	};
}

/** One model directory beside the pinned one, described by what it holds. */
export interface ModelDirectoryEntry {
	name: string;
	hasPart: boolean;
	complete: boolean;
}

/**
 * Every model directory on disk, so the caller can decide which are superseded.
 *
 * Reading the directory belongs here rather than in the settings card that asks the question: this
 * file is the only one in the local-model set that is allowed to touch a disk, and keeping that true
 * is what lets every rule above it be tested without one.
 */
export function readModelDirectories(paths: LocalModelPaths): ModelDirectoryEntry[] {
	const fs = nodeRequire("fs");
	const path = nodeRequire("path");
	const modelsRoot = path.dirname(paths.modelDir);
	let names: string[];
	try {
		names = fs
			.readdirSync(modelsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	return names.map((name) => {
		const directory = path.join(modelsRoot, name);
		return {
			name,
			hasPart: exists(path.join(directory, MODEL_FILE + PART_SUFFIX)) || exists(path.join(directory, MMPROJ_FILE + PART_SUFFIX)),
			complete: sizeOf(path.join(directory, MODEL_FILE)) === MODEL_BYTES && sizeOf(path.join(directory, MMPROJ_FILE)) === MMPROJ_BYTES,
		};
	});
}

/** Removes one model directory by name, for a partial this build can no longer finish (§5.3). */
export function removeModelDirectory(paths: LocalModelPaths, name: string): void {
	const fs = nodeRequire("fs");
	const path = nodeRequire("path");
	fs.rmSync(path.join(path.dirname(paths.modelDir), name), { recursive: true, force: true });
}

/** This machine's architecture and memory, for the gate in `local-model-gate.ts`. */
export function machineFacts(): { platform: string; arch: string; totalMemoryBytes: number } | null {
	if (!Platform.isDesktop) return null;
	const os = nodeRequire("os");
	return { platform: os.platform(), arch: os.arch(), totalMemoryBytes: os.totalmem() };
}

/**
 * The model's state right now, read fresh from disk.
 *
 * Never cached: a model deleted or truncated by something outside the plugin -- an antivirus taking
 * the engine, a user clearing space -- has to be noticed, and a remembered "ready" is precisely what
 * would hide it.
 */
export function readLocalModelState(paths: LocalModelPaths, nowMs: number): LocalModelState {
	return deriveLocalModelState(readLocalModelSnapshot(paths), nowMs);
}
