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

/**
 * Whether the chosen model reasons before answering when the request does not ask it to (#116).
 *
 * Three values, and only one of them ever writes a line: `"on"` warns, `"off"` and `"unknown"` are
 * both silent. `"off"` is not decoration -- it is an authoritative negative (Ollama's capability
 * array without `"thinking"`, LM Studio's `reasoning.default: "off"`), and keeping it distinct from
 * "we never asked" is what lets a test tell a working probe from a silent one.
 *
 * We never write "this model does not reason". Absence of a flag is absence of evidence: a `custom`
 * endpoint reports nothing, Gemini reports no default, and an LM Studio older than 0.4.0 has no
 * endpoint to report it on.
 */
export type ThinkingVerdict = "on" | "off" | "unknown";

/**
 * What one probe answers about one model. Two orthogonal facts, because they are: a thinking model
 * that sees images is `{ vision: "supported", thinking: "on" }` and both halves are worth saying.
 *
 * One probe rather than two, because the data forces it -- Ollama's `capabilities` array and
 * OpenRouter's model entry each answer both questions in a response we already fetch. LM Studio is
 * the exception that proves it: there the two facts live on two endpoints, so the branch makes two
 * requests behind this one shape.
 */
export interface ModelCapabilities {
	vision: VisionVerdict;
	thinking: ThinkingVerdict;
}

/** The answer when only the vision half could be established -- every other provider path. */
export function visionOnly(vision: VisionVerdict): ModelCapabilities {
	return { vision, thinking: "unknown" };
}

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
 * LM Studio's native v1 listing (0.4.0+). Only the two fields this reads are declared.
 *
 * `key` is the same string `/api/v0/models` calls `id` and the same string the user types into the
 * model field -- verified against a running LM Studio on 2026-09-05, all nine models in the library,
 * publisher-prefixed ids (`google/gemma-4-12b`) included.
 */
interface LmStudioV1Models {
	models?: Array<{ key?: string; capabilities?: { reasoning?: { default?: string } } | null }>;
}

/**
 * Checks what `model` can do on a server the user runs: whether it accepts image input, and whether
 * it reasons before answering. Ollama and LM Studio report both authoritatively; a `custom` endpoint
 * has no queryable flag for either and falls back to the name heuristic for vision alone.
 * Never throws -- any query failure degrades to `unreachable`.
 */
export async function detectLocalhostVisionCapability(input: LocalhostVisionDetectInput): Promise<ModelCapabilities> {
	const reach = LOCALHOST_PROVIDERS[input.provider].visionReach;

	const model = input.model.trim();
	if (reach === "heuristic") return visionOnly(model.length > 0 && looksLikeVisionModel(model) ? "supported" : "unconfirmed-name");
	if (model.length === 0) return visionOnly("unconfirmed-name");

	// Rewritten to the requestUrl shim by esbuild's `inject`, same as the adapter's default — see
	// `src/fetch-shim.ts`. The lint warning rides in the ratchet baseline; disabling the rule is not
	// allowed in this repo, and quietly working around it would hide the one thing worth knowing.
	const fetchFn = input.fetchFn ?? fetch;
	try {
		if (input.provider === "ollama") return await detectOllama(input.baseURL, model, fetchFn);
		if (input.provider === "lmstudio") return await detectLmStudio(input.baseURL, input.apiKey, model, fetchFn);
	} catch {
		return visionOnly("unreachable");
	}
	return visionOnly("unreachable");
}

/**
 * Ollama's native `/api/show` returns a `capabilities` array (multi-provider spec §8). One array,
 * both answers: `"vision"` for image input, `"thinking"` for reasoning.
 *
 * **On Ollama the support flag is the default flag**, which is why `"thinking"` reads as `"on"` and
 * not as "can, if asked". Both handlers do the same thing with it: `if slices.Contains(modelCaps,
 * CapabilityThinking) { if req.Think == nil { req.Think = true } }` (`server/routes.go:458-461` and
 * `:2630-2634`), and the OpenAI-compat surface inherits it -- no `reasoning_effort` leaves `think`
 * nil, which that check flips to true. Our requests send neither field, so a model carrying the
 * capability reasons on every page we send it. This is the same array the server itself reasons
 * about (`/api/show` returns `m.Capabilities()` verbatim), not a second opinion about the model.
 */
