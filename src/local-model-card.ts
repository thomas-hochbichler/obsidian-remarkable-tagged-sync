// Every word the setup card says, as a pure function of the state it is in (managed-local-llm-ocr
// spec §7.1-§7.5, §5.6, §5.7).
//
// The copy lives here rather than inside the settings renderer for one reason: these sentences were
// decided by tickets after measurement, several of them against a competing wording, and a string
// that can be asserted is a string that cannot quietly drift. The renderer below the seam turns this
// into DOM and knows nothing about what any of it means.

import { betterGeneration, type ChoiceContext, type ModelGeneration, totalDownloadBytes } from "./local-model-artefacts";
import { formatBytes, shortfallMessage } from "./local-model-download";
import { estimateLine } from "./local-model-settings";
import type { LocalModelPlatform } from "./local-model-store";
import type { BackendSettings } from "./ocr-registry";

/** What the user can press. The renderer maps each id to behaviour; the copy owns the label. */
/**
 * A better model exists and this install is not using it (ticket 20).
 *
 * Both error rates are carried so the card can state the trade rather than assert an improvement --
 * "3.2 % against your 4.3 %" is a reason to press a button; "a newer model is available" is not.
 */
export interface NewerModelOffer {
	label: string;
	downloadBytes: number;
	medianCer: number;
	currentMedianCer: number;
}

/**
 * What to say about a newer model, when the one in use is not the newest.
 *
 * Pure, and here rather than in the settings registry for the reason the local-model set is built on:
 * everything that *decides* is a function over facts, so it can be tested without a filesystem. Both
 * error rates come from the generation records, so the card quotes what *these* files measured on the
 * fifteen public reference pages rather than a claim from a model card.
 *
 * "Better" is judged against what this machine can run, not against the list: on a Mac too small for
 * the most accurate model there may still be one better than the reader has, and offering a model its
 * own memory gate would refuse is worse than offering nothing.
 */
export function newerModelOffer(inUse: ModelGeneration, context: ChoiceContext): NewerModelOffer | null {
	const better = betterGeneration(inUse, context);
	if (!better) return null;
	return {
		label: better.label,
		downloadBytes: totalDownloadBytes(context.platform, better),
		medianCer: better.measured.medianCer,
		currentMedianCer: inUse.measured.medianCer,
	};
}

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
	| { kind: "ready"; newer: NewerModelOffer | null }
	| { kind: "corrupt" }
	| { kind: "removed"; modelBytes: number }
	| { kind: "runtime-failed"; message: string };

