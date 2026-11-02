/**
 * What Readwise should hold from us, per reMarkable document, and what it already does (Readwise
 * spec §3, §4.2). Pure. The unit write records into it with no network; the push step (ticket 19)
 * sends what is pending.
 *
 * `data.json` is shared between installs and versions, so the map is carried through the settings
 * migration opaquely and read one book at a time, here, like `zotero-links.ts`: a book this build
 * cannot read stays in the file exactly as it is.
 */

import type { BookIdentity } from "./readwise-book";
import type { ReadwiseEntry } from "./readwise-highlights";

/** The settings rows of spec §2. */
export interface ReadwiseSettings {
	/** *Push highlights to Readwise*. */
	readonly push: boolean;
	/** The Keychain entry's name (Obsidian's `SecretComponent`), never the token itself. */
	readonly tokenSecret: string | null;
}

export const DEFAULT_READWISE_SETTINGS: ReadwiseSettings = { push: false, tokenSecret: null };

/** The whole map, as `data.json` carries it: reMarkable document uuid -> a book this build may or may not read. */
export type StoredReadwiseBooks = Record<string, unknown>;

/** One highlight's content, compared whole (spec §4.2). */
export interface ReadwiseText {
	readonly text: string;
	/** Absent = no note; never `""`, which Readwise refuses. */
	readonly note?: string;
	readonly location: number;
}

export interface ReadwiseHighlight {
	/** What Readwise holds from us; absent = never landed. */
	readonly pushed?: ReadwiseText;
	/** Readwise's highlight id, once known (spec §11 P5, best effort). */
	readonly id?: number;
	/** Pending: a text to push, or `null` = delete; absent = nothing pending. */
	readonly want?: ReadwiseText | null;
	/** What Readwise refused with a 400 (spec §11 P13); set aside while `want` equals it. */
	readonly rejected?: ReadwiseText;
	/** A margin note of its own or an added page, not a highlight: left alone while margin notes are off (spec §11 P20). */
	readonly margin?: true;
}

export interface ReadwiseBook {
	/** Frozen at the first record (spec §11 P21): with the author, the book's key in Readwise. */
	readonly title: string;
	/** Frozen likewise; absent = omitted. */
	readonly author?: string;
	readonly bookId?: number;
	/** Deleted in Readwise: never recorded into or pushed again (ticket 14 #2). */
	readonly deleted?: true;
	/** The names the user gave the book in Readwise (spec §11 P25). Written by the push, never by the recorder. */
	readonly shown?: { readonly title?: string; readonly author?: string; readonly owed?: true };
	/** Key `pageId:crdtId` (spec §1.3) -> its record. */
	readonly highlights: Record<string, ReadwiseHighlight>;
}

/**
 * Which stored records a unit speaks for (spec §4.2): a whole-document unit every record of the
 * book, a page-tag unit those of its one page, a failed digest build none.
 */
export type RecordScope = "document" | { readonly pageId: string } | "none";

