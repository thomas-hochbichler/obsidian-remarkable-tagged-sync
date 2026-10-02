/**
 * Extraction backends, registered like OCR backends (`ocr-registry.ts`) so the Pro census in
 * `pro-capabilities.ts` covers them and a later backend (a CLI, a custom command) plugs in without
 * touching the engine (spec §14). The ids are the provider ids the OCR side already uses, so a
 * provider's key and URL are entered once.
 */

import type { BackendSettings } from "../ocr-registry";
import { type ExtractionBackend, oneCallBackend, openAiCompatComplete, ownServerBackend } from "./extraction-backend";

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
	/** What the pause says when `create` has nothing; unset, it names a missing key or address. */
	readonly notReady?: string;
	/**
	 * The name of the model this backend would extract with, when its server says the model reasons
	 * unasked; else null. Only the user's own servers answer: there a reasoning model returns a
	 * schema-bound answer inside its reasoning and the page fails (`REASONED_ONLY`). A cloud provider
	 * keeps the two apart, so it has nothing to warn about.
	 */
	reasoningModel?(settings: BackendSettings, model: string | null): Promise<string | null>;
}

const entries = new Map<string, ExtractionBackendEntry>();

/**
 * Models an answer showed to reason although their server did not say so (LM Studio reports no
 * reasoning config for some, qwen3.6 on MLX among them), kept per provider in its settings blob.
 */
const REASONING_MODELS = "reasoningModels";
const readList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
const knownToReason = (settings: BackendSettings, model: string): boolean => readList(settings[REASONING_MODELS]).includes(model);

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
	/** Whether the server says this model reasons unasked; see `ExtractionBackendEntry.reasoningModel`. */
	reasons?(endpoint: { baseURL: string; model: string; apiKey: string | null }): Promise<boolean>;
}

/**
 * One call per page for every provider: under a strict schema in the cloud, as a tool call on the
 * user's own servers (`schemaAsTool`). The own servers had the managed model's two-call path until
 * 2026-10-02; with the schema as `response_format` reasoning models failed there, and the tool call
 * works for reasoning and plain models alike in one call. They stay local in every other respect: no
 * classifier, a first topical pick proposed. Only OpenRouter is measured (research 10, 15); the rest
 * carry `measured: false`.
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
				schemaAsTool: !cloud,
			});
			if (cloud) return oneCallBackend(provider.id, true, complete);
			const used = model?.trim() || endpoint.model;
			return ownServerBackend(
				provider.id,
				complete,
				async () => knownToReason(settings, used) || ((await provider.reasons?.({ ...endpoint, model: used })) ?? false),
				// Into the provider's own settings blob, which the plugin saves after every sync.
				() => void (settings[REASONING_MODELS] = [...new Set([...readList(settings[REASONING_MODELS]), used])]),
			);
		},
		...(cloud
			? {}
			: {
					async reasoningModel(settings, model) {
						const endpoint = provider.resolve(settings);
						const used = model?.trim() || endpoint.model;
						return knownToReason(settings, used) || ((await provider.reasons?.({ ...endpoint, model: used })) ?? false) ? used : null;
					},
				}),
	};
}
