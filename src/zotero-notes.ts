/**
 * Pages added on the tablet as child notes under the paper in Zotero: Zotero spec §2 and §3 (#246).
 *
 * The annotation write-back's twin, kept beside it rather than inside it: an added page has no place
 * on the PDF, so nothing of `planWriteBack`'s fields, positions or re-adoption applies, and a note is
 * one field where an annotation is six. The split is the same, though. {@link planNotes} is
 * arithmetic over the digest, what we recorded and what stands in Zotero; {@link executeNotes} does
 * the talking and records what landed.
 *
 * One note per added page, under the paper rather than the PDF -- Zotero hangs notes on regular items
 * only -- titled by where the page sits: "Added page after p. 12". The body is written in exactly the
 * form both connections store, so that what we sent is what we read back (ticket 08 #1).
 */

import type { AddedPage, DigestPage } from "./digest-builder";
import { type NewNote, type ZoteroClient, ZoteroError, type ZoteroNote } from "./zotero-client";
import type { LinkedNote, ZoteroLink } from "./zotero-links";
import { describeZoteroError } from "./zotero-writeback";

/**
 * Which added pages a unit speaks for (Zotero spec §2.1): every one of the document's, deleted ones
 * included; the one page a page-scoped unit is; or none -- a failed digest build, or *Your notes on
 * PDFs* off, where the digest was given no added page at all. A page whose handwriting could not be
 * read is left out of each ({@link AddedPage.unread}).
 */
export type AddedPagesScope = "document" | "none" | { readonly blockId: string };

/** One added page, reduced to what its note needs. */
interface AddedEntry {
	readonly blockId: string;
	readonly text: string;
	readonly added: AddedPage;
}

/** The added pages of a digest, in page order. Each is one whole-page entry (F21). */
function addedEntries(pages: readonly DigestPage[]): AddedEntry[] {
	return pages.flatMap((page) => {
		const entry = page.notes.find((note) => note.wholePage === true);
		return page.added === undefined || entry === undefined ? [] : [{ blockId: entry.id, text: entry.text, added: page.added }];
	});
}

function speaksFor(scope: AddedPagesScope, entry: AddedEntry): boolean {
	if (entry.added.unread === true || scope === "none") return false;
	return scope === "document" || scope.blockId === entry.blockId;
}

/** "Added page after p. 12", "Added page 2 after p. 12", "Added page before p. 1" (Zotero spec §2.1). */
export function addedPageTitle({ relation, label, nth }: AddedPage): string {
	return `Added page${nth === null ? "" : ` ${nth}`} ${relation} p. ${label}`;
}

/**
 * One line of text as the body carries it.
 *
 * Control characters go because the desktop's `setNote` strips them, and runs of whitespace become
 * one space so that no cleaner on either side has anything left to normalise: a body Zotero stores
 * differently from how we sent it reads as the user's edit on the next sync.
 */
function bodyText(text: string): string {
	return text
		// eslint-disable-next-line no-control-regex -- matching control characters is the point
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * The note's HTML: the title as `<h1>`, then one `<p>` per non-blank line, joined with `\n` and with
 * no whitespace around the whole -- the desktop trims it (ticket 08 #1). No attributes and no editor
 * container: a note marked with a schema version opens read-only in an older Zotero (research 03 §2).
 */
export function noteBody(title: string, text: string): string {
	return [`<h1>${bodyText(title)}</h1>`, ...bodyLines(text).map((line) => `<p>${line}</p>`)].join("\n");
}

function bodyLines(text: string): string[] {
	return text.split(/\r\n?|\n/).map(bodyText).filter((line) => line !== "");
}

/** An added page this unit may write: one it speaks for, with something on it to write. */
function writable(scope: AddedPagesScope, entry: AddedEntry): boolean {
	return speaksFor(scope, entry) && bodyLines(entry.text).length > 0;
}

/** The title out of a body we wrote, for telling one of ours apart from another under the same paper. */
function titleOf(body: string): string | undefined {
	return /^<h1>(.*?)<\/h1>/.exec(body)?.[1];
}

export interface PlannedNoteCreate {
	readonly blockId: string;
	readonly note: NewNote;
}

export interface NotesPlan {
	readonly creates: PlannedNoteCreate[];
}

export interface NotesInput {
	readonly pages: readonly DigestPage[];
	readonly scope: AddedPagesScope;
	/** The paper the PDF hangs under. Notes go there: Zotero has no notes on an attachment. */
	readonly paperKey: string;
	readonly link: ZoteroLink;
	/** Our own notes under the paper as they stand in Zotero now, read by the ownership tag. */
	readonly existing: readonly ZoteroNote[];
}

/** Does any added page of this digest have something to write? The pass asks before it reads anything of Zotero's. */
export function hasAddedText(pages: readonly DigestPage[], scope: AddedPagesScope): boolean {
	return addedEntries(pages).some((entry) => writable(scope, entry));
}

/**
 * What this sync would write for the document's added pages. Reads nothing, writes nothing.
 *
 * A page with text, that this unit speaks for, with no record and no note of ours under the same
 * title, is created. A page with a record is ticket 12's (refresh, trash, the user's edit); one with
 * no record and a note of ours under its title is the record a 1.9.x install dropped, and adopting it
 * is ticket 12's as well -- here it is only never duplicated.
 */
export function planNotes({ pages, scope, paperKey, link, existing }: NotesInput): NotesPlan {
	const titles = new Set(existing.map((note) => titleOf(note.note)));
	const creates: PlannedNoteCreate[] = [];
	for (const entry of addedEntries(pages)) {
		if (!writable(scope, entry) || link.notes?.[entry.blockId] !== undefined) continue;
		const title = addedPageTitle(entry.added);
		if (titles.has(bodyText(title))) continue;
		creates.push({ blockId: entry.blockId, note: { parentKey: paperKey, note: noteBody(title, entry.text) } });
	}
	return { creates };
}

/** What happened, for `data.json` and for the counts the note and the run report. */
export interface NotesResult {
	/** The note records to store: everything known before, with what landed merged over it. */
	readonly notes: Record<string, LinkedNote>;
	readonly written: number;
	readonly total: number;
	readonly failures: string[];
}

/**
 * Carries out a plan, into the link's library and no other. As with annotations there is nothing
 * to roll back: a note Zotero refused is not recorded, and the next sync creates it then.
 *
 * A library that refuses writes is thrown on, for the pass to name (ticket 26); any other failure
 * ends the run with what landed counted.
 */
export async function executeNotes(client: ZoteroClient, link: ZoteroLink, plan: NotesPlan): Promise<NotesResult> {
	const notes: Record<string, LinkedNote> = { ...link.notes };
	const total = plan.creates.length;
	if (total === 0) return { notes, written: 0, total, failures: [] };
	try {
		const { created, failures } = await client.createNotes(
			plan.creates.map((create) => create.note),
			link.library,
		);
		let written = 0;
		plan.creates.forEach((create, index) => {
			const landed = created[index];
			if (!landed) return;
			notes[create.blockId] = { key: landed.key, parentKey: create.note.parentKey, written: { note: landed.note } };
			written++;
		});
		return { notes, written, total, failures };
	} catch (error) {
		if (error instanceof ZoteroError && error.reason === "read-only") throw error;
		return { notes, written: 0, total, failures: [describeZoteroError(error)] };
	}
}
