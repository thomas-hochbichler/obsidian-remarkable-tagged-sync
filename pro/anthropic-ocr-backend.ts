import { type OcrBackend, type OcrResult } from "../src/ocr-backend";
import { fetchWithRetry, type LlmPageOutcome, sanitizeTranscript, type Sleep, TRANSCRIPTION_PROMPT, transcribePages } from "./llm-transcript";
import { rasterizePage } from "../src/page-rasterizer";
import { encodeGrayscalePng } from "../src/png-encoder";
import type { RmPage } from "../src/rm-parser";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";
/**
 * Generous now that it bounds **one page** rather than a whole notebook. It used to cap the entire
 * unit: a 40-page notebook ran into it, and the response was still reported `ok` over a transcript
 * that stopped mid-sentence. Truncation is now `failed` for the page it happened on -- see below.
 */
const MAX_TOKENS = 4096;

export interface AnthropicOcrOptions {
	apiKey: string;
	/** Anthropic model id; defaults to `claude-sonnet-5` (spec §3.2). */
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

	constructor(options: AnthropicOcrOptions) {
		this.apiKey = options.apiKey;
		this.model = options.model ?? DEFAULT_MODEL;
		this.fetchFn = options.fetchFn ?? fetch;
		this.sleepFn = options.sleepFn;
	}

	async recognize(pages: RmPage[]): Promise<OcrResult> {
		if (pages.length === 0) return { status: "skipped", pages: [], text: "", confidence: null };
		return transcribePages(pages, (page) => this.transcribePage(page));
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
				console.warn(`Tagged Sync: anthropic OCR request failed with status ${response.status}`);
				return { kind: "failed" };
			}

			const body = (await response.json()) as AnthropicResponse;
			// A truncated page is `failed`, not `ok`: half a page of handwriting read as a whole one is a
			// silent, permanent loss, because the next sync skips a document whose device hash is unchanged.
			if (body.stop_reason === "max_tokens") {
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
			console.warn("Tagged Sync: anthropic OCR failed, note will ship with render only", error);
			return { kind: "failed" };
		}
	}
}
