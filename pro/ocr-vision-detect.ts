import { detectLmStudio, detectOllama, type VisionVerdict } from "../src/localhost-vision-detect";
import { looksLikeVisionModel, PROVIDERS, type LlmProviderId } from "./ocr-providers";

// The Ollama and LM Studio probes moved to `src/localhost-vision-detect.ts` with the free build's
// localhost backend (free-localhost-ocr spec §2.4) and are delegated to below, so both builds ask a
// host the same question. The OpenRouter and Gemini probes stay here: OpenRouter's carries the
// string the free bundle is scanned for.
//
// `VisionVerdict` is re-exported so no Pro call site changed. Its doc comment lives with the type.
export type { VisionVerdict } from "../src/localhost-vision-detect";

export interface VisionDetectInput {
	provider: LlmProviderId;
	model: string;
	/** Resolved base URL (preset from {@link PROVIDERS}, or the user's for editable providers). */
	baseURL: string;
	apiKey?: string | null;
	fetchFn?: typeof fetch;
}

interface OpenRouterModels {
	data?: Array<{ id?: string; architecture?: { input_modalities?: string[] } }>;
}

/**
 * Checks, as far as each provider allows (spec §8), whether `model` accepts image input. Reach
 * varies: OpenRouter, Ollama, and LM Studio report it authoritatively (a live query), Gemini can
 * only be probed for reachability (`partial`), and OpenAI/Custom fall back to a name heuristic.
 * Never throws -- any query failure degrades to `unreachable`.
 */
export async function detectVisionCapability(input: VisionDetectInput): Promise<VisionVerdict> {
	const reach = PROVIDERS[input.provider].visionReach;
	if (reach === "none") return "none";

	const model = input.model.trim();
	if (reach === "heuristic") return model.length > 0 && looksLikeVisionModel(model) ? "supported" : "unconfirmed-name";
	if (model.length === 0) return "unconfirmed-name";

	const fetchFn = input.fetchFn ?? fetch;
	try {
		if (input.provider === "openrouter") return await detectOpenRouter(input.baseURL, input.apiKey, model, fetchFn);
		if (input.provider === "ollama") return await detectOllama(input.baseURL, model, fetchFn);
		if (input.provider === "lmstudio") return await detectLmStudio(input.baseURL, input.apiKey, model, fetchFn);
		if (input.provider === "gemini") return await detectGemini(input.baseURL, input.apiKey, fetchFn);
	} catch {
		return "unreachable";
	}
	return "unreachable";
}

/** OpenRouter's models list exposes `architecture.input_modalities` -- the authoritative signal (spec §8). */
async function detectOpenRouter(baseURL: string, apiKey: string | null | undefined, model: string, fetchFn: typeof fetch): Promise<VisionVerdict> {
	const headers: Record<string, string> = {};
	if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
	const response = await fetchFn(`${baseURL.replace(/\/+$/, "")}/models`, { headers });
	if (!response.ok) return "unreachable";
	const body = (await response.json()) as OpenRouterModels;
	const entry = (body.data ?? []).find((m) => m.id === model);
	// The catalog was reached but doesn't list this model (typo / just-added): fall back to the name
	// heuristic rather than claim the endpoint was unreachable.
	if (!entry) return looksLikeVisionModel(model) ? "supported" : "unconfirmed-name";
	return (entry.architecture?.input_modalities ?? []).includes("image") ? "supported" : "unsupported";
}

/**
 * Gemini's metadata exposes no input-modality flag (spec §8), so we can only confirm the endpoint is
 * reachable -- the verdict is always `partial` on success. A working query still catches a dead
 * endpoint or bad key.
 */
async function detectGemini(baseURL: string, apiKey: string | null | undefined, fetchFn: typeof fetch): Promise<VisionVerdict> {
	const headers: Record<string, string> = {};
	if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
	const response = await fetchFn(`${baseURL.replace(/\/+$/, "")}/models`, { headers });
	return response.ok ? "partial" : "unreachable";
}
