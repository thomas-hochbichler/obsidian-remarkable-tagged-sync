/**
 * Extraction backends. A backend owns how many calls a page costs (§14): cloud models get one call
 * under a strict JSON schema; a local 8B gets two (free text first, then formatting under a grammar),
 * because one call on local lost 9 of 25 core tasks (research 10). Either way the engine sees one
 * `extract` per page and one outcome.
 *
 * Underneath, every call is a {@link Complete}: one prompt in, one text out. That is the seam a
 * spawned local runtime, an OpenAI-compatible server and a test double all fit.
 */

import { fetchWithRetry, isUnreachable, OcrTimeoutError, refusalDetail, type Sleep } from "../llm-transcript";
import { obsidianFetch } from "../obsidian-fetch";
import { buildPrompt, buildSchema, type ExtractionResult, type KnownItem, parseExtraction } from "./extraction";
import type { ProfileDef, SlotDef } from "./settings";

export interface CompletionRequest {
	system: string;
	user: string;
	/** A JSON schema the answer must follow, or null for free text. */
	schema: Record<string, unknown> | null;
	maxTokens: number;
}

export type CompletionOutcome = { kind: "ok"; text: string } | { kind: "truncated" } | { kind: "failed"; reason: string };

export type Complete = (request: CompletionRequest) => Promise<CompletionOutcome>;

export interface ExtractionInput {
	profile: ProfileDef;
	slots: readonly SlotDef[];
	transcript: string;
	/** The page's first-seen or sync date: the reference until the page names its own. */
	referenceDate: Date;
	/** Per Slot, the base's items with their ids. */
	known: Record<string, readonly KnownItem[]>;
}

export type ExtractionOutcome = { kind: "ok"; result: ExtractionResult } | { kind: "failed"; reason: string };

export interface ExtractionBackend {
	readonly id: string;
	/** Costs the user money per page: drives the auto-sync spend consent. */
	readonly metered: boolean;
	extract(input: ExtractionInput): Promise<ExtractionOutcome>;
}

/** The format pass cap: enough for a 20-item page, small enough that a runaway answer fails fast. */
export const EXTRACTION_MAX_TOKENS = 4000;

function readJson(text: string): unknown {
	// Some servers wrap a schema-constrained answer in a Markdown fence anyway.
	const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
	try {
		return JSON.parse(fenced ? fenced[1] : text);
	} catch {
		return undefined;
	}
}

/** One call per page under a strict schema: the cloud path. */
export function oneCallBackend(id: string, metered: boolean, complete: Complete): ExtractionBackend {
	return {
		id,
		metered,
		async extract(input) {
			const { system, user } = buildPrompt(input);
			const outcome = await complete({ system, user, schema: buildSchema(input.slots), maxTokens: EXTRACTION_MAX_TOKENS });
			if (outcome.kind === "truncated") return { kind: "failed", reason: "The answer was cut off at the token limit." };
			if (outcome.kind === "failed") return outcome;
			const result = parseExtraction(readJson(outcome.text), input.slots, input.referenceDate);
			return result ? { kind: "ok", result } : { kind: "failed", reason: "The answer was not the JSON object that was asked for." };
		},
	};
}

export interface OpenAiCompatOptions {
	baseURL: string;
	model: string;
	apiKey?: string | null;
	extraHeaders?: Record<string, string>;
	/** temperature 0 for the user's own servers; cloud Claude models reject a non-default one. */
	deterministic?: boolean;
	/** OpenRouter: only route to a provider that honours the schema. */
	requireParameters?: boolean;
	fetchFn?: typeof fetch;
	sleepFn?: Sleep;
}

interface ChatResponse {
	choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
}

/** One `POST {baseURL}/chat/completions`. Never throws: every problem is an outcome with a reason a user can act on. */
export function openAiCompatComplete(options: OpenAiCompatOptions): Complete {
	const url = `${options.baseURL.replace(/\/+$/, "")}/chat/completions`;
	return async (request) => {
		if (options.model.trim() === "") return { kind: "failed", reason: "No extraction model is set — open the plugin settings and enter one." };
		const headers: Record<string, string> = { "content-type": "application/json", ...options.extraHeaders };
		if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
		const body = {
			model: options.model,
			messages: [
				{ role: "system", content: request.system },
				{ role: "user", content: request.user },
			],
			max_tokens: request.maxTokens,
			...(request.schema ? { response_format: { type: "json_schema", json_schema: { name: "extraction", strict: true, schema: request.schema } } } : {}),
			...(options.requireParameters ? { provider: { require_parameters: true } } : {}),
			...(options.deterministic ? { temperature: 0 } : {}),
		};
		try {
			const response = await fetchWithRetry(options.fetchFn ?? obsidianFetch, url, { method: "POST", headers, body: JSON.stringify(body) }, options.sleepFn);
			if (!response.ok) return { kind: "failed", reason: `The server at ${options.baseURL} answered ${response.status}${await refusalDetail(response)}.` };
			const json = (await response.json()) as ChatResponse;
			const choice = json.choices?.[0];
			if (choice?.finish_reason === "length") return { kind: "truncated" };
			const text = choice?.message?.content;
			return typeof text === "string" && text.trim() !== "" ? { kind: "ok", text } : { kind: "failed", reason: "The server sent an empty answer." };
		} catch (error) {
			if (error instanceof OcrTimeoutError) return { kind: "failed", reason: `The server at ${options.baseURL} did not answer in time.` };
			if (isUnreachable(error)) return { kind: "failed", reason: `Could not reach the server at ${options.baseURL}. Is it running?` };
			return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
		}
	};
}
