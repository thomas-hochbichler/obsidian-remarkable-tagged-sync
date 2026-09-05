import { detectLmStudio, detectOllama, type ModelCapabilities, type ThinkingVerdict, visionOnly } from "../src/localhost-vision-detect";
import { looksLikeVisionModel, PROVIDERS, type LlmProviderId } from "./ocr-providers";

// The Ollama and LM Studio probes moved to `src/localhost-vision-detect.ts` with the free build's
// localhost backend (free-localhost-ocr spec §2.4) and are delegated to below, so both builds ask a
// host the same question. The OpenRouter and Gemini probes stay here: OpenRouter's carries the
// string the free bundle is scanned for.
//
// `VisionVerdict` is re-exported so no Pro call site changed. Its doc comment lives with the type.
export type { ModelCapabilities, ThinkingVerdict, VisionVerdict } from "../src/localhost-vision-detect";

export interface VisionDetectInput {
	provider: LlmProviderId;
	model: string;
	/** Resolved base URL (preset from {@link PROVIDERS}, or the user's for editable providers). */
	baseURL: string;
	apiKey?: string | null;
	fetchFn?: typeof fetch;
}

interface OpenRouterModels {
	data?: Array<{ id?: string; architecture?: { input_modalities?: string[] }; reasoning?: OpenRouterReasoning }>;
}

/**
 * OpenRouter's per-model `reasoning` object -- the two fields that answer "does it reason when we do
 * not ask". `default_enabled` is documented as exactly that question ("default reasoning enabled
 * state when the client does not set `reasoning.enabled`"), and `mandatory` is the state no other
 * provider reports at all: reasoning that cannot be switched off.
 */
interface OpenRouterReasoning {
	mandatory?: boolean;
	default_enabled?: boolean;
}

/**
 * The Claude models that reason unasked, from Anthropic's own table (#116 ticket 06).
 *
 * Hardcoded because the API cannot supply it: `/v1/models` reports `capabilities.thinking.supported`,
 * a *support* flag that is true for all fourteen current Claude models -- including the seven where
 * thinking defaults off. Opus 4.7 and Opus 5 are indistinguishable through it, so a warning driven by
 * the queryable flag would fire on every Claude model, and a warning that always lights is not read.
 *
 * A list ages, and this one ages in the safe direction: into a **missing** warning for a model we
 * have not heard of yet, never into a broken request. That is the difference from the prefilled
 * `gemini-2.0-flash` this table used to carry (see `ocr-providers.ts`) -- users adopted that value,
 * and it aged into a provider error.
 */
const THINKING_CLAUDE_MODELS: readonly string[] = [
	"claude-opus-5",
	"claude-sonnet-5",
	// `claude-fable-5` and `claude-mythos-5` already cover their `-5-1` successors by prefix; both are
	// spelled out anyway, so this list can be read against Anthropic's table line for line.
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-mythos-5",
	"claude-mythos-5-1",
	"claude-mythos-preview",
];

/**
 * Anthropic's thinking answer, from the model id alone and without a request -- which is the point:
 * this provider's `visionReach` is `"none"`, so no probe runs for it and none needs to.
 *
 * A model that is not on the list is `"unknown"`, not `"off"`. The list says which models reason; it
 * does not claim to know every model Anthropic serves, and silence is what "we did not establish it"
 * looks like everywhere else in this file.
 */
function claudeThinking(model: string): ThinkingVerdict {
	const id = model.trim().toLowerCase();
	// Dated ids (`claude-opus-5-20260101`) are the normal shape, so the family prefix is the match.
	return THINKING_CLAUDE_MODELS.some((family) => id.startsWith(family)) ? "on" : "unknown";
}

/**
 * Reads OpenRouter's `reasoning` object into a verdict. Absent means the catalog does not list the
 * model as a reasoning model at all (126 of 431 entries when this was measured); `{mandatory: false}`
 * with no `default_enabled` is the genuinely undocumented middle (78 entries), and stays `"unknown"`.
 */
