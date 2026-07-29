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
 * Whether a stored backend id is one this build actually has. Drives the load-time migration: a
 * retired literal, or a backend this build does not include, is coerced back to the platform default
 * rather than selecting a backend that cannot be built.
 */
export function isRegisteredOcrBackend(value: unknown): value is OcrBackendId {
	return typeof value === "string" && entries.has(value);
}
