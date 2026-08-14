// The seven LLM-vision providers, composed from two halves (free-localhost-ocr spec §2.2).
//
// The three localhost providers moved to `src/localhost-providers.ts` when the free build gained
// them, and this file keeps the four cloud metas plus the composition. What must not change is
// anything a Pro user can observe: the order below IS the dropdown order (multi-provider spec §2/§5),
// and Ollama's shipped `defaultModel` is restored by the one override at the bottom. That is the
// mechanical form of managed-local-llm-ocr §6.4 -- Pro's providers behave exactly as their spec left
// them -- and it holds by construction rather than by a test remembering to check.
//
// The cloud hostnames stay HERE, deliberately: `scripts/check-bundle.mjs` scans the free bundle for
// them to prove a pro build has not overwritten `main.js`. In `src/` they would fire that gate on a
// correct free build.

import { LOCALHOST_PROVIDERS, type ProviderMeta } from "../src/localhost-providers";

export {
	looksLikeVisionModel,
	resolveProviderEndpoint,
	type LlmProviderConfig,
	type ProviderMeta,
	type ResolvedProviderEndpoint,
	type VisionReach,
} from "../src/localhost-providers";

/**
 * Every LLM-vision provider. Declared here rather than derived from the core's `OcrBackend`, which
 * is deliberately open: the provider list is this block's own business, and keeping it here is what
 * makes {@link PROVIDERS} exhaustively checked.
 */
export type LlmProviderId = "anthropic" | "openai" | "gemini" | "openrouter" | "ollama" | "lmstudio" | "custom";

/** The cloud half. Order here leads the dropdown, ahead of the three local ones. */
const CLOUD_PROVIDERS = {
	anthropic: {
		id: "anthropic",
		label: "Anthropic (Claude)",
		kind: "cloud",
		adapter: "anthropic",
		baseURL: "https://api.anthropic.com",
		editableURL: false,
		defaultModel: "claude-sonnet-5",
		key: "required",
		visionReach: "none",
	},
	openai: {
		id: "openai",
		label: "OpenAI",
		kind: "cloud",
		adapter: "openai-compat",
		baseURL: "https://api.openai.com/v1",
		editableURL: false,
		defaultModel: "gpt-4o",
		key: "required",
		visionReach: "heuristic",
	},
	gemini: {
		id: "gemini",
		label: "Google Gemini",
		kind: "cloud",
		adapter: "openai-compat",
		baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
		editableURL: false,
		defaultModel: "gemini-2.0-flash",
		key: "required",
		visionReach: "partial",
	},
	openrouter: {
		id: "openrouter",
		label: "OpenRouter",
		kind: "cloud",
		adapter: "openai-compat",
		baseURL: "https://openrouter.ai/api/v1",
		editableURL: false,
		defaultModel: "openai/gpt-4o",
		key: "required",
		visionReach: "reported",
	},
} as const satisfies Record<"anthropic" | "openai" | "gemini" | "openrouter", ProviderMeta>;

/**
 * Order here is the settings-dropdown order (spec §2 / §5), unchanged by the split.
 *
 * The Ollama override restores the `defaultModel` this build has always shipped. The shared meta
 * carries an empty one because the free build refuses to seed a model it has never measured; Pro
 * keeps `llama3.2-vision` because §6.4 says Pro's providers do not change. It is no better measured
 * than the value the free build declined to ship -- noted rather than fixed, since changing it is a
 * change to Pro's behaviour and belongs to whoever measures the hosts.
 */
export const PROVIDERS: Record<LlmProviderId, ProviderMeta> = {
	...CLOUD_PROVIDERS,
	ollama: { ...LOCALHOST_PROVIDERS.ollama, defaultModel: "llama3.2-vision" },
	lmstudio: LOCALHOST_PROVIDERS.lmstudio,
	custom: LOCALHOST_PROVIDERS.custom,
};
