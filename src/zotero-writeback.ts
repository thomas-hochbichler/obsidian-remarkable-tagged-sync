/**
 * Highlights from the tablet as native Zotero annotations: spec §3.3 and §3.4.
 *
 * The policy is **add and refresh, and trash only what is still ours**, and every rule in it exists
 * because the user's library is not ours. What we wrote is ours to keep up to date; what they did to
 * it afterwards is theirs, and the four ways they can disagree with us each have an answer:
 *
 * | They did | We do |
 * |---|---|
 * | edited one of our fields in Zotero | never write that field again |
 * | deleted one of our annotations | leave it deleted, and remember that we did |
 * | removed the highlight on the tablet | trash the annotation if untouched in Zotero; else leave it |
 * | highlighted something themselves | never read it, never touch it |
 *
 * The last one is bought by the ownership tag alone: the annotations we read back are filtered by it
 * on the server, so nothing else in the library is ever in hand to get wrong.
 *
 * The one thing ever removed goes to Zotero's **trash**, never past it, and only when every field
 * still reads exactly as we wrote it: an annotation the user commented on, recoloured or otherwise
 * built on in Zotero stays, whatever the tablet says (§3.3). And it is only decided for the pages
 * the digest actually looked at ({@link WriteBackInput.covered}): "not in the digest" means "erased
 * on the tablet" only on a page the digest had in hand.
 *
 * Split in two on purpose. {@link planWriteBack} is arithmetic over what is already known -- the
 * digest, what we recorded last time, and what stands in Zotero now -- and every rule above is a
 * branch in it that a test can drive. {@link executeWriteBack} does the talking, and does nothing
 * else: it batches, it collects what came back, and it reports. A failure there costs a retry on the
 * next sync, which is safe precisely because the plan is add-and-refresh.
 */

import type { DigestPage } from "./digest-builder";
import { highlightAnnotation, noteAnnotation } from "./zotero-annotations";
import type { AnnotationFields, NewAnnotation, ZoteroAnnotation, ZoteroAnnotationRef, ZoteroClient } from "./zotero-client";
import { ZoteroError } from "./zotero-client";
import type { LinkedAnnotation, WrittenAnnotationFields, ZoteroLink } from "./zotero-links";

/** The six fields a refresh may touch, in one place so the plan and the store cannot disagree about the list. */
const REFRESHABLE = ["text", "comment", "color", "pageLabel", "sortIndex", "position"] as const;
type RefreshableField = (typeof REFRESHABLE)[number];

export interface PlannedCreate {
	readonly blockId: string;
	readonly annotation: NewAnnotation;
	/** What to remember as ours once Zotero hands back a key. */
	readonly written: WrittenAnnotationFields;
}

export interface PlannedPatch {
	readonly blockId: string;
	readonly annotation: ZoteroAnnotationRef;
	/** Only the fields that differ from what we wrote and that the user has not taken over. Never empty. */
	readonly fields: AnnotationFields;
	readonly written: WrittenAnnotationFields;
	readonly userEdited: readonly string[];
}

/** An annotation whose highlight was erased on the tablet and that the user never touched in Zotero. */
export interface PlannedTrash {
	readonly blockId: string;
	readonly annotation: ZoteroAnnotationRef;
	/** What to remember once it is in the trash: the key, marked deleted, so it is never recreated (§3.3). */
	readonly record: LinkedAnnotation;
}

export interface WriteBackPlan {
	readonly creates: PlannedCreate[];
	readonly patches: PlannedPatch[];
	readonly trashes: PlannedTrash[];
	/**
	 * Entries whose annotation is already exactly what it should be, with what to remember about them.
	 *
	 * They cost no request and they are not nothing: an entry that was re-adopted, or one whose fields
	 * the user has just taken over, has something new to store even though Zotero needs no telling.
	 */
	readonly unchanged: { readonly blockId: string; readonly annotation: LinkedAnnotation }[];
	/** Entries whose annotation the user deleted in Zotero. Remembered as deleted, never recreated. */
	readonly vanished: { readonly blockId: string; readonly annotation: LinkedAnnotation }[];
	/** How many digest entries were not offered to Zotero at all -- a page added on the device, an entry with no place on the page. */
	readonly skipped: number;
}

