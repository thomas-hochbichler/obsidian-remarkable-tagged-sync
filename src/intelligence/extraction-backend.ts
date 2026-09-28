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
	/** An 8B-class model on the user's machine or server: its first topical pick is proposed, not written (spec §7.4). */
	readonly local?: boolean;
	extract(input: ExtractionInput): Promise<ExtractionOutcome>;
	/**
	 * Picks one of a tag's Profiles for a new page, from their one-line descriptions (spec §5.1). Cloud
	 * only: a local model picked right 5 times in 10 (research 10), so a local backend has none.
	 */
	classify?(input: ClassifyInput): Promise<ClassifyOutcome>;
}

export interface ClassifyInput {
	transcript: string;
	profiles: readonly { id: string; description: string }[];
}

export type ClassifyOutcome = { kind: "ok"; id: string } | { kind: "failed"; reason: string };

/** One call under a schema whose only answer is one of the Profile ids. */
function classifyWith(complete: Complete): (input: ClassifyInput) => Promise<ClassifyOutcome> {
	return async (input) => {
		const ids = input.profiles.map((profile) => profile.id);
		const outcome = await complete({
			system: "You sort one handwritten notebook page into one of the given page types. Answer with the id of the type that fits best.",
			user: [...input.profiles.map((profile) => `- ${profile.id}: ${profile.description}`), "", "## Page text", input.transcript].join("\n"),
			schema: { type: "object", properties: { profile: { type: "string", enum: ids } }, required: ["profile"], additionalProperties: false },
			maxTokens: 200,
		});
		if (outcome.kind === "truncated") return { kind: "failed", reason: "The answer was cut off." };
		if (outcome.kind === "failed") return outcome;
		const answer = readJson(outcome.text) as { profile?: unknown } | undefined;
		const id = answer?.profile;
		return typeof id === "string" && ids.includes(id) ? { kind: "ok", id } : { kind: "failed", reason: "The answer named no known profile." };
	};
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
		classify: classifyWith(complete),
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

/**
 * The local pass-1 prompt: free text, one heading per Slot, one line per item with the words copied
 * off the page. Free text first because an 8B model under a grammar from the first token loses items
 * it would have written down in prose (research 10: 16 of 29 in one call, 25 of 29 in two).
 */
export function localReadPrompt(input: ExtractionInput): { system: string; user: string } {
	const { system, user } = buildPrompt(input);
	return {
		system: `${system}\nAnswer in plain text, not JSON. Read the whole page before answering.`,
		user: [
			user,
			"",
			"## Answer format",
			"For every Slot write its id as a heading. Under it, one line per item:",
			"- <item> | SOURCE: <words copied from the page> | DUE: <due words or none> | REASON: <why>",
			"For a Text Slot write the text under its heading. Write NONE under a Slot with nothing.",
		].join("\n"),
	};
}

/** Pass 2 formats pass 1's notes into the schema; it sees the page too, so `source` stays verbatim. */
export function localFormatPrompt(input: ExtractionInput, notes: string): { system: string; user: string } {
	return {
		system: "You convert notes about a handwritten page into JSON that follows the schema exactly. Add nothing that is not in the notes.",
		user: ["## Notes", notes, "", "## Page text", input.transcript].join("\n"),
	};
}

/** Whether pass 1 found nothing at all: only headings (`#…` or a bare Slot id), blank lines and NONE. Any other line is a find. */
export function notesAreEmpty(notes: string, slotIds: readonly string[]): boolean {
	const ids = new Set(slotIds.map((id) => id.toLowerCase()));
	return notes
		.split("\n")
		.map((line) => line.trim())
		.every((line) => line === "" || line.startsWith("#") || ids.has(line.replace(/:$/, "").toLowerCase()) || /^(?:[-*]\s*)?none\.?$/i.test(line));
}

/**
 * Two calls per page: the local path. Pass 2 is skipped when pass 1 found nothing anywhere -- a
 * format pass over "NONE" is where a small model invents its junk items.
 */
export function twoCallBackend(id: string, metered: boolean, complete: Complete): ExtractionBackend {
	return {
		id,
		metered,
		local: true,
		async extract(input) {
			const read = localReadPrompt(input);
			const notes = await complete({ ...read, schema: null, maxTokens: 2000 });
			if (notes.kind === "truncated") return { kind: "failed", reason: "The notes pass was cut off at the token limit." };
			if (notes.kind === "failed") return notes;
			if (notesAreEmpty(notes.text, input.slots.map((slot) => slot.id))) {
				return { kind: "ok", result: parseExtraction({}, input.slots, input.referenceDate)! };
			}
			const format = localFormatPrompt(input, notes.text);
			const formatted = await complete({ ...format, schema: buildSchema(input.slots), maxTokens: EXTRACTION_MAX_TOKENS });
			if (formatted.kind === "truncated") return { kind: "failed", reason: "The answer was cut off at the token limit." };
			if (formatted.kind === "failed") return formatted;
			const result = parseExtraction(readJson(formatted.text), input.slots, input.referenceDate);
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
