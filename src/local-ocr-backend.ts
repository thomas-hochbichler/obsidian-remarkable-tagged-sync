// The local model backend, with the subprocess injected (managed-local-llm-ocr spec §3, §8).
//
// Everything that decides what a unit's transcript and status become lives here and is testable
// without a 5.5 GB model; `local-ocr-runtime.ts` is the half that spawns `llama-mtmd-cli`.

import { typedText } from "./llm-transcript";
import { recordPageDuration } from "./local-model-settings";
import type { BackendSettings } from "./ocr-registry";
import type { OcrBackend, OcrResult } from "./ocr-backend";
import { rasterizePage } from "./page-rasterizer";
import { encodeGrayscalePng } from "./png-encoder";
import type { RmPage } from "./rm-parser";

/**
 * What one page's invocation came back as.
 *
 * The two failure kinds are not cosmetic: §8.2 maps them to different unit outcomes, and telling them
 * apart is what stops a healthy runtime's one bad page from costing the other 39.
 */
export type LocalPageOutcome =
	| { kind: "text"; text: string; durationMs: number }
	/** The runtime ran and this page did not come out. The next page is still worth trying. */
	| { kind: "page-failed"; message: string }
	/** The runtime cannot run here at all: spawn failure, immediate exit, a missing DLL, a deleted binary. */
	| { kind: "runtime-broken"; message: string };

/** Runs one page image through the model. Never throws -- every failure is one of the outcomes. */
export type LocalPageRunner = (image: Uint8Array) => Promise<LocalPageOutcome>;

/** What one finished `llama-mtmd-cli` process left behind, as {@link classifyRun} needs to read it. */
export interface FinishedRun {
	/** Exit status, or null when the process was killed rather than exiting on its own. */
	code: number | null;
	/** True when the page timer killed it. A timeout is a slow page, never a broken runtime. */
	timedOut: boolean;
	stdout: string;
	stderr: string;
	/** Re-checked *after* the run: antivirus can take the engine between two pages of one sync (§5.7). */
	executablePresent: boolean;
}

/**
 * Which of §8.2's cases a finished process is.
 *
 * Pure, and split out of the spawn layer for one reason: **the release gate found this wrong.** A page
 * that hit the ten-minute timer was being read as case 1, which discards the whole document, remembers
 * the runtime as broken and returns `unavailable` for every further unit of the sync -- from one slow
 * page. §8.2 case 1 is *"immediate exit with no output"*; a process that ran for ten minutes is the
 * plainest possible case 2, *"one page fails while the runtime is healthy"*, and the six pages this run
 * had already transcribed were the proof of the health.
 */
export function classifyRun(run: FinishedRun): LocalPageOutcome {
	if (run.code === 0 && !run.timedOut) return { kind: "text", text: run.stdout, durationMs: 0 };
	// Checked before anything else about the exit: a dead process with the binary gone underneath it is
	// §5.7's removed engine whatever its exit status looked like.
	if (!run.executablePresent) return { kind: "runtime-broken", message: "the transcription engine was removed while it ran" };
	if (run.timedOut) return { kind: "page-failed", message: "the page took longer than ten minutes and was given up on" };
	// Exit code 1 with nothing on stdout is the shape of a runtime that cannot run here at all -- a
	// missing MSVC redistributable fails exactly this silently.
	if (run.stdout.trim() === "") {
		return { kind: "runtime-broken", message: `the engine exited with ${run.code}: ${run.stderr.trim().split("\n").pop() ?? "no output"}` };
	}
	return { kind: "page-failed", message: `the engine exited with ${run.code}` };
}

export interface LocalOcrOptions {
	runPage: LocalPageRunner;
	/**
	 * The backend's own blob from `data.json`, live rather than a copy: page durations are written
	 * through it and the plugin's next save carries them (§7.3's rolling mean).
	 */
	settings: BackendSettings;
	/**
	 * Called once when the runtime turns out not to run here, so the setup card can say so instead of
	 * showing a healthy "ready" over a backend that transcribed nothing all sync.
	 *
	 * Session-scoped by construction: the adapter is rebuilt per sync and this is not written to disk
	 * (§5.5), so the next sync probes again rather than inheriting a verdict.
	 */
	onRuntimeFailure?: (message: string) => void;
}

const SKIPPED: OcrResult = { status: "skipped", text: "", confidence: null };

/**
 * One `llama-mtmd-cli` spawn per page, strictly sequential, nothing kept alive between pages or
 * between syncs (§8.3).
 *
 * Model load is only ~1.9 s of 14.9 s, so a resident `llama-server` would buy ~13 % for the price of
 * holding 13.43 GB (16.64 GB on Windows) resident while the user is doing something else. Sequential
 * because two concurrent processes are 27 GB -- the same arithmetic that produced §5.4's lock.
 */
export class LocalOcrBackend implements OcrBackend {
	readonly id = "local" as const;
	/** Costs no money by construction: it never leaves the machine. */
	readonly metered = false;
	private readonly runPage: LocalPageRunner;
	private readonly settings: BackendSettings;
	private readonly onRuntimeFailure: (message: string) => void;
	/**
	 * Session-scoped and deliberately not on disk (§5.5): the runtime being broken is a fact about this
	 * run, not a property of the directory. The adapter is rebuilt per sync, so the next one probes
	 * again.
	 */
	private runtimeBroken = false;

	constructor(options: LocalOcrOptions) {
		this.runPage = options.runPage;
		this.settings = options.settings;
		this.onRuntimeFailure = options.onRuntimeFailure ?? (() => undefined);
	}

	async recognize(pages: RmPage[]): Promise<OcrResult> {
		if (pages.length === 0) return SKIPPED;
		// Case 1, remembered: without this it is 39 more pages of fans for 39 identical failures.
		if (this.runtimeBroken) return { status: "unavailable", text: "", confidence: null };

		const transcripts: string[] = [];
		const warnings: string[] = [];
		for (const [index, page] of pages.entries()) {
			const outcome = await this.runPage(encodeGrayscalePng(rasterizePage(page)));

			if (outcome.kind === "runtime-broken") {
				this.runtimeBroken = true;
				this.onRuntimeFailure(outcome.message);
				// Nothing already read is kept. The sync skips a document whose device-side hash is
				// unchanged, so half a transcript written now is half a transcript forever (§8.1).
				return { status: "unavailable", text: "", confidence: null, warnings: [`the transcription engine stopped: ${outcome.message}`] };
			}
			if (outcome.kind === "page-failed") {
				// Vision keeps the other pages and says nothing; this backend keeps them and says so,
				// because under §8.1 a silently lost page is a permanently lost one.
				warnings.push(`page ${index + 1} could not be transcribed: ${outcome.message}`);
				continue;
			}

			recordPageDuration(this.settings, outcome.durationMs);
			// Typed text is not on the image -- the rasterizer draws ink -- and it must not go through
			// the model either, being exact already. Appended per page: one image per invocation means
			// there is no line box to splice it against, which is the one thing Vision can do here.
			const pageTranscript = [outcome.text.trim(), typedText([page])].filter((part) => part !== "").join("\n\n");
			if (pageTranscript !== "") transcripts.push(pageTranscript);
		}

		if (transcripts.length > 0) {
			return { status: "ok", text: transcripts.join("\n\n"), confidence: null, ...(warnings.length > 0 ? { warnings } : {}) };
		}
		// No text anywhere: a genuinely blank set is `skipped`, one that errored is `failed`.
		return warnings.length > 0 ? { status: "failed", text: "", confidence: null, warnings } : SKIPPED;
	}
}
