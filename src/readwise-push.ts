/**
 * The Readwise half of a sync (Readwise spec §4): the unit write records what Readwise should hold,
 * with no network, and one push per sync attempt sends what is pending.
 */

import type { DigestPage } from "./digest-builder";
import type { Entitlement } from "./licence-state";
import { bookIdentity, type BookIdentity, type BookSources } from "./readwise-book";
import { MAX_PUSH_BATCH, type ReadwiseBookEntry, type ReadwiseClient, ReadwiseError, type ReadwiseErrorKind, type ReadwiseItem, type ReadwisePushResult } from "./readwise-client";
import { highlightUrl, readwiseHighlights } from "./readwise-highlights";
import {
	liveBooks,
	pendingDocuments,
	pendingItems,
	type ReadwiseBook,
	readwiseBook,
	type ReadwiseHighlight,
	type ReadwiseText,
	recordUnit,
	type RecordScope,
	type ReadwiseSettings,
	type StoredReadwiseBooks,
	withBook,
} from "./readwise-state";
import { invalidateRenders, type SyncIndex } from "./sync-engine";

/** One written unit with a digest, as the engine hands it to the recorder (spec §4.2). */
export interface ReadwiseUnit {
	readonly docId: string;
	/** The unit's digest entries. */
	readonly pages: readonly DigestPage[];
	readonly scope: RecordScope;
	/** The document's page order for a typed document or a notebook's typed pages; null for a PDF or an EPUB (spec §11 P8). */
	readonly pageOrder: readonly string[] | null;
	/** The vault's *margin notes* setting, which the digest was built under. */
	readonly marginNotes: boolean;
	/**
	 * What may name the book. Asked only for a document with no book yet, because the name is frozen
	 * at the first record (spec §11 P21) and an EPUB's costs a download.
	 */
	readonly sources: () => Promise<BookSources>;
}

/** The record step, absent from the engine while recording is off (no Pro, or the switch off). */
export interface ReadwiseRecorder {
	record(unit: ReadwiseUnit): Promise<void>;
}

/** Where the recorder keeps `readwiseBooks`: the plugin's data, saved by the run's own checkpoint after each unit. */
export interface RecorderHost {
	books(): StoredReadwiseBooks;
	setBooks(books: StoredReadwiseBooks): void;
}

/** The gate: pushing to Readwise is Pro (ticket 06 #4). */
export function readwiseProAllowed(entitlement: Entitlement): boolean {
	return entitlement.tier !== "free";
}

/** Recording is on with Pro and the switch on; a token is not needed to record (spec §11 P2). */
export function readwiseRecordingOn(settings: ReadwiseSettings, entitlement: Entitlement): boolean {
	return settings.push && readwiseProAllowed(entitlement);
}

/** The engine's recorder for this run, or absent while recording is off -- which is the whole of "refused in place". */
export function readwiseRecorderFor(settings: ReadwiseSettings, entitlement: Entitlement, host: RecorderHost): ReadwiseRecorder | undefined {
	return readwiseRecordingOn(settings, entitlement) ? createReadwiseRecorder(host) : undefined;
}

/** What `recordUnit` is handed for a document that already has its book, whose name it never reads again. */
const NAME_NOT_READ: BookIdentity = { title: "" };

export function createReadwiseRecorder(host: RecorderHost): ReadwiseRecorder {
	return {
		async record({ docId, pages, scope, pageOrder, marginNotes, sources }) {
			const identity = host.books()[docId] === undefined ? bookIdentity(await sources()) : NAME_NOT_READ;
			const items = readwiseHighlights(pages, docId, pageOrder);
			host.setBooks(recordUnit(host.books(), docId, { items, scope, identity, marginNotes }));
		},
	};
}

/** The part of the plugin's data the push reads and writes (spec §3). Changed in place; the caller saves once. */
export interface ReadwiseData {
	readwiseBooks: StoredReadwiseBooks;
	readwiseAccount?: string;
	readwiseAccountBefore?: string;
	readwiseAccountClash?: true;
	readwiseRecording?: true;
}

