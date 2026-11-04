import { rowForNotePath } from "./note-rename";
import { bookIdOf, readwiseBook, type StoredReadwiseBooks } from "./readwise-state";

/** What the commands need of a sync index row. */
interface NoteRow {
	readonly docId: string;
	readonly notePath: string;
	readonly status: string;
}

/**
 * *Open in Readwise* for the note at `notePath` (spec §7): its document's book, or `null` for a note
 * never pushed, a book whose id is not known yet, or one deleted in Readwise.
 */
export function readwiseBookUrl(rows: Record<string, NoteRow>, books: StoredReadwiseBooks, notePath: string): string | null {
	const row = rowForNotePath(rows, notePath);
	const bookId = row === undefined ? undefined : bookIdOf(books, row.docId);
	return bookId === undefined ? null : `https://readwise.io/bookreview/${bookId}`;
}

/** *Push to Readwise again* for the note at `notePath` (ticket 22): its document, when that document's book was deleted in Readwise, else `null`. */
export function deletedBookOf(rows: Record<string, NoteRow>, books: StoredReadwiseBooks, notePath: string): string | null {
	const row = rowForNotePath(rows, notePath);
	return row !== undefined && readwiseBook(books, row.docId)?.deleted ? row.docId : null;
}
