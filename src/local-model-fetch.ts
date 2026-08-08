// The half of the downloader that touches the disk and the network (managed-local-llm-ocr spec §5.3,
// §5.9).
//
// Every rule this file follows lives in `local-model-download.ts` as a pure function; this is the
// plumbing that carries them out. Two constraints shape the whole file:
//
//   1. **Download with Node, write with `fs`. Never `open`, never `shell.openPath`.** That is ticket
//      01's Gatekeeper rule and it is load-bearing: Obsidian sets no `LSFileQuarantineEnabled`, so an
//      `fs` write attaches no quarantine xattr and the extracted binary starts. A file handed to the
//      OS to place would be quarantined and `SIGKILL`ed on first run.
//   2. **Nothing is streamed through Obsidian's `requestUrl`**, which buffers a whole response in
//      memory. 5.5 GB has to arrive as a stream that is written as it lands and resumed where it
//      stopped.

import { Platform } from "obsidian";
import { MODEL_ARTEFACTS, RUNTIME_ARTEFACTS, type PinnedArtefact, totalDownloadBytes } from "./local-model-artefacts";
import {
	freeSpaceShortfall,
	planRangeResponse,
	planResume,
	requiredFreeBytes,
	verificationOutcome,
	type VerificationOutcome,
	withNetworkRetry,
} from "./local-model-download";
import {
	LOCK_HEARTBEAT_MS,
	type LocalModelPaths,
	type LocalModelPlatform,
	PART_SUFFIX,
} from "./local-model-store";
import { releaseLock, writeLock } from "./local-model-runtime";

/** How many redirects to follow before treating the chain as broken. HuggingFace uses one. */
const MAX_REDIRECTS = 5;
/** Long enough for a stalled CDN to be a stall rather than a slow start. */
const RESPONSE_TIMEOUT_MS = 60_000;
/** `tar` unpacking 12 MB is seconds; a minute means something is wrong with it. */
const EXTRACT_TIMEOUT_MS = 120_000;

function nodeRequire(id: "fs"): typeof import("fs");
function nodeRequire(id: "path"): typeof import("path");
function nodeRequire(id: "https"): typeof import("https");
function nodeRequire(id: "crypto"): typeof import("crypto");
function nodeRequire(id: "child_process"): typeof import("child_process");
function nodeRequire(id: string): unknown {
	if (!Platform.isDesktop) throw new Error("Tagged Sync: node modules are desktop-only");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- Deliberate: a static import would load node modules on mobile, where they do not exist.
	const loaded: unknown = require(id);
	return loaded;
}

/** Why a download stopped short. Each maps to one card state (§7.1). */
export type DownloadFailure =
	| { kind: "out-of-disk"; shortfallBytes: number }
	| { kind: "network"; message: string }
	| { kind: "corrupt" }
	| { kind: "extract"; message: string }
	| { kind: "busy" }
	| { kind: "cancelled" };

/** What the card is showing right now. Read on every re-render; never persisted (§5.5). */
export type DownloadProgress =
	| { phase: "checking" }
	| { phase: "downloading"; receivedBytes: number; totalBytes: number }
	| { phase: "verifying" }
	| { phase: "extracting" }
	| { phase: "done" }
	| { phase: "failed"; failure: DownloadFailure };

/** A download in flight: what it is doing, and the one thing the user can do to it. */
export interface DownloadHandle {
	progress(): DownloadProgress;
	cancel(): void;
	/** Resolves when the download has finished, failed or been cancelled -- it never rejects. */
	finished: Promise<DownloadProgress>;
}

/** Free bytes on the volume the model lives on, or null when the platform cannot say. */
function freeBytesOn(directory: string): number | null {
	const fs = nodeRequire("fs");
	const path = nodeRequire("path");
	// statfs needs a path that exists; walk up to the nearest ancestor that does.
	let probe = directory;
	for (let i = 0; i < 20; i++) {
		try {
			const stats = fs.statfsSync(probe);
			return stats.bavail * stats.bsize;
		} catch {
			const parent = path.dirname(probe);
			if (parent === probe) return null;
			probe = parent;
		}
	}
	return null;
}

