import { type OcrPageResult, type OcrResult, unitStatus } from "./ocr-backend";
import type { RmPage, RmStroke } from "./rm-parser";
import { layoutText } from "./text-layout";
import { mapWithConcurrency } from "./concurrency";

/**
 * The transcription prompt shared verbatim by every LLM-vision backend (multi-provider spec §3).
 *
 * Phrased for **one** image, because every backend now sends one: the local model always did
 * (`local-ocr-runtime.ts`), and the cloud adapters joined it under page-anchored-transcripts §6. The
 * plural wording it replaces was already wrong for the local backend.
 *
 * The boilerplate is load-bearing, not politeness -- four shorter alternatives were measured and each
 * was equal or worse, one collapsing to 836.8 % CER on a page. Only the plurals changed here.
 *
 * "No page labels" now means what it says: the sync-engine attaches the page header, so a
 * model-written "Page 3" would be a duplicate at best and wrong at worst.
 */
export const TRANSCRIPTION_PROMPT =
	"Transcribe the handwritten text in this page image into clean Markdown, " +
	"preserving reading order and visible structure: headings, lists, GFM task lists (- [ ] / - [x]), " +
	"and tables. Do not invent structure that is not visually present; when unsure, use plain " +
	"paragraphs. Output only the transcript text -- no commentary, preamble, code fences, or page " +
	"labels. If the page has no legible text, output nothing.";

/** One part of a page in reading order: ink to transcribe, or typed text to place exactly as it is. */
export type PagePart = { kind: "ink"; scene: RmPage } | { kind: "typed"; text: string };

/**
 * How many requests one page may cost. Past it the page is transcribed whole and its typed text
 * appended, which is what every page did before this existed.
 *
 * Three, because typed text is rare (72 of the 80 corpus pages carry none) and two blocks on one
 * page rarer still. The cap is not protecting against a shape anyone has produced; it is there so a
 * page nobody imagined cannot quietly cost ten requests.
 */
const MAX_INK_PARTS = 3;

/** The vertical middle of a stroke, which is the slot it belongs to even where it spans two. */
function strokeMiddleY(stroke: RmStroke): number {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const point of stroke.points) {
		min = Math.min(min, point.y);
		max = Math.max(max, point.y);
	}
	return (min + max) / 2;
}

/** The page with only the given strokes on it, and no typed text -- a scene that is this ink and nothing else. */
function inkOnly(page: RmPage, keep: ReadonlySet<RmStroke>): RmPage {
	return {
		...page,
		text: undefined,
		layers: page.layers.map((layer) => ({ ...layer, strokes: layer.strokes.filter((stroke) => keep.has(stroke)) })),
	};
}

/**
 * A page in reading order: its ink split where the typed text sits between it, and the typed lines
 * in their place.
 *
 * Typed text is on no page image at all -- the rasterizer draws ink -- so without it the words are
 * missing from the note entirely, and it must not go through transcription either, being exact
 * already. That much was always true. What was not is *where* it lands: it used to be appended after
 * the model's answer for the page, so a page with handwriting above and below a typed block read
 * back with the block last and the writing that followed it in the middle.
 *
 * The answer carries no positions, so nothing in it can be spliced against. The ink can be split
 * before it is ever sent, though, and the device does record where every stroke and every typed line
 * sits. So each stroke is placed in the slot between the typed baselines it falls between, and each
 * run of ink becomes a scene of its own.
 *
 * Strokes are assigned, never cut. A stroke that spans the typed text -- a box drawn around it, an
 * arrow across it -- goes whole into the slot its middle is in. That is the wrong half for it, and a
 * far smaller wrong than the two half-glyphs a cut through the raster would hand the model.
 *
 * `VisionOcrBackend` needs none of this and does not use it: Apple Vision reports a box per line, so
 * it places typed lines by height directly (`insertTypedText`).
 */
