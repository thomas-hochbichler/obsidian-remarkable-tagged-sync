import type { OcrBackend as OcrBackendId } from "./note-builder";
import { type OcrBackend, type OcrResult } from "./ocr-backend";
import {
	fetchWithRetry,
	isUnreachable,
	type LlmPageOutcome,
	refusalDetail,
	sanitizeTranscript,
	type Sleep,
	TRANSCRIPTION_PROMPT,
	transcribePages,
} from "./llm-transcript";
import { rasterizePage } from "./page-rasterizer";
import { encodeGrayscalePng } from "./png-encoder";
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
	choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
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
	private readonly baseURL: string;
	private readonly model: string;
	private readonly apiKey: string | null;
	private readonly extraHeaders: Record<string, string>;
	private readonly deterministic: boolean;
	private readonly fetchFn: typeof fetch;
	private readonly sleepFn: Sleep | undefined;
	/** Set when a page failed because nothing answered at `baseURL` -- see `recognize`. */
	private unreachable = false;
	/** The first refusal the server explained, as `<status>: <message>` -- see `recognize`. */
	private refusal: string | null = null;
	/**
	 * How many pages were dropped because the answer ran past what the model may return -- see
	 * `recognize`. Counted rather than flagged, and counted separately from `failedPages`: that number
	 * is every failed page whatever the cause, including a thrown parse error that sets no flag at all,
	 * so reporting it as truncations would over-claim.
	 */
	private truncated = 0;

	constructor(options: OpenAiCompatOcrOptions) {
		this.id = options.id;
		this.metered = !FREE_PROVIDER_IDS.has(options.id);
		this.baseURL = options.baseURL;
		this.model = options.model;
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

	async recognize(pages: RmPage[], onPage?: () => void): Promise<OcrResult> {
		if (pages.length === 0) return { status: "skipped", pages: [], text: "", confidence: null };
		this.unreachable = false;
		this.refusal = null;
		this.truncated = 0;

		// An empty model field is a misconfiguration, and sending it anyway is worse than refusing:
		// LM Studio answers `"model": ""` with whatever happens to be loaded -- so the note would carry
		// a transcript from a model nobody chose -- and with a bare 400 when nothing is, which reaches
		// the note as "Could not read this page" and names nothing to fix. The one thing the user has
		// to do is said here instead.
		if (this.model.trim() === "") {
			return transcribePages(
				pages,
				async () => ({ kind: "failed" }),
				(failedPages) => `No model is set for this OCR backend — open the plugin settings and enter one. ${pageCount(failedPages)} not transcribed.`,
				onPage,
			);
		}

		return transcribePages(
			pages,
			(page) => this.transcribePage(page),
			// One warning per unit, not per page: forty identical lines in the end-of-sync report is the
			// same silence in a different costume. A server that is not running comes first -- it is the
			// most likely failure and the one the user fixes in seconds. Otherwise the server's own words
			// go through unchanged: "No models loaded" is a sentence we could not have written for it,
			// and inventing one for a 404 or a bad key is still not done here.
			// Truncation goes last, and stays last: someone whose server died should read that rather than
			// a model recommendation. Both causes above are systemic -- the whole unit is lost for one
			// reason -- while truncation is a property of particular pages, so it is the right thing to be
			// displaced by a bigger failure that is also true.
			(failedPages) => {
				if (this.unreachable) return `Could not reach the server at ${this.baseURL} — ${pageCount(failedPages)} not transcribed. Is it running?`;
				if (this.refusal) return `The server at ${this.baseURL} answered ${this.refusal} — ${pageCount(failedPages)} not transcribed.`;
				if (this.truncated > 0) return truncationWarning(this.truncated);
				return null;
			},
			onPage,
		);
	}

	/** One page, one request. Every outcome that isn't usable text is `failed` for that page alone. */
	private async transcribePage(page: RmPage): Promise<LlmPageOutcome> {
		try {
			const content = [
				{ type: "text", text: TRANSCRIPTION_PROMPT },
				{
					type: "image_url",
					image_url: { url: `data:image/png;base64,${Buffer.from(encodeGrayscalePng(rasterizePage(page))).toString("base64")}` },
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
				console.warn(`Tagged Sync: ${this.id} OCR request failed with status ${response.status}`);
				return { kind: "failed" };
			}

			const body = (await response.json()) as OpenAiChatResponse;
			// A truncated page is `failed`, not `ok`: half a page read as a whole one is a silent,
			// permanent loss, because the next sync skips a document whose device hash is unchanged.
			if (body.choices?.[0]?.finish_reason === "length") {
				this.truncated++;
				console.warn(`Tagged Sync: ${this.id} OCR response was truncated, marking the page failed`);
				return { kind: "failed" };
			}

			return { kind: "ok", text: sanitizeTranscript(body.choices?.[0]?.message?.content ?? "") };
		} catch (error) {
			if (isUnreachable(error)) this.unreachable = true;
			console.warn(`Tagged Sync: ${this.id} OCR failed, note will ship with render only`, error);
			return { kind: "failed" };
		}
	}
}

/**
 * The one sentence a user sees when pages were dropped for running too long (#116).
 *
 * Four things it must carry, and each is there for a reason a shorter sentence loses: the cause in
 * the user's terms rather than `finish_reason`; that the page was **left out** on purpose, so it does
 * not read as a plugin bug; the lever, which has to stand alone for someone who never opened
 * settings; and that the loss does **not** heal itself -- the next sync skips a document whose device
 * hash is unchanged, so "Re-transcribe all notes" is the repair.
 */
function truncationWarning(pages: number): string {
	return (
		`${pageCount(pages)} left out because the model's answer ran past what it may return — ` +
		`this happens with models that reason before answering. A later sync will not pick them up on its own: ` +
		`switch to a model that doesn't reason, then run "Re-transcribe all notes".`
	);
}

/** "1 page was" / "3 pages were", so the warnings above read as sentences. */
function pageCount(pages: number): string {
	return `${pages} ${pages === 1 ? "page was" : "pages were"}`;
}