/** SHA-256 of a finished file, as its own visible pass (§5.3) -- never streamed alongside the download. */
function hashFile(file: string): Promise<string> {
	const fs = nodeRequire("fs");
	const crypto = nodeRequire("crypto");
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		const stream = fs.createReadStream(file);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

/**
 * One GET, following redirects, with the `Range` header the caller asked for.
 *
 * The response is handed back unread so the caller can decide what to do with its *status* before a
 * single byte is written -- which is the whole point of §5.3's 206 rule.
 */
function openRequest(url: string, offset: number, signal: { cancelled: boolean }): Promise<import("http").IncomingMessage> {
	const https = nodeRequire("https");
	return new Promise((resolve, reject) => {
		const attempt = (target: string, redirectsLeft: number): void => {
			if (signal.cancelled) {
				reject(new Error("cancelled"));
				return;
			}
			const headers: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {};
			const request = https.get(target, { headers, timeout: RESPONSE_TIMEOUT_MS }, (response) => {
				const status = response.statusCode ?? 0;
				const location = response.headers.location;
				if (status >= 300 && status < 400 && location) {
					response.resume();
					if (redirectsLeft <= 0) {
						reject(new Error("too many redirects"));
						return;
					}
					attempt(new URL(location, target).toString(), redirectsLeft - 1);
					return;
				}
				resolve(response);
			});
			request.on("timeout", () => request.destroy(new Error("the connection timed out")));
			request.on("error", reject);
		};
		attempt(url, MAX_REDIRECTS);
	});
}

/** Progress across the whole set, so the card shows one bar rather than one per file. */
interface ByteCounter {
	received: number;
	total: number;
}

/**
 * Fetches one artefact into its `.part` and renames it into place, resuming where a previous attempt
 * stopped.
 *
 * Returns the bytes it had already been credited with, so the caller's running total stays right
 * whichever branch was taken.
 */
async function fetchArtefact(
	artefact: PinnedArtefact,
	targetFile: string,
	counter: ByteCounter,
	signal: { cancelled: boolean },
	onProgress: () => void,
): Promise<void> {
	const fs = nodeRequire("fs");
	const partFile = targetFile + PART_SUFFIX;

	const existing = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
	const plan = planResume(existing, artefact.bytes);
	if (plan.kind === "complete") {
		fs.renameSync(partFile, targetFile);
		counter.received += artefact.bytes;
		onProgress();
		return;
	}

	const offset = plan.kind === "resume" ? plan.offset : 0;
	const response = await openRequest(artefact.url, offset, signal);
	const decision = planRangeResponse(response.statusCode ?? 0, offset);
	if (decision.kind === "error") {
		response.resume();
		throw new Error(`the server answered ${decision.status}`);
	}

	// A 200 to a ranged request means the range was ignored and this body starts at byte zero. The
	// part is truncated rather than appended to -- otherwise it becomes two beginnings spliced
	// together and only the final hash finds out, after 5.5 GB.
	const appending = decision.kind === "append";
	const startAt = appending ? decision.from : 0;
	counter.received += startAt;

	await new Promise<void>((resolve, reject) => {
		const out = fs.createWriteStream(partFile, appending ? { flags: "a" } : { flags: "w" });
		const abort = (error: Error) => {
			response.destroy();
			out.destroy();
			reject(error);
		};
		response.on("data", (chunk: Buffer) => {
			if (signal.cancelled) {
				abort(new Error("cancelled"));
				return;
			}
			counter.received += chunk.length;
			onProgress();
		});
		response.on("error", abort);
		out.on("error", abort);
		out.on("finish", resolve);
		response.pipe(out);
	});

	const written = fs.statSync(partFile).size;
	if (written !== artefact.bytes) throw new Error(`the download stopped at ${written} of ${artefact.bytes} bytes`);
	fs.renameSync(partFile, targetFile);
}

/** A cancellable pause between two attempts. */
function wait(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * {@link fetchArtefact}, retried through a dropped connection (§5.3).
 *
 * The release gate found why this is needed: a 5.5 GB download dropped three times on an ordinary
 * connection, at unrelated offsets and with `curl` pulling the same URL happily, and each drop was a
 * terminal state the user had to clear by hand. **No byte is ever lost** — the `.part` and the 206
 * rule already guarantee that — so a drop is a pause, not a failure, and the only question is when to
 * stop calling it one. {@link planNetworkRetry} answers it: any attempt that gained ground resets the
 * budget, so a flaky connection finishes and a dead one gives up in about half a minute.
 *
 * **The byte counter is rewound on every failed attempt.** `fetchArtefact` credits the resume offset
 * as soon as it opens the stream, so without this the card's percentage would climb by the whole part
 * again on each retry and sail past 100 %.
 */
async function fetchWithRetry(
	artefact: PinnedArtefact,
	targetFile: string,
	counter: ByteCounter,
	signal: { cancelled: boolean },
	onProgress: () => void,
): Promise<void> {
	const fs = nodeRequire("fs");
	const partSize = (): number => {
		try {
			return fs.statSync(targetFile + PART_SUFFIX).size;
		} catch {
			// Not started, or already renamed into place by a finished attempt.
			return 0;
		}
	};

	let credited = counter.received;
	return withNetworkRetry({
		attempt: () => fetchArtefact(artefact, targetFile, counter, signal, onProgress),
		bytesOnDisk: partSize,
		mark: () => {
			credited = counter.received;
		},
		reset: () => {
			counter.received = credited;
		},
		sleep: wait,
		cancelled: () => signal.cancelled,
		onRetry: onProgress,
	});
}

/**
 * Downloads one artefact and verifies it, applying §5.3's two-strikes rule.
 *
 * On the first mismatch the file is discarded and fetched again from zero -- the likeliest cause is a
 * resume the server mishandled, which a clean download fixes. A **second** mismatch is terminal:
 * these bytes are not the published ones, and a third attempt is 5.5 GB spent on hope. The rule
 * itself lives in {@link verificationOutcome} so the loop cannot drift from it.
 */
async function fetchAndVerify(
	artefact: PinnedArtefact,
	targetFile: string,
	counter: ByteCounter,
	signal: { cancelled: boolean },
	onProgress: () => void,
	publish: (next: DownloadProgress) => void,
): Promise<VerificationOutcome> {
	const fs = nodeRequire("fs");
	for (let attempt = 0; ; attempt++) {
		publish({ phase: "downloading", receivedBytes: counter.received, totalBytes: counter.total });
		await fetchWithRetry(artefact, targetFile, counter, signal, onProgress);

		publish({ phase: "verifying" });
		const outcome = verificationOutcome((await hashFile(targetFile)) === artefact.sha256, attempt > 0);
		if (outcome !== "retry") return outcome;

		// Discarded so the retry starts from zero rather than resuming into the same bad bytes.
		fs.rmSync(targetFile, { force: true });
		counter.received -= artefact.bytes;
	}
}

/**
 * Unpacks the runtime archive with the **system** `tar` -- bsdtar on macOS, `tar.exe` on Windows
 * 10 1803+, which also reads zip.
 *
 * Bundling a JS archive library would add supply chain to a plugin whose store scan (§10) already
 * treats dependencies as the risk to manage, for a job the OS ships a tool for. Its absence is a
 * §8.2 case-1 failure and is reported as one rather than crashing.
 */
function extractArchive(archive: string, intoDirectory: string, stripComponents: number): Promise<void> {
	const { execFile } = nodeRequire("child_process");
	const fs = nodeRequire("fs");
	fs.mkdirSync(intoDirectory, { recursive: true });
	// The strip depth is pinned per platform rather than discovered: the macOS tarball wraps its
	// payload in one directory and the Windows zip does not, and `tar` reports success either way --
	// so a wrong depth extracts nothing and says nothing.
	const args = ["-xf", archive, "-C", intoDirectory, ...(stripComponents > 0 ? [`--strip-components=${stripComponents}`] : [])];
	return new Promise((resolve, reject) => {
		execFile("tar", args, { timeout: EXTRACT_TIMEOUT_MS }, (error, _stdout, stderr) => {
			if (error) reject(new Error(`tar could not unpack the engine: ${error.message} :: ${stderr}`));
			else resolve();
		});
	});
}

/**
 * Downloads, verifies and installs everything the backend needs.
 *
 * **The 12 MB runtime is fetched first, deliberately.** A broken engine download, a missing `tar` or
 * a quarantined archive then surfaces in seconds instead of after the hours the model takes -- and
 * the model is the half nobody wants to fetch twice.
 */
export function startLocalModelDownload(paths: LocalModelPaths, platform: LocalModelPlatform, onChange: () => void): DownloadHandle {
	const fs = nodeRequire("fs");
	const path = nodeRequire("path");
	const signal = { cancelled: false };
	const counter: ByteCounter = { received: 0, total: totalDownloadBytes(platform) };
	let current: DownloadProgress = { phase: "checking" };

	const publish = (next: DownloadProgress): void => {
		current = next;
		onChange();
	};
	// The byte counter ticks thousands of times a second; the card only ever redraws a percentage.
	let lastPublishedPercent = -1;
	const tickProgress = (): void => {
		const percent = Math.floor((counter.received / counter.total) * 100);
		if (percent === lastPublishedPercent) return;
		lastPublishedPercent = percent;
		publish({ phase: "downloading", receivedBytes: counter.received, totalBytes: counter.total });
	};

	const run = async (): Promise<DownloadProgress> => {
		let heartbeat: number | null = null;
		try {
			fs.mkdirSync(paths.modelDir, { recursive: true });
			fs.mkdirSync(paths.runtimeDir, { recursive: true });

			const free = freeBytesOn(paths.root);
			if (free !== null) {
				const shortfall = freeSpaceShortfall(requiredFreeBytes(platform), free);
				if (shortfall > 0) return { phase: "failed", failure: { kind: "out-of-disk", shortfallBytes: shortfall } };
			}

			writeLock(paths, Date.now());
			heartbeat = window.setInterval(() => writeLock(paths, Date.now()), LOCK_HEARTBEAT_MS);

			publish({ phase: "downloading", receivedBytes: 0, totalBytes: counter.total });

			const runtime = RUNTIME_ARTEFACTS[platform];
			const archive = path.join(paths.runtimeDir, runtime.fileName);
			// No `corrupt` marker for the engine: it is 12 MB, so a fresh attempt after a restart costs
			// seconds, and the marker exists to protect the 5.5 GB half from a third download.
			if ((await fetchAndVerify(runtime, archive, counter, signal, tickProgress, publish)) === "corrupt") {
				return { phase: "failed", failure: { kind: "corrupt" } };
			}
			publish({ phase: "extracting" });
			try {
				await extractArchive(archive, paths.runtimeDir, runtime.stripComponents ?? 0);
			} catch (error) {
				return { phase: "failed", failure: { kind: "extract", message: (error as Error).message } };
			}
			if (!fs.existsSync(paths.runtimeExecutable)) {
				// `tar` exits 0 on a wrong strip depth, having written nothing useful. Checking for the
				// one file the archive exists for turns that into a visible failure instead of a
				// "ready" state whose first transcription dies.
				return { phase: "failed", failure: { kind: "extract", message: "the engine was not in the archive where it was expected" } };
			}
			fs.rmSync(archive, { force: true });
			if (platform === "darwin") fs.chmodSync(paths.runtimeExecutable, 0o755);

			for (const artefact of MODEL_ARTEFACTS) {
				const target = path.join(paths.modelDir, artefact.fileName);
				if (fs.existsSync(target) && fs.statSync(target).size === artefact.bytes) {
					counter.received += artefact.bytes;
					continue;
				}
				if ((await fetchAndVerify(artefact, target, counter, signal, tickProgress, publish)) === "corrupt") {
					// Recorded on disk, because §5.5 forbids caching state anywhere else and a restart
					// would otherwise reset the count and buy a third 5.5 GB attempt.
					fs.writeFileSync(paths.corruptMarker, "");
					return { phase: "failed", failure: { kind: "corrupt" } };
				}
			}

			// Written last and only once both hashes matched: its presence is half of "ready" (§5.5).
			fs.writeFileSync(paths.verifiedMarker, "");
			return { phase: "done" };
		} catch (error) {
			if (signal.cancelled) return { phase: "failed", failure: { kind: "cancelled" } };
			return { phase: "failed", failure: { kind: "network", message: (error as Error).message } };
		} finally {
			if (heartbeat !== null) window.clearInterval(heartbeat);
			releaseLock(paths);
		}
	};

	const finished = run().then((outcome) => {
		publish(outcome);
		return outcome;
	});

	return {
		progress: () => current,
		cancel: () => {
			signal.cancelled = true;
		},
		finished,
	};
}

/**
 * How far a download this vault is *not* running has got, as a percentage.
 *
 * The filesystem is the shared state: a second vault reads the same growing `.part` rather than
 * coordinating with the first (§5.4). Null when there is nothing to measure.
 */
export function foreignDownloadPercent(paths: LocalModelPaths, platform: LocalModelPlatform): number | null {
	const fs = nodeRequire("fs");
	const path = nodeRequire("path");
	let received = 0;
	let found = false;
	for (const artefact of MODEL_ARTEFACTS) {
		const target = path.join(paths.modelDir, artefact.fileName);
		try {
			received += fs.statSync(target).size;
			continue;
		} catch {
			// Not finished yet; fall through to the part.
		}
		try {
			received += fs.statSync(target + PART_SUFFIX).size;
			found = true;
		} catch {
			// Not started yet.
		}
	}
	if (!found) return null;
	return Math.min(99, Math.floor((received / totalDownloadBytes(platform)) * 100));
}

/** Removes the model, its markers and the engine, for §5.6's Delete button. Returns the bytes freed. */
export function removeLocalModel(paths: LocalModelPaths): number {
	const fs = nodeRequire("fs");
	let freed = 0;
	for (const file of [paths.modelFile, paths.mmprojFile]) {
		try {
			freed += fs.statSync(file).size;
		} catch {
			// Already gone; nothing to count.
		}
	}
	fs.rmSync(paths.modelDir, { recursive: true, force: true });
	fs.rmSync(paths.runtimeDir, { recursive: true, force: true });
	return freed;
}

/**
 * Throws away a paused download, for the button that says how much it discards (§5.3).
 *
 * It removes **the whole unfinished set**, complete files included, and not only the `.part`s --
 * because that is what {@link partialBytes} counts and what the button's label therefore promises.
 * A model whose first file finished and whose second did not is one incomplete download, and
 * discarding half of it would leave 4.6 GB the card can no longer explain.
 */
export function discardPartialDownload(paths: LocalModelPaths): void {
	const fs = nodeRequire("fs");
	for (const file of [paths.modelFile, paths.mmprojFile, paths.modelPart, paths.mmprojPart]) fs.rmSync(file, { force: true });
}

/** Bytes {@link discardPartialDownload} would throw away, so the button can name them before it does. */
export function partialBytes(paths: LocalModelPaths): number {
	const fs = nodeRequire("fs");
	let bytes = 0;
	for (const file of [paths.modelFile, paths.mmprojFile, paths.modelPart, paths.mmprojPart]) {
		try {
			bytes += fs.statSync(file).size;
		} catch {
			// Not there.
		}
	}
	return bytes;
}