export async function detectOllama(baseURL: string, model: string, fetchFn: typeof fetch): Promise<ModelCapabilities> {
	// /api/show lives on the native surface, not the OpenAI-compat /v1 path.
	const nativeBase = baseURL.replace(/\/v1\/?$/, "");
	const response = await fetchFn(`${nativeBase}/api/show`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: model }),
	});
	if (!response.ok) return visionOnly("unreachable");
	const body = (await response.json()) as OllamaShow;
	const capabilities = body.capabilities ?? [];
	return {
		vision: capabilities.includes("vision") ? "supported" : "unsupported",
		thinking: capabilities.includes("thinking") ? "on" : "off",
	};
}

/**
 * LM Studio answers the two questions on two endpoints, so this branch makes two requests -- the one
 * provider where "one probe" costs more than one call.
 *
 * The v0 listing keeps the vision half rather than being migrated to v1, and that is the measured
 * choice rather than the conservative one (#116 ticket 07, against a running LM Studio, 2026-09-05):
 * the two surfaces agree on vision model for model, so migrating buys no accuracy, and it would put
 * the working half at risk of the finding below.
 */
export async function detectLmStudio(
	baseURL: string,
	apiKey: string | null | undefined,
	model: string,
	fetchFn: typeof fetch,
): Promise<ModelCapabilities> {
	// Both live on the native surface, not the OpenAI-compat /v1 path.
	const nativeBase = baseURL.replace(/\/v1\/?$/, "");
	const headers: Record<string, string> = {};
	if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
	const [vision, thinking] = await Promise.all([
		lmStudioVision(nativeBase, headers, model, fetchFn),
		lmStudioThinking(nativeBase, headers, model, fetchFn),
	]);
	return { vision, thinking };
}

/**
 * `/api/v0/models` reports each model's `type` -- `"vlm"` for vision-language models -- which the
 * OpenAI-compat `/v1/models` surface omits (multi-provider spec §8). Authoritative like Ollama.
 */
async function lmStudioVision(nativeBase: string, headers: Record<string, string>, model: string, fetchFn: typeof fetch): Promise<VisionVerdict> {
	const response = await fetchFn(`${nativeBase}/api/v0/models`, { headers });
	if (!response.ok) return "unreachable";
	const body = (await response.json()) as LmStudioModels;
	const entry = (body.data ?? []).find((m) => m.id === model);
	// Reached but this model isn't listed (typo / not loaded): fall back to the name heuristic.
	if (!entry) return looksLikeVisionModel(model) ? "supported" : "unconfirmed-name";
	return entry.type === "vlm" ? "supported" : "unsupported";
}

/**
 * `/api/v1/models` (LM Studio 0.4.0+) is the only source of the six providers that separates "reasons
 * unasked" from "can reason if asked": `capabilities.reasoning.default`. The v0 listing cannot be made
 * to answer it -- its own `capabilities` array exists and carries `["tool_use"]` and nothing else.
 *
 * **Every failure here is `"unknown"`, and deliberately so.** The version floor is invisible to a
 * status check: this server answers an unknown path with **HTTP 200 and an error body** (measured:
 * `GET /api/v2/models` → 200), so a build older than 0.4.0 -- which has no v1 router -- returns a
 * 200 whose body has no `models` array rather than the 404 a `!response.ok` check would catch. The
 * body shape is the version check. And because this half can only ever fall silent, a wrong guess
 * about an old build costs a missing line, never the vision verdict next to it.
 *
 * `capabilities.reasoning` absent maps to `"unknown"`, not `"off"`: the field is documented as
 * "absent when no reasoning config is exposed", which is a statement about the server rather than
 * about the model.
 */
async function lmStudioThinking(nativeBase: string, headers: Record<string, string>, model: string, fetchFn: typeof fetch): Promise<ThinkingVerdict> {
	try {
		const response = await fetchFn(`${nativeBase}/api/v1/models`, { headers });
		if (!response.ok) return "unknown";
		const body = (await response.json()) as LmStudioV1Models;
		const entry = (body.models ?? []).find((m) => m.key === model);
		const preset = entry?.capabilities?.reasoning?.default;
		if (preset === undefined) return "unknown";
		// "on" | "low" | "medium" | "high" all mean it reasons unasked; only "off" means it does not.
		return preset === "off" ? "off" : "on";
	} catch {
		return "unknown";
	}
}