export interface WriteBackInput {
	readonly pages: DigestPage[];
	/**
	 * The source page indexes the digest spoke for -- every page it was given, whether or not the
	 * page produced an entry. An annotation whose block id is nowhere in `pages` is one the reader
	 * erased only when its page is in here: a page-scoped unit speaks for one page of the document,
	 * and a failed digest build for none, and trashing beyond that would empty the library of every
	 * highlight the digest never saw.
	 */
	readonly covered: readonly number[];
	readonly attachmentKey: string;
	readonly link: ZoteroLink;
	/** Our own annotations as they stand in Zotero now, read by the ownership tag. */
	readonly existing: ZoteroAnnotation[];
	/**
	 * The vault note was deleted by hand since the last sync, and this write recreates it.
	 *
	 * Deleting the note is the user's "start over", and it is the one gesture that also un-remembers
	 * a deletion in Zotero: an annotation of ours that is not in Zotero any more is created again
	 * rather than stored as deleted (§3.3). Everything still in Zotero keeps its record, and with it
	 * every field the user took over -- so a note deleted to regenerate it overwrites nothing there.
	 */
	readonly noteWasDeleted?: boolean;
}

/** One digest entry, reduced to what write-back cares about. */
interface Entry {
	readonly blockId: string;
	readonly annotation: NewAnnotation;
}

/**
 * Every entry of the digest that can become an annotation, in reading order -- and, separately, the
 * id of every entry the digest has at all. A skipped entry is still on the tablet, so the second set
 * is the one "erased on the tablet" is measured against, never the first.
 */
function entriesOf(pages: DigestPage[], attachmentKey: string): { entries: Entry[]; present: Set<string>; skipped: number } {
	const entries: Entry[] = [];
	const present = new Set<string>();
	let skipped = 0;
	for (const page of pages) {
		for (const item of [...page.highlights, ...page.notes]) present.add(item.id);
		const source = page.source;
		// A page the reader added on the device is not a page of this PDF, and a page whose text layer
		// could not be read has no coordinates in it. Both are the same fact -- see `DigestPage.source`
		// -- and both are skipped rather than written somewhere approximate (§3.1).
		if (source === null) {
			skipped += page.highlights.length + page.notes.length;
			continue;
		}
		for (const highlight of page.highlights) {
			const annotation = highlightAnnotation(highlight, page, source, attachmentKey);
			if (annotation === null) skipped++;
			else entries.push({ blockId: highlight.id, annotation });
		}
		for (const note of page.notes) {
			const annotation = noteAnnotation(note, page, source, attachmentKey);
			if (annotation === null) skipped++;
			else entries.push({ blockId: note.id, annotation });
		}
	}
	return { entries, present, skipped };
}

/** The annotation's fields as we would have them, as the flat record the store keeps. */
function fieldsOf(annotation: NewAnnotation): WrittenAnnotationFields {
	return {
		...(annotation.type === "note" ? {} : { text: annotation.text ?? "" }),
		comment: annotation.comment ?? "",
		color: annotation.color ?? "",
		pageLabel: annotation.pageLabel ?? "",
		sortIndex: annotation.sortIndex ?? "",
		position: annotation.position ?? "",
	};
}

/** What one field of an annotation says in Zotero right now. */
function currentValue(annotation: ZoteroAnnotation, field: RefreshableField): string {
	return annotation[field];
}

/**
 * ⚠️ Re-adoption, and the one place a `tagged-sync` annotation is claimed without a key to prove it.
 *
 * The mapping in `data.json` can be lost while the annotations are not: a vault restored from a
 * backup, `data.json` reset, a second machine that synced the vault but not the plugin data. Without
 * this, the next sync creates a second copy of every highlight in the user's library, and nothing
 * short of deleting them by hand puts that right.
 *
 * Matched on **type, page and text together** -- never on any one of them. Two highlights of the same
 * words on one page is the only collision left, and it takes the first, which is the one the reader
 * would point at. Anything that matches nothing is left exactly where it is: an annotation we cannot
 * identify is one we have no business editing.
 */
function adopt(entry: Entry, existing: ZoteroAnnotation[], taken: Set<string>): ZoteroAnnotation | null {
	const wantedPage = JSON.parse(entry.annotation.position ?? "{}") as { pageIndex?: number };
	return (
		existing.find(
			(candidate) =>
				!taken.has(candidate.key) &&
				candidate.type === entry.annotation.type &&
				candidate.pageIndex === wantedPage.pageIndex &&
				candidate.text === (entry.annotation.text ?? ""),
		) ?? null
	);
}

/**
 * What this sync would do to the attachment's annotations. Reads nothing, writes nothing.
 *
 * The order of the questions is the order the rules override each other: a deleted annotation stays
 * deleted whatever the tablet now says; a field the user edited is theirs from then on; everything
 * else is refreshed to what the tablet says today.
 */
