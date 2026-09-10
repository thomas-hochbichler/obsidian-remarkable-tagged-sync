// The local model as a registry entry, and the setup card that carries its whole lifecycle
// (managed-local-llm-ocr spec §6.5, §7).
//
// Everything decided here is decided somewhere else and only assembled here: the machine gate in
// `local-model-gate.ts`, the disk state in `local-model-store.ts`, the copy in `local-model-card.ts`,
// the download in `local-model-fetch.ts`. This file is the wiring, and it is deliberately the only
// place that knows they belong to each other.

import { Notice, Platform, Setting } from "obsidian";
import { backgroundConsentDesc, cardCopy, deleteConfirmation, type LocalCardState, newerModelOffer } from "./local-model-card";
import { formatBytes, planCleanup } from "./local-model-download";
import { localModelBlock, localModelUnavailableLabel } from "./local-model-gate";
import {
	discardPartialDownload,
	type DownloadHandle,
	foreignDownloadPercent,
	partialBytes,
	removeStaleParts,
	removeLocalModel,
	startLocalModelDownload,
} from "./local-model-fetch";
import {
	localModelPlatform,
	machineFacts,
	readLocalModelSnapshot,
	readModelDirectories,
	removeModelDirectory,
	pathsForGeneration,
	resolveLocalModel,
	resolveLocalModelPaths,
} from "./local-model-runtime";
import { readLocalModelSettings, reTranscribeCaveat, setBackgroundConsent, setPreferredModelDir } from "./local-model-settings";
import { deriveLocalModelState, type LocalModelPaths } from "./local-model-store";
import { betterGeneration, type ChoiceContext, type ModelGeneration, MODEL_GENERATIONS, runnableGenerations } from "./local-model-artefacts";
import { createLocalOcrBackend, isLocalModelBusy } from "./local-ocr-runtime";
import { type BackendSettings, type BackendSettingsContext, registerOcrBackend } from "./ocr-registry";
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
export const LOCAL_NOTE_CONTRACT = "Transcripts keep headings and lists as written on the page; tables come out as plain lines.";

/** The download in flight for this Obsidian session, if any. Never persisted; §5.5 forbids it. */
let download: DownloadHandle | null = null;
/** A runtime that failed to start this session (§5.5: session-scoped, not a property of the directory). */
let runtimeFailure: string | null = null;

/**
 * Redraws the most recently rendered card, in place. Module state like `download` because it has to
 * outlive one render: the download keeps calling back long after the settings page that started it
 * has been redrawn, and a redraw bound to that first render would draw into an element the page no
 * longer shows.
 */
let redrawCard: () => void = () => undefined;

/** Records a runtime failure so the card can explain it, rather than showing a healthy "ready". */
export function noteLocalRuntimeFailure(message: string): void {
	runtimeFailure = message;
}

/** What the choice rule needs about this machine, plus the user's own pick. Null off a desktop Mac/PC. */
function choiceContext(settings?: BackendSettings): ChoiceContext | null {
	const machine = machineFacts();
	const platform = localModelPlatform();
	if (!machine || !platform) return null;
	return {
		platform,
		totalMemoryBytes: machine.totalMemoryBytes,
		preferred: settings ? readLocalModelSettings(settings).preferredModelDir : null,
	};
}

/**
 * Why this machine cannot run the model, or null. Null on a machine where node is not available.
 *
 * Judged against the floors of the generation this install would actually use: an install holding the
 * 7B is asked whether it can run the 7B, and a machine with nothing installed is asked about the model
 * a fresh install gets. Using one constant here would shut a 16 GB Mac out of a model measured at
 * 8.3 GB because a different, larger model needs 18.
 */
