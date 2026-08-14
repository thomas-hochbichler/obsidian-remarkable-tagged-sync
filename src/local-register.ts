// The local model as a registry entry, and the setup card that carries its whole lifecycle
// (managed-local-llm-ocr spec §6.5, §7).
//
// Everything decided here is decided somewhere else and only assembled here: the machine gate in
// `local-model-gate.ts`, the disk state in `local-model-store.ts`, the copy in `local-model-card.ts`,
// the download in `local-model-fetch.ts`. This file is the wiring, and it is deliberately the only
// place that knows they belong to each other.

import { Notice, Platform, Setting } from "obsidian";
import { BACKGROUND_CONSENT_DESC, cardCopy, deleteConfirmation, type LocalCardState } from "./local-model-card";
import { planCleanup } from "./local-model-download";
import { localModelBlock, localModelUnavailableLabel, NOT_READY_LABEL } from "./local-model-gate";
import {
	discardPartialDownload,
	type DownloadHandle,
	foreignDownloadPercent,
	partialBytes,
	removeLocalModel,
	startLocalModelDownload,
} from "./local-model-fetch";
import {
	localModelPlatform,
	machineFacts,
	readLocalModelSnapshot,
	readModelDirectories,
	removeModelDirectory,
	resolveLocalModelPaths,
} from "./local-model-runtime";
import { readLocalModelSettings, reTranscribeCaveat, setBackgroundConsent } from "./local-model-settings";
import { deriveLocalModelState, type LocalModelPaths, MODEL_DIR } from "./local-model-store";
import { createLocalOcrBackend, isLocalModelBusy } from "./local-ocr-runtime";
import { type BackendSettingsContext, registerOcrBackend } from "./ocr-registry";
import { UnavailableOcrBackend } from "./vision-ocr-backend";

export const LOCAL_BACKEND_ID = "local";
const LOCAL_BACKEND_LABEL = "Local model (on your machine)";

/**
 * The plugin id, which is the directory name under Application Support / LOCALAPPDATA.
 *
 * Hard-coded to `manifest.json`'s id rather than read from it: the manifest is not importable from a
 * bundled module, and a *display name* here would put a space and a capital in a path that has to be
 * stable across releases (§5.1 says the id, explicitly, for that reason).
 */
const PLUGIN_ID = "remarkable-tagged-sync";

/** What the note-contract hint says while this backend is selected (§7.6). */
export const LOCAL_NOTE_CONTRACT = "Local model: headings and lists, as written on the page. Tables are transcribed as plain lines.";

/** The download in flight for this Obsidian session, if any. Never persisted; §5.5 forbids it. */
let download: DownloadHandle | null = null;
/** A runtime that failed to start this session (§5.5: session-scoped, not a property of the directory). */
let runtimeFailure: string | null = null;

/** Records a runtime failure so the card can explain it, rather than showing a healthy "ready". */
export function noteLocalRuntimeFailure(message: string): void {
	runtimeFailure = message;
}

/** Why this machine cannot run the model, or null. Null on a machine where node is not available. */
function blockForThisMachine(): ReturnType<typeof localModelBlock> {
	const machine = machineFacts();
	return machine ? localModelBlock(machine) : { kind: "architecture" };
}

/** True where the backend could actually run, which is what decides whether it gets a card at all. */
function machineCanRun(): boolean {
	return blockForThisMachine() === null;
}

/**
 * The card's state, read fresh from disk on every render (§5.5).
 *
 * Never cached: a model deleted or truncated by something outside the plugin has to be noticed, and a
 * remembered "ready" is precisely what would hide it.
 */
function currentCardState(paths: LocalModelPaths): LocalCardState {
	const inFlight = download?.progress();
	if (inFlight) {
		switch (inFlight.phase) {
			case "checking":
			case "downloading":
				return { kind: "downloading", receivedBytes: inFlight.phase === "downloading" ? inFlight.receivedBytes : 0, totalBytes: inFlight.phase === "downloading" ? inFlight.totalBytes : 1 };
			case "verifying":
			case "extracting":
				return { kind: "verifying" };
			case "failed":
				switch (inFlight.failure.kind) {
					case "out-of-disk":
						return { kind: "out-of-disk", shortfallBytes: inFlight.failure.shortfallBytes };
					case "corrupt":
						return { kind: "corrupt" };
					case "extract":
						return { kind: "runtime-failed", message: inFlight.failure.message };
					case "network":
						return { kind: "network-lost", message: inFlight.failure.message };
					case "cancelled":
					case "busy":
						break;
				}
				break;
			case "done":
				break;
		}
	}

	const snapshot = readLocalModelSnapshot(paths);
	const state = deriveLocalModelState(snapshot, Date.now());
	switch (state) {
		case "corrupt":
			return { kind: "corrupt" };
		case "downloading":
			// Someone holds the lock and it is not us, so this vault reads the same growing file.
			return { kind: "foreign-download", percent: foreignDownloadPercent(paths, localModelPlatform() ?? "darwin") ?? 0 };
		case "partial":
			return { kind: "paused", onDiskBytes: partialBytes(paths) };
		case "verifying":
			return { kind: "verifying" };
		case "removed":
			return { kind: "removed" };
		case "ready":
			return runtimeFailure ? { kind: "runtime-failed", message: runtimeFailure } : { kind: "ready" };
		case "absent":
			return supersededModelPresent(paths) ? { kind: "update-available" } : { kind: "absent" };
	}
}

