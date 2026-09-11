/**
 * Which reMarkable document is which Zotero PDF, and what we have already written into it.
 *
 * The link is kept in `data.json` under the **reMarkable document uuid** (spec §2.2) and nowhere
 * else. Three things follow from that address, and each of them ruled out an easier one:
 *
 * - **Not in the tablet document's name.** The promise is that Send only ever adds a file and
 *   changes nothing about it; a key in the title would be a change, and the user would have to keep
 *   it there forever.
 * - **Not on a sync-index row.** A row is `docId:tag`, so one document synced under two tags would
 *   hold two copies of one fact and they would drift. Worse, Send writes the link *at upload*, when
 *   no row exists yet: the row is the note's identity, this is the document's.
 * - **Not derived at sync time.** Matching (§2.3) runs once and is then remembered, precisely so a
 *   user who was asked a question is never asked it again.
 *
 * What is stored here is written by us and read by us, but the file it sits in is shared: `data.json`
 * travels between machines through Obsidian Sync, and two installs on different plugin versions may
 * both write it. So this module takes the shape `settings-store.ts` uses for `sshHashes` and
 * `llmProviders` -- the map is carried through the settings migration **opaquely**, and validated one
 * entry at a time, here, at the moment it is used. An entry this build cannot read is left exactly
 * where it is rather than dropped, because dropping it would delete what a newer install wrote.
 */

/** The whole map, as `data.json` carries it: reMarkable document uuid -> a link this build may or may not understand. */
export type StoredZoteroLinks = Record<string, unknown>;

/** What we wrote into one annotation, so that §3.3 can tell our value from one the user has edited since. */
export interface WrittenAnnotationFields {
	readonly text?: string;
	readonly comment?: string;
	readonly color?: string;
	readonly pageLabel?: string;
	readonly sortIndex?: string;
	readonly position?: string;
}

/**
 * One digest entry's annotation in Zotero.
 *
 * `deleted` is the memory of a user's decision, and it is why this map is not simply rebuilt from
 * Zotero each time: an annotation the user deleted there must **stay** deleted (§3.3), and the only
 * difference between "deleted by the user" and "never created" is what is written here.
 */
export interface LinkedAnnotation {
	readonly key: string;
	readonly written: WrittenAnnotationFields;
	readonly deleted?: true;
	/**
	 * Fields the user has edited in Zotero, which we never write again (§3.3, "user's value wins,
	 * that field never overwritten again").
	 *
	 * A list rather than a re-reading of the value, because the value cannot answer the question: once
	 * their edit is noticed, remembering *their* text as ours makes the field look untouched again on
	 * the next sync, and it would be overwritten with what the tablet says. The surrender has to be
	 * the thing that is stored.
	 */
	readonly userEdited?: readonly string[];
}

