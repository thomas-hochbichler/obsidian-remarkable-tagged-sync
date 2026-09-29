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
import { buildPrompt, buildSchema, describeSlot, type ExtractionResult, type KnownItem, parseExtraction, WEEKDAYS } from "./extraction";
import type { ProfileDef, SlotDef } from "./settings";

export interface CompletionRequest {
	system: string;
	user: string;
	/** A JSON schema the answer must follow, or null for free text. */
	schema: Record<string, unknown> | null;
	/** The words the answer starts with, sent as the assistant's turn: the model continues from them. */
	prefill?: string;
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
	/** Releases what the backend holds for a run -- the managed local server. Called when the sync ends. */
	dispose?(): void;
	/**
	 * Frees the model's memory between documents while keeping the run going: the next document's
	 * transcription loads the same model file, and two copies of an 8B model do not fit beside each
	 * other on a 16 GB machine. The next `extract` starts it again.
	 */
	rest?(): void;
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

/**
 * The input as the model sees it: without a Slot that can hold no value -- a Choice whose option list
 * was never filled, like the default Tags Slot. Its schema is an empty enum, and a local model that
 * wants to write a tag there runs the grammar into a dead end: llama-server answers 500 (live test,
 * 2026-09-29). Parsing still reads every Slot, so such a Slot comes out empty.
 */
export function askedInput(input: ExtractionInput): ExtractionInput {
	const empty = (slot: SlotDef) => slot.fields.some((field) => field.type === "choice" && (field.options?.length ?? 0) === 0);
	return { ...input, slots: input.slots.filter((slot) => !empty(slot)) };
}

/** One call per page under a strict schema: the cloud path. */
export function oneCallBackend(id: string, metered: boolean, complete: Complete): ExtractionBackend {
	return {
		id,
		metered,
		classify: classifyWith(complete),
		async extract(input) {
			const asked = askedInput(input);
			const { system, user } = buildPrompt(asked);
			const outcome = await complete({ system, user, schema: buildSchema(asked.slots), maxTokens: EXTRACTION_MAX_TOKENS });
			if (outcome.kind === "truncated") return { kind: "failed", reason: "The answer was cut off at the token limit." };
			if (outcome.kind === "failed") return outcome;
			const result = parseExtraction(readJson(outcome.text), input.slots, input.referenceDate);
			return result ? { kind: "ok", result } : { kind: "failed", reason: "The answer was not the JSON object that was asked for." };
		},
	};
}

/**
 * How to tell a task in terse handwritten notes, and the line pass that goes with it (research 22).
 * The line pass carries the gain: without it an 8B found 24 of 38 real tasks, with it 36. One changed
 * clause made the model skip it on every page, so the answer is started with `LINES:` for it.
 */
const TASK_LINES = [
	"How to recognise a task in handwritten notes. Notes are terse, so a task rarely looks like a full sentence. A line is a task when it says what someone should still do:",
	"- it starts with or contains a verb of doing (check, fix, ask, run, deploy, test, create, merge, switch, move, prepare, send, call, plan, analyse, restart, upgrade, prüfen, schicken, anrufen, erledigen, ...), even if misspelled;",
	'- or it assigns a piece of work to a person with an arrow, colon or dash ("Backup -> Anna", "Max: Rollout-Plan");',
	"- or it is a numbered step or an item under a heading such as To do, Plan, Prepare, Sprint planning, Don't forget, Next.",
	"A line is NOT a task when it is a status or result (\"done\", \"deployed at 14:00\", a tick mark), an observation, an insight or a question, a heading, or one of several names/components listed under a task line (those belong to the task above; do not list them one by one).",
	"",
	"Work in two steps.",
	'Step 1. Write "LINES:" and then go through the transcript from the first to the last line. For every line write one short line: "<first words of the line> => TASK" or "=> PART" (only a bare name listed under a task line, with no work of its own) or "=> NO". Do not skip lines.',
	"Step 2. Then write the answer.",
];
const LINE_PASS_PREFILL = "LINES:\n";
const LOCAL_TASK_SLOT = "tasks";

/** One line per item of a list Slot, with a column per Field; the tasks Slot takes the lines marked TASK. */
function answerLine(slot: SlotDef): string {
	const columns = slot.fields.map((field) => ` | ${field.name}: <${field.type === "date" ? "date words as written" : "value"}, or NONE>`).join("");
	if (slot.shape === "text") return `Under "## ${slot.id}" write one or two sentences.`;
	if (slot.shape === "value") return `Under "## ${slot.id}" write the value.`;
	const which = slot.id === LOCAL_TASK_SLOT ? "one line per line you marked TASK" : "one line per item";
	return `Under "## ${slot.id}" write ${which}: "- <text> | SOURCE: <the transcript line, copied exactly>${columns}".`;
}

/**
 * The local pass-1 prompt (research 22's final prompt, measured on 18 real pages): free text, one
 * heading per Slot, one line per item with its transcript line. Free text first because an 8B model
 * under a grammar from the first token loses items it would have written down in prose (research 10).
 */
export function localReadPrompt(input: ExtractionInput): { system: string; user: string; prefill?: string } {
	const day = input.referenceDate;
	const linePass = input.slots.some((slot) => slot.id === LOCAL_TASK_SLOT);
	const system = [
		`You extract structured data from ONE handwritten notebook page. Profile: ${input.profile.name}: ${input.profile.description}`,
		`Page date: ${WEEKDAYS[day.getUTCDay()]}, ${day.toISOString().slice(0, 10)}.`,
		"The transcript comes from handwriting OCR: expect misspellings and garbled words; strike-throughs are not marked. A misspelled line still counts: judge what the writer most likely meant, but never invent items or values. Every slot may be empty.",
		"",
		"Slots:",
		"",
		...input.slots.map((slot) => describeSlot(slot, input.known[slot.id] ?? [])),
		"",
		...(linePass ? TASK_LINES : []),
		'For every slot write a heading "## <slot>".',
		...input.slots.map(answerLine),
		"Write NONE under a slot that has nothing.",
	].join("\n");
	return { system, user: `Transcript:\n<<<\n${input.transcript}\n>>>`, ...(linePass ? { prefill: LINE_PASS_PREFILL } : {}) };
}

/** Pass 1's answer from its first Slot heading on: the line pass before it is reasoning, not a find. */
export function notesSection(notes: string): string {
	const at = notes.indexOf("## ");
	return at === -1 ? notes : notes.slice(at);
}

/** Pass 2 formats pass 1's notes into the schema; it sees the page too, so `source` stays verbatim. */
export function localFormatPrompt(input: ExtractionInput, notes: string): { system: string; user: string } {
	return {
		system: [
			"Convert the extraction notes into JSON matching the schema. Keep only what the notes contain. A slot marked NONE becomes an empty list or empty string. Field values that the notes do not give become null. For every item, `source` must be copied character for character from the original transcript (the line the item comes from), not from the notes.",
			"",
			"Slot definitions:",
			...input.slots.map((slot) => describeSlot(slot, input.known[slot.id] ?? [])),
		].join("\n"),
		user: `Notes:\n${notesSection(notes)}\n\nOriginal transcript (for verbatim source spans):\n<<<\n${input.transcript}\n>>>`,
	};
}

/** Whether pass 1 found nothing at all: only headings (`#…` or a bare Slot id), blank lines and NONE. Any other line is a find. */
export function notesAreEmpty(notes: string, slotIds: readonly string[]): boolean {
	const ids = new Set(slotIds.map((id) => id.toLowerCase()));
	return notesSection(notes)
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
			const asked = askedInput(input);
			const read = localReadPrompt(asked);
			// The line pass costs about 600 output tokens before the first heading (research 22).
			const notes = await complete({ ...read, schema: null, maxTokens: 3000 });
			if (notes.kind === "truncated") return { kind: "failed", reason: "The notes pass was cut off at the token limit." };
			if (notes.kind === "failed") return notes;
			if (notesAreEmpty(notes.text, asked.slots.map((slot) => slot.id))) {
				return { kind: "ok", result: parseExtraction({}, input.slots, input.referenceDate)! };
			}
			const format = localFormatPrompt(asked, notes.text);
			const formatted = await complete({ ...format, schema: buildSchema(asked.slots), maxTokens: EXTRACTION_MAX_TOKENS });
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
	/** A fixed sampling seed, for a local model that should answer the same page the same way. */
	seed?: number;
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
				...(request.prefill === undefined ? [] : [{ role: "assistant", content: request.prefill }]),
			],
			max_tokens: request.maxTokens,
			...(request.schema ? { response_format: { type: "json_schema", json_schema: { name: "extraction", strict: true, schema: request.schema } } } : {}),
			...(options.requireParameters ? { provider: { require_parameters: true } } : {}),
			...(options.deterministic ? { temperature: 0 } : {}),
			...(options.seed === undefined ? {} : { seed: options.seed }),
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
