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
import { type NewNote, type NoteFields, type ZoteroClient, ZoteroError, type ZoteroNote, type ZoteroNoteRef } from "./zotero-client";
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

/** Does this unit speak for the added page with this block id -- including one deleted on the tablet? */
function covers(scope: AddedPagesScope, blockId: string): boolean {
	return scope === "document" || (scope !== "none" && scope.blockId === blockId);
}

function speaksFor(scope: AddedPagesScope, entry: AddedEntry): boolean {
	return entry.added.unread !== true && covers(scope, entry.blockId);
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

/**
 * A note's body without the container Zotero's note editor puts around it.
 *
 * The desktop editor saves a note as soon as it is shown, wrapped in `<div data-schema-version="9">`
 * with a newline before the closing tag and the text untouched (device check 2026-10-29). Compared
 * as it stands, merely looking at the note in Zotero would hand it to the user.
 */
function unwrapped(note: string): string {
	return /^<div data-schema-version="\d+">([\s\S]*?)\n?<\/div>$/.exec(note)?.[1] ?? note;
}

export interface PlannedNoteCreate {
	readonly blockId: string;
	readonly note: NewNote;
}

/** A refresh of one of our notes: a new body, a new paper, or both in one request. */
export interface PlannedNotePatch {
	readonly blockId: string;
	readonly note: ZoteroNoteRef;
	/** Never empty. */
	readonly fields: NoteFields;
	/** What to remember once it landed. */
	readonly record: LinkedNote;
}

/** A note whose page was deleted on the tablet, untouched in Zotero. */
export interface PlannedNoteTrash {
	readonly blockId: string;
	readonly note: ZoteroNoteRef;
	readonly record: LinkedNote;
}

export interface NotesPlan {
	readonly creates: PlannedNoteCreate[];
	readonly patches: PlannedNotePatch[];
	readonly trashes: PlannedNoteTrash[];
	/** Records that change without a request: a note the user edited or removed, one adopted as it stands. */
	readonly records: { readonly blockId: string; readonly record: LinkedNote }[];
}

export interface NotesInput {
	readonly pages: readonly DigestPage[];
	readonly scope: AddedPagesScope;
	/** The paper the PDF hangs under. Notes go there: Zotero has no notes on an attachment. */
	readonly paperKey: string;
	readonly link: ZoteroLink;
	/**
	 * Our own notes as they stand in Zotero now, read by the ownership tag: under the paper, and under
	 * every paper a record still names -- the one the PDF hung under before it was moved.
	 */
	readonly existing: readonly ZoteroNote[];
	/** The vault note was deleted by hand: a note the user removed in Zotero is written again (Zotero spec §3). See `WriteBackInput.noteWasDeleted`. */
	readonly noteWasDeleted?: boolean;
}

/** Does any added page of this digest have something to write? The pass asks before it reads anything of Zotero's. */
export function hasAddedText(pages: readonly DigestPage[], scope: AddedPagesScope): boolean {
	return addedEntries(pages).some((entry) => writable(scope, entry));
}

/** Does the link hold a note of ours that a sync may still refresh, move or trash? */
export function hasLiveNotes(link: ZoteroLink): boolean {
	return Object.values(link.notes ?? {}).some((record) => record.deleted !== true && record.userEdited !== true);
}

/** The papers our live notes hang under, other than `paperKey`: where they were before the PDF moved. */
export function formerPapers(link: ZoteroLink, paperKey: string): string[] {
	const live = Object.values(link.notes ?? {}).filter((record) => record.deleted !== true && record.userEdited !== true);
	return [...new Set(live.map((record) => record.parentKey))].filter((key) => key !== paperKey);
}

function refOf({ key, version, source, library }: ZoteroNote): ZoteroNoteRef {
	return { key, version, source, library };
}

/**
 * What this sync would do to the notes of the document's added pages. Reads nothing, writes nothing.
 * Every row of Zotero spec §3 that is about one note is a branch here.
 *
 * The rules override each other in this order: a note the user removed stays removed, unless they
 * deleted the vault note as well; a note the user edited -- its body is not what we wrote, or our
 * last PATCH came back 412 -- is theirs and never written again, not even moved; a note whose page
 * this unit covered and that has no entry any more goes to the trash; everything else is refreshed
 * to what the tablet says and follows the PDF to its paper. A page whose handwriting could not be read
 * is neither refreshed nor trashed (P5).
 */
export function planNotes({ pages, scope, paperKey, link, existing: read, noteWasDeleted = false }: NotesInput): NotesPlan {
	const entries = new Map(addedEntries(pages).map((entry) => [entry.blockId, entry]));
	const existing = read.map((note) => ({ ...note, note: unwrapped(note.note) }));
	const byKey = new Map(existing.map((note) => [note.key, note]));
	const stored = link.notes ?? {};
	// Never adopted twice, and never a note another record already holds.
	const taken = new Set(Object.values(stored).map((record) => record.key));
	const plan: NotesPlan = { creates: [], patches: [], trashes: [], records: [] };
	// *Your notes on PDFs* off, or a failed build: nothing created, patched or trashed (Zotero spec §3).
	if (scope === "none") return plan;

	// What we wrote for a page this sync does not write: trashed when its page is gone, else left with
	// its text and only moved after the PDF.
	for (const [blockId, record] of Object.entries(stored)) {
		const entry = entries.get(blockId);
		if (record.deleted || record.userEdited || (entry !== undefined && writable(scope, entry))) continue;
		const known = byKey.get(record.key);
		// Not under any paper it could be: the user trashed or erased it, and it is never recreated.
		if (known === undefined) plan.records.push({ blockId, record: { ...record, deleted: true } });
		else if (known.note !== record.written.note) plan.records.push({ blockId, record: { ...record, userEdited: true } });
		else if (covers(scope, blockId) && entry?.added.unread !== true) plan.trashes.push({ blockId, note: refOf(known), record: { ...record, deleted: true } });
		else if (known.parentKey !== paperKey) plan.patches.push({ blockId, note: refOf(known), fields: { parentKey: paperKey }, record: { ...record, parentKey: paperKey } });
	}

	for (const entry of entries.values()) {
		if (!writable(scope, entry)) continue;
		const { blockId } = entry;
		const record = stored[blockId];
		if (record?.userEdited || (record?.deleted && !noteWasDeleted)) continue;
		const body = noteBody(addedPageTitle(entry.added), entry.text);

		let known: ZoteroNote | undefined;
		if (record !== undefined && !record.deleted) {
			known = byKey.get(record.key);
			if (known === undefined && !noteWasDeleted) {
				plan.records.push({ blockId, record: { ...record, deleted: true } });
				continue;
			}
			if (known !== undefined && known.note !== record.written.note) {
				plan.records.push({ blockId, record: { ...record, userEdited: true } });
				continue;
			}
		} else if (record === undefined) {
			// The record a 1.9.x install dropped (ticket 09 #3): ours, under this paper, under the exact
			// title this sync writes. Adopted and refreshed like any other.
			known = existing.find((note) => note.parentKey === paperKey && !taken.has(note.key) && titleOf(note.note) === titleOf(body));
		}

		if (known === undefined) {
			plan.creates.push({ blockId, note: { parentKey: paperKey, note: body } });
			continue;
		}
		taken.add(known.key);
		const next: LinkedNote = { key: known.key, parentKey: paperKey, written: { note: body } };
		const fields: NoteFields = {
			...(known.note === body ? {} : { note: body }),
			...(known.parentKey === paperKey ? {} : { parentKey: paperKey }),
		};
		if (Object.keys(fields).length === 0) plan.records.push({ blockId, record: next });
		else plan.patches.push({ blockId, note: refOf(known), fields, record: next });
	}

	return plan;
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
 * to roll back: what landed is recorded, and whatever did not is done by the next sync.
 *
 * A library that refuses writes is thrown on, for the pass to name (ticket 26); any other failure
 * ends the run with what landed counted.
 */
export async function executeNotes(client: ZoteroClient, link: ZoteroLink, plan: NotesPlan): Promise<NotesResult> {
	const notes: Record<string, LinkedNote> = { ...link.notes };
	for (const { blockId, record } of plan.records) notes[blockId] = record;
	const total = plan.creates.length + plan.patches.length + plan.trashes.length;
	let written = 0;
	const failures: string[] = [];
	const giveUp = (error: unknown): NotesResult => {
		if (error instanceof ZoteroError && error.reason === "read-only") throw error;
		return { notes, written, total, failures: [...failures, describeZoteroError(error)] };
	};

	for (const trash of plan.trashes) {
		try {
			// A conflict is the user editing it since we read it: nothing is recorded, and the next sync
			// sees the edit for what it is.
			if ((await client.trashAnnotation(trash.note)) === "conflict") continue;
			notes[trash.blockId] = trash.record;
			written++;
		} catch (error) {
			return giveUp(error);
		}
	}

	if (plan.creates.length > 0) {
		try {
			const created = await client.createNotes(
				plan.creates.map((create) => create.note),
				link.library,
			);
			plan.creates.forEach((create, index) => {
				const landed = created.created[index];
				if (!landed) return;
				notes[create.blockId] = { key: landed.key, parentKey: create.note.parentKey, written: { note: landed.note } };
				written++;
			});
			failures.push(...created.failures);
		} catch (error) {
			return giveUp(error);
		}
	}

	for (const patch of plan.patches) {
		try {
			if ((await client.patchNote(patch.note, patch.fields)) === "conflict") {
				// Edited in Zotero between our read and our write: theirs from now on (Zotero spec §3).
				notes[patch.blockId] = { ...(link.notes?.[patch.blockId] ?? patch.record), userEdited: true };
				continue;
			}
			notes[patch.blockId] = patch.record;
			written++;
		} catch (error) {
			return giveUp(error);
		}
	}

	return { notes, written, total, failures };
}
