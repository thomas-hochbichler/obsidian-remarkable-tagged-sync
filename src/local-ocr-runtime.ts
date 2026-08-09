// The half of the local backend that spawns `llama-mtmd-cli` (managed-local-llm-ocr spec §3.3, §5.8).
//
// Everything that decides a unit's status lives in `local-ocr-backend.ts`; this writes a PNG to a
// temp directory, runs one process over it, and turns whatever happened into one of three outcomes.

import { Platform } from "obsidian";
import { sanitizeTranscript, TRANSCRIPTION_PROMPT } from "./llm-transcript";
import { classifyRun, type FinishedRun, LocalOcrBackend, type LocalPageOutcome, type LocalPageRunner } from "./local-ocr-backend";
import { readLocalModelState, readLock, releaseLock, resolveLocalModelPaths, writeLock } from "./local-model-runtime";
import { isTranscriptionInProgress, LOCK_HEARTBEAT_MS, type LocalModelPaths } from "./local-model-store";
import type { BackendSettings } from "./ocr-registry";

/** Tokens per page. 1024 covers the longest corpus page with room; a runaway loop is capped by it. */
const MAX_TOKENS = 1024;
/**
 * `--temp 0 --seed 42`. Two runs of the same page were byte-identical, and a re-run weeks later after
 * a model-cache eviction was byte-identical again -- so there is no re-run policy here, because there
 * is no non-determinism to police.
 */
const TEMPERATURE = "0";
const SEED = "42";

/** 14.9 s a page on an M2 Max, up to ~4 minutes derived on Windows arm64. Ten minutes is a hang. */
const PAGE_TIMEOUT_MS = 600_000;
/** The model writes a transcript, not a document; 16 MB of stdout is already pathological. */
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;
/** A process killed by the OS reports this. On macOS a first start dying this way is §5.8's signature. */
const SIGKILL_EXIT_CODE = 137;

function nodeRequire(id: "fs"): typeof import("fs");
function nodeRequire(id: "os"): typeof import("os");
function nodeRequire(id: "path"): typeof import("path");
function nodeRequire(id: "child_process"): typeof import("child_process");
function nodeRequire(id: string): unknown {
	if (!Platform.isDesktop) throw new Error("Tagged Sync: node modules are desktop-only");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- Deliberate: a static import would load node modules on mobile, where they do not exist.
	const loaded: unknown = require(id);
	return loaded;
}

/** What one spawn did, before {@link classifyRun} says what it means. */
type RunOutput = Omit<FinishedRun, "executablePresent">;

/** One `llama-mtmd-cli` run. Resolves with whatever the process did; rejects only when it never started. */
function spawnOnce(executable: string, args: string[]): Promise<RunOutput> {
	const { execFile } = nodeRequire("child_process");
	return new Promise((resolve, reject) => {
		execFile(executable, args, { maxBuffer: EXEC_MAX_BUFFER, timeout: PAGE_TIMEOUT_MS }, (error, stdout, stderr) => {
			if (!error) {
				resolve({ stdout, stderr, code: 0, timedOut: false });
				return;
			}
			const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
			// A string code (ENOENT, EACCES) means the process never ran; a number is its exit status.
			if (typeof code === "string") {
				reject(new Error(`${code}: ${error.message}`));
				return;
			}
			// `execFile`'s own timer kills the process, which leaves no exit status at all -- so without
			// this flag a timeout is indistinguishable from a crash, and the release gate found it being
			// read as the far more serious one.
			const timedOut = (error as { killed?: boolean }).killed === true;
			resolve({ stdout, stderr, code: typeof code === "number" ? code : null, timedOut });
		});
	});
}

/**
 * Strips the quarantine attribute once and retries, on the one symptom that means it (§5.8).
 *
 * Research 01 showed the case cannot arise through the plugin's own writes -- Obsidian sets no
 * `LSFileQuarantineEnabled`, so an `fs` write attaches no xattr -- so there is no probe and no cost in
 * the normal case. But Node has no API for extended attributes either, which leaves the symptom as the
 * only evidence available: a **first start dying with SIGKILL (137)** is the exact signature. A second
 * failure is a §8.2 case-1 runtime failure and is reported as one. The repair is plainly visible in
 * the source, which is the right side of §10's "do not obfuscate" line.
 */
async function repairQuarantine(executable: string): Promise<void> {
	const { execFile } = nodeRequire("child_process");
	await new Promise<void>((resolve) => {
		execFile("xattr", ["-d", "com.apple.quarantine", executable], { timeout: 10_000 }, () => resolve());
	});
}