export interface RecordedUnit {
	/** The unit's digest as Readwise should hold it (`readwiseHighlights`). */
	readonly items: readonly ReadwiseEntry[];
	readonly scope: RecordScope;
	/** The book a new document becomes; ignored once the document has one. */
	readonly identity: BookIdentity;
	/** The vault's *margin notes* setting. */
	readonly marginNotes: boolean;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function readText(value: unknown): ReadwiseText | undefined {
	const stored = asRecord(value);
	if (stored === null || typeof stored.text !== "string" || !Number.isInteger(stored.location)) return undefined;
	const note = typeof stored.note === "string" && stored.note !== "" ? stored.note : undefined;
	return { text: stored.text, ...(note === undefined ? {} : { note }), location: stored.location as number };
}

function readHighlight(value: unknown): ReadwiseHighlight | null {
	const stored = asRecord(value);
	if (stored === null) return null;
	const pushed = readText(stored.pushed);
	const want = stored.want === null ? null : readText(stored.want);
	const rejected = readText(stored.rejected);
	return {
		...(pushed === undefined ? {} : { pushed }),
		...(typeof stored.id === "number" ? { id: stored.id } : {}),
		...(want === undefined ? {} : { want }),
		...(rejected === undefined ? {} : { rejected }),
		...(stored.margin === true ? { margin: true as const } : {}),
	};
}

/** One document's book, or `null` when it has none this build can read. */
export function readwiseBook(books: StoredReadwiseBooks, docId: string): ReadwiseBook | null {
	const stored = asRecord(books[docId]);
	if (stored === null || typeof stored.title !== "string" || stored.title === "") return null;
	const highlights: Record<string, ReadwiseHighlight> = {};
	for (const [key, value] of Object.entries(asRecord(stored.highlights) ?? {})) {
		const highlight = readHighlight(value);
		if (highlight !== null) highlights[key] = highlight;
	}
	const shown = asRecord(stored.shown);
	return {
		title: stored.title,
		...(typeof stored.author === "string" && stored.author !== "" ? { author: stored.author } : {}),
		...(typeof stored.bookId === "number" ? { bookId: stored.bookId } : {}),
		...(stored.deleted === true ? { deleted: true as const } : {}),
		...(shown === null
			? {}
			: {
					shown: {
						...(typeof shown.title === "string" ? { title: shown.title } : {}),
						...(typeof shown.author === "string" ? { author: shown.author } : {}),
						...(shown.owed === true ? { owed: true as const } : {}),
					},
				}),
		highlights,
	};
}

function sameText(a: ReadwiseText | null | undefined, b: ReadwiseText | null | undefined): boolean {
	return a != null && b != null && a.text === b.text && a.note === b.note && a.location === b.location;
}

/** The record holding `text` from now on (spec §4.2). */
function wanting(record: ReadwiseHighlight | undefined, text: ReadwiseText): ReadwiseHighlight {
	// The tablet is back to what Readwise holds: whatever was pending is void, a delete included.
	if (record?.pushed && sameText(record.pushed, text)) {
		const { want: _void, rejected: _cleared, ...rest } = record;
		return rest;
	}
	return { ...record, want: text };
}

/** The page a key belongs to: everything before its first colon (spec §1.3). */
function pageIdOf(key: string): string {
	return key.slice(0, key.indexOf(":"));
}

/** Does the unit speak for this record? With margin notes off, never for a note or an added page (spec §11 P20). */
function covers({ scope, marginNotes }: RecordedUnit, key: string, record: ReadwiseHighlight): boolean {
	if (scope === "none" || (record.margin && !marginNotes)) return false;
	return scope === "document" || scope.pageId === pageIdOf(key);
}

/**
 * The note a highlight keeps when the tablet's says nothing -- its nested note unread, or margin
 * notes off (spec §4.2): the latest one known, a pending one before the one Readwise holds.
 */
function storedNote(record: ReadwiseHighlight | undefined): string | undefined {
	return (record?.want ?? record?.pushed)?.note;
}

/** Readwise's limits on a book's name, in characters (research 01 §1). */
const TITLE_LIMIT = 511;
const AUTHOR_LIMIT = 1024;

/** `value` cut to `limit` characters, ending in "…" (spec §11 P9). */
function cut(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * A new document's book (spec §11 P6, P9, P21): its name cut to Readwise's limits and numbered past
 * every other book of this vault with the same title and author -- deleted ones too, which still
 * exist in Readwise -- because Readwise files highlights by title and author.
 */
function newBook(books: StoredReadwiseBooks, docId: string, { title, author }: BookIdentity): ReadwiseBook {
	const named = author === undefined ? {} : { author: cut(author, AUTHOR_LIMIT) };
	const taken = new Set(
		Object.keys(books)
			.filter((other) => other !== docId)
			.map((other) => readwiseBook(books, other))
			.filter((book) => book !== null && book.author === named.author)
			.map((book) => book?.title),
	);
	let unique = cut(title, TITLE_LIMIT);
	for (let n = 2; taken.has(unique); n++) unique = `${cut(title, TITLE_LIMIT - ` (${n})`.length)} (${n})`;
	return { title: unique, ...named, highlights: {} };
}

/** Every book with one document's unit recorded into it (spec §4.2). */
export function recordUnit(books: StoredReadwiseBooks, docId: string, unit: RecordedUnit): StoredReadwiseBooks {
	const book = readwiseBook(books, docId) ?? newBook(books, docId, unit.identity);
	if (book.deleted) return books;
	const highlights = { ...book.highlights };
	const seen = new Set<string>();
	for (const item of unit.items) {
		seen.add(item.key);
		if (item.unread) continue;
		const record = highlights[item.key];
		const note = item.margin || (unit.marginNotes && !item.noteUnread) ? item.note : storedNote(record);
		const wanted = wanting(record, { text: item.text, ...(note === undefined ? {} : { note }), location: item.location });
		highlights[item.key] = item.margin ? { ...wanted, margin: true } : wanted;
	}
	for (const [key, record] of Object.entries(highlights)) {
		if (seen.has(key) || !covers(unit, key, record)) continue;
		if (record.pushed) highlights[key] = { ...record, want: null };
		else delete highlights[key];
	}
	// A document with nothing to record has no name yet: the first record freezes it.
	const stored = asRecord(books[docId]);
	if (stored === null && Object.keys(highlights).length === 0) return books;
	// What a newer build wrote stays: unknown fields of the book, and records this one cannot read.
	const unreadable = Object.entries(asRecord(stored?.highlights) ?? {}).filter(([, value]) => readHighlight(value) === null);
	return { ...books, [docId]: { ...stored, ...book, highlights: { ...Object.fromEntries(unreadable), ...highlights } } };
}

/** Is something waiting to be pushed: a text, or a delete? A text Readwise refused is not, until it changes (spec §11 P13). */
export function isPending({ want, rejected }: ReadwiseHighlight): boolean {
	return want === null || (want !== undefined && !sameText(want, rejected));
}

/** Set aside: what the tablet shows is what Readwise refused. */
function isSetAside({ want, rejected }: ReadwiseHighlight): boolean {
	return sameText(want, rejected);
}

/** Every readable book not deleted in Readwise, by document. */
function liveBooks(books: StoredReadwiseBooks): [string, ReadwiseBook][] {
	return Object.keys(books).flatMap((docId): [string, ReadwiseBook][] => {
		const book = readwiseBook(books, docId);
		return book === null || book.deleted ? [] : [[docId, book]];
	});
}

/** The documents with something waiting to be pushed. A book deleted in Readwise never has. */
export function pendingDocuments(books: StoredReadwiseBooks): string[] {
	return liveBooks(books)
		.filter(([, book]) => Object.values(book.highlights).some(isPending))
		.map(([docId]) => docId);
}

/** For the Connection line (spec §2.1): from the state, never from Readwise. */
export function readwiseCounts(books: StoredReadwiseBooks): { books: number; highlights: number; setAside: number } {
	const records = liveBooks(books).map(([, book]) => Object.values(book.highlights));
	return {
		books: records.filter((highlights) => highlights.some((record) => record.pushed)).length,
		highlights: records.flat().filter((record) => record.pushed).length,
		setAside: records.flat().filter(isSetAside).length,
	};
}

/** The document's book in Readwise, when it is known and not deleted there (*Open in Readwise*, spec §7). */
export function bookIdOf(books: StoredReadwiseBooks, docId: string): number | undefined {
	const book = readwiseBook(books, docId);
	return book?.deleted ? undefined : book?.bookId;
}
