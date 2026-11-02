/**
 * readwise.io's Highlights API v2, as much of it as the Readwise push needs (spec §4.3).
 *
 * Requests go through `obsidianFetch`, which wraps Obsidian's `requestUrl`, so there is no CORS
 * problem and no new dependency -- the route `zotero-web.ts` takes. This client sends what it is
 * given: field cuts and "never blank" (spec §11 P9) belong to whoever builds the items, because a
 * blank field fails the whole call (ticket 10).
 */

import { withTimeout } from "./licence-client";
import { type Fetch, obsidianFetch } from "./obsidian-fetch";
import { realSleep, retryOnceAfter, type Sleep } from "./retry-after";

const READWISE_API = "https://readwise.io/api/v2";

/** The `source_type` every item carries, and the value our books are listed by. */
export const READWISE_SOURCE = "tagged_sync";

/**
 * How long one readwise.io call may take before the sync stops waiting. The push is awaited on the
 * sync path, so a server that never answers must not be a sync that never ends. Thirty seconds: a
 * full batch of 1,000 highlights took 1.4 s in ticket 10, 20,000 took 15 s.
 */
export const READWISE_TIMEOUT_MS = 30_000;

/** At most this many highlights per create call (spec §11 P15); the push step batches. */
export const MAX_PUSH_BATCH = 1_000;

/** The largest page the list endpoints serve. LIST is limited to 20 calls a minute, so pages are as big as allowed. */
const PAGE_SIZE = 1_000;

/** A ceiling on paging, so a server that keeps answering `next` ends as an error rather than as a sync that never finishes. */
const MAX_PAGES = 100;

/**
 * - `rejected`: 401, the token was not accepted.
 * - `no-api`: 403, read as a plan without API access until spec §12 F5 is checked.
 * - `unreachable`: no answer, a timeout, 429/503 after the one allowed wait, 5xx, or an answer that is not what the API sends.
 * - `bad-request`: 400 without a per-item list (spec §6), so there is nothing to set aside.
 */
export type ReadwiseErrorKind = "rejected" | "no-api" | "unreachable" | "bad-request";

export class ReadwiseError extends Error {
	constructor(
		readonly kind: ReadwiseErrorKind,
		message: string,
	) {
		super(message);
		this.name = "ReadwiseError";
	}
}

/**
 * Where Readwise files a book: an EPUB under Books, anything else under Articles (user, 2026-11-02).
 * Not part of the book's key: a push with the other one moves the book (`research/20-category-check.ts`).
 */
export type ReadwiseCategory = "books" | "articles";

/** One highlight as the push sends it. `author` absent = omitted, never blank (ticket 14 #4). */
export interface ReadwiseItem {
	readonly title: string;
	readonly author?: string;
	readonly category: ReadwiseCategory;
	readonly text: string;
	/**
	 * Never `""`, which Readwise refuses. Absent clears the note Readwise holds, even on a re-push
	 * with the same text (ticket 15, F1) -- so a note that is to stay is sent again.
	 */
	readonly note?: string;
	readonly location: number;
	/** `highlight_url`: the update key in Readwise and the link back into the vault (spec §1.3). */
	readonly url: string;
}

export interface ReadwiseBookEntry {
	readonly id: number;
	readonly title: string;
	/** `null` is how Readwise answers for a book whose author we omitted (ticket 10). */
	readonly author: string | null;
}

export interface ReadwisePushedBook extends ReadwiseBookEntry {
	/** The highlights this call created or changed; an identical re-push is not among them (ticket 10 check 9). */
	readonly highlightIds: readonly number[];
}

export type ReadwisePushResult =
	| {
			readonly kind: "pushed";
			readonly books: readonly ReadwisePushedBook[];
			/** `highlight_url` → highlight id, only for books whose ids could be matched by send order (spec §11 P5). */
			readonly ids: ReadonlyMap<string, number>;
	  }
	/** A 400 with a per-item error list: nothing landed, and these items were the ones refused (spec §11 P13). */
	| { readonly kind: "refused"; readonly urls: readonly string[] };

export interface ReadwiseHighlightEntry {
	readonly id: number;
	/** Our `highlight_url`, or `null` for a highlight that has none. */
	readonly url: string | null;
}

export type ReadwiseCheck = "ok" | Exclude<ReadwiseErrorKind, "bad-request">;