/**
 * Whether a complete model of a *superseded* version is sitting beside the pinned one.
 *
 * That is what "update available" means here: the plugin version is the model version (§5.2), so an
 * update is a release that ships new constants next to a model that still works and is still the
 * fallback if the new download fails.
 */
function supersededModelPresent(paths: LocalModelPaths): boolean {
	const plan = planCleanup(readModelDirectories(paths), MODEL_DIR);
	// A partial of a version this build can no longer finish is provably useless and goes now; a
	// complete one is what makes this an update rather than a fresh install.
	for (const name of plan.deleteSilently) removeModelDirectory(paths, name);
	return plan.offerToDelete.length > 0;
}

/** Starts (or restarts) the download and re-renders as it moves. */
function beginDownload(paths: LocalModelPaths, rerender: () => void): void {
	const platform = localModelPlatform();
	if (!platform) return;
	if (isLocalModelBusy(paths)) {
		// The guard names a *transcription*, not a download: `isLocalModelBusy` is only true for a held
		// lock with no `.part` beside it (§5.4). A vault that is downloading is caught earlier and much
		// more usefully, by the `foreign-download` card state, which shows its progress instead of a
		// notice.
		new Notice("Another vault is transcribing right now. Try again in a moment.");
		return;
	}
	runtimeFailure = null;
	download = startLocalModelDownload(paths, platform, rerender);
	void download.finished.then(() => rerender());
	rerender();
}

/** Renders the setup card: the state, its copy, its buttons, and the consent checkbox where it belongs. */
function renderCard(containerEl: HTMLElement, ctx: BackendSettingsContext, rerender: () => void): void {
	const paths = resolveLocalModelPaths(PLUGIN_ID);
	const platform = localModelPlatform();
	if (!paths || !platform) return;

	const state = currentCardState(paths);
	// A ready model has nothing left to set up: the backend is selectable, so the dropdown is where it
	// belongs now. Its speed, its misread caveat and its delete button are about a backend in use, and
	// beside a different selected backend they only add a screenful. Every other state stays -- an
	// absent, paused or broken model is exactly what the card exists to explain, and it cannot be
	// selected to reach that explanation.
	if (state.kind === "ready" && !ctx.isSelected) return;

	const copy = cardCopy(state, platform, ctx.settings);

	const card = containerEl.createDiv({ cls: "tagged-sync-card" });
	card.createEl("h4", { text: copy.heading });
	for (const paragraph of copy.paragraphs) card.createEl("p", { text: paragraph });

	if (copy.percent !== null) {
		// A plain progress element: no styling of our own to go stale against a theme.
		const bar = card.createEl("progress");
		bar.max = 100;
		bar.value = copy.percent;
	}

	if (copy.actions.length > 0) {
		const row = new Setting(card);
		// A delete button on a nameless row asks the user to take on trust what it removes. Naming the
		// directory beside it is the whole answer, and it is also where to look when the model is gone
		// from outside the plugin.
		if (copy.actions.some((action) => action.id === "delete")) row.setName("Model files").setDesc(paths.modelDir);
		for (const action of copy.actions) {
			row.addButton((button) => {
				button.setButtonText(action.label);
				if (action.emphasis === "cta") button.setCta();
				// The class Obsidian styles a destructive button with. `setWarning()` is deprecated and
				// `setDestructive()` needs 1.13, while the manifest floor is 1.5.7 -- the class predates both.
				if (action.emphasis === "warning") button.buttonEl.addClass("mod-warning");
				button.onClick(async () => {
					switch (action.id) {
						case "download":
						case "resume":
						case "update":
						case "retry-runtime":
							beginDownload(paths, rerender);
							break;
						case "cancel":
							download?.cancel();
							download = null;
							rerender();
							break;
						case "discard":
							discardPartialDownload(paths);
							download = null;
							rerender();
							break;
						case "delete": {
							const freed = removeLocalModel(paths);
							new Notice(deleteConfirmation(freed, Platform.isMacOS ? "Apple Vision" : "no transcription"));
							download = null;
							runtimeFailure = null;
							// The selection has to move with the model. §6.2's listing rule keeps a *selected*
							// entry in the dropdown, disabled -- so without this the user is left holding a
							// backend that transcribes nothing, with no hint of what to switch to.
							await ctx.selectDefaultBackend();
							break;
						}
					}
				});
			});
		}
	}

	// Asked twice, but never on one screen. The canonical row under *Automatic sync* only exists while
	// this backend is the selected one, and a backend still downloading cannot be selected -- so the
	// card carries the question exactly where the other row cannot reach: during setup, next to the
	// runtime estimate that makes it answerable (§7.5). Once selected, the canonical row has it.
	if (copy.showsBackgroundConsent && !ctx.isSelected) {
		new Setting(card)
			.setName("Transcribe during background sync")
			.setDesc(BACKGROUND_CONSENT_DESC)
			.addToggle((toggle) =>
				toggle.setValue(readLocalModelSettings(ctx.settings).backgroundConsent).onChange(async (value) => {
					setBackgroundConsent(ctx.settings, value);
					await ctx.save();
				}),
			);
	}
}