/** The page one of our annotations was written on, read off the position we wrote; `null` when that cannot be read. */
function writtenPageIndex(stored: LinkedAnnotation): number | null {
	try {
		const position = JSON.parse(stored.written.position ?? "") as { pageIndex?: unknown };
		return typeof position.pageIndex === "number" ? position.pageIndex : null;
	} catch {
		return null;
	}
}

export function planWriteBack({ pages, covered, attachmentKey, link, existing, noteWasDeleted = false }: WriteBackInput): WriteBackPlan {
	const { entries, present, skipped } = entriesOf(pages, attachmentKey);
	const byKey = new Map(existing.map((annotation) => [annotation.key, annotation]));
	// Two entries must never adopt the same annotation: the second would patch what the first just
	// claimed, and one of the two highlights would end up describing the other.
	const taken = new Set<string>(Object.values(link.annotations).map((stored) => stored.key));

	const creates: PlannedCreate[] = [];
	const patches: PlannedPatch[] = [];
	const trashes: PlannedTrash[] = [];
	const unchanged: { blockId: string; annotation: LinkedAnnotation }[] = [];
	const vanished: { blockId: string; annotation: LinkedAnnotation }[] = [];

	// Erased on the tablet: written once, on a page the digest looked at, no longer anywhere in the
	// digest. Trashed only while it still reads exactly as we wrote it -- a single field of theirs
	// keeps the whole annotation, and is remembered as theirs so that a later sync does not re-ask.
	{
		const coveredPages = new Set(covered);
		for (const [blockId, stored] of Object.entries(link.annotations)) {
			if (present.has(blockId) || stored.deleted) continue;
			const pageIndex = writtenPageIndex(stored);
			if (pageIndex === null || !coveredPages.has(pageIndex)) continue;
			const known = byKey.get(stored.key);
			if (known === undefined) {
				// Gone from Zotero as well: whoever removed it there, nothing is left to trash.
				vanished.push({ blockId, annotation: { key: stored.key, written: stored.written, deleted: true } });
				continue;
			}
			const theirs = REFRESHABLE.filter((field) => {
				const ours = stored.written[field];
				return ours !== undefined && currentValue(known, field) !== ours;
			});
			const surrendered = new Set<string>([...(stored.userEdited ?? []), ...theirs]);
			if (surrendered.size > 0) {
				unchanged.push({ blockId, annotation: { key: stored.key, written: stored.written, userEdited: [...surrendered] } });
				continue;
			}
			trashes.push({
				blockId,
				annotation: { key: known.key, version: known.version, source: known.source, library: known.library },
				record: { key: stored.key, written: stored.written, deleted: true },
			});
		}
	}

	for (const entry of entries) {
		const stored = link.annotations[entry.blockId];
		// The user deleted it in Zotero. It is never recreated, and the key is kept so that a later
		// sync can tell this from "never written" -- which is the whole difference (§3.3). Unless they
		// deleted the note as well: then it is written like a highlight Zotero has never seen.
		if (stored?.deleted && !noteWasDeleted) {
			vanished.push({ blockId: entry.blockId, annotation: stored });
			continue;
		}

		const known = stored === undefined || stored.deleted ? adopt(entry, existing, taken) : (byKey.get(stored.key) ?? null);
		if (stored !== undefined && known === null && !noteWasDeleted) {
			// We wrote it, it is not there any more, and only the user can have removed it.
			vanished.push({ blockId: entry.blockId, annotation: { key: stored.key, written: stored.written, deleted: true } });
			continue;
		}
		if (known === null) {
			creates.push({ blockId: entry.blockId, annotation: entry.annotation, written: fieldsOf(entry.annotation) });
			continue;
		}
		taken.add(known.key);

		const desired = fieldsOf(entry.annotation);
		// Everything the user has already taken over stays taken over. A field is only *newly* theirs
		// when what stands in Zotero differs from what we last wrote -- which is why the store keeps
		// what we wrote rather than what we meant.
		const surrendered = new Set<string>(stored?.userEdited ?? []);
		const fields: Record<string, string> = {};
		const written: Record<string, string> = { ...stored?.written };
		for (const field of REFRESHABLE) {
			const want = desired[field];
			if (want === undefined) continue;
			// Theirs already. Not written, and not remembered as ours either -- claiming their value as
			// something we wrote is how a surrender turns back into an overwrite two syncs later.
			if (surrendered.has(field)) continue;
			const ours = stored?.written[field];
			const theirs = currentValue(known, field);
			// A newly adopted annotation has no `written` to compare against, so nothing about it reads
			// as edited: it is refreshed to what the tablet says, which is what re-adoption is for.
			if (ours !== undefined && theirs !== ours) {
				surrendered.add(field);
				continue;
			}
			written[field] = want;
			if (theirs !== want) fields[field] = want;
		}

		const record: LinkedAnnotation = {
			key: known.key,
			written,
			...(surrendered.size > 0 ? { userEdited: [...surrendered] } : {}),
		};
		if (Object.keys(fields).length === 0) unchanged.push({ blockId: entry.blockId, annotation: record });
		else {
			patches.push({
				blockId: entry.blockId,
				annotation: { key: known.key, version: known.version, source: known.source, library: known.library },
				fields,
				written,
				userEdited: [...surrendered],
			});
		}
	}

	return { creates, patches, trashes, unchanged, vanished, skipped };
}

