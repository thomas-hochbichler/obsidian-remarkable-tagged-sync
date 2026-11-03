import { digestId } from "./digest-builder";
import { rowForNotePath } from "./note-rename";
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

/** Where a Readwise highlight's link opens: a note, at the block of the entry when the note carries it. */
export interface LinkedNote {
	readonly notePath: string;
	readonly block: string | null;
}

/**
 * The note a `highlight=<docId>/<pageId>:<crdtId>` value opens (spec §7), or `null` when the value
 * is not one of ours or no active note of that document is left.
 *
 * The document is everything before the first `/`, the page everything before the key's first `:`
 * (spec §1.3). The whole-document note comes first, then the page note; of those still in the vault
 * (`blocksIn` answers `null` for a note deleted by hand), the first that carries the entry's block
 * wins -- `hl-` or `nt-`, the key cannot tell a highlight from a margin note -- and with none
 * carrying it the first note opens at its top.
 */
export function linkedNote(rows: Record<string, NoteRow>, value: string, blocksIn: (notePath: string) => readonly string[] | null): LinkedNote | null {
	const slash = value.indexOf("/");
	const key = value.slice(slash + 1);
	const colon = key.indexOf(":");
	const docId = value.slice(0, slash);
	const pageId = key.slice(0, colon);
	const crdtId = key.slice(colon + 1);
	if (slash < 1 || colon < 1 || crdtId === "") return null;
	const active = Object.values(rows).filter((row) => row.docId === docId && row.status === "active");
	const notes = [...active.filter((row) => row.pageId === null), ...active.filter((row) => row.pageId === pageId)].flatMap((row) => {
		const blocks = blocksIn(row.notePath);
		return blocks === null ? [] : [{ notePath: row.notePath, blocks }];
	});
	const ids = [digestId("hl", pageId, crdtId), digestId("nt", pageId, crdtId)];
	for (const { notePath, blocks } of notes) {
		const block = ids.find((id) => blocks.includes(id));
		if (block !== undefined) return { notePath, block };
	}
	return notes.length === 0 ? null : { notePath: notes[0].notePath, block: null };
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
