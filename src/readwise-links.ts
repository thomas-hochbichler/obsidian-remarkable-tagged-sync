import { digestId } from "./digest-builder";
import { rowForNotePath } from "./note-rename";
import { pageIdOf } from "./readwise-highlights";
import { bookIdOf, type StoredReadwiseBooks } from "./readwise-state";

/** What the link back needs of a sync index row. */
interface NoteRow {
	readonly docId: string;
	readonly pageId: string | null;
	readonly notePath: string;
	readonly status: string;
}

/** Said when a link from Readwise finds no note to open (spec §7). */
export const HIGHLIGHT_NOTE_GONE_NOTICE = "This highlight's note is no longer in this vault.";

/** A note in the vault, as the caller found it at a row's path, and the `^block` ids it carries. */
export interface FoundNote<Note> {
	readonly note: Note;
	readonly blocks: readonly string[];
}

/** Where a Readwise highlight's link opens: a note, at the block of the entry when the note carries it. */
export interface LinkedNote<Note> {
	readonly note: Note;
	readonly block: string | null;
}

/**
 * The note a `highlight=<docId>/<pageId>:<crdtId>` value opens (spec §7), or `null` when the value
 * is not one of ours or no active note of that document is left.
 *
 * The document is everything before the first `/`, the page everything before the key's first `:`
 * (spec §1.3). The whole-document note comes first, then the page note; of those still in the vault
 * (`find` answers `null` for a note deleted by hand), the first that carries the entry's block
 * wins -- `hl-` or `nt-`, the key cannot tell a highlight from a margin note -- and with none
 * carrying it the first note opens at its top.
 */
export function linkedNote<Note>(rows: Record<string, NoteRow>, value: string, find: (notePath: string) => FoundNote<Note> | null): LinkedNote<Note> | null {
	const slash = value.indexOf("/");
	const docId = value.slice(0, slash);
	const key = value.slice(slash + 1);
	const pageId = pageIdOf(key);
	const crdtId = key.slice(pageId.length + 1);
	if (slash < 1 || !key.includes(":") || pageId === "" || crdtId === "") return null;
	const active = Object.values(rows).filter((row) => row.docId === docId && row.status === "active");
	const notes = [...active.filter((row) => row.pageId === null), ...active.filter((row) => row.pageId === pageId)].flatMap((row) => find(row.notePath) ?? []);
	const ids = [digestId("hl", pageId, crdtId), digestId("nt", pageId, crdtId)];
	for (const { note, blocks } of notes) {
		const block = ids.find((id) => blocks.includes(id));
		if (block !== undefined) return { note, block };
	}
	return notes.length === 0 ? null : { note: notes[0].note, block: null };
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