function blockForThisMachine(): ReturnType<typeof localModelBlock> {
	const machine = machineFacts();
	if (!machine) return { kind: "architecture" };
	// Judged against the model this install would actually use, and the least demanding one otherwise:
	// a machine that can run *something* is not blocked because the most accurate model needs more.
	const generation = resolveLocalModel(PLUGIN_ID)?.generation ?? MODEL_GENERATIONS[MODEL_GENERATIONS.length - 1];
	return localModelBlock(machine, generation.floorGb);
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
function currentCardState(paths: LocalModelPaths, generation: ModelGeneration, context: ChoiceContext | null): LocalCardState {
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
	const state = deriveLocalModelState(snapshot, Date.now(), generation);
	switch (state) {
		case "corrupt":
			return { kind: "corrupt" };
		case "downloading":
			// Someone holds the lock and it is not us, so this vault reads the same growing file.
			return { kind: "foreign-download", percent: foreignDownloadPercent(paths, localModelPlatform() ?? "darwin", generation) ?? 0 };
		case "partial":
			return { kind: "paused", onDiskBytes: partialBytes(paths) };
		case "verifying":
			return { kind: "verifying" };
		case "removed":
			return { kind: "removed", modelBytes: generation.modelBytes + generation.mmprojBytes };
		case "ready":
			if (runtimeFailure) return { kind: "runtime-failed", message: runtimeFailure };
			// The offer, and only an offer: a working model is never displaced by a newer one without the
			// user pressing the button (ticket 20).
			return { kind: "ready", newer: context === null ? null : newerModelOffer(generation, context) };
		case "absent":
			// Unreachable while a complete older model is present -- `chooseGeneration` would have picked
			// it and this would read `ready`. What is left is a genuine fresh install.
			return { kind: "absent" };
	}
}

/** Deletes the partials of a model this build can no longer finish; leaves anything complete alone. */
function sweepUnfinishedDirectories(paths: LocalModelPaths, inUse: ModelGeneration): void {
	const plan = planCleanup(readModelDirectories(paths), inUse.dir);
	// Provably useless: no URL in this build could finish it. A *complete* directory is never touched
	// here -- it is either the model in use or the one the user can fall back to.
	for (const name of plan.deleteSilently) removeModelDirectory(paths, name);
}

/**
 * Starts (or restarts) the download and re-renders as it moves.
 *
 * `into` is where the files land and `busyPaths` is what the "is anything transcribing" guard reads,
 * and they are the same directory in every case but one: taking the offer of a newer model writes into
 * a directory nothing has ever locked, while the transcription that must not be disturbed is holding
 * the *current* model's lock. Passing the target to the guard would have made it answer about an empty
 * directory and always say no.
 */
function beginDownload(into: LocalModelPaths, rerender: () => void, generation: ModelGeneration, busyPaths: LocalModelPaths): void {
	const paths = into;
	const platform = localModelPlatform();
	if (!platform) return;
	if (isLocalModelBusy(busyPaths)) {
		// The guard names a *transcription*, not a download: `isLocalModelBusy` is only true for a held
		// lock with no `.part` beside it (§5.4). A vault that is downloading is caught earlier and much
		// more usefully, by the `foreign-download` card state, which shows its progress instead of a
		// notice.
		new Notice("Another vault is transcribing right now. Try again in a moment.");
		return;
	}
	const inFlight = download?.progress().phase;
	if (inFlight !== undefined && inFlight !== "done" && inFlight !== "failed") {
		// Two fetchers appending to one `.part` is how a verified model ends up with a stray part
		// beside it. The card should never offer the button while this instance is downloading, but
		// the guard belongs here, where the second download would actually start.
		return;
	}
	runtimeFailure = null;
	download = startLocalModelDownload(paths, platform, rerender, generation);
	void download.finished.then(() => rerender());
	rerender();
}

/** Renders the setup card: the state, its copy, its buttons, and the consent checkbox where it belongs. */
function renderCard(containerEl: HTMLElement, ctx: BackendSettingsContext, rerender: () => void): void {
	const context = choiceContext(ctx.settings);
	const resolved = resolveLocalModel(PLUGIN_ID, context?.preferred ?? null);
	const platform = localModelPlatform();
	if (!resolved || !platform || !context) return;
	const { paths, generation } = resolved;
	// A partial of a model no build can finish any more is provably useless; anything complete is left
	// exactly where it is, whether it is the model in use or the one to fall back to.
	sweepUnfinishedDirectories(paths, generation);

	const state = currentCardState(paths, generation, context);
	// A leftover `.part` beside a model that is ready is ignored by the state rule; here it is also
	// removed, for an install that got one before the download learnt to clean up after itself.
	if (state.kind === "ready") removeStaleParts(paths);
	// Where the newer model would land, resolved once so the update button does not have to.
	const newer = betterGeneration(generation, context);
	const newerPaths = newer ? pathsForGeneration(PLUGIN_ID, newer) : null;
	const copy = cardCopy(state, platform, ctx.settings, generation);

	const card = containerEl.createDiv({ cls: "tagged-sync-card" });
	card.createEl("h4", { text: copy.heading });
	for (const paragraph of copy.paragraphs) card.createEl("p", { text: paragraph });

	if (copy.percent !== null) {
		// A plain progress element: no styling of our own to go stale against a theme.
		const bar = card.createEl("progress");
		bar.max = 100;
		bar.value = copy.percent;
	}

	// The choice, offered only where there is one: a single runnable model is not a decision, and a
	// dropdown listing one option is a question with one answer.
	// Offered before the download too: the pick decides which model the button below fetches. A reader
	// who wanted the small model used to get the large one, and could switch only after having both.
	const choices = runnableGenerations(context);
	if ((state.kind === "ready" || state.kind === "absent") && choices.length > 1) {
		// What the rule picks with no preference stored. It used to be its own entry, "Decide for me
		// (Qwen3-VL-8B)", above an entry for the same model -- two rows for one choice, and the reader
		// asked why the 8B was listed twice. Now the rule's pick is marked on the entry it names, and
		// choosing that entry stores nothing, exactly as the old entry did.
		const byRule = resolveLocalModel(PLUGIN_ID, null)?.generation ?? generation;
		new Setting(card)
			.setName("Model")
			.setDesc(
				`Character error on fifteen reference pages, and the memory used while a page is read. Lower is better. The memory is measured, not read off the name: a smaller model can hold more. ${
					MODEL_GENERATIONS.filter((candidate) => !choices.includes(candidate))
						.map((candidate) => `${candidate.label} needs ${candidate.floorGb[context.platform]} GB and is not offered here.`)
						.join(" ")
				}`.trim(),
			)
			.addDropdown((dropdown) => {
				for (const candidate of choices) {
					dropdown.addOption(
						candidate.dir,
						// Same unit as the card's Memory line: this divided by 1024³ while the card divided by
						// 10⁹, so one screen said 2.9 GB and 3.1 GB of the same figure.
						`${candidate.label} — ${(candidate.measured.medianCer * 100).toFixed(1)} % error, ${formatBytes(candidate.peakRssBytes)} memory${
							candidate === byRule ? " (default)" : ""
						}`,
					);
				}
				dropdown.setValue(context.preferred ?? byRule.dir);
				dropdown.onChange(async (value) => {
					// The default is a cleared preference rather than a stored one -- `readLocalModelSettings`
					// treats both alike, and not writing a key keeps `data.json` free of one that means
					// nothing. It also keeps the rule in charge on another machine, where its pick may differ.
					setPreferredModelDir(ctx.settings, value === byRule.dir ? null : value);
					await ctx.save();
					rerender();
				});
			});
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
						case "retry-runtime":
							beginDownload(paths, rerender, generation, paths);
							break;
						// The one action that writes into a *different* directory than the one in use: the
						// newer model installs beside the working one, which is what makes it an offer.
						case "update":
							beginDownload(newerPaths ?? paths, rerender, newer ?? generation, paths);
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
		 * Costs no money and still costs battery, heat and 14 GB of RAM for minutes at a time without the
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
			// Not downloaded is not unavailable: the entry is listed and selectable, and its card below
			// says what to do. Only a machine that can never run it gets the disabled option.
			return null;
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
		 * Stops a download this plugin instance started, so it does not outlive the instance.
		 *
		 * Cancelling releases the lock and leaves the `.part` where a Resume finds it, so nothing that
		 * was fetched is thrown away -- the card comes back as *Download paused* with the bytes named,
		 * which is a state the user already has a button for. Without this the fetch and the 10-second
		 * lock heartbeat both survive a reload, and the fresh instance reads its own predecessor's work
		 * as `foreign-download`: *"Being downloaded in another vault"*, with one vault open.
		 */
		onPluginUnload() {
			download?.cancel();
			download = null;
		},

		/**
		 * Attached only where the model could actually run (§4.1). Where it cannot, the entry registers
		 * *without* a card and carries a permanent `unavailableLabel()` — which makes §6.2's listing rule
		 * produce show-but-disable for exactly those machines, with no extra mechanism.
		 */
		renderSettings: machineCanRun()
			? (containerEl, ctx) => {
					// The card gets an element of its own, so a redraw empties the card and nothing else.
					// `containerEl` is the whole settings page: emptying *that* on a progress tick left the
					// user with a lone card and no settings, and the redrawn card's own redraw was a no-op,
					// so the tick after it moved nothing.
					const host = containerEl.createDiv();
					redrawCard = () => {
						host.empty();
						renderCard(host, ctx, () => redrawCard());
					};
					renderCard(host, ctx, () => redrawCard());
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
			description: backgroundConsentDesc(resolveLocalModel(PLUGIN_ID)?.generation ?? MODEL_GENERATIONS[MODEL_GENERATIONS.length - 1]),
		},
	});
}


