import type { OcrBackend as OcrBackendId, OcrStatus } from "./note-builder";
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
	 * `onPage` is called once per page whose transcription is finished, in *completion* order rather
	 * than input order: a backend that runs pages concurrently reports them as they land. Driving the
	 * progress bar is all it is for, so it carries no page identity -- and a backend that cannot say
	 * when a single page is done simply never calls it, leaving the caller to count the whole unit at
	 * its end.
	 */
	recognize(pages: RmPage[], onPage?: () => void): Promise<OcrResult>;
}
