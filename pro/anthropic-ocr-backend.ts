import { type OcrBackend, type OcrResult } from "../src/ocr-backend";
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
import { rasterizePage } from "../src/page-rasterizer";
import { encodeGrayscalePng } from "../src/png-encoder";
import type { RmPage } from "../src/rm-parser";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/**
 * Generous now that it bounds **one page** rather than a whole notebook. It used to cap the entire
 * unit: a 40-page notebook ran into it, and the response was still reported `ok` over a transcript
 * that stopped mid-sentence. Truncation is now `failed` for the page it happened on -- see below.
 *
 * Raised from 4096 for #116. Anthropic's Messages API **requires** `max_tokens`, which is why the
 * OpenAI-compatible adapter can omit it and this file cannot -- so the honest target is the shape
 * that path already has: a bound that catches a runaway, not one that budgets a normal page. The
 * densest page in the measurement corpus is 1114 characters, roughly 320 output tokens; every model
 * on Anthropic's current generation reasons before answering unless asked not to, and those tokens
 * count against this same ceiling. 16k is about fifty times the densest transcript, which leaves room
 * for a thinking pass while still bounding spend on a metered backend.
 *
 * The accepted risk, named: an adaptive thinking pass may scale to the room available, so a higher
 * ceiling can invite more thinking and more spend. That is what the settings warning covers, and it
 * is the better trade against a page silently dropped.
 */
const MAX_TOKENS = 16_384;

export interface AnthropicOcrOptions {
	apiKey: string;
	/**
	 * Anthropic model id. No default: a shipped id ages into a dead one, and sending an empty string
	 * gets a bare 400 that reaches the note as "Could not read this page" -- so an empty model is
	 * refused in {@link AnthropicOcrBackend.recognize} with a sentence naming what to do.
	 */
	model?: string;
	fetchFn?: typeof fetch;
	/** Injected by tests so a 429 backoff doesn't actually wait. */
	sleepFn?: Sleep;
}

interface AnthropicContentBlock {
	type: string;
	text?: string;
}

interface AnthropicResponse {
	content?: AnthropicContentBlock[];
	stop_reason?: string;
}

/**
 * Native Anthropic OCR backend (multi-provider spec §3.2): rasterizes each page with the same
 * page-rasterizer.ts pipeline the native Vision backend uses -- no separate stroke-based pipeline --
 * then sends **one page image per request** to Claude's Messages API, four in flight. Its `image`
 * source-block schema and `x-api-key` auth are why Anthropic keeps a native path rather than riding
 * the generic OpenAI-compatible adapter. Never throws -- degrades to `ocr: failed` like every other
 * backend, per spec §3.3.
 *
 * It sent every page in one call until page-anchored transcripts: the response could then not be
 * attributed to a page, so the note could not say where any line came from.
 */
export class AnthropicOcrBackend implements OcrBackend {
	readonly id = "anthropic" as const;
	readonly metered = true;
	private readonly apiKey: string;
	private readonly model: string;
	private readonly fetchFn: typeof fetch;
	private readonly sleepFn: Sleep | undefined;
	/** Set when a page failed because nothing answered at the endpoint -- see `recognize`. */
	private unreachable = false;
	/** The first refusal the API explained, as `<status>: <message>` -- see `recognize`. */
	private refusal: string | null = null;
	/** How many pages were dropped because the answer ran past `max_tokens` -- see `recognize`. */
	private truncated = 0;

	constructor(options: AnthropicOcrOptions) {
		this.apiKey = options.apiKey;
		this.model = options.model ?? "";
		this.fetchFn = options.fetchFn ?? fetch;
		this.sleepFn = options.sleepFn;
	}

