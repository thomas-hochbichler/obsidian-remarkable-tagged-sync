/**
 * Extraction backends, registered like OCR backends (`ocr-registry.ts`) so the Pro census in
 * `pro-capabilities.ts` covers them and a later backend (a CLI, a custom command) plugs in without
 * touching the engine (spec §14). The ids are the provider ids the OCR side already uses, so a
 * provider's key and URL are entered once.
 */

import type { BackendSettings } from "../ocr-registry";
import { type ExtractionBackend, oneCallBackend, openAiCompatComplete, twoCallBackend } from "./extraction-backend";

export interface ExtractionBackendEntry {
	readonly id: string;
	readonly label: string;
	/** Costs the user money per page: the auto-sync spend consent applies. */
	readonly metered: boolean;
	/** Pro only (cloud extraction, spec §11). */
	readonly requiresLicence: boolean;
	/** Measured on the corpus; an unmeasured one says so in settings (spec §11: "not measured"). */
	readonly measured: boolean;
	/** The backend for one sync, or null when it cannot run (no key, no URL). */
	create(settings: BackendSettings, model: string | null): ExtractionBackend | null;
}

const entries = new Map<string, ExtractionBackendEntry>();

export function registerExtractionBackend(entry: ExtractionBackendEntry): void {
	entries.set(entry.id, entry);
}

export function extractionBackendEntries(): ExtractionBackendEntry[] {
	return [...entries.values()];
}

export function extractionBackendEntry(id: string): ExtractionBackendEntry | null {
	return entries.get(id) ?? null;
}

/** What an OpenAI-compatible provider needs to become an extraction backend. */
export interface CompatProvider {
	id: string;
	label: string;
	kind: "cloud" | "local" | "user";
	extraHeaders?: Record<string, string>;
	deterministic?: boolean;
	resolve(settings: BackendSettings): { baseURL: string; model: string; apiKey: string | null };
}

/**
 * Cloud providers get one call under a strict schema; the user's own servers get the two-call local
 * path, because what they serve is typically an 8B-class model (research 10). Only OpenRouter is
 * measured (research 10, 15); the rest carry `measured: false`.
 */
export function compatExtractionEntry(provider: CompatProvider): ExtractionBackendEntry {
	const cloud = provider.kind === "cloud";
	return {
		id: provider.id,
		label: provider.label,
		metered: cloud,
		requiresLicence: cloud,
		measured: provider.id === "openrouter",
		create(settings, model) {
			const endpoint = provider.resolve(settings);
			if (cloud && !endpoint.apiKey) return null;
			if (endpoint.baseURL === "") return null;
			const complete = openAiCompatComplete({
				baseURL: endpoint.baseURL,
				model: model?.trim() || endpoint.model,
				apiKey: endpoint.apiKey,
				extraHeaders: provider.extraHeaders,
				deterministic: provider.deterministic,
				requireParameters: provider.id === "openrouter",
			});
			return cloud ? oneCallBackend(provider.id, true, complete) : twoCallBackend(provider.id, false, complete);
		},
	};
}
