import type { OcrBackend as OcrBackendId } from "./note-builder";
import type { OcrBackend as OcrBackendAdapter } from "./ocr-backend";

/**
 * One backend's own persisted settings, stored in `data.json` under the backend's id. Deliberately
 * opaque: the registry and the plugin never look inside, so a backend can add a field without the
 * core knowing. Each backend casts this to its own shape.
 */
export type BackendSettings = Record<string, unknown>;

/** What a backend's settings rows get to do: read its blob, and persist an edit. */
export interface BackendSettingsContext {
	settings: BackendSettings;
	save(): Promise<void>;
	/**
	 * Whether this backend is the selected one. A setup card renders for every backend, so a card that
	 * has nothing left to set up — the model is downloaded and the backend is now selectable — is
	 * noise beside whichever backend the user actually picked.
	 */
	isSelected: boolean;
	/**
	 * Whether the *selected* backend already asks "may an automatic sync run with this backend?" on
	 * its own row under *Automatic sync*. A setup card that asks the same question for a backend that
	 * is not selected would then put two switches with one name on one screen, for two different
	 * backends, one of them inert -- so the card is told, and keeps its own copy of the question to
	 * itself until the other row is gone.
	 */
	selectedBackendAsksBackgroundConsent: boolean;
	/**
	 * Hands the selection back to the platform default, for a backend that has just made itself
	 * unusable on purpose — the one case being a "delete the model" button.
	 *
	 * Without it the user is left selecting a backend the listing rule has just hidden: the entry
	 * stays in the dropdown because it is selected, disabled, pointing at a card, and every sync from
	 * then on transcribes nothing until they work out what to change it to.
	 */
	selectDefaultBackend(): Promise<void>;
}

/** Context for building an adapter, for the rare backend whose refusal has something to say. */
export interface CreateOptions {
	/**
	 * True on a background auto-sync, which must never interrupt with a popup. A backend that would
	 * otherwise explain why it is standing this run out stays quiet instead; the next interval retries.
	 */
	silent: boolean;
}

/**
 * A transcription backend the user can select, as the plugin sees it. This is the seam between this
 * build and any backends shipped separately: the plugin names no provider and imports no adapter, it
 * only walks the registry. That is what lets it compile with those backends absent.
 */
/**
 * The one name for the "may an automatic sync run with this backend?" row, wherever it is drawn: the
 * setup card asks during setup, the settings page asks once the backend is chosen, and the money row
 * for a metered backend asks the same question with a price attached. One name so they cannot drift.
 *
 * It used to read *"Transcribe during background sync"*, which promised the switch was about
 * transcription. It is not: with it off the scheduled run is skipped entirely, so beside *Enable
 * automatic sync* it looked like a second switch for the same thing with a different name, and was
 * reported as exactly that. What it really decides is whether an automatic sync may happen *with
 * this backend*, so that is what it says.
 */
export const BACKGROUND_CONSENT_NAME = "Allow automatic sync with this backend";