	async recognize(pages: RmPage[], onPage?: () => void): Promise<OcrResult> {
		if (pages.length === 0) return { status: "skipped", pages: [], text: "", confidence: null };
		this.unreachable = false;
		this.refusal = null;
		this.truncated = 0;

		// Same refusal as the OpenAI-compatible adapter, for the same reason: Anthropic answers an
		// empty `model` with a bare 400, which reaches the note as "Could not read this page" and
		// names nothing the user could fix. The one thing they have to do is said here instead.
		if (this.model.trim() === "") {
			return transcribePages(
				pages,
				async () => ({ kind: "failed" }),
				(failedPages) =>
					`No model is set for this OCR backend — open the plugin settings and enter one. ${failedPages} ${failedPages === 1 ? "page was" : "pages were"} not transcribed.`,
				onPage,
			);
		}

		return transcribePages(
			pages,
			(page) => this.transcribePage(page),
			// This backend reported nothing at all until #116 -- not truncation, not a dead host, not a bad
			// key. A unit where every page failed still raised the generic notice; a unit where only some
			// did was completely silent, because `unitStatus` calls a unit `ok` as soon as one page reads.
			// The chain and its order are the OpenAI-compatible adapter's, deliberately: the two must not
			// drift, and the systemic causes displace the per-page one.
			(failedPages) => {
				if (this.unreachable) return `Could not reach Anthropic — ${pageCount(failedPages)} not transcribed. Is this machine online?`;
				if (this.refusal) return `Anthropic answered ${this.refusal} — ${pageCount(failedPages)} not transcribed.`;
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
					type: "image",
					source: {
						type: "base64",
						media_type: "image/png",
						data: Buffer.from(encodeGrayscalePng(rasterizePage(page))).toString("base64"),
					},
				},
			];

			const response = await fetchWithRetry(
				this.fetchFn,
				ENDPOINT,
				{
					method: "POST",
					headers: {
						"x-api-key": this.apiKey,
						"anthropic-version": ANTHROPIC_VERSION,
						"content-type": "application/json",
					},
					body: JSON.stringify({ model: this.model, max_tokens: MAX_TOKENS, messages: [{ role: "user", content }] }),
				},
				this.sleepFn,
			);

			if (!response.ok) {
				// First refusal wins: with four pages in flight they carry the same refusal anyway.
				this.refusal ??= `${response.status}${await refusalDetail(response)}`;
				console.warn(`Tagged Sync: anthropic OCR request failed with status ${response.status}`);
				return { kind: "failed" };
			}

			const body = (await response.json()) as AnthropicResponse;
			// A truncated page is `failed`, not `ok`: half a page of handwriting read as a whole one is a
			// silent, permanent loss, because the next sync skips a document whose device hash is unchanged.
			if (body.stop_reason === "max_tokens") {
				this.truncated++;
				console.warn("Tagged Sync: anthropic OCR response was truncated, marking the page failed");
				return { kind: "failed" };
			}

			return {
				kind: "ok",
				text: sanitizeTranscript(
					(body.content ?? [])
						.filter((block) => block.type === "text" && block.text)
						.map((block) => block.text!.trim())
						.join("\n\n"),
				),
			};
		} catch (error) {
			if (isUnreachable(error)) this.unreachable = true;
			console.warn("Tagged Sync: anthropic OCR failed, note will ship with render only", error);
			return { kind: "failed" };
		}
	}
}


/** "1 page was" / "3 pages were", so the warnings above read as sentences. */
function pageCount(pages: number): string {
	return `${pages} ${pages === 1 ? "page was" : "pages were"}`;
}

/**
 * The truncation sentence. Deliberately the same four things the OpenAI-compatible adapter says --
 * cause in the user's terms, that the page was left out on purpose, the lever, and that the loss does
 * not heal itself -- with the one difference this backend owns: on the current Claude generation
 * thinking cannot be switched off, so the lever is a different model rather than a different setting.
 */
function truncationWarning(pages: number): string {
	return (
		`${pageCount(pages)} left out because the model's answer ran past what it may return — ` +
		`Claude models reason before answering, and those tokens count against the same limit. ` +
		`A later sync will not pick them up on its own: switch to a model that doesn't reason, then run "Re-transcribe all notes".`
	);
}