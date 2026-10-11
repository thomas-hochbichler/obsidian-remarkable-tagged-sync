import type { OcrBackend as OcrBackendId, OcrStatus } from "./note-builder";
import { rasterizePage } from "./page-rasterizer";
import { encodeGrayscalePng } from "./png-encoder";
import type { RmPage } from "./rm-parser";

/**
 * A single page's outcome. Deliberately narrower than the unit-level `OcrStatus`: `unavailable` is a
 * property of the *backend* -- it never looked at a page at all -- so it can never describe one.
 */
export type OcrPageStatus = "ok" | "skipped" | "failed";

export interface OcrPageResult {
	status: OcrPageStatus;
	/** Empty unless `status` is "ok". */
	text: string;
}

export interface OcrResult {
	status: OcrStatus;
	/**
	 * One entry per page handed to `recognize`, in input order -- `pages[i]` describes input page `i`.
	 * This is what lets the note say which text came from which page.
	 *
	 * `null` means *no per-page information exists*: either the backend transcribed nothing at all
	 * (`off`, unavailable), or it produced text it cannot attribute to a page. Never a partial,
	 * filtered or reordered list -- a backend that cannot meet the arity returns `null` and keeps
	 * `text`, because misattributing a transcript to the wrong page is worse than an honest
	 * unlabelled blob.
	 */
	pages: OcrPageResult[] | null;
	/** The whole-unit transcript, unlabelled. Derived from `pages` when they exist; the only carrier when they don't. */
	text: string;
	/** 0-100 if the backend reports one, otherwise null. */
	confidence: number | null;
	/**
	 * Things that went wrong inside a unit the backend still considers a success — a page that failed
	 * while the others read fine. They land in `SyncResult.skipErrors`, so "Copy diagnostics" and the
	 * end-of-sync report can name them.
	 *
	 * Without this channel a partial transcript is silent, and silence is permanent: the sync skips a
	 * document whose device-side hash is unchanged, so the missing page is never revisited.
	 */
	warnings?: string[];
	/**
	 * Set when a page failed because nothing answered at the endpoint: no server, no network, or a
	 * local engine that stopped. The one failure the very same request can get past later, unchanged
	 * and at no cost while it lasts -- so the sync tries a failed margin note again on this alone
	 * (`SyncIndexRow.ocrRetry`), where a refusal or a truncation waits for different settings.
	 */
	unreachable?: true;
}

/**
 * The unit's status stated from its pages, rather than inferred from whether the joined text came
 * out empty. Shared so all four backends answer it the same way.
 *
 * A unit with one failed page among thirty good ones still counts `ok` -- deliberately, because that
 * is what the end-of-sync counters have always reported. The failure is not swallowed: it is now
 * visible in the note, on the page it happened to, which is a better place for it than a whole-unit
 * counter.
 */
export function unitStatus(pages: OcrPageResult[]): OcrStatus {
	if (pages.some((page) => page.status === "ok")) return "ok";
	return pages.some((page) => page.status === "failed") ? "failed" : "skipped";
}

/**
 * What the scenes handed to `recognize` are, which decides how a backend frames them for its reader.
 *
 * `page` is a page of writing, sent as it always was. `note` is a margin note: a few words cut out of
 * an annotated PDF, one cluster of ink. Sent like a page, such a crop arrived at a model as a strip
 * with the letters touching its edges and a prompt about a "page image", and was read at more than
 * twice the error rate it is read at framed as a note (see `NOTE_TRANSCRIPTION_PROMPT`).
 *
 * `added-page` is a page the user added to an annotated PDF on the tablet. It reads exactly like a
 * page -- page prompt, no padding -- but it belongs to the digest, so what recovers a lost one is the
 * sync reading the document again (`SyncIndexRow.ocrRetry`), not "Re-transcribe", which refuses a
 * digest. Framed as a page, its warnings sent the user to that refusal.
 *
 * Each backend decides what the framing means for its reader, from measurement: the model backends
 * pad the crop and switch prompts, and Apple Vision reads it tight, as it reads a page.
 */
export type OcrFraming = "page" | "note" | "added-page";

/**
 * Quiet space around a margin note sent to a model. Qwen2.5-VL-7B read the reference set's line crops
 * at 18.0 % median CER tight and 8.4 % with it.
 *
 * The model backends' number only. Apple Vision's rescue pass pads its crops by its own
 * `RESCUE_PADDING_PX`, measured for Vision; the two are equal today and tuning one must not move the
 * other.
 */
export const NOTE_PADDING_PX = 40;

/** A scene as the PNG a backend sends: a page sized to its ink, a note with quiet space around it. */
export function ocrImage(scene: RmPage, framing: OcrFraming = "page"): Uint8Array {
	return encodeGrayscalePng(rasterizePage(scene, framing === "note" ? { paddingPx: NOTE_PADDING_PX } : undefined));
}

/**
 * Pluggable transcription abstraction (spec §6 / ticket 09-10): a backend
 * consumes the parsed ink strokes for a synced unit and returns transcribed
 * text. Whether it needs the strokes directly (e.g. a future stroke-based
 * backend) or a rasterized page image (e.g. the Vision and LLM-vision backends)
 * is an implementation detail of the backend, not the call site.
 */
export interface OcrBackend {
	readonly id: OcrBackendId;
	/**
	 * Whether recognizing with this adapter spends the user's money per page — the auto-sync
	 * money-safety gate. Declared per adapter rather than derived from `id`, so a keyless cloud
	 * provider that fell back to a free backend, or one that can't run here at all, reports honestly.
	 */
	readonly metered: boolean;
	/**
	 * Everything about this adapter that changes how a page reads, as one opaque string: the backend,
	 * the model, and the endpoint it reaches them at. The per-page transcript store keys on it, so a
	 * user who switches model gets their notes read again instead of one note carrying two models'
	 * readings (issue #117).
	 *
	 * **Never a credential.** An API key identifies the user, not the reading, and this string is
	 * hashed into every row of `data.json`.
	 *
	 * Declared per adapter rather than assembled by the caller, for the same reason `metered` is: only
	 * the adapter knows which of its options reach the model. An adapter that cannot describe itself
	 * exactly should return a constant -- the store then keeps text across a change it could not see,
	 * which is a known limitation of that backend rather than a bug in the store.
	 */
	readonly fingerprint: string;
	/**
	 * The model this adapter reads with, as the user named it in the settings, for "Copy diagnostics".
	 * Absent where there is nothing to name: Apple Vision's model belongs to the OS.
	 *
	 * Not the fingerprint: that is a store key, and one of them is a hash of the weights.
	 */
	readonly model?: string;
	/**
	 * `onPage` is called once per page whose transcription is finished, in *completion* order rather
	 * than input order: a backend that runs pages concurrently reports them as they land. Driving the
	 * progress bar is all it is for, so it carries no page identity -- and a backend that cannot say
	 * when a single page is done simply never calls it, leaving the caller to count the whole unit at
	 * its end.
	 *
	 * `framing` says what the scenes are; see {@link OcrFraming}. Omitted, they are pages.
	 */
	recognize(pages: RmPage[], onPage?: () => void, framing?: OcrFraming): Promise<OcrResult>;
}