/** Bytes as a one-decimal GB, for copy a person reads rather than a number a machine compares. */
function gib(bytes: number): string {
	return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** A rate as a one-decimal percentage. */
function percent(rate: number): string {
	return `${(rate * 100).toFixed(1)} %`;
}

/**
 * What this install would actually download, as the consent copy names it.
 *
 * A function of the generation rather than a constant, because three ship and they differ by a factor
 * of four: a fresh install on an 8 GB Mac fetches 1.6 GB, and a hard-coded string would have promised
 * it the 6.2 GB the largest one costs.
 */
const modelSize = (generation: ModelGeneration) => gib(generation.modelBytes + generation.mmprojBytes);
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
export const QUALITY_LINE_SHORT = "Misreads come out as fluent text — check anything that matters against the handwriting.";

/**
 * The background-sync gate's own copy. Money is gone from it entirely: this costs none (§7.5).
 *
 * The memory figure is the chosen model's own. It was a constant while one model shipped, and telling
 * a reader on the smallest tier that "the model holds 14 GB" would be describing somebody else's Mac.
 *
 * **It says what the switch does before what it costs.** The old wording named only the price --
 * *"the model holds 8.6 GB and pushes the fans"* -- and left the reader to guess what they were
 * buying; it was reported as a setting nobody could picture. What being off actually means is not
 * mild, either: `backgroundRunBlocked` returns `no-background-consent` *before* a run starts, so the
 * whole scheduled sync is skipped, silently, and no note arrives on its own while this backend is the
 * chosen one. "Manual syncs are unaffected" hinted at that and never said it.
 */
export function backgroundConsentDesc(generation: ModelGeneration): string {
	return (
		"Off by default: while this backend is chosen, scheduled syncs are skipped altogether and nothing arrives until you sync by hand. " +
		`Switch it on and they run unattended — the model holds ${gib(generation.peakRssBytes)} and keeps the fans going for as long as each run takes.`
	);
}

/** What the user is agreeing to, in the four terms §7.2 requires plus the speed line of §7.3. */
function consentParagraphs(platform: LocalModelPlatform, settings: BackendSettings, generation: ModelGeneration): string[] {
	return [
		`${modelSize(generation)} model + ${ENGINE_SIZE} program, each checked against a published SHA-256 before it runs.`,
		"Stored outside your vault, shared by every vault, never synced. Uninstalling the plugin does not remove it; the Delete button here does.",
		"Runs on this machine. No account, no key, no network once the download is done.",
		`${generation.label} · Apache-2.0.`,
		`Speed: ${estimateLine(platform, settings)}`,
		// Not an implementation detail on a machine at the floor; it is a large share of it. Both figures
		// are this model's own -- they range from 2.9 GB on an 8 GB Mac to 8.0 GB on a 16 GB one.
		`Memory: ${gib(generation.peakRssBytes)} while a page is read · ${generation.floorGb[platform]} GB of memory needed.`,
		QUALITY_LINE,
	];
}

/** The whole card, for one state. */
export function cardCopy(state: LocalCardState, platform: LocalModelPlatform, settings: BackendSettings, generation: ModelGeneration): CardCopy {
	switch (state.kind) {
		case "absent":
			return {
				heading: "Local model — not downloaded",
				paragraphs: consentParagraphs(platform, settings, generation),
				actions: [{ id: "download", label: `Download the model (${modelSize(generation)})`, emphasis: "cta" }],
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
			//
			// **"Elsewhere", not "in another vault".** The lock holds a timestamp and nothing else -- by
			// §5.4's design, because two vaults share one process and a PID would prove nothing -- so
			// this card cannot actually see a second vault. It never could, and it said so anyway: a
			// download left running by a previous plugin instance shows up here identically, and a user
			// with one vault open was told about a vault that did not exist. The heading now says only
			// what the disk shows -- that a download is running -- and the paragraph names both ways it
			// can be one this vault did not start.
			return {
				heading: `Downloading… — ${state.percent} %`,
				paragraphs: [
					"Another vault is fetching it — or this one was, before the plugin last reloaded. The model is shared, so this vault will use it as soon as the download finishes.",
				],
				actions: [],
				percent: state.percent,
				showsBackgroundConsent: true,
			};

		case "ready": {
			const paragraphs = [`Speed: ${estimateLine(platform, settings)}`, QUALITY_LINE_SHORT];
			const actions: CardAction[] = [{ id: "delete", label: "Delete the model", emphasis: "warning" }];
			if (state.newer) {
				// Stated as a trade with both numbers in it, and never started for the user: what they
				// have works, and a multi-gigabyte download is not something a plugin update may decide.
				paragraphs.push(
					`${state.newer.label} reads the same pages at ${percent(state.newer.medianCer)} character error against your ${percent(state.newer.currentMedianCer)}. ` +
						`A ${gib(state.newer.downloadBytes)} download, installed beside the model you have, which keeps working until you delete it.`,
					"Notes already transcribed are not redone; 'Re-transcribe everything' does that.",
				);
				actions.unshift({ id: "update", label: `Get ${state.newer.label}`, emphasis: "cta" });
			}
			return { heading: "Local model — ready", paragraphs, actions, percent: null, showsBackgroundConsent: true };
		}

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
					// The size of the model *this install has*, not of the newest one on offer: two generations
					// ship, and telling a 5.5 GB user their 6.2 GB model is safe reads as a different machine.
					`Only the ${ENGINE_SIZE} engine is affected; the ${gib(state.modelBytes)} model on disk is untouched and does not need downloading again.`,
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
