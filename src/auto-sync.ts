import type { OcrBackend as OcrBackendId } from "./note-builder";
import { ocrBackendEntry } from "./ocr-registry";

/**
 * Whether the *selected* backend id is a metered one. Used only for the settings visibility rule
 * (show the "auto-transcribe on paid API" toggle), which must not run `resolveOcrBackend` — that has
 * side effects (constructs adapters, may show a fallback notice). The runtime gate reads `metered`
 * off the resolved adapter instead, which is the honest answer once a keyless cloud provider has
 * fallen back to a free backend (auto-sync spec §"Money-safety gate").
 */
export function isMeteredProvider(backend: OcrBackendId): boolean {
	return ocrBackendEntry(backend)?.metered ?? false;
}

/**
 * The interval backstop is due when at least `intervalHours` have elapsed since the last completed
 * sync (auto-sync spec §"Coexistence & scheduling"). A missing or unparseable timestamp counts as
 * due, so a fresh install still gets its first interval sync.
 */
export function isIntervalSyncDue(lastSyncAt: string | null, intervalHours: number, nowMs: number): boolean {
	const last = lastSyncAt ? Date.parse(lastSyncAt) : NaN;
	if (Number.isNaN(last)) return true;
	return nowMs - last >= intervalHours * 3_600_000;
}