export interface OcrBackendEntry {
	readonly id: OcrBackendId;
	/** Dropdown text when this backend can run here. */
	readonly label: string;
	/** True when a run costs the user money per page — drives the auto-sync money gate. */
	readonly metered: boolean;
	/**
	 * True when this backend is part of Tagged Sync Pro and refuses to run without a valid licence.
	 *
	 * A third flag rather than a reading of `metered`, for the same reason `needsBackgroundConsent` is
	 * a third flag: the two coincide today and mean different things. `metered` is about the user's
	 * money and gates unattended runs; this is about ours and gates the feature itself. A free metered
	 * backend, or a paid one that costs nothing per page, would break whichever of them was made to
	 * stand in for the other -- and it would break silently, by either charging someone for a free
	 * backend or giving a paid one away.
	 *
	 * The plugin core still names no provider: the entry declares this about itself.
	 */
	readonly requiresLicence: boolean;
	/**
	 * True when running this in the background needs the user's say-so, whether or not it costs money.
	 *
	 * Separate from `metered` rather than a rename of it, which is the shape a rename would have
	 * broken: the six LLM providers register through one loop with `metered: kind === "cloud"`, so
	 * Ollama and LM Studio are `false` today and are not background-gated. Renaming the field and
	 * applying its new meaning honestly would flip them to `true` while the consent flag defaults to
	 * `false`, and an existing Ollama user's background transcription would silently stop. A local
	 * model costs no money and still costs battery, heat and several GB of RAM, which is what this
	 * field is for.
	 */
	readonly needsBackgroundConsent: boolean;
	/**
	 * Replacement dropdown text when this backend cannot run on this machine, or null when it can.
	 * A backend that can never be unavailable omits this.
	 */
	unavailableLabel?(): string | null;
	/**
	 * Called when the plugin unloads, for a backend holding something that outlives it.
	 *
	 * Only the downloadable local model needs it today, and the reason it needs it is worth stating:
	 * its download runs on plain promises and a `window` interval, neither of which Obsidian tears
	 * down with the plugin. A reload mid-download -- a plugin update, a disable and enable -- left the
	 * fetch and the lock heartbeat running with nobody able to stop them, while the fresh instance saw
	 * a held lock over a growing `.part` and could only conclude the download belonged to *another
	 * vault*. It said so, on a machine with one vault open.
	 *
	 * The core still names no provider: the entry declares this about itself, like every other hook.
	 */
	onPluginUnload?(): void;
	/**
	 * Builds the adapter for one run. Returns `null` when the backend is selected but not configured
	 * enough to run *and* falling back to a free local backend is the right answer (a cloud provider
	 * with no key) — the caller decides the fallback, so this never silently spends money. A backend
	 * that must not fall back returns its own unavailable adapter instead.
	 */
	create(settings: BackendSettings, options?: CreateOptions): OcrBackendAdapter | null;
	/**
	 * What this backend's transcripts look like, in one sentence under the dropdown — headings and
	 * lists or flat text, and where its ceiling is.
	 *
	 * Shown only while this backend is selected, and it replaces the generic hint rather than joining
	 * it: a sentence about Apple Vision's flat-text ceiling is simply not true of the notes a user
	 * with another backend selected is about to get.
	 */
	readonly noteContract?: string;
	/** Renders this backend's own settings rows under the backend dropdown, when it has any. */
	renderSettings?(containerEl: HTMLElement, ctx: BackendSettingsContext): void;
	/**
	 * Renders this backend's setup card, for **every** registered backend regardless of which one is
	 * selected — unlike `renderSettings`, which the plugin calls for the selected one only.
	 *
	 * That difference is the whole point: a backend that cannot yet be selected has no way to explain
	 * what would make it selectable, because the only hook it has fires once it already is. This is
	 * where a backend that must be downloaded before it can run says so, asks for consent and shows
	 * its progress.
	 *
	 * Its presence also drives {@link isListedBackend}: a backend with a card is one whose gap the card
	 * is already explaining, so it is hidden from the dropdown rather than shown disabled.
	 */
	renderSetup?(containerEl: HTMLElement, ctx: BackendSettingsContext): void;
	/**
	 * This backend's own sentence for the re-transcribe confirmation, or null when it has nothing to
	 * add. The core cannot compute it: a figure like "about ten minutes per notebook" is a rolling mean
	 * over the user's own pages, and it lives in the backend's opaque settings blob.
	 *
	 * `unitCount` is what makes it a total rather than a rate. The confirmation already names how many
	 * notes are about to be re-transcribed, and "about 50 minutes" is the fact that decides the answer
	 * where "about 15 seconds a note" only hands the user a multiplication.
	 */
	reTranscribeCaveat?(settings: BackendSettings, unitCount: number): string | null;
	/**
	 * This backend's own background-sync consent, for a backend whose {@link needsBackgroundConsent}
	 * is true.
	 *
	 * Deliberately **not** the auto-sync money flag. That one authorises spending, and a user who
	 * agreed to run a free local model unattended has not agreed to be billed by a cloud provider they
	 * select later. Two consents, because they are two different promises.
	 *
	 * The accessors keep the blob opaque: the plugin renders the row and gates the run without ever
	 * learning which key inside it holds the answer.
	 */
	backgroundConsent?: {
		get(settings: BackendSettings): boolean;
		set(settings: BackendSettings, value: boolean): void;
		/** The row's description under *Automatic sync* — the canonical control for this consent. */
		readonly description: string;
	};
}

/** Registration order is the settings-dropdown order; the free backends register first. */
const entries = new Map<OcrBackendId, OcrBackendEntry>();

export function registerOcrBackend(entry: OcrBackendEntry): void {
	entries.set(entry.id, entry);
}

export function ocrBackendEntries(): OcrBackendEntry[] {
	return [...entries.values()];
}

export function ocrBackendEntry(id: OcrBackendId): OcrBackendEntry | null {
	return entries.get(id) ?? null;
}

/**
 * Whether an entry belongs in the backend dropdown at all.
 *
 * > Not listed when `unavailableLabel()` returns a string **and** the entry has a `renderSetup`
 * > **and** it is not the currently selected backend.
 *
 * Which is the mechanical form of one rule: **show-but-disable is for a gap the user cannot fix; hide
 * is for a gap the card below is already explaining.** Apple Vision off macOS has no card and stays
 * visible-and-disabled forever, which is right for a gap that will never close. A backend whose model
 * has not been downloaded yet has a card, and listing it would hand the user a selectable option that
 * transcribes nothing -- Obsidian persists a dropdown change immediately, so the setting would be
 * saved and dead for as long as the download takes.
 *
 * The selected-backend clause carries the case that makes it a rule rather than a filter: the user
 * selects the backend while it works and the model later disappears. Hiding a *selected* entry would
 * leave the dropdown showing nothing at all, so it stays, disabled, pointing at its card.
 */
export function isListedBackend(entry: OcrBackendEntry, selectedId: OcrBackendId): boolean {
	if (entry.id === selectedId) return true;
	return !(entry.unavailableLabel?.() && entry.renderSetup);
}

/**
 * Whether a stored backend id is one this build actually has. Drives the load-time migration: a
 * retired literal, or a backend this build does not include, is coerced back to the platform default
 * rather than selecting a backend that cannot be built.
 */
export function isRegisteredOcrBackend(value: unknown): value is OcrBackendId {
	return typeof value === "string" && entries.has(value);
}