function openRouterThinking(reasoning: OpenRouterReasoning | undefined): ThinkingVerdict {
	if (!reasoning) return "off";
	if (reasoning.mandatory === true || reasoning.default_enabled === true) return "on";
	if (reasoning.default_enabled === false) return "off";
	return "unknown";
}

/**
 * Checks, as far as each provider allows (spec §8), whether `model` accepts image input -- and, since
 * #116, whether it reasons before answering. Reach varies: OpenRouter, Ollama, and LM Studio report
 * image input authoritatively (a live query), Gemini can only be probed for reachability (`partial`),
 * and OpenAI/Custom fall back to a name heuristic. Never throws -- any query failure degrades to
 * `unreachable`.
 *
 * The thinking half rides on the same responses wherever it can: OpenRouter's model entry and
 * Ollama's capability array each answer both questions. Anthropic answers without a request at all.
 */
export async function detectVisionCapability(input: VisionDetectInput): Promise<ModelCapabilities> {
	const reach = PROVIDERS[input.provider].visionReach;
	// Anthropic: no vision probe exists for it, and none is needed for the other half -- the thinking
	// fact is a lookup on the model id. `"none"` still means "no vision line", as it always did.
	if (reach === "none") return { vision: "none", thinking: input.provider === "anthropic" ? claudeThinking(input.model) : "unknown" };

	const model = input.model.trim();
	if (reach === "heuristic") return visionOnly(model.length > 0 && looksLikeVisionModel(model) ? "supported" : "unconfirmed-name");
	if (model.length === 0) return visionOnly("unconfirmed-name");

	const fetchFn = input.fetchFn ?? fetch;
	try {
		if (input.provider === "openrouter") return await detectOpenRouter(input.baseURL, input.apiKey, model, fetchFn);
		if (input.provider === "ollama") return await detectOllama(input.baseURL, model, fetchFn);
		if (input.provider === "lmstudio") return await detectLmStudio(input.baseURL, input.apiKey, model, fetchFn);
		if (input.provider === "gemini") return await detectGemini(input.baseURL, input.apiKey, fetchFn);
	} catch {
		return visionOnly("unreachable");
	}
	return visionOnly("unreachable");
}

/**
 * OpenRouter's models list exposes `architecture.input_modalities` -- the authoritative signal (spec
 * §8) -- and, on the same entry, the `reasoning` object. One request, both answers.
 */
async function detectOpenRouter(baseURL: string, apiKey: string | null | undefined, model: string, fetchFn: typeof fetch): Promise<ModelCapabilities> {
	const headers: Record<string, string> = {};
	if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
	const response = await fetchFn(`${baseURL.replace(/\/+$/, "")}/models`, { headers });
	if (!response.ok) return visionOnly("unreachable");
	const body = (await response.json()) as OpenRouterModels;
	const entry = (body.data ?? []).find((m) => m.id === model);
	// The catalog was reached but doesn't list this model (typo / just-added): fall back to the name
	// heuristic rather than claim the endpoint was unreachable. Nothing is known about its reasoning
	// either -- a model the catalog has never heard of has no `reasoning` object to read.
	if (!entry) return visionOnly(looksLikeVisionModel(model) ? "supported" : "unconfirmed-name");
	return {
		vision: (entry.architecture?.input_modalities ?? []).includes("image") ? "supported" : "unsupported",
		thinking: openRouterThinking(entry.reasoning),
	};
}

/**
 * Gemini's metadata exposes no input-modality flag (spec §8), so we can only confirm the endpoint is
 * reachable -- the verdict is always `partial` on success. A working query still catches a dead
 * endpoint or bad key.
 */
async function detectGemini(baseURL: string, apiKey: string | null | undefined, fetchFn: typeof fetch): Promise<ModelCapabilities> {
	const headers: Record<string, string> = {};
	if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
	const response = await fetchFn(`${baseURL.replace(/\/+$/, "")}/models`, { headers });
	// Nothing about reasoning either: Gemini's metadata reports that a model supports thinking, never
	// what it does when the request stays silent, which is the only question worth a warning.
	return visionOnly(response.ok ? "partial" : "unreachable");
}