/** Why a push stopped: an answer of readwise.io, or two computers pushing to two accounts (spec §11 P4). */
export type PushFailure = ReadwiseErrorKind | "clash";

/**
 * The start of every sync (spec §5). Recording on and not yet started -- switched on, Pro gained or
 * regained, state dropped for another account -- makes every active document due once, so each digest
 * is rebuilt and recorded; the flag and the invalidation go into `data` together, never the flag alone.
 * Recording off forgets the flag, so switching back on backfills again. True when `data` changed and
 * must be saved now: when opening the source throws, nothing else saves it.
 */
export function startReadwiseRecording(data: { syncIndex: SyncIndex; readwiseRecording?: true }, on: boolean): boolean {
	if (!on) {
		if (!data.readwiseRecording) return false;
		delete data.readwiseRecording;
		return true;
	}
	if (data.readwiseRecording) return false;
	// Every active row: a typed document or a mixed notebook looks like any notebook row, so the rows
	// with a digest cannot be picked out. Notebooks cost a render; margin notes are read again (§11 P3).
	data.syncIndex = invalidateRenders(data.syncIndex);
	data.readwiseRecording = true;
	return true;
}

/** Which account a token belongs to, as far as the state can tell: 12 hex of its SHA-256 (spec §11 P4). Never the token. */
export async function tokenFingerprint(token: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
	return Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The notice for a push that stopped (spec §6), or null. Said only on a sync the user started (§11 P17); the caller decides. */
export function readwiseNotice(failure: PushFailure | null, books: StoredReadwiseBooks): string | null {
	switch (failure) {
		case null:
			return null;
		case "rejected":
			return "Readwise: the access token was not accepted — paste a new one in Settings → Tagged Sync → Readwise.";
		case "no-api":
			return "Readwise: your plan doesn't include API access, so nothing was pushed.";
		case "clash":
			return "Readwise: this computer and another push to different accounts, so nothing was pushed.";
		case "unreachable":
		case "bad-request": {
			const waiting = pendingDocuments(books).length;
			return waiting === 0 ? null : `Readwise: ${waiting} document${waiting === 1 ? "" : "s"} not pushed — will retry next sync.`;
		}
	}
}

/** Is there anything to send: a change, or a book still owed the user's names (spec §4.3 step 4b)? */
function hasWork(books: StoredReadwiseBooks): boolean {
	return liveBooks(books).some(([, book]) => pendingItems(book).length > 0 || (book.shown?.owed === true && book.bookId !== undefined));
}

/**
 * Sends what is pending (spec §4.3): the account check, books deleted in Readwise and the user's names
 * for a book, deletes, then creates and updates, then the names put back. Stops at the first error;
 * whatever landed is recorded in `data`, the rest stays pending for the next sync.
 *
 * The caller holds the run lock, so no unit is recorded meanwhile, and saves `data` once afterwards.
 */
export async function pushToReadwise(data: ReadwiseData, client: ReadwiseClient, fingerprint: string): Promise<PushFailure | null> {
	if (data.readwiseAccountClash) {
		if (fingerprint === data.readwiseAccount || fingerprint === data.readwiseAccountBefore) return "clash";
		delete data.readwiseAccountClash;
	}
	if (fingerprint === data.readwiseAccount && !hasWork(data.readwiseBooks)) return null;
	try {
		let listing: ReadwiseBookEntry[] | null = null;
		if (fingerprint !== data.readwiseAccount) {
			const known = liveBooks(data.readwiseBooks).flatMap(([, book]) => (book.bookId === undefined ? [] : [book.bookId]));
			// With no fingerprint stored or no book id remembered there is nothing to compare: the state stays --
			// unless this is the fingerprint the state was just dropped for, whose computer would otherwise
			// backfill it back before the other one has pushed anything to compare (spec §11 P4).
			if (data.readwiseAccount !== undefined && known.length > 0) {
				listing = await client.ourBooks();
				const listed = new Set(listing.map((entry) => entry.id));
				if (!known.some((id) => listed.has(id))) return switchAccount(data, fingerprint);
			} else if (fingerprint === data.readwiseAccountBefore) {
				return switchAccount(data, fingerprint);
			}
			data.readwiseAccount = fingerprint;
		}
		if (!hasWork(data.readwiseBooks)) return null;
		// Without the listing a push would recreate a book the user deleted (spec §11 P24).
		readListing(data, listing ?? (await client.ourBooks()));
		await sendDeletes(data, client);
		await sendTexts(data, client);
		await putNamesBack(data, client);
		return null;
	} catch (error) {
		if (error instanceof ReadwiseError) return error.kind;
		throw error;
	}
}

/**
 * None of our books is in this token's account. Back to the fingerprint the state was dropped for on
 * the last switch, it is two computers on two accounts: stopped, not backfilled each way. Otherwise it
 * is a switch: the state goes, and the next sync's backfill (spec §5) pushes everything there.
 */
function switchAccount(data: ReadwiseData, fingerprint: string): PushFailure | null {
	if (fingerprint === data.readwiseAccountBefore) {
		data.readwiseAccountClash = true;
		return "clash";
	}
	data.readwiseBooks = {};
	delete data.readwiseRecording;
	data.readwiseAccountBefore = data.readwiseAccount;
	data.readwiseAccount = fingerprint;
	return null;
}

function put(data: ReadwiseData, docId: string, book: ReadwiseBook): void {
	data.readwiseBooks = withBook(data.readwiseBooks, docId, book);
}

/** A record with nothing pending. */
function settled({ want: _sent, rejected: _cleared, ...record }: ReadwiseHighlight): ReadwiseHighlight {
	return record;
}

/**
 * Step 2: a remembered book the listing does not have was deleted in Readwise (ticket 14 #2); one it
 * has tells the names the user gave it there (spec §11 P25). A blank author listed where ours is set
 * counts as ours: a blank cannot be put back.
 */
function readListing(data: ReadwiseData, listing: readonly ReadwiseBookEntry[]): void {
	const byId = new Map(listing.map((entry) => [entry.id, entry]));
	for (const [docId, book] of liveBooks(data.readwiseBooks)) {
		if (book.bookId === undefined) continue;
		const entry = byId.get(book.bookId);
		if (entry === undefined) {
			const kept = Object.entries(book.highlights).flatMap(([key, record]) => (record.pushed ? [[key, settled(record)] as const] : []));
			put(data, docId, { ...book, deleted: true, highlights: Object.fromEntries(kept) });
			continue;
		}
		const title = entry.title === book.title ? undefined : entry.title;
		const author = entry.author === null || entry.author === book.author ? undefined : entry.author;
		const { shown: _shown, ...unnamed } = book;
		// Readwise shows the user's names right now, so nothing is owed; ours again ends what was owed unless a push reset them.
		if (title !== undefined || author !== undefined) put(data, docId, { ...book, shown: { ...(title === undefined ? {} : { title }), ...(author === undefined ? {} : { author }) } });
		else if (!book.shown?.owed) put(data, docId, unnamed);
	}
}

/**
 * Step 3, before any create: every erased highlight. 204 and 404 both mean gone. One whose id was
 * never learnt is looked up in its book's listing; not there, it is gone already. In a book whose id
 * was never learnt it cannot be addressed and is let go: it stays in Readwise (accepted, spec §4.3).
 */
async function sendDeletes(data: ReadwiseData, client: ReadwiseClient): Promise<void> {
	for (const [docId, book] of liveBooks(data.readwiseBooks)) {
		const erased = pendingItems(book).filter(([, record]) => record.want === null);
		let ids: Map<string | null, number> | null = null;
		const highlights = { ...book.highlights };
		for (const [key, record] of erased) {
			let id = record.id;
			if (id === undefined && book.bookId !== undefined) {
				ids ??= new Map((await client.bookHighlights(book.bookId)).map((entry) => [entry.url, entry.id]));
				id = ids.get(highlightUrl(docId, key));
			}
			if (id !== undefined) await client.remove(id);
			delete highlights[key];
			put(data, docId, { ...book, highlights });
		}
	}
}

interface Outgoing {
	readonly docId: string;
	readonly key: string;
	readonly want: ReadwiseText;
	readonly item: ReadwiseItem;
}

/** Every pending text. The deletes before it have left no `want: null` behind. */
function outgoing(data: ReadwiseData): Outgoing[] {
	return liveBooks(data.readwiseBooks).flatMap(([docId, book]) =>
		pendingItems(book)
			.filter((entry): entry is [string, { want: ReadwiseText }] => entry[1].want != null)
			.map(([key, { want }]) => {
				const item: ReadwiseItem = {
					title: book.title,
					...(book.author === undefined ? {} : { author: book.author }),
					text: want.text,
					...(want.note === undefined ? {} : { note: want.note }),
					location: want.location,
					url: highlightUrl(docId, key),
				};
				return { docId, key, want, item };
			}),
	);
}

/** A book the push has just read from the state: it stays readable while the push runs. */
function bookOf(data: ReadwiseData, docId: string): ReadwiseBook {
	return readwiseBook(data.readwiseBooks, docId)!;
}

/**
 * Step 4: every pending text, at most {@link MAX_PUSH_BATCH} per call. Items Readwise refuses are set
 * aside until they change on the tablet (spec §11 P13) and the rest sent once more; a second refusal stops.
 */
async function sendTexts(data: ReadwiseData, client: ReadwiseClient): Promise<void> {
	const all = outgoing(data);
	for (let start = 0; start < all.length; start += MAX_PUSH_BATCH) {
		let batch = all.slice(start, start + MAX_PUSH_BATCH);
		let result = await client.push(batch.map(({ item }) => item));
		if (result.kind === "refused") {
			const refused = new Set(result.urls);
			for (const { docId, key, want } of batch.filter(({ item }) => refused.has(item.url))) {
				const book = bookOf(data, docId);
				put(data, docId, { ...book, highlights: { ...book.highlights, [key]: { ...book.highlights[key], rejected: want } } });
			}
			batch = batch.filter(({ item }) => !refused.has(item.url));
			if (batch.length === 0) continue;
			result = await client.push(batch.map(({ item }) => item));
			if (result.kind === "refused") throw new ReadwiseError("bad-request", "readwise.io refused highlights it had accepted a moment before.");
		}
		land(data, batch, result);
	}
}

/** What a create that landed means for the state: pushed, whether or not the ids could be matched (spec §11 P5). */
function land(data: ReadwiseData, batch: readonly Outgoing[], result: Extract<ReadwisePushResult, { kind: "pushed" }>): void {
	for (const { docId, key, want, item } of batch) {
		const book = bookOf(data, docId);
		const id = result.ids.get(item.url) ?? book.highlights[key].id;
		const bookId = book.bookId ?? result.books.find((entry) => entry.title === book.title && entry.author === (book.author ?? null))?.id;
		put(data, docId, {
			...book,
			...(bookId === undefined ? {} : { bookId }),
			// The push reset the user's names to ours: they are owed until step 4b puts them back.
			...(book.shown ? { shown: { ...book.shown, owed: true as const } } : {}),
			highlights: { ...book.highlights, [key]: { ...settled(book.highlights[key]), pushed: want, ...(id === undefined ? {} : { id }) } },
		});
	}
}

/** Step 4b: the user's names back on every book owed them. A failure keeps them owed for the next push, without a notice. */
async function putNamesBack(data: ReadwiseData, client: ReadwiseClient): Promise<void> {
	for (const [docId, book] of liveBooks(data.readwiseBooks)) {
		if (!book.shown?.owed || book.bookId === undefined) continue;
		const { owed: _owed, ...names } = book.shown;
		try {
			await client.rename(book.bookId, names);
		} catch (error) {
			if (error instanceof ReadwiseError) continue;
			throw error;
		}
		put(data, docId, { ...book, shown: names });
	}
}
