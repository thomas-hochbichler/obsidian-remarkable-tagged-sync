import type { OcrBackend as OcrBackendId } from "./note-builder";
import { type CutOff, type OcrBackend, type OcrFraming, ocrImage, type OcrResult } from "./ocr-backend";
import {
	fetchWithRetry,
	isUnreachable,
	type LlmPageOutcome,
	OCR_REQUEST_TIMEOUT_MS,
	OcrTimeoutError,
	pageCount,
	readAgain,
	realSleep,
	refusalDetail,
	sanitizeTranscript,
	type Sleep,
	transcribePages,
	transcriptionPrompt,
	triedAgain,
	upperFirst,
} from "./llm-transcript";
import type { RmPage } from "./rm-parser";

export interface OpenAiCompatOcrOptions {
	/** The provider this adapter serves; recorded in the note's `ocr-backend` frontmatter. */
	id: OcrBackendId;
	/** Provider base URL, e.g. `https://api.openai.com/v1` -- `/chat/completions` is appended. */
	baseURL: string;
	model: string;
	/** Omitted from the request when empty/absent (local servers ignore auth). */
	apiKey?: string | null;
	/** Optional provider attribution headers (e.g. OpenRouter's `X-Title`). */
	extraHeaders?: Record<string, string>;
	/**
	 * Send `temperature: 0` (#116). Comes from `ProviderMeta.deterministic`, which is where the reason
	 * per provider is written down -- true for the servers the user runs, false for every cloud one,
	 * because nine current Claude models answer a non-default temperature with a 400.
	 */
	deterministic?: boolean;
	fetchFn?: typeof fetch;
	/** Injected by tests so a 429 backoff doesn't actually wait. */
	sleepFn?: Sleep;
}