export function splitAtTypedText(page: RmPage): PagePart[] {
	const lines = page.text ? layoutText(page.text).lines.filter((line) => line.text.trim() !== "") : [];
	const whole: PagePart[] = [{ kind: "ink", scene: page }];
	if (lines.length === 0) return whole;

	// Slot i holds the strokes above typed line i; the last slot holds what is below them all.
	const slots: Set<RmStroke>[] = Array.from({ length: lines.length + 1 }, () => new Set());
	for (const layer of page.layers) {
		for (const stroke of layer.strokes) {
			const middle = strokeMiddleY(stroke);
			let slot = 0;
			while (slot < lines.length && lines[slot].yPx < middle) slot++;
			slots[slot].add(stroke);
		}
	}

	const parts: PagePart[] = [];
	let pending: string[] = [];
	for (let i = 0; i <= lines.length; i++) {
		if (slots[i].size > 0) {
			if (pending.length > 0) parts.push({ kind: "typed", text: pending.join("\n") });
			pending = [];
			parts.push({ kind: "ink", scene: inkOnly(page, slots[i]) });
		}
		if (i < lines.length) pending.push(lines[i].text);
	}
	if (pending.length > 0) parts.push({ kind: "typed", text: pending.join("\n") });

	const inkParts = parts.filter((part) => part.kind === "ink").length;
	// A page of typed text with no ink on it at all: one part, nothing to send, and the caller's loop
	// produces the typed lines without a request. The cap is about the other end.
	if (inkParts > MAX_INK_PARTS) return [...whole, { kind: "typed", text: lines.map((line) => line.text).join("\n") }];
	return parts;
}

/**
 * Strip LLM envelope leakage from a transcript: a single leading preamble line and an outer code
 * fence wrapping the whole response (structure-preserving-ocr spec §2). Anchored to the response
 * edges only — never touches inner content, so a code block the user wrote on the page survives.
 * Biased to under-strip: a stray line is a cheap failure, corrupting a note is not.
 */
export function sanitizeTranscript(text: string): string {
	let lines = text.trim().split("\n");

	// 1. Leading preamble line: only a tight "Here is/are (the) transcript/transcription" match.
	if (/^here (is|are)( the)? (transcript|transcription)[:.]?$/i.test(lines[0].trim())) {
		lines = lines.slice(1);
		if (lines[0]?.trim() === "") lines = lines.slice(1);
	}

	// 2. Outer wrapping fence: only when an md/empty-info opening fence and a closing ``` span the
	//    whole (post-preamble) response. Any other info string (```python) is a real code block.
	const firstIdx = lines.findIndex((line) => line.trim() !== "");
	const lastIdx = lines.length - 1 - [...lines].reverse().findIndex((line) => line.trim() !== "");
	if (firstIdx !== -1 && lastIdx > firstIdx) {
		const opener = lines[firstIdx].trim();
		const closer = lines[lastIdx].trim();
		if (/^```(markdown|md)?$/i.test(opener) && closer === "```") {
			lines = lines.slice(firstIdx + 1, lastIdx);
		}
	}

	return lines.join("\n").trim();
}

// --- the OpenAI-compatible call machinery ----------------------------------------------------
//
// This was `pro/`'s until the free build gained a localhost backend (free-localhost-ocr spec §2).
// It is the same code serving the same adapter; only the set of servers it may be pointed at grew.
// `pro/llm-transcript.ts` re-exports it, so no Pro call site changed.

/**
 * Concurrent requests for the OpenAI-compatible adapter, which sends one image per call.
 *
 * Deliberately **not** Vision's `DEFAULT_MAX_PARALLELISM = 8`: that governs local subprocesses with
 * no rate limiter on the other end, and overloading one constant would couple two unrelated tunings.
 *
 * 4 is the conservative read of the vendors' own documentation. Anthropic's entry tier leaves ample
 * room for 40 calls but warns that short bursts trip a limit while still under budget, and OpenAI and
 * Gemini no longer publish rate-limit numbers at all -- so a free- or low-tier key cannot be reasoned
 * about in advance. Local OpenAI-compatible servers serialise regardless (Ollama's
 * `OLLAMA_NUM_PARALLEL` defaults to 1, LM Studio queues), so the cap costs them nothing.
 */
export const LLM_MAX_PARALLELISM = 4;
/** Attempts per page, including the first. A page still rate-limited after this is `failed` and says so in the note. */
const MAX_ATTEMPTS = 3;
/** Backoff when the provider rate-limits without saying for how long. */
const RETRY_BASE_MS = 1000;

/** What one page's request came back as, before typed text and the note's page labels are added. */
export type LlmPageOutcome = { kind: "ok"; text: string } | { kind: "failed" };

/** Injectable so a test does not actually wait out a backoff. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * `Retry-After` in ms, in both forms the HTTP spec allows (delta-seconds and a date), or the
 * exponential fallback when the header is absent or unparseable.
 */
