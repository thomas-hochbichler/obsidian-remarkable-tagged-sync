// The vision-capability check for the three providers the free build ships (free-localhost-ocr
// spec §2.4).
//
// Only two of the five probes moved here. `pro/ocr-vision-detect.ts` keeps the OpenRouter and Gemini
// ones -- not for tidiness but because the OpenRouter probe carries the string `openrouter`, which
// `scripts/check-bundle.mjs` scans the free bundle for. Pro delegates the two below rather than
// keeping a second copy, so both builds ask a host the same question.

import { looksLikeVisionModel, LOCALHOST_PROVIDERS, type LocalhostProviderId } from "./localhost-providers";

/**
 * The outcome of a best-effort vision-capability check (multi-provider spec §8). Advisory only -- it
 * feeds the settings warning and never gates a run:
 * - `none`             — no check applies.
 * - `supported`        — confirmed image input (reported providers, or a positive name heuristic).
 * - `unsupported`      — a `reported` provider says the model has no image input (hard warning).
 * - `partial`          — reachable but the provider can't confirm image input (soft warning).
 * - `unconfirmed-name` — a `heuristic` provider whose model name doesn't look vision-capable.
 * - `unreachable`      — the provider couldn't be queried to verify.
 *
 * For a localhost provider `unreachable` carries more weight than it does for a cloud one: it is
 * almost always "the app is not running", which is the most likely failure this backend has and the
 * one the user can fix in seconds (spec §5.1).
 */
export type VisionVerdict = "none" | "supported" | "unsupported" | "partial" | "unconfirmed-name" | "unreachable";

export interface LocalhostVisionDetectInput {
	provider: LocalhostProviderId;
	model: string;
	/** Resolved base URL: the preset, or the user's own for these three (all editable). */
	baseURL: string;
	apiKey?: string | null;
	fetchFn?: typeof fetch;
}

interface OllamaShow {
	capabilities?: string[];
}

interface LmStudioModels {
	data?: Array<{ id?: string; type?: string }>;
}

/**
 * Checks whether `model` accepts image input on a server the user runs. Ollama and LM Studio report
 * it authoritatively; a `custom` endpoint has no queryable flag and falls back to the name heuristic.
 * Never throws -- any query failure degrades to `unreachable`.
 */
export async function detectLocalhostVisionCapability(input: LocalhostVisionDetectInput): Promise<VisionVerdict> {
	const reach = LOCALHOST_PROVIDERS[input.provider].visionReach;

	const model = input.model.trim();
	if (reach === "heuristic") return model.length > 0 && looksLikeVisionModel(model) ? "supported" : "unconfirmed-name";
	if (model.length === 0) return "unconfirmed-name";

	// Rewritten to the requestUrl shim by esbuild's `inject`, same as the adapter's default — see
	// `src/fetch-shim.ts`. The lint warning rides in the ratchet baseline; disabling the rule is not
	// allowed in this repo, and quietly working around it would hide the one thing worth knowing.
	const fetchFn = input.fetchFn ?? fetch;
	try {
		if (input.provider === "ollama") return await detectOllama(input.baseURL, model, fetchFn);
		if (input.provider === "lmstudio") return await detectLmStudio(input.baseURL, input.apiKey, model, fetchFn);
	} catch {
		return "unreachable";
	}
	return "unreachable";
}

/** Ollama's native `/api/show` returns a `capabilities` array containing `"vision"` for image models (multi-provider spec §8). */
export async function detectOllama(baseURL: string, model: string, fetchFn: typeof fetch): Promise<VisionVerdict> {
	// /api/show lives on the native surface, not the OpenAI-compat /v1 path.
	const nativeBase = baseURL.replace(/\/v1\/?$/, "");
	const response = await fetchFn(`${nativeBase}/api/show`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: model }),
	});
	if (!response.ok) return "unreachable";
	const body = (await response.json()) as OllamaShow;
	return (body.capabilities ?? []).includes("vision") ? "supported" : "unsupported";
}

/**
 * LM Studio's native `/api/v0/models` reports each model's `type` -- `"vlm"` for vision-language
 * models -- which the OpenAI-compat `/v1/models` surface omits (multi-provider spec §8).
 * Authoritative like Ollama.
 */
export async function detectLmStudio(
	baseURL: string,
	apiKey: string | null | undefined,
	model: string,
	fetchFn: typeof fetch,
): Promise<VisionVerdict> {
	// /api/v0/models lives on the native surface, not the OpenAI-compat /v1 path.
	const nativeBase = baseURL.replace(/\/v1\/?$/, "");
	const headers: Record<string, string> = {};
	if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
	const response = await fetchFn(`${nativeBase}/api/v0/models`, { headers });
	if (!response.ok) return "unreachable";
	const body = (await response.json()) as LmStudioModels;
	const entry = (body.data ?? []).find((m) => m.id === model);
	// Reached but this model isn't listed (typo / not loaded): fall back to the name heuristic.
	if (!entry) return looksLikeVisionModel(model) ? "supported" : "unconfirmed-name";
	return entry.type === "vlm" ? "supported" : "unsupported";
}
