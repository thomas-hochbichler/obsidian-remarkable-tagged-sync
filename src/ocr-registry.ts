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
}

/**
 * A transcription backend the user can select, as the plugin sees it. This is the seam between this
 * build and any backends shipped separately: the plugin names no provider and imports no adapter, it
 * only walks the registry. That is what lets it compile with those backends absent.
 */
export interface OcrBackendEntry {
	readonly id: OcrBackendId;
	/** Dropdown text when this backend can run here. */
	readonly label: string;
	/** True when a run costs the user money per page — drives the auto-sync money gate. */
	readonly metered: boolean;
	/**
	 * True when running this in the background needs the user's say-so, whether or not it costs money.
	 *
	 * Separate from `metered` rather than a rename of it, which is the shape a rename would have
	 * broken: the six LLM providers register through one loop with `metered: kind === "cloud"`, so
	 * Ollama and LM Studio are `false` today and are not background-gated. Renaming the field and
	 * applying its new meaning honestly would flip them to `true` while the consent flag defaults to
	 * `false`, and an existing Ollama user's background transcription would silently stop. A local
	 * model costs no money and still costs battery, fans and several GB of RAM, which is what this
	 * field is for.
	 */
	readonly needsBackgroundConsent: boolean;
	/**
	 * Replacement dropdown text when this backend cannot run on this machine, or null when it can.
	 * A backend that can never be unavailable omits this.
	 */
	unavailableLabel?(): string | null;
	/**
	 * Builds the adapter for one run. Returns `null` when the backend is selected but not configured
	 * enough to run *and* falling back to a free local backend is the right answer (a cloud provider
	 * with no key) — the caller decides the fallback, so this never silently spends money. A backend
	 * that must not fall back returns its own unavailable adapter instead.
	 */
	create(settings: BackendSettings): OcrBackendAdapter | null;
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
	 */
	reTranscribeCaveat?(settings: BackendSettings): string | null;
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
