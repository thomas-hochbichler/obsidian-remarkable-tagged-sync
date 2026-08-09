// Every word the setup card says, as a pure function of the state it is in (managed-local-llm-ocr
// spec §7.1-§7.5, §5.6, §5.7).
//
// The copy lives here rather than inside the settings renderer for one reason: these sentences were
// decided by tickets after measurement, several of them against a competing wording, and a string
// that can be asserted is a string that cannot quietly drift. The renderer below the seam turns this
// into DOM and knows nothing about what any of it means.

import { formatBytes, shortfallMessage } from "./local-model-download";
import { estimateLine } from "./local-model-settings";
import type { LocalModelPlatform } from "./local-model-store";
import type { BackendSettings } from "./ocr-registry";

/** What the user can press. The renderer maps each id to behaviour; the copy owns the label. */
export interface CardAction {
	id: "download" | "resume" | "cancel" | "discard" | "delete" | "retry-runtime" | "update";
	label: string;
	/** `cta` is the one obvious next step; `warning` is destructive and styled as such. */
	emphasis: "cta" | "warning" | "normal";
}

export interface CardCopy {
	heading: string;
	paragraphs: string[];
	actions: CardAction[];
	/** 0-100 when the card should draw a bar, null otherwise. */
	percent: number | null;
	/** True when the card asks for the background-sync consent checkbox (§7.5). */
	showsBackgroundConsent: boolean;
}

/**
 * The thirteen states of §7.1. `ready` appears once rather than twice: §7.3's 9a and 9b differ only
 * in which figure the Speed line quotes, and that difference is *the point* -- the derived number is
 * provisional by construction, not by disclaimer, so it is one state whose number improves.
 */
export type LocalCardState =
	| { kind: "absent" }
	| { kind: "downloading"; receivedBytes: number; totalBytes: number }
	| { kind: "verifying" }
	| { kind: "paused"; onDiskBytes: number }
	| { kind: "out-of-disk"; shortfallBytes: number }
	| { kind: "network-lost"; message: string }
	| { kind: "foreign-download"; percent: number }
	| { kind: "ready" }
	| { kind: "update-available" }
	| { kind: "corrupt" }
	| { kind: "removed" }
	| { kind: "runtime-failed"; message: string };

/** The download's two halves as the consent copy names them, one line each. */
const MODEL_SIZE = "5.5 GB";
/**
 * The engine's size, quoted as **12 MB**.
 *
 * The pinned archives measure 10.98 MB on macOS and 12.19 MB on Windows, so this is exact on Windows
 * and one megabyte generous on macOS -- which is the right direction for a number in a consent
 * dialog, and one line beats two. The binary is named as a cost rather than hidden inside "the
 * model": §10 accepted a residual store risk *because* the hygiene is visible.
 */
const ENGINE_SIZE = "12 MB";

/**
 * The quality line: a comparison, not a warning (§7.4).
 *
 * The model hallucinates quietly -- ink reading `daas inventory det.` came back as `dao (over here
 * out)`: fluent, plausible, invented. A warning attached only to the LLM would tell the user that the
 * *accurate* option is the risky one, since Vision gets three times as many characters wrong.
 */
export const QUALITY_LINE =
	"Any transcription misreads words sometimes. Apple Vision gets more of them wrong, and its mistakes " +
	"usually look broken on the page. This model gets fewer wrong and writes them as fluent text — so a " +
	"mistake reads like something you meant to write. Check anything that matters against the handwriting.";

/**
 * The same warning for a card the user is not deciding anything on.
 *
 * {@link QUALITY_LINE} earns its four sentences where the choice is still open: it is a comparison
 * against the alternative, and dropping the comparison there would leave a bare warning on the
 * accurate option. On a model already downloaded and selected there is nothing left to compare -- the
 * only sentence still doing work is the one that says what a mistake will look like.
 */
export const QUALITY_LINE_SHORT =
	"This model's misreads come out as fluent text, so check anything that matters against the handwriting.";

/** The background-sync gate's own copy. Money is gone from it entirely: this costs none (§7.5). */
export const BACKGROUND_CONSENT_DESC =
	"Off by default. In the background the model holds 14 GB and pushes the fans for as long as it runs. Manual syncs are unaffected.";

/** What the user is agreeing to, in the four terms §7.2 requires plus the speed line of §7.3. */
function consentParagraphs(platform: LocalModelPlatform, settings: BackendSettings): string[] {
	return [
		`${MODEL_SIZE} model + ${ENGINE_SIZE} program, each checked against a published SHA-256 before it runs.`,
		"Stored outside your vault, shared by every vault, never synced. Uninstalling the plugin does not remove it; the Delete button here does.",
		"Runs on this machine. No account, no key, no network once the download is done.",
		"Qwen2.5-VL-7B · Apache-2.0.",
		`Speed: ${estimateLine(platform, settings)}`,
		// 13.43 GB is not an implementation detail on a 32 GB floor; it is half the machine.
		"Memory: 14 GB · 32 GB of memory recommended.",
		QUALITY_LINE,
	];
}