/** The invocation of §3.3, with one image per process and per-page results. */
function pageArgs(paths: LocalModelPaths, imageFile: string): string[] {
	return [
		"-m",
		paths.modelFile,
		"--mmproj",
		paths.mmprojFile,
		"--image",
		imageFile,
		"-p",
		TRANSCRIPTION_PROMPT,
		"-n",
		String(MAX_TOKENS),
		"--temp",
		TEMPERATURE,
		"--seed",
		SEED,
	];
}

/**
 * The real page runner: one PNG in a throwaway temp directory, one process, one transcript.
 *
 * **Empty stdout is not a failure signal.** `llama-mtmd-cli` writes its version banner to *stderr*
 * and can exit 0 with nothing on stdout (ticket 08 §6), and a page can legitimately hold no legible
 * text -- so the transcript is read from stdout alone and an empty one is an empty page.
 */
function createRunner(paths: LocalModelPaths): LocalPageRunner {
	const fs = nodeRequire("fs");
	const os = nodeRequire("os");
	const path = nodeRequire("path");
	let quarantineRepairAttempted = false;

	return async (image: Uint8Array): Promise<LocalPageOutcome> => {
		// The engine is the half antivirus takes (§5.7), and it can go between two pages of one sync.
		if (!fs.existsSync(paths.runtimeExecutable)) {
			return { kind: "runtime-broken", message: "the transcription engine is no longer on disk" };
		}

		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tagged-sync-local-"));
		const imageFile = path.join(directory, "page.png");
		// Held for the length of the spawn, and renewed while it runs: a page is 15 s on a Mac and a
		// derived 4 minutes on Windows, both of which outlast the 60 s a lock stays fresh for. Without
		// the heartbeat a second vault would find it stale mid-page and start its own 13 GB run.
		writeLock(paths, Date.now());
		const heartbeat = window.setInterval(() => writeLock(paths, Date.now()), LOCK_HEARTBEAT_MS);
		try {
			fs.writeFileSync(imageFile, image);
			const startedAt = Date.now();
			let run = await spawnOnce(paths.runtimeExecutable, pageArgs(paths, imageFile));

			if (run.code === SIGKILL_EXIT_CODE && !quarantineRepairAttempted && process.platform === "darwin") {
				quarantineRepairAttempted = true;
				await repairQuarantine(paths.runtimeExecutable);
				run = await spawnOnce(paths.runtimeExecutable, pageArgs(paths, imageFile));
			}

			const outcome = classifyRun({ ...run, executablePresent: fs.existsSync(paths.runtimeExecutable) });
			// The transcript is the one thing the classifier cannot produce: it holds no clock and does no
			// sanitising, so a successful run is finished here.
			if (outcome.kind !== "text") return outcome;
			return { kind: "text", text: sanitizeTranscript(run.stdout), durationMs: Date.now() - startedAt };
		} catch (error) {
			// execFile rejected: the process never started at all.
			return { kind: "runtime-broken", message: (error as Error).message };
		} finally {
			window.clearInterval(heartbeat);
			releaseLock(paths);
			fs.rmSync(directory, { recursive: true, force: true });
		}
	};
}

/**
 * Whether another vault is mid-**transcription** right now (§5.4).
 *
 * Two concurrent runs are 27 GB, so a sync that finds the lock held does not start. A *download*
 * holding the same lock is different and deliberately so: it lasts hours, and refusing to sync for
 * hours would cost renders, notes and highlights, which are the plugin's actual job. Hours with a
 * progress bar: write. Minutes with nothing on screen: wait.
 *
 * **The `.part` file is what tells the two jobs apart.** §5.4 fixes the lock's body as a timestamp
 * and nothing else, so it cannot name its own holder — but a download always has a `.part` open and
 * a transcription never does, which is the same discriminator §5.5 already uses to separate
 * `downloading` from the rest.
 */
export function isLocalModelBusy(paths: LocalModelPaths): boolean {
	const fs = nodeRequire("fs");
	return isTranscriptionInProgress(
		{ lockHeldAtMs: readLock(paths), partPresent: fs.existsSync(paths.modelPart) || fs.existsSync(paths.mmprojPart) },
		Date.now(),
	);
}

/**
 * Builds the adapter for one sync, or null when the model cannot run right now.
 *
 * Null is not a fallback signal here -- the registry entry turns it into an `unavailable` adapter of
 * its own id, because map constraint 11 forbids falling back to Vision: a silent Vision transcript is
 * written once and never revisited, since the sync skips a document whose device-side hash is
 * unchanged.
 */
export function createLocalOcrBackend(
	pluginId: string,
	settings: BackendSettings,
	onRuntimeFailure?: (message: string) => void,
): LocalOcrBackend | null {
	const paths = resolveLocalModelPaths(pluginId);
	if (!paths) return null;
	if (readLocalModelState(paths, Date.now()) !== "ready") return null;
	if (isLocalModelBusy(paths)) return null;
	return new LocalOcrBackend({ runPage: createRunner(paths), settings, onRuntimeFailure });
}
