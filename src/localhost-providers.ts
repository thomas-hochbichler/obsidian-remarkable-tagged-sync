// The OpenAI-compatible providers the FREE build ships: servers the user runs themselves.
//
// Why the table is split across two files rather than living in one (free-localhost-ocr spec §2.2):
// the cloud metas carry `api.openai.com`, `generativelanguage.googleapis.com`, `api.anthropic.com`
// and `openrouter.ai`, and `scripts/check-bundle.mjs` scans the free bundle for exactly those
// hostnames to prove a pro build did not overwrite `main.js`. Putting the whole table here would
// plant them in the free bundle and fire the gate on a correct build. So the shape lives here with
// the three local providers, and `pro/ocr-providers.ts` composes the seven on top -- in the original
// order, which is the dropdown order its own spec fixed.

import type { OcrBackend as OcrBackendId } from "./note-builder";

/** The three this build registers. Pro's `LlmProviderId` is a superset and stays Pro's own. */
export type LocalhostProviderId = "ollama" | "lmstudio" | "custom";

/**
 * How confidently we can tell whether a provider's chosen model accepts image input (multi-provider
 * spec §8). Drives the tone of the settings warning -- it never gates a run.
 */
export type VisionReach = "reported" | "partial" | "heuristic" | "none";

/**
 * Static, non-persisted provider metadata (multi-provider spec §2). Presets derive their base URL
 * from here; only the editable providers (`ollama`/`lmstudio`/`custom`) ever persist one of their own.
 *
 * `id` is the core's open backend id rather than a closed union, because this shape is now shared by
 * two builds with different provider lists. Pro keeps its exhaustiveness where it always was, on the
 * `Record<LlmProviderId, ProviderMeta>` key.
 */
export interface ProviderMeta {
	readonly id: OcrBackendId;
	readonly label: string;
	readonly kind: "cloud" | "local" | "user";
	readonly adapter: "anthropic" | "openai-compat";
	/** Preset base URL; empty for `custom` (the user supplies it). */
	readonly baseURL: string;
	/** Whether the settings screen lets the user edit the base URL (local host/port varies). */
	readonly editableURL: boolean;
	/** Seed value for the model field; empty where it depends on the loaded/user model. */
	readonly defaultModel: string;
	readonly key: "required" | "optional" | "none";
	readonly visionReach: VisionReach;
	/** Optional attribution headers (OpenRouter); merged into the request as-is. */
	readonly extraHeaders?: Record<string, string>;
}

/**
 * The three providers the free build registers, in dropdown order.
 *
 * **`defaultModel` is empty on all three, including Ollama** (free-localhost-ocr spec §2.2, §4.3).
 * A seeded model is a quality promise, and the only measurement we own -- Qwen2.5-VL-7B at 7.6 % CER
 * -- was produced by our own `llama.cpp` invocation, not by one of these servers. Measuring them was
 * ruled out of scope, so this stays empty rather than waiting for a number that is not coming.
 *
 * Pro overrides Ollama's back to `llama3.2-vision`, which is what it shipped and what its own spec
 * §6.4 requires stay unchanged -- an equally unmeasured default, preserved because changing Pro's
 * behaviour is not this effort's business.
 */
export const LOCALHOST_PROVIDERS = {
	ollama: {
		id: "ollama",
		label: "Ollama (local)",
		kind: "local",
		adapter: "openai-compat",
		baseURL: "http://localhost:11434/v1",
		editableURL: true,
		defaultModel: "",
		key: "optional",
		visionReach: "reported",
	},
	lmstudio: {
		id: "lmstudio",
		label: "LM Studio (local)",
		kind: "local",
		adapter: "openai-compat",
		baseURL: "http://localhost:1234/v1",
		editableURL: true,
		defaultModel: "",
		key: "none",
		visionReach: "reported",
	},
	custom: {
		id: "custom",
		label: "Custom (OpenAI-compatible)",
		kind: "user",
		adapter: "openai-compat",
		baseURL: "",
		editableURL: true,
		defaultModel: "",
		key: "optional",
		visionReach: "heuristic",
	},
} as const satisfies Record<LocalhostProviderId, ProviderMeta>;

/**
 * Per-provider config the user has entered, remembered across backend switches (multi-provider spec
 * §4). A `type` rather than an `interface` so it stays assignable to the registry's opaque
 * `BackendSettings`.
 */
export type LlmProviderConfig = {
	/** Seeded from the provider's default model; user-editable. */
	model?: string;
	/** Absent for `lmstudio`; optional for local/custom; needed-to-run for cloud. */
	apiKey?: string | null;
	/** Persisted ONLY for editable providers; presets always read `baseURL` from the meta. */
	baseURL?: string;
};

export interface ResolvedProviderEndpoint {
	baseURL: string;
	model: string;
	apiKey: string | null;
}

/**
 * Resolves a provider's effective request target from its static metadata and the user's stored
 * config: a preset base URL unless the provider is editable and the user set one, and the default
 * model unless overridden. The single source of truth for both the adapter and the settings vision
 * check, so the fallback rule lives in one place.
 */
export function resolveProviderEndpoint(meta: ProviderMeta, cfg: LlmProviderConfig): ResolvedProviderEndpoint {
	return {
		baseURL: (meta.editableURL ? cfg.baseURL?.trim() : "") || meta.baseURL,
		model: cfg.model?.trim() || meta.defaultModel,
		apiKey: cfg.apiKey ?? null,
	};
}

/**
 * Name-based heuristic for the `heuristic`-reach providers (multi-provider spec §8): OpenAI and a
 * `custom` endpoint expose no queryable modality flag, so we guess from common vision-model naming.
 * Advisory only.
 */
const VISION_MODEL_PATTERNS: readonly RegExp[] = [
	/vision/i,
	/llava/i,
	/\b4o\b/i,
	/gpt-4\.1/i,
	/gpt-5/i,
	/\bo[134]\b/i,
	/gemini/i,
	/claude/i,
	/pixtral/i,
	/-vl\b/i,
	/[:/]vl\b/i,
	/qwen.*vl/i,
	/minicpm-?v/i,
	/moondream/i,
	/internvl/i,
	/bakllava/i,
	/granite.*vision/i,
];

export function looksLikeVisionModel(model: string): boolean {
	return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}