function retryDelay(response: Response, attempt: number, now: number): number {
	const header = response.headers?.get?.("retry-after");
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
		const date = Date.parse(header);
		if (!Number.isNaN(date)) return Math.max(0, date - now);
	}
	return RETRY_BASE_MS * 2 ** (attempt - 1);
}

/**
 * A request that retries **only** a 429, up to `MAX_ATTEMPTS`, honouring `Retry-After`.
 *
 * This exists *because* of the move to one call per page, not despite it. Both adapters used to make
 * exactly one request per note and mapped any non-`ok` response straight to `failed`; turning that
 * into one request per page with no backoff would have left a user on a rate-limited key worse off
 * than before page-anchoring. Preventing that regression is the point.
 *
 * Deliberately narrow: OpenRouter's 502 `provider_unavailable` and 503 `provider_overloaded` are
 * transient too, and are still **not** retried. Each added code is another failure mode to reason
 * about, and a failed page is already a graceful, visible outcome rather than a lost note.
 */
export async function fetchWithRetry(fetchFn: typeof fetch, url: string, init: RequestInit, sleep: Sleep = realSleep): Promise<Response> {
	let response = await fetchFn(url, init);
	for (let attempt = 1; attempt < MAX_ATTEMPTS && response.status === 429; attempt++) {
		await sleep(retryDelay(response, attempt, Date.now()));
		response = await fetchFn(url, init);
	}
	return response;
}

/**
 * Runs one request per page, at most `LLM_MAX_PARALLELISM` in flight, and assembles the `OcrResult`.
 *
 * One image per call is the only shape where the page boundary comes from **the request array** --
 * something the plugin controls -- rather than from the model's willingness to mark it. No provider
 * correlates its response with the images it was sent, and JSON schemas cannot constrain array
 * length, so a single multi-image call can *ask* for a boundary but never guarantee one. The cost of
 * asking per page is small: image tokens are identical either way and only the prompt repeats.
 *
 * Typed text is placed **within** the page rather than appended after it, by splitting the ink where
 * the typed lines sit and sending each run of it as a scene of its own (`splitAtTypedText`). A page
 * with no typed text on it is one part and one request, exactly as before.
 *
 * A part that fails fails its page, and the parts after it are not requested. The page carries one
 * status, as it always has, and a backend that just refused is not worth asking twice -- a failure
 * here is nearly always systemic (server gone, key wrong, model refusing), and then every part of
 * every page fails anyway.
 *
 * `warnings` carries whatever the caller collected while the pages ran. It is the only channel that
 * reaches the end-of-sync report and "Copy diagnostics"; a `console.warn` reaches a console the user
 * will never open (free-localhost-ocr spec §5.2).
 */
export async function transcribePages(
	pages: RmPage[],
	run: (page: RmPage, index: number) => Promise<LlmPageOutcome>,
	warnings?: (failedPages: number) => string | null,
	onPage?: () => void,
): Promise<OcrResult> {
	const pageResults = await mapWithConcurrency(pages, LLM_MAX_PARALLELISM, async (page, index): Promise<OcrPageResult> => {
		const read: string[] = [];
		let failed = false;
		for (const part of splitAtTypedText(page)) {
			if (part.kind === "typed") {
				read.push(part.text);
				continue;
			}
			const outcome = await run(part.scene, index);
			if (outcome.kind === "failed") {
				failed = true;
				break;
			}
			if (outcome.text !== "") read.push(outcome.text);
		}
		// After the whole page, not after each part: a page that failed is as finished as one that
		// read, and the progress bar counts pages that are over -- one tick per page, whatever a page
		// cost in requests.
		onPage?.();
		if (failed) return { status: "failed", text: "" };
		const text = read.join("\n\n");
		return text.length > 0 ? { status: "ok", text } : { status: "skipped", text: "" };
	});

	const text = pageResults
		.filter((page) => page.status === "ok")
		.map((page) => page.text)
		.join("\n\n");
	const failed = pageResults.filter((page) => page.status === "failed").length;
	const warning = failed > 0 ? (warnings?.(failed) ?? null) : null;
	return {
		status: unitStatus(pageResults),
		pages: pageResults,
		text,
		confidence: null,
		...(warning ? { warnings: [warning] } : {}),
	};
}