export interface ReadwiseClient {
	/** `GET /auth/`, for the Connection line. Never throws. */
	check(): Promise<ReadwiseCheck>;
	/** Every book created with our `source_type`, all pages. A page that fails fails the listing, never a shorter list (spec §11 P24). */
	ourBooks(): Promise<ReadwiseBookEntry[]>;
	/** Creates or updates by `highlight_url`, at most {@link MAX_PUSH_BATCH} items. */
	push(items: readonly ReadwiseItem[]): Promise<ReadwisePushResult>;
	/** A book's highlights, all pages, for finding the id of one to delete. */
	bookHighlights(bookId: number): Promise<ReadwiseHighlightEntry[]>;
	/** Deletes one highlight. 404 counts as deleted: either way it is gone. */
	remove(highlightId: number): Promise<void>;
	/**
	 * Shows a book under the title and author the user gave it in Readwise. Every push resets both to
	 * the ones it sends -- which stay the book's key, since sending the user's title opens a second
	 * book -- so the push puts the user's names back afterwards (spec §11 P25, ticket 15).
	 */
	rename(bookId: number, names: ReadwiseNames): Promise<void>;
}

/** What `rename` sets; a field left out is left as it is. */
export interface ReadwiseNames {
	readonly title?: string;
	readonly author?: string;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** `{"author": ["This field may not be blank."]}`: field names, each with what is wrong with it. `{}` is an item that was fine. */
function isFieldErrors(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const reasons = Object.values(value);
	return reasons.length > 0 && reasons.every(Array.isArray);
}

function failure(status: number, what: string): ReadwiseError {
	if (status === 401) return new ReadwiseError("rejected", "Readwise did not accept the access token.");
	if (status === 403) return new ReadwiseError("no-api", "Readwise refused API access for this account.");
	return new ReadwiseError("unreachable", `readwise.io answered ${status} ${what}.`);
}

function bookEntry(value: unknown): ReadwiseBookEntry | null {
	if (!isRecord(value) || typeof value.id !== "number" || typeof value.title !== "string") return null;
	return { id: value.id, title: value.title, author: typeof value.author === "string" ? value.author : null };
}

/**
 * Ids by send order, per book, where the count allows it (spec §11 P5): Readwise lists a book's
 * `modified_highlights` in the order they were sent (ticket 10), but leaves out an identical
 * re-push, and then the order no longer says which id is whose.
 */
function idsBySendOrder(items: readonly ReadwiseItem[], books: readonly ReadwisePushedBook[]): Map<string, number> {
	const ids = new Map<string, number>();
	for (const book of books) {
		const sent = items.filter((item) => item.title === book.title && (item.author ?? null) === book.author);
		if (sent.length !== book.highlightIds.length) continue;
		sent.forEach((item, index) => ids.set(item.url, book.highlightIds[index]));
	}
	return ids;
}

export function createReadwiseClient(
	token: string,
	fetchImpl: Fetch = obsidianFetch,
	sleep: Sleep = realSleep,
	timeoutMs: number = READWISE_TIMEOUT_MS,
): ReadwiseClient {
	const send = async (url: string, init: RequestInit): Promise<Response> => {
		const headers = { Authorization: `Token ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) };
		try {
			return await withTimeout(fetchImpl(url, { ...init, headers }), timeoutMs);
		} catch {
			throw new ReadwiseError("unreachable", "Could not reach readwise.io.");
		}
	};

	const request = async (url: string, init: RequestInit = {}): Promise<Response> => await retryOnceAfter(() => send(url, init), sleep);

	/**
	 * Every page of a list endpoint. `next` is followed only while it stays on readwise.io: the token
	 * goes with every request, and an answer pointing elsewhere is not one to hand it to.
	 */
	const listAll = async (first: string, what: string): Promise<unknown[]> => {
		const results: unknown[] = [];
		let url: string | null = first;
		for (let page = 0; url !== null; page++) {
			if (page === MAX_PAGES) throw new ReadwiseError("unreachable", `readwise.io kept paging past ${MAX_PAGES} pages of ${what}.`);
			const response = await request(url);
			if (!response.ok) throw failure(response.status, `when listing ${what}`);
			const body: unknown = await response.json().catch(() => null);
			if (!isRecord(body) || !Array.isArray(body.results)) throw new ReadwiseError("unreachable", `readwise.io sent a listing of ${what} that is not one.`);
			const listed: unknown[] = body.results;
			results.push(...listed);
			const next = body.next;
			if (next !== null && next !== undefined && (typeof next !== "string" || !next.startsWith(`${READWISE_API}/`))) {
				throw new ReadwiseError("unreachable", `readwise.io pointed the listing of ${what} somewhere else.`);
			}
			url = next ?? null;
		}
		return results;
	};

	const entries = <T>(values: unknown[], read: (value: unknown) => T | null, what: string): T[] =>
		values.map((value) => {
			const entry = read(value);
			if (entry === null) throw new ReadwiseError("unreachable", `readwise.io sent ${what} that is not one.`);
			return entry;
		});

	return {
		async check() {
			let response: Response;
			try {
				response = await request(`${READWISE_API}/auth/`);
			} catch {
				return "unreachable";
			}
			if (response.ok) return "ok";
			if (response.status === 401) return "rejected";
			return response.status === 403 ? "no-api" : "unreachable";
		},

		async ourBooks() {
			const books = await listAll(`${READWISE_API}/books/?source=${READWISE_SOURCE}&page_size=${PAGE_SIZE}`, "books");
			return entries(books, bookEntry, "a book");
		},

		async push(items) {
			if (items.length > MAX_PUSH_BATCH) throw new RangeError(`at most ${MAX_PUSH_BATCH} highlights per call, not ${items.length}`);
			const highlights = items.map((item) => ({
				text: item.text,
				title: item.title,
				...(item.author === undefined ? {} : { author: item.author }),
				...(item.note === undefined ? {} : { note: item.note }),
				category: item.category,
				source_type: READWISE_SOURCE,
				location: item.location,
				location_type: "page",
				highlight_url: item.url,
			}));
			const response = await request(`${READWISE_API}/highlights/`, { method: "POST", body: JSON.stringify({ highlights }) });

			if (response.status === 400) {
				// Validation is all or nothing (ticket 10): one entry per item sent, `{}` for the ones that
				// were fine. A call of one item gets that item's entry alone, not a list of one (ticket 15).
				const body: unknown = await response.json().catch(() => null);
				const perItem = Array.isArray(body) ? body : items.length === 1 && isFieldErrors(body) ? [body] : null;
				const urls = perItem?.length === items.length ? items.filter((_item, index) => isFieldErrors(perItem[index])).map((item) => item.url) : [];
				if (urls.length === 0) throw new ReadwiseError("bad-request", "readwise.io refused the highlights without saying which.");
				return { kind: "refused", urls };
			}
			if (!response.ok) throw failure(response.status, "when sent highlights");

			// It landed. An answer we cannot read costs the ids, not the push (spec §11 P5).
			const body: unknown = await response.json().catch(() => null);
			const books = (Array.isArray(body) ? body : []).flatMap((value): ReadwisePushedBook[] => {
				const book = bookEntry(value);
				if (book === null || !isRecord(value)) return [];
				const modified = Array.isArray(value.modified_highlights) ? value.modified_highlights : [];
				return [{ ...book, highlightIds: modified.filter((id): id is number => typeof id === "number") }];
			});
			return { kind: "pushed", books, ids: idsBySendOrder(items, books) };
		},

		async bookHighlights(bookId) {
			const highlights = await listAll(`${READWISE_API}/highlights/?book_id=${bookId}&page_size=${PAGE_SIZE}`, "highlights");
			return entries(
				highlights,
				(value) => (isRecord(value) && typeof value.id === "number" ? { id: value.id, url: typeof value.url === "string" ? value.url : null } : null),
				"a highlight",
			);
		},

		async remove(highlightId) {
			const response = await request(`${READWISE_API}/highlights/${highlightId}/`, { method: "DELETE" });
			if (response.ok || response.status === 404) return;
			throw failure(response.status, "when asked to delete a highlight");
		},

		async rename(bookId, { title, author }) {
			const body = { ...(title === undefined ? {} : { title_override: title }), ...(author === undefined ? {} : { author_override: author }) };
			const response = await request(`${READWISE_API}/books/${bookId}/`, { method: "PATCH", body: JSON.stringify(body) });
			if (!response.ok) throw failure(response.status, "when asked to rename a book");
		},
	};
}