interface OpenAiChatResponse {
	choices?: Array<{ message?: { content?: string | null; reasoning?: string; reasoning_content?: string }; finish_reason?: string }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

/**
 * Whether a truncated answer ran out of room while the model was still reasoning, as each server says
 * it: Ollama in `reasoning`, llama-server and LM Studio in `reasoning_content`, OpenAI and OpenRouter
 * as `reasoning_tokens`, and a model whose reasoning nobody separated as an inline `<think>`. An empty
 * answer counts too: that is #116's case, reasoning that used up the room before the answer began.
 * Anything else is a model that kept writing the answer itself -- a small one repeating a line.
 */
function ranOutReasoning(body: OpenAiChatResponse): boolean {
	const message = body.choices?.[0]?.message;
	const content = message?.content ?? "";
	return !!message?.reasoning || !!message?.reasoning_content || (body.usage?.completion_tokens_details?.reasoning_tokens ?? 0) > 0 || content.trim() === "" || content.includes("<think>");
}

/** A truncated answer as figures for the diagnostics -- see `CutOff`. The context is filled in after the pages, see `serverContext`. */
function cutOff(body: OpenAiChatResponse): CutOff {
	const lines = (body.choices?.[0]?.message?.content ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
	return {
		promptTokens: body.usage?.prompt_tokens ?? null,
		answerTokens: body.usage?.completion_tokens ?? null,
		context: null,
		reasoning: ranOutReasoning(body),
		repeatedLines: lines.length - new Set(lines).size,
		lines: lines.length,
	};
}

/**
 * The context a local server gave `model`, or null: Ollama lists it in `/api/ps`, LM Studio in
 * `/api/v0/models` for a loaded model (read against 0.4.26), and no other server says. Asked only after
 * a page was cut off, and once per adapter -- which is once per run, since each run builds its own --
 * so a run that read everything sends nothing extra; and anything that goes wrong here, a server that
 * never answers included, costs only this one figure, never the page results it describes.
 */
async function serverContext(fetchFn: typeof fetch, sleep: Sleep, id: OcrBackendId, baseURL: string, model: string): Promise<number | null> {
	// Raced rather than aborted: `fetch` in Obsidian is `requestUrl`, which accepts a signal and ignores
	// it (see `withTimeout` in licence-client.ts). The lookup is for the diagnostics only, and a server
	// that never answers it may not hold up the run whose pages it describes.
	return Promise.race([askContext(fetchFn, id, baseURL, model), sleep(CONTEXT_LOOKUP_TIMEOUT_MS).then(() => null)]);
}

/** How long a context lookup may take: it is a local server listing what it has loaded. */
const CONTEXT_LOOKUP_TIMEOUT_MS = 5_000;

async function askContext(fetchFn: typeof fetch, id: OcrBackendId, baseURL: string, model: string): Promise<number | null> {
	const root = baseURL.replace(/\/v1\/?$/, "");
	try {
		if (id === "ollama") {
			const body = (await (await fetchFn(`${root}/api/ps`)).json()) as { models?: Array<{ name?: string; context_length?: number }> };
			// Ollama runs a name without a tag as `:latest`, and `/api/ps` always prints the tag
			// (`Name.DisplayShortest`, read at v0.40.2). The tag is after the last `/`, since a registry host
			// can carry a port: `host:5000/ns/model`.
			const listed = model.slice(model.lastIndexOf("/") + 1).includes(":") ? model : `${model}:latest`;
			return body.models?.find((loaded) => loaded.name === listed)?.context_length ?? null;
		}
		if (id === "lmstudio") {
			const body = (await (await fetchFn(`${root}/api/v0/models`)).json()) as { data?: Array<{ id?: string; state?: string; loaded_context_length?: number }> };
			return body.data?.find((listed) => listed.id === model && listed.state === "loaded")?.loaded_context_length ?? null;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * The providers that cost nothing per page, because the server is the user's own.
 *
 * This replaced a `PROVIDERS[id]?.kind === "cloud"` lookup when the adapter moved into `src/`
 * (free-localhost-ocr spec §2): the cloud table cannot live here, and naming the *free* ids instead
 * of the paid ones flips the default for an id nobody listed from "free" to "metered" -- the safe
 * direction for a money gate. Blocking a free background sync is recoverable; billing one silently
 * is not.
 */
const FREE_PROVIDER_IDS: ReadonlySet<string> = new Set(["ollama", "lmstudio", "custom"]);

/** `{baseURL}/chat/completions`, tolerant of a trailing slash on the base URL (Gemini's compat URL has one). */
function chatCompletionsUrl(baseURL: string): string {
	return `${baseURL.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * Generic OpenAI-compatible OCR backend (multi-provider spec §3.1): one code path for OpenAI, Gemini
 * (compat endpoint), OpenRouter, Ollama, LM Studio, and any custom OpenAI-compatible server.
 * Rasterizes each page with the shared `rasterizePage` → `encodeGrayscalePng` pipeline, then sends
 * **one page per `POST {baseURL}/chat/completions` call**, four in flight, reading each transcript
 * from `choices[0].message.content`. Never throws -- degrades to `ocr: failed` like every backend.
 *
 * It sent every page in one call until page-anchored transcripts, which could not attribute the
 * response to a page. One image per call also fits the local providers this adapter serves: Ollama's
 * default 4k context cannot hold forty page images in one request at all.
 *
 * It lived in `pro/` until the free build gained the three localhost providers; the class is
 * unchanged apart from where `metered` comes from (free-localhost-ocr spec §2).
 */
export class OpenAiCompatOcrBackend implements OcrBackend {
	readonly id: OcrBackendId;
	/** Only the cloud providers bill per page; Ollama, LM Studio and a self-hosted `custom` are free. */
	readonly metered: boolean;
	/**
	 * Provider, endpoint and model -- the three things that change what comes back. The API key is
	 * deliberately absent: it says who is asking, not what is read, and this ends up in `data.json`.
	 * The endpoint is in because a `custom` provider pointed at a different server is a different
	 * reader even when the model string matches.
	 */
	readonly fingerprint: string;
	private readonly baseURL: string;
	/** The model the requests name, exactly as the user entered it. */
	readonly model: string;
	private readonly apiKey: string | null;
	private readonly extraHeaders: Record<string, string>;
	private readonly deterministic: boolean;
	private readonly fetchFn: typeof fetch;
	private readonly sleepFn: Sleep | undefined;
	/** Set when a page failed because nothing answered at `baseURL` -- see `recognize`. */
	private unreachable = false;
	/**
	 * Set when the server answered with its own failure, a 5xx or a 429 still there after
	 * `fetchWithRetry`. Apart from `unreachable`, which picks the sentence: the server is running, so
	 * "Is it running?" would be wrong. Both make the result `retryable` -- see `OcrResult.retryable`.
	 */
	private serverError = false;
	/**
	 * Set when the server refused the request itself, a 4xx other than a 429 -- the other side of
	 * `serverError`. It makes the result `refused` -- see `OcrResult.refused`.
	 */
	private refused = false;
	/** The first refusal the server explained, as `<status>: <message>` -- see `recognize`. */
	private refusal: string | null = null;
	/**
	 * The pages dropped because the answer ran past what the model may return, one entry each -- see
	 * `recognize`. Kept apart from `failedPages`: that number is every failed page whatever the cause,
	 * including a thrown parse error that sets no flag at all, so reporting it as truncations would
	 * over-claim.
	 */
	private cutOffs: CutOff[] = [];
	/** The context lookup, asked at most once per adapter -- see `serverContext`. */
	private context: Promise<number | null> | null = null;
	/** How many pages were dropped because the server never answered -- see `recognize`. */
	private timedOut = 0;

	constructor(options: OpenAiCompatOcrOptions) {
		this.id = options.id;
		this.metered = !FREE_PROVIDER_IDS.has(options.id);
		this.baseURL = options.baseURL;
		this.model = options.model;
		this.fingerprint = `${options.id}|${options.baseURL}|${options.model}`;
		this.apiKey = options.apiKey ?? null;
		this.extraHeaders = options.extraHeaders ?? {};
		this.deterministic = options.deterministic ?? false;
		// Reads as the global fetch and is not one: esbuild's `inject` rewrites this free identifier to
		// the CORS-free requestUrl shim inside the bundle. `src/fetch-shim.ts` names this exact pattern
		// -- "the OCR backends' `fetchFn ?? fetch` defaults" -- as one of the two it exists for. The
		// lint warning it earns is carried in the ratchet baseline rather than silenced, because the
		// repo forbids disabling that rule.
		this.fetchFn = options.fetchFn ?? fetch;
		this.sleepFn = options.sleepFn;
	}

	async recognize(pages: RmPage[], onPage?: () => void, framing: OcrFraming = "page"): Promise<OcrResult> {
		if (pages.length === 0) return { status: "skipped", pages: [], text: "", confidence: null };
		this.unreachable = false;
		this.serverError = false;
		this.refused = false;
		this.refusal = null;
		this.cutOffs = [];
		this.timedOut = 0;

		// An empty model field is a misconfiguration, and sending it anyway is worse than refusing:
		// LM Studio answers `"model": ""` with whatever happens to be loaded -- so the note would carry
		// a transcript from a model nobody chose -- and with a bare 400 when nothing is, which reaches
		// the note as "Could not read this page" and names nothing to fix. The one thing the user has
		// to do is said here instead.
		if (this.model.trim() === "") {
			return transcribePages(
				pages,
				async () => ({ kind: "failed" }),
				(failedPages) => `No model is set for this OCR backend — open the plugin settings and enter one. ${upperFirst(pageCount(failedPages, framing))} not transcribed.`,
				onPage,
			);
		}

		const result = await transcribePages(
			pages,
			(page) => this.transcribePage(page, framing),
			// One warning per unit, not per page: forty identical lines in the end-of-sync report is the
			// same silence in a different costume. A server that is not running comes first -- it is the
			// most likely failure and the one the user fixes in seconds. Otherwise the server's own words
			// go through unchanged: "No models loaded" is a sentence we could not have written for it,
			// and inventing one for a 404 or a bad key is still not done here.
			// Truncation goes last, and stays last: someone whose server died should read that rather than
			// a model recommendation. Both causes above are systemic -- the whole unit is lost for one
			// reason -- while truncation is a property of particular pages, so it is the right thing to be
			// displaced by a bigger failure that is also true.
			// A refusal promises no retry, though a sync may make one: that happens only when every margin
			// note of the PDF was refused (`OcrResult.refused`), and this sentence knows one note, not the
			// PDF. Promised here, it would be false for the note refused among thirty that were read.
			(failedPages) => {
				if (this.unreachable) return `Could not reach the server at ${this.baseURL} — ${pageCount(failedPages, framing)} not transcribed. Is it running?${triedAgain(framing)}`;
				if (this.refusal) return `The server at ${this.baseURL} answered ${this.refusal} — ${pageCount(failedPages, framing)} not transcribed.${this.serverError ? triedAgain(framing) : ""}`;
				if (this.timedOut > 0) return timeoutWarning(this.timedOut, this.baseURL, framing);
				if (this.cutOffs.length > 0) return truncationWarning(this.cutOffs.length, framing, this.cutOffs.some((cut) => cut.reasoning));
				return null;
			},
			onPage,
		);
		if (this.unreachable || this.serverError) result.retryable = true;
		if (this.refused) result.refused = true;
		if (this.cutOffs.length > 0) {
			this.context ??= serverContext(this.fetchFn, this.sleepFn ?? realSleep, this.id, this.baseURL, this.model);
			const context = await this.context;
			result.cutOffs = this.cutOffs.map((cut) => ({ ...cut, context }));
		}
		return result;
	}

	/** One page, one request. Every outcome that isn't usable text is `failed` for that page alone. */
	private async transcribePage(page: RmPage, framing: OcrFraming): Promise<LlmPageOutcome> {
		try {
			const content = [
				{ type: "text", text: transcriptionPrompt(framing) },
				{
					type: "image_url",
					image_url: { url: `data:image/png;base64,${Buffer.from(ocrImage(page, framing)).toString("base64")}` },
				},
			];

			const headers: Record<string, string> = { "content-type": "application/json", ...this.extraHeaders };
			if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

			// Still no max_tokens: the spec's request body omits it (§3.1), and providers differ on the
			// ceiling. Truncation is caught below via `finish_reason` instead of being capped here.
			//
			// `temperature` is spread in rather than always sent, so the cloud providers keep receiving
			// exactly `{ model, messages }` -- see `deterministic` in the options, and `ProviderMeta` for
			// which providers set it and why.
			const response = await fetchWithRetry(
				this.fetchFn,
				chatCompletionsUrl(this.baseURL),
				{
					method: "POST",
					headers,
					body: JSON.stringify({ model: this.model, messages: [{ role: "user", content }], ...(this.deterministic ? { temperature: 0 } : {}) }),
				},
				this.sleepFn,
			);

			if (!response.ok) {
				// First refusal wins: with four pages in flight they are the same refusal anyway, and the
				// first one is the one whose status the user saw the run stop on.
				this.refusal ??= `${response.status}${await refusalDetail(response)}`;
				// A server failing rather than refusing: Ollama's "500 unknown model architecture" goes away
				// with an Ollama update and the same model, and a 503 or a 429 with the load. A 400 or a 401
				// would be refused again however long the sync waits -- unless what it refused is fixed
				// outside the plugin, as a 404 for a model not pulled yet is (`OcrResult.refused`).
				if (response.status >= 500 || response.status === 429) this.serverError = true;
				else this.refused = true;
				console.warn(`Tagged Sync: ${this.id} OCR request failed with status ${response.status}`);
				return { kind: "failed" };
			}

			const body = (await response.json()) as OpenAiChatResponse;
			// A truncated page is `failed`, not `ok`: half a page read as a whole one is a silent,
			// permanent loss, because the next sync skips a document whose device hash is unchanged.
			if (body.choices?.[0]?.finish_reason === "length") {
				this.cutOffs.push(cutOff(body));
				console.warn(`Tagged Sync: ${this.id} OCR response was truncated, marking the page failed`);
				return { kind: "failed" };
			}

			return { kind: "ok", text: sanitizeTranscript(body.choices?.[0]?.message?.content ?? "") };
		} catch (error) {
			// A server that answers nothing for ten minutes is running and reachable, so it is counted on
			// its own rather than folded into `unreachable` -- "Is it running?" is the wrong thing to ask
			// somebody watching their model generate.
			if (error instanceof OcrTimeoutError) this.timedOut++;
			else if (isUnreachable(error)) this.unreachable = true;
			console.warn(`Tagged Sync: ${this.id} OCR failed, note will ship with render only`, error);
			return { kind: "failed" };
		}
	}
}

/**
 * The sentence a run that waited out {@link OCR_REQUEST_TIMEOUT_MS} puts in the report.
 *
 * It names the tall-page shape because that is the one that has produced it: a page scrolled far
 * past a screen becomes one very tall image, and a local model given greedy decoding did not finish
 * reading it at all. The advice is what the user can actually do about it today.
 *
 * `pro/anthropic-ocr-backend.ts` has a sentence of the same name and it is **not** this one: it names
 * Anthropic where this names the server's own URL, and it has no tall-page advice to give, because a
 * hosted model that does not answer is not slow for a reason the user can see. Two sentences about
 * two situations, not one sentence in two places.
 */
function timeoutWarning(pages: number, baseURL: string, framing: OcrFraming): string {
	// The tall-page advice is about pages, an added one included: a margin note is a few words and never that shape.
	const tallPage =
		framing !== "note"
			? "A page scrolled far past one screen is sent as one very tall image, which a local model can take a long time over, or never finish. "
			: "";
	return (
		`${upperFirst(pageCount(pages, framing))} left out because the server at ${baseURL} did not answer in ` +
		`${Math.round(OCR_REQUEST_TIMEOUT_MS / 60_000)} minutes. ${tallPage}A later sync will not pick them up on ` +
		`its own: try a different model, then ${readAgain(framing)}.`
	);
}

/**
 * The one sentence a user sees when pages were dropped for running too long (#116).
 *
 * Four things it must carry, and each is there for a reason a shorter sentence loses: the cause in
 * the user's terms rather than `finish_reason`; that the page was **left out** on purpose, so it does
 * not read as a plugin bug; the lever, which has to stand alone for someone who never opened
 * settings; and that the loss does **not** heal itself -- the next sync skips a document whose device
 * hash is unchanged. For a page the repair is "Re-transcribe all synced notes"; a margin note or a
 * page added to a PDF has none to run, and `readAgain` says what does bring it back.
 *
 * `pro/anthropic-ocr-backend.ts` carries the same four things and says so in its own docstring. The
 * one thing it cannot borrow is the lever: here the fix is a model that does not reason, or the
 * setting that stops it; there, thinking cannot be switched off at all, so the lever is the model
 * alone. Keep the four things in step; leave the lever to each.
 *
 * Only a model that reasoned is named as the cause (`ranOutReasoning`); its answer says so. Any other
 * truncated answer has more than one cause and does not say which: told to switch to a model that
 * does not reason, a reporter on qwen2.5vl:3b was sent to the model they already had, and a full
 * context window -- which no other model fixes -- cuts an ordinary transcript off just the same. So
 * that sentence names no cause, and its lever is the figures that do (`CutOff`, in "Copy diagnostics").
 */
function truncationWarning(pages: number, framing: OcrFraming, reasoning: boolean): string {
	const head = `${upperFirst(pageCount(pages, framing))} left out because`;
	if (reasoning) {
		return (
			`${head} the model's answer ran past what it may return — this happens with models that reason before answering. ` +
			`A later sync will not pick them up on its own: switch to a model that doesn't reason, then ${readAgain(framing)}.`
		);
	}
	// Not `readAgain`: for a margin note that promises the next sync, which reads it again only under a
	// different backend or model -- and a full context is fixed in the server's settings, under the same
	// fingerprint. Switching "Handwritten notes" off and on reads every note again whatever the fix was.
	const repair = framing === "page" ? readAgain(framing) : `switch "Handwritten notes" off and on in the settings to read them again`;
	return (
		`${head} the model's answer was cut off before it was complete. A later sync will not pick them up on its own: ` +
		`"Copy diagnostics" shows what cut it off, and once that is fixed, ${repair}.`
	);
}