/** The whole card, for one state. */
export function cardCopy(state: LocalCardState, platform: LocalModelPlatform, settings: BackendSettings): CardCopy {
	switch (state.kind) {
		case "absent":
			return {
				heading: "Local model — not downloaded",
				paragraphs: consentParagraphs(platform, settings),
				actions: [{ id: "download", label: `Download the model (${MODEL_SIZE})`, emphasis: "cta" }],
				percent: null,
				// Asked here, on the one screen where the runtime estimate is already on the user's eye.
				showsBackgroundConsent: true,
			};

		case "downloading": {
			const percent = state.totalBytes > 0 ? Math.floor((state.receivedBytes / state.totalBytes) * 100) : 0;
			return {
				heading: "Downloading the model",
				paragraphs: [
					`${formatBytes(state.receivedBytes)} of ${formatBytes(state.totalBytes)}.`,
					"You can close settings — the download keeps going. Syncing still works while it runs; notes just arrive without a transcript until it is done.",
				],
				actions: [{ id: "cancel", label: "Pause", emphasis: "normal" }],
				percent,
				showsBackgroundConsent: true,
			};
		}

		case "verifying":
			// Its own visible step, never a hash streamed alongside the download: a streamed hash cannot
			// survive a restart mid-download, and this is minutes of disk on 5.5 GB.
			return {
				heading: "Verifying the download",
				paragraphs: ["Checking the downloaded files against the SHA-256 this plugin was published with."],
				actions: [],
				percent: null,
				showsBackgroundConsent: true,
			};

		case "paused":
			return {
				heading: "Download paused",
				paragraphs: [`${formatBytes(state.onDiskBytes)} is already on disk and will not be downloaded again.`],
				actions: [
					{ id: "resume", label: "Resume", emphasis: "cta" },
					// The button says how much it throws away, because that is the fact the answer turns on.
					{ id: "discard", label: `Discard ${formatBytes(state.onDiskBytes)}`, emphasis: "warning" },
				],
				percent: null,
				showsBackgroundConsent: true,
			};

		case "out-of-disk":
			return {
				heading: "Not enough space",
				paragraphs: [
					// Named rather than implied: a bare "not enough space" only sends the user looking for
					// the number nobody gave them.
					shortfallMessage(state.shortfallBytes),
					"Nothing already downloaded was thrown away.",
				],
				actions: [{ id: "resume", label: "Resume", emphasis: "cta" }],
				percent: null,
				showsBackgroundConsent: true,
			};

		case "network-lost":
			return {
				heading: "Download interrupted",
				paragraphs: [state.message, "What is already on disk is kept, and Resume picks up where it stopped."],
				actions: [{ id: "resume", label: "Resume", emphasis: "cta" }],
				percent: null,
				showsBackgroundConsent: true,
			};

		case "foreign-download":
			// The filesystem is the shared state: this vault watches the same growing file rather than
			// coordinating with the vault that owns the lock.
			return {
				heading: `Being downloaded in another vault — ${state.percent} %`,
				paragraphs: ["The model is shared by every vault, so this one will use it as soon as that download finishes."],
				actions: [],
				percent: state.percent,
				showsBackgroundConsent: true,
			};

		case "ready":
			return {
				heading: "Local model — ready",
				paragraphs: [`Speed: ${estimateLine(platform, settings)}`, QUALITY_LINE_SHORT],
				actions: [{ id: "delete", label: "Delete the model", emphasis: "warning" }],
				percent: null,
				showsBackgroundConsent: true,
			};

		case "update-available":
			return {
				heading: "A newer model is available",
				paragraphs: [
					`This plugin version ships a different model. Downloading it needs ${MODEL_SIZE} of free space alongside the one you have, which stays until the new one is verified.`,
					// An 8 GB-class update must not silently start a two-hour job.
					"Notes you have already transcribed are not redone — use 'Re-transcribe everything' afterwards if you want them redone.",
				],
				actions: [
					{ id: "update", label: "Download the new model", emphasis: "cta" },
					{ id: "delete", label: "Delete the old model", emphasis: "warning" },
				],
				percent: null,
				showsBackgroundConsent: true,
			};

		case "corrupt":
			// Terminal, with no further automatic attempt. The second sentence is the one that matters:
			// nothing that failed verification was ever executed.
			return {
				heading: "The download could not be verified",
				paragraphs: [
					"The download did not match the checksum this plugin was published with. Nothing has been run.",
					"Delete it and try again if you want to; the plugin will not retry on its own.",
				],
				actions: [{ id: "delete", label: "Delete and start over", emphasis: "warning" }],
				percent: null,
				showsBackgroundConsent: false,
			};

		case "removed":
			return {
				heading: "The transcription engine was removed after it was installed",
				paragraphs: [
					"This is almost always antivirus software reacting to the engine — Windows Defender flags these builds.",
					// Load-bearing: Defender never touched the model, so the honest reassurance is that the
					// expensive half is safe. There is deliberately no automatic retry, which would loop the
					// malware alert once per cycle, and no "removed twice, giving up" counter.
					`Only the ${ENGINE_SIZE} engine is affected; the ${MODEL_SIZE} model on disk is untouched and does not need downloading again.`,
				],
				actions: [{ id: "retry-runtime", label: "Download the engine again", emphasis: "cta" }],
				percent: null,
				showsBackgroundConsent: false,
			};

		case "runtime-failed":
			return {
				heading: "The transcription engine would not start",
				paragraphs: [state.message, "Notes still sync with the handwriting render. The next sync tries again."],
				actions: [{ id: "retry-runtime", label: "Download the engine again", emphasis: "normal" }],
				percent: null,
				showsBackgroundConsent: false,
			};
	}
}

/**
 * What deleting the model costs and what it does not, for the confirmation (§5.6).
 *
 * It names what transcription falls back to, because the mechanical consequence -- `ocrBackend` is
 * reset to the platform default -- is otherwise invisible until the next sync produces nothing.
 */
export function deleteConfirmation(freedBytes: number, fallbackLabel: string): string {
	return (
		`Delete the local model and engine? This frees ${formatBytes(freedBytes)}. ` +
		`Transcription falls back to ${fallbackLabel}. Transcripts already in your notes are not touched.`
	);
}