/**
 * **Linux is not registered at all**, which is different from every other excluded machine.
 *
 * Intel Macs and Windows x64 do register, disabled and with a reason, because those users can see
 * the backend exists -- the README and every macOS screenshot promise it -- and silence would read
 * as a bug. Nothing on Linux is verified in any respect, and an unverified 5.5 GB download is worse
 * than no offer (§4.3, on ticket 07 §3's argument).
 */
function offeredOnThisPlatform(): boolean {
	return localModelPlatform() !== null;
}

if (offeredOnThisPlatform()) {
	registerOcrBackend({
		id: LOCAL_BACKEND_ID,
		label: LOCAL_BACKEND_LABEL,
		/** Never spends money: it never leaves the machine. */
		metered: false,
		requiresLicence: false,
		/**
		 * Costs no money and still costs battery, fans and 14 GB of RAM for minutes at a time without the
		 * user having asked. That is what this field is for, and it is why it is not a rename of `metered`.
		 */
		needsBackgroundConsent: true,

		unavailableLabel() {
			const block = blockForThisMachine();
			if (block) {
				// eslint-disable-next-line @typescript-eslint/no-require-imports -- Desktop-guarded above by blockForThisMachine.
				const platform = Platform.isDesktop ? (require("os") as typeof import("os")).platform() : "";
				return localModelUnavailableLabel(block, platform);
			}
			const paths = resolveLocalModelPaths(PLUGIN_ID);
			if (!paths) return null;
			const snapshot = readLocalModelSnapshot(paths);
			if (deriveLocalModelState(snapshot, Date.now()) === "ready" && !runtimeFailure) return null;
			// The one lifecycle string: the card below says which of the five reasons it is.
			return NOT_READY_LABEL;
		},

		/**
		 * **Never `null`.** `null` means "fall back to a free local backend", which map constraint 11
		 * forbids here: a silent Vision transcript is written once and never revisited, because the sync
		 * skips a document whose device-side hash is unchanged. An `unavailable` unit writes no transcript
		 * and poisons no cache, and *Re-transcribe all synced notes* is the way back (§8.1).
		 */
		create(settings, options) {
			const paths = resolveLocalModelPaths(PLUGIN_ID);
			if (paths && isLocalModelBusy(paths) && !options?.silent) {
				// Two concurrent runs are 27 GB. Manual says so; a background sync is skipped silently and
				// the next interval retries.
				new Notice("Another vault is transcribing right now. Try again in a moment.");
			}
			const backend = createLocalOcrBackend(PLUGIN_ID, settings, noteLocalRuntimeFailure);
			return backend ?? new UnavailableOcrBackend(LOCAL_BACKEND_ID);
		},

		/**
		 * Attached only where the model could actually run (§4.1). Where it cannot, the entry registers
		 * *without* a card and carries a permanent `unavailableLabel()` — which makes §6.2's listing rule
		 * produce show-but-disable for exactly those machines, with no extra mechanism.
		 */
		renderSetup: machineCanRun()
			? (containerEl, ctx) => {
					renderCard(containerEl, ctx, () => {
						containerEl.empty();
						renderCard(containerEl, ctx, () => undefined);
					});
				}
			: undefined,

		/**
		 * The free build's note contract used to be Vision's flat-text ceiling. With this backend selected
		 * that sentence is wrong in the user's favour, and claiming parity with the six Pro providers
		 * would be wrong the other way: the single table in the corpus came back as 24 bullets.
		 */
		noteContract: LOCAL_NOTE_CONTRACT,

		reTranscribeCaveat: (settings, unitCount) => reTranscribeCaveat(settings, unitCount),

		backgroundConsent: {
			get: (settings) => readLocalModelSettings(settings).backgroundConsent,
			set: (settings, value) => setBackgroundConsent(settings, value),
			description: BACKGROUND_CONSENT_DESC,
		},
	});
}


