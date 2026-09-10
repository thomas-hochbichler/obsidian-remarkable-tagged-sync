import { type OcrPageResult, type OcrResult, unitStatus } from "./ocr-backend";
import { inkBounds } from "./page-rasterizer";
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
/**
 * The most images one page may cost.
 *
 * Raised from 3 to 6 on 2026-09-10, when a scrolled page became splittable: page 15 of the reference
 * set needs five pieces. Six leaves one piece of headroom without opening the door to a page that
 * costs twenty requests. A page that would exceed it is sent whole, which is exactly the behaviour
 * before any of this and therefore never a regression -- only a page that was going to be read badly
 * anyway is read badly still.
 */
const MAX_INK_PARTS = 6;

/**
 * A blank band this tall, in device pixels, reads as a break between blocks of writing rather than as
 * the space between two lines. The prototype's number, kept: it was chosen on one page and cuts a
 * completely different one into sensible pieces without being touched, which is the only evidence
 * available that it is not fitted to the page it came from.
 */
const GAP_PX = 200;

/** Neighbouring blocks are merged again while the image they make stays this many times its own width. */
const MERGE_ASPECT = 2;

/**
 * How many times its own width a page's ink must run before it is worth cutting at all.
 *
 * Measured, and the bracket is wide: the widest of the fourteen ordinary reference pages reaches
 * **2.08x** its own width, and the scrolled page reaches **8.77x**. A gate at 3x catches the scrolled
 * page and no ordinary one, with the nearest miss 44 % below and the target 192 % above.
 *
 * An aspect ratio rather than a pixel height or a byte count on purpose: both of those move with the
 * rasterizer's scale, while how much taller than wide someone wrote is a property of the writing.
 */
const TALL_ASPECT = 3;

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
/** The band of page a stroke covers, top to bottom. */
function strokeBand(stroke: RmStroke): { top: number; bottom: number } {
	let top = Number.POSITIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const point of stroke.points) {
		top = Math.min(top, point.y);
		bottom = Math.max(bottom, point.y);
	}
	return { top, bottom };
}

/**
 * A page far taller than it is wide, cut into pieces at the blank bands between blocks of writing.
 *
 * A scrolled page is one very tall image, and every backend shrinks an image before reading it -- so
 * the writing arrives at a fraction of its legible size and the model guesses. Measured on the
 * reference set's scrolled page, cutting it at its blank bands: GPT-4o **50.17 % -> 4.32 %**, Claude
 * 11.30 % -> 8.31 %, Gemini 3.65 % -> 1.33 %, the local model 4.32 % -> **1.00 %**. Every backend
 * improved and none regressed.
 *
 * Cuts fall where there is no ink, so **no stroke is ever divided** -- the failure that would hand a
 * model two half-glyphs and be worse than the tall image. Neighbouring blocks are put back together
 * while the piece they make stays a readable shape, because cutting at every band would send one
 * request per line: more expensive and no better read.
 *
 * Returns the page unchanged unless it is past {@link TALL_ASPECT}, so an ordinary page takes exactly
 * the path it took before and `inkBounds` returns exactly the frame it returned before.
 */
export function splitTallInk(page: RmPage): RmPage[] {
	const frame = inkBounds(page);
	if (frame === null || frame.height <= frame.width * TALL_ASPECT) return [page];

	const banded = page.layers
		.flatMap((layer) => layer.strokes)
		.map((stroke) => ({ stroke, ...strokeBand(stroke) }))
		.sort((a, b) => a.top - b.top);
	// No `banded.length === 0` guard: `inkBounds` returns null unless a stroke has points, and that
	// case already returned above.

	// Every blank band wider than a line's spacing is a cut. `reach` is the lowest ink so far, not the
	// previous stroke's: a long stroke drawn early must not let a later one look isolated.
	const blocks: { strokes: RmStroke[]; top: number; bottom: number }[] = [];
	let reach = Number.NEGATIVE_INFINITY;
	for (const { stroke, top, bottom } of banded) {
		const block = blocks[blocks.length - 1];
		if (block === undefined || top - reach > GAP_PX) blocks.push({ strokes: [stroke], top, bottom });
		else {
			block.strokes.push(stroke);
			block.bottom = Math.max(block.bottom, bottom);
		}
		reach = Math.max(reach, bottom);
	}

	const merged: typeof blocks = [];
	for (const block of blocks) {
		const last = merged[merged.length - 1];
		if (last !== undefined && block.bottom - last.top <= frame.width * MERGE_ASPECT) {
			last.strokes.push(...block.strokes);
			last.bottom = block.bottom;
			continue;
		}
		merged.push({ ...block, strokes: [...block.strokes] });
	}

	// One piece is the page itself; returning it unwrapped keeps the caller's "did anything split"
	// question answerable by length alone.
	if (merged.length <= 1) return [page];
	return merged.map((block) => inkOnly(page, new Set(block.strokes)));
}