/** One reMarkable document's link to one Zotero attachment. */
export interface ZoteroLink {
	readonly attachmentKey: string;
	/** Personal library only; group libraries are refused (spec §1.3). A link that says otherwise is not ours to act on. */
	readonly library: "user";
	/** When Send put this file on the tablet. Absent on a document that arrived some other way and was matched. */
	readonly sentAt?: string;
	/** The MD5 Send uploaded, which is what a later match can recognise the file by without asking Zotero. */
	readonly sentMd5?: string;
	/**
	 * Present only on a link this plugin made **without asking** -- the hash row of §2.3.
	 *
	 * It is what keeps that row's "note says: matched by file hash" true for longer than the one sync
	 * in which it happened. A silent link is the plugin deciding something about the user's library on
	 * its own, and a note that mentions it only on the day it was made discloses it to nobody: the
	 * reader opens the note weeks later. The clause goes as soon as the link stops being ours alone --
	 * *Link to Zotero item…* and Send both write a link without this field.
	 */
	readonly matchedBy?: "hash";
	/** Block id (`hl-…` / `nt-…`) -> the annotation it became in Zotero. */
	readonly annotations: Record<string, LinkedAnnotation>;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The six fields a refresh may touch, and nothing else the entry happens to carry.
 *
 * ⚠️ `""` is kept, unlike everywhere else in this file. An empty comment or an empty page label is a
 * value we really wrote, and §3.3 compares what stands in Zotero against *what we wrote*: dropped,
 * an empty one would read as "we never wrote this field", and a field the user then cleared by hand
 * would be written back over on the next sync.
 */
function writtenFields(value: unknown): WrittenAnnotationFields {
	const stored = asRecord(value);
	const fields: Record<string, string> = {};
	for (const name of ["text", "comment", "color", "pageLabel", "sortIndex", "position"]) {
		const written = stored[name];
		if (typeof written === "string") fields[name] = written;
	}
	return fields;
}

/**
 * The annotations of one link, keeping only the entries that name a key.
 *
 * An entry without a key says nothing -- it can neither be refreshed nor recognised as deleted --
 * and keeping it would make "is this block already in Zotero?" answer yes for an annotation that
 * does not exist.
 */
function annotationsOf(value: unknown): Record<string, LinkedAnnotation> {
	const annotations: Record<string, LinkedAnnotation> = {};
	for (const [blockId, entry] of Object.entries(asRecord(value))) {
		const stored = asRecord(entry);
		const key = asString(stored.key);
		if (key === undefined) continue;
		const userEdited = Array.isArray(stored.userEdited) ? stored.userEdited.filter((field): field is string => typeof field === "string") : [];
		annotations[blockId] = {
			key,
			written: writtenFields(stored.written),
			...(stored.deleted === true ? { deleted: true as const } : {}),
			...(userEdited.length > 0 ? { userEdited } : {}),
		};
	}
	return annotations;
}

/**
 * The link for one reMarkable document, or `null` when there is none this build can act on.
 *
 * Total: any stored value at all -- absent, a string, an array, a link written by a version that
 * knows about group libraries -- answers `null` rather than throwing. `null` means exactly what the
 * matcher needs it to mean: *this document is not linked*, so it is matched again (§2.3), and the
 * note is written without a Zotero part until it is.
 */
export function linkFor(links: StoredZoteroLinks, docId: string): ZoteroLink | null {
	const stored = asRecord(links[docId]);
	const attachmentKey = asString(stored.attachmentKey);
	// A library this build does not handle is not an error and not ours to repair: it stays in the
	// file untouched, and this document simply reads as unlinked here.
	if (attachmentKey === undefined || stored.library !== "user") return null;
	return {
		attachmentKey,
		library: "user",
		...(asString(stored.sentAt) === undefined ? {} : { sentAt: asString(stored.sentAt) }),
		...(asString(stored.sentMd5) === undefined ? {} : { sentMd5: asString(stored.sentMd5) }),
		...(stored.matchedBy === "hash" ? { matchedBy: "hash" as const } : {}),
		annotations: annotationsOf(stored.annotations),
	};
}

/**
 * Was this document put to the user, and did they close the question without answering it?
 *
 * The spec says a document is asked about **once** (§2.3). Without a record of the asking, a
 * duplicate file hash would open the same picker on every single sync -- so a dismissed question is
 * stored as a document with no link, which reads as "not linked" everywhere else and stops only the
 * asking. The *Link to Zotero item…* command is how the user changes their mind, and a link written
 * later replaces this outright.
 */
export function wasDeclined(links: StoredZoteroLinks, docId: string): boolean {
	return asRecord(links[docId]).declined === true && linkFor(links, docId) === null;
}

/** The map with this document marked as asked-about and not answered. */
export function withDeclinedLink(links: StoredZoteroLinks, docId: string): StoredZoteroLinks {
	return { ...links, [docId]: { declined: true } };
}

/** Every document this build sees a usable link for. The matcher's "is it already linked?" over the whole vault. */
export function linkedDocumentIds(links: StoredZoteroLinks): string[] {
	return Object.keys(links).filter((docId) => linkFor(links, docId) !== null);
}

/**
 * The map with one document's link set, as a new object.
 *
 * A copy rather than a mutation because `data.json` is handed around whole and written by whoever
 * saves next; the sync index learned that the hard way (`EMPTY_SYNC_INDEX` being shared). Entries
 * this build could not read are copied along untouched -- see the file header.
 */
export function withLink(links: StoredZoteroLinks, docId: string, link: ZoteroLink): StoredZoteroLinks {
	return { ...links, [docId]: link };
}

/**
 * The map with one document's link gone.
 *
 * Used where a link is *replaced* rather than repaired -- the re-send case where the mapped document
 * is no longer on the tablet (§2.5). Nothing else removes a link: an attachment that was trashed in
 * Zotero keeps its link, because the user may put it back, and until they do the note simply says so.
 */
export function withoutLink(links: StoredZoteroLinks, docId: string): StoredZoteroLinks {
	const { [docId]: _gone, ...rest } = links;
	return rest;
}