/** What happened, for `data.json` and for the status line. */
export interface WriteBackResult {
	/** The annotation map to store: every entry this run knows about, merged over what was there. */
	readonly annotations: Record<string, LinkedAnnotation>;
	/** How many annotations reached Zotero, and how many were meant to. */
	readonly written: number;
	readonly total: number;
	/** One sentence per failure; empty when everything landed. */
	readonly failures: string[];
}

/**
 * Carries out a plan. Add-and-refresh means there is nothing to roll back: whatever landed is
 * recorded, whatever did not is created, refreshed or trashed on the next sync.
 *
 * A `ZoteroError` ends the run for this document rather than being retried here -- the client has
 * already honoured whatever wait the server asked for, and hammering a rejected key or a closed
 * desktop app would only make a user's next sync slower. What *is* kept is everything that already
 * succeeded, which is the difference between "resume" and "start again".
 */
export async function executeWriteBack(client: ZoteroClient, link: ZoteroLink, plan: WriteBackPlan): Promise<WriteBackResult> {
	const annotations: Record<string, LinkedAnnotation> = { ...link.annotations };
	for (const { blockId, annotation } of [...plan.unchanged, ...plan.vanished]) annotations[blockId] = annotation;

	const total = plan.creates.length + plan.patches.length + plan.trashes.length;
	let written = 0;
	const failures: string[] = [];

	/**
	 * A failed request ends the run with what landed counted; a library that refuses writes ends it
	 * as a *skip* (ticket 26): nothing after it can land either, and "0 of 12 written, retry on next
	 * sync" would promise a retry that the next sync refuses the same way. The pass names the group.
	 */
	const giveUp = (error: unknown): void => {
		if (error instanceof ZoteroError && error.reason === "read-only") throw error;
		failures.push(describeZoteroError(error));
	};

	for (const trash of plan.trashes) {
		try {
			const outcome = await client.trashAnnotation(trash.annotation);
			// A conflict is the user editing it between our read and now, and an edited annotation is
			// theirs to keep: nothing is recorded, and the next sync sees the edit for what it is.
			if (outcome === "conflict") continue;
			annotations[trash.blockId] = trash.record;
			written++;
		} catch (error) {
			giveUp(error);
			return { annotations, written, total, failures };
		}
	}

	if (plan.creates.length > 0) {
		try {
			// Into the link's library and no other: a `read-only` answer from a group is reported, never
			// retried into the personal library (ticket 26).
			const created = await client.createAnnotations(plan.creates.map((create) => create.annotation), link.library);
			plan.creates.forEach((create, index) => {
				const key = created.keys[index];
				// A key or nothing: an annotation Zotero refused is simply not recorded, so the next sync
				// creates it again rather than remembering a key that does not exist.
				if (key === null) return;
				annotations[create.blockId] = { key, written: create.written };
				written++;
			});
			failures.push(...created.failures);
		} catch (error) {
			giveUp(error);
			return { annotations, written, total, failures };
		}
	}

	for (const patch of plan.patches) {
		try {
			const outcome = await client.patchAnnotation(patch.annotation, patch.fields);
			if (outcome === "conflict") {
				// Zotero moved under us between reading and writing, which is the user editing it by hand
				// in that window. Their value wins from here on, exactly as if we had seen it in the read.
				annotations[patch.blockId] = {
					key: patch.annotation.key,
					written: patch.written,
					userEdited: [...new Set([...patch.userEdited, ...Object.keys(patch.fields)])],
				};
				continue;
			}
			annotations[patch.blockId] = {
				key: patch.annotation.key,
				written: patch.written,
				...(patch.userEdited.length > 0 ? { userEdited: patch.userEdited } : {}),
			};
			written++;
		} catch (error) {
			giveUp(error);
			return { annotations, written, total, failures };
		}
	}

	return { annotations, written, total, failures };
}

/** The one line a failed Zotero request is reported as, wherever the plugin reports one. */
export function describeZoteroError(error: unknown): string {
	return error instanceof ZoteroError ? error.message : error instanceof Error ? error.message : String(error);
}