export function splitAtTypedText(page: RmPage): PagePart[] {
	const lines = page.text ? layoutText(page.text).lines.filter((line) => line.text.trim() !== "") : [];
	const whole: PagePart[] = [{ kind: "ink", scene: page }];
	// No typed text: the only question left is whether the ink itself is too tall to read in one image.
	if (lines.length === 0) {
		const tall = splitTallInk(page).map((scene): PagePart => ({ kind: "ink", scene }));
		return tall.length > MAX_INK_PARTS ? whole : tall;
	}

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
			// Each run of ink between typed lines is still a page image, and still worth cutting if it is
			// far taller than it is wide.
			for (const scene of splitTallInk(inkOnly(page, slots[i]))) parts.push({ kind: "ink", scene });
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

/**
 * How long one request may run before the page it is reading is failed instead.
 *
 * There was no bound at all, and a local model showed what that costs: a scrolled page rasterizes
 * 325 x 7082 px, and `google/gemma-4-12b` in LM Studio answered it in 102 s with no `temperature`
 * and never answered it at all with the `temperature: 0` every localhost provider sends. `lms ps`
 * reported the model `GENERATING` after 40 minutes, the socket stayed open, the status bar stayed on
 * the notebook, and nothing was written or said. A run cannot be left to end that way.
 *
 * Ten minutes, which is a runaway bound and not a page budget: the slowest page anyone has measured
 * took a sixth of it, and the request also waits out whatever the server has queued ahead of it --
 * four are sent at a time and a local server answers one at a time. So it is far too long to be a
 * timeout in the usual sense, and that is the point. Failing a page that would have answered is the
 * one outcome worse than waiting.
 *
 * The request itself is not cancelled: inside the bundle `fetch` is Obsidian's `requestUrl`, which
 * takes no signal. The model keeps generating until it stops on its own; what this bounds is how
 * long the *sync* waits for it.
 */
export const OCR_REQUEST_TIMEOUT_MS = 600_000;

/** Thrown when a request passes {@link OCR_REQUEST_TIMEOUT_MS}, so the page fails as a page. */
export class OcrTimeoutError extends Error {
	constructor() {
		super(`the request went unanswered for ${Math.round(OCR_REQUEST_TIMEOUT_MS / 60_000)} minutes`);
		this.name = "OcrTimeoutError";
	}
}

/**
 * The request, or an {@link OcrTimeoutError} -- whichever comes first.
 *
 * On its own timer rather than on the injected `sleep`, which is the backoff clock: a test that
 * hands in an instant sleep to skip a `Retry-After` wait would otherwise time out every request it
 * makes. The timer is cleared as soon as the request settles, so only a request that really is
 * hanging keeps one alive.
 *
 * Bare `setTimeout` and not `realSleep`'s `window.setTimeout`, which is what the two lint warnings
 * this earns are about: there is no DOM in a delay, and every suite runs on Node, where `window` does
 * not exist and this function runs on every request a test makes. The warnings are carried in the
 * ratchet baseline rather than silenced, exactly as the `fetch` defaults above are.
 */
function withTimeout(request: Promise<Response>): Promise<Response> {
	let timer: ReturnType<typeof setTimeout>;
	const expiry = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new OcrTimeoutError()), OCR_REQUEST_TIMEOUT_MS);
	});
	return Promise.race([request, expiry]).finally(() => clearTimeout(timer));
}

/** What one page's request came back as, before typed text and the note's page labels are added. */
export type LlmPageOutcome = { kind: "ok"; text: string } | { kind: "failed" };

/** Injectable so a test does not actually wait out a backoff. */
export type Sleep = (ms: number) => Promise<void>;

/**
 * Bare `setTimeout`, for the reason `withTimeout` below gives at length: there is no DOM in a delay,
 * and this file runs on Node as well as in Obsidian. `window.setTimeout` here threw
 * `ReferenceError: window is not defined` in the nightly on the first 429 of every run, so the
 * backoff this default exists for had never once executed outside a test that replaced it. Found
 * 2026-09-09 while measuring precision through this adapter: eleven of fifteen rate-limited pages
 * were lost rather than retried, and reported as "the provider could not answer" instead.
 */
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
	let response = await withTimeout(fetchFn(url, init));
	for (let attempt = 1; attempt < MAX_ATTEMPTS && response.status === 429; attempt++) {
		await sleep(retryDelay(response, attempt, Date.now()));
		response = await withTimeout(fetchFn(url, init));
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

/**
 * The `: <message>` half of a refusal, or "" when the server sent none.
 *
 * Here rather than in one backend because both of them report refusals since #116, and a second copy
 * of a rule about response shapes is a rule that drifts.
 *
 * Two shapes, because both are in the wild: OpenAI's `{error: {message}}`, which LM Studio and
 * Ollama follow, and a bare `{error: "..."}` string. Anything else -- HTML, an empty body, a parse
 * failure -- leaves the status to speak alone rather than putting a stringified object in a note.
 */
export async function refusalDetail(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: string | { message?: string } };
		const message = typeof body.error === "string" ? body.error : body.error?.message;
		return message ? `: ${message}` : "";
	} catch {
		return "";
	}
}

/**
 * Whether a thrown request error means *nothing answered at that address*, as opposed to answering
 * badly. Matched on the text because Electron's fetch exposes no stable typed error -- the same
 * reason `explain-error.ts` matches strings for the reMarkable cloud.
 *
 * Deliberately loose in the harmless direction: a false positive says "is it running?" about a server
 * that is, which costs a wrong hint. A false negative restores the silence this exists to end.
 */
export function isUnreachable(error: unknown): boolean {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	return /econnrefused|enotfound|ehostunreach|enetunreach|econnreset|failed to fetch|fetch failed|network|socket hang up/i.test(text);
}
