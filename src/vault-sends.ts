/**
 * Which tablet documents this vault put there itself, and from which file (send spec §5).
 *
 * The record is what makes a vault send more than an upload. Two questions are answered from it and
 * from nothing else: *is this earlier copy ours* -- a second send may clear only its own copies
 * (ADR 0001) -- and *does a page tag bring back the whole document* (ADR 0002). Both are one test,
 * "the document's id has an entry" ({@link isCovered}): a document of the same name from another
 * vault, a manual upload or a Zotero paper in the same folder has none, and is never touched.
 *
 * Kept in `data.json` under the tablet document's id, like `zoteroLinks`, and for the same reasons
 * (`zotero-links.ts` has them): not in the tablet document's name, not on an index row -- a sent
 * document has no row until it is tagged, and most never are. The file travels between machines
 * through Obsidian Sync and two installs of different ages may write it, so the map is carried
 * through the settings migration opaquely and read here one entry at a time. An entry this build
 * cannot read is kept, never dropped; fields it does not know survive a write.
 *
 * The sync never writes back a copy of this map it took at its start (§5). A rename or a send made
 * while a sync runs lands in the live map, and the sync's own findings arrive as marks per document
 * ({@link applySyncMarks}) applied to whatever the map holds by then.
 */

import { remapNotePath, type Renamed } from "./note-rename";
import { SENT_GRACE_MS } from "./zotero-send";

/** The whole map, as `data.json` carries it: tablet document id -> a send this build may or may not understand. */
export type StoredVaultSends = Record<string, unknown>;

/** What was sent: a note printed to a PDF, or a PDF from the vault as it is. */
export type SentKind = "note" | "pdf";

/** One tablet document the vault sent. The field table is spec §5. */
export interface VaultSend {
	/** The origin's vault path, kept current through renames ({@link remapOrigins}). */
	readonly origin: string;
	readonly kind: SentKind;
	/** ISO time of the send. */
	readonly sentAt: string;
	/** The name it was sent as. Absent on an entry that lost it: such a copy counts as the user's (§3). */
	readonly name?: string;
	/** The tablet folder it was put into. Absent the same way, with the same consequence. */
	readonly folderId?: string;
	/** The last sync listing that found the document. Absent until one has -- the listing can lag the upload. */
	readonly seenAt?: string;
	/** The first listing that missed it after {@link seenAt}. Cleared when a listing finds it again. */
	readonly goneAt?: string;
	/** The user answered *Keep it* for this copy; it is never asked about or cleared again (§11 P4, P15). */
	readonly kept?: true;
	/** The document's listing hash at the last "marks, no tag" look (§6.5). */
	readonly inkCheckedHash?: string;
	/** The sync has said "marks on it but no sync tag" for this copy. */
	readonly saidNoTag?: true;
	/** The sync has said "handwriting that was not read" for this copy. */
	readonly saidUnread?: true;
	/**
	 * The mapped page-tag names the sync promoted to document tags when it last opened the document
	 * (§6.1). The document gate compares the listing's tags together with these against the active
	 * rows, because the listing carries no page tags.
	 */
	readonly promotedTags?: readonly string[];
}

/** What a sync hands back for one covered document. Only these four fields are the sync's to set (§5). */
export interface SyncMarks {
	readonly inkCheckedHash?: string;
	readonly saidNoTag?: true;
	readonly saidUnread?: true;
	readonly promotedTags?: readonly string[];
}

/**
 * How long an entry outlives its document (§11 P5): 30 days after the listing first missed it, or --
 * for a copy no listing ever found -- 30 days after it was sent. A copy restored from the trash
 * inside that month is still the vault's own; after it, a stranger.
 */
export const SEND_RECORD_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Every field this build reads into a {@link VaultSend}. Anything else on a stored entry was written by a newer build. */
const KNOWN_FIELDS = new Set(["origin", "kind", "sentAt", "name", "folderId", "seenAt", "goneAt", "kept", "inkCheckedHash", "saidNoTag", "saidUnread", "promotedTags"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** An ISO time, or `undefined` for anything that does not parse -- a date nobody can compare is no date. */
function asTime(value: unknown): string | undefined {
	const time = asString(value);
	return time !== undefined && !Number.isNaN(Date.parse(time)) ? time : undefined;
}

/**
 * The send for one tablet document, or `null` when there is none this build can read.
 *
 * Total: any stored value answers rather than throws. `origin`, `kind` and `sentAt` are what make an
 * entry a send; without one of them it is `null` here and stays in the map untouched. Every other
 * field is read on its own, and a field that does not read is simply absent -- an absent `name` or
 * `folderId` is what makes the copy count as the user's (§3), which is the safe side.
 */
export function sendFor(sends: StoredVaultSends, docId: string): VaultSend | null {
	const stored = asRecord(sends[docId]);
	const origin = asString(stored.origin);
	const kind = stored.kind === "note" || stored.kind === "pdf" ? stored.kind : undefined;
	const sentAt = asTime(stored.sentAt);
	if (origin === undefined || kind === undefined || sentAt === undefined) return null;
	const name = asString(stored.name);
	const folderId = asString(stored.folderId);
	const seenAt = asTime(stored.seenAt);
	const goneAt = asTime(stored.goneAt);
	const inkCheckedHash = asString(stored.inkCheckedHash);
	const promotedTags = Array.isArray(stored.promotedTags) ? stored.promotedTags.filter((tag): tag is string => typeof tag === "string") : undefined;
	return {
		origin,
		kind,
		sentAt,
		...(name === undefined ? {} : { name }),
		...(folderId === undefined ? {} : { folderId }),
		...(seenAt === undefined ? {} : { seenAt }),
		...(goneAt === undefined ? {} : { goneAt }),
		...(stored.kept === true ? { kept: true as const } : {}),
		...(inkCheckedHash === undefined ? {} : { inkCheckedHash }),
		...(stored.saidNoTag === true ? { saidNoTag: true as const } : {}),
		...(stored.saidUnread === true ? { saidUnread: true as const } : {}),
		...(promotedTags === undefined ? {} : { promotedTags }),
	};
}

/**
 * Did this vault send the document? The one test behind both "is this earlier copy ours" (§3) and
 * "does a page tag bring back the whole document" (§6.1).
 *
 * An entry this build cannot read covers too. It can only have been written by another install of
 * this vault, so the document is still this vault's own; reading it as a stranger would give it page
 * notes here and one note there, for one document.
 */
export function isCovered(sends: StoredVaultSends, docId: string): boolean {
	return Object.prototype.hasOwnProperty.call(sends, docId) && isRecord(sends[docId]);
}

/** Every readable send of one origin, oldest first -- the earlier copies a second send looks at (§3). */
export function copiesOf(sends: StoredVaultSends, origin: string): { docId: string; send: VaultSend }[] {
	const copies: { docId: string; send: VaultSend }[] = [];
	for (const docId of Object.keys(sends)) {
		const send = sendFor(sends, docId);
		if (send !== null && send.origin === origin) copies.push({ docId, send });
	}
	return copies.sort((a, b) => Date.parse(a.send.sentAt) - Date.parse(b.send.sentAt));
}

/**
 * The map with one document's send set, as a new object.
 *
 * Fields of this entry that this build does not know are carried along -- a newer build wrote them.
 * A field this build does know is the send's to say, so a replaced entry carries none of the old one's.
 */
export function withSend(sends: StoredVaultSends, docId: string, send: VaultSend): StoredVaultSends {
	const unknown = Object.fromEntries(Object.entries(asRecord(sends[docId])).filter(([field]) => !KNOWN_FIELDS.has(field)));
	return { ...sends, [docId]: { ...unknown, ...send } };
}

/**
 * What the run's listing says about the sent documents: the ones it found are seen, the ones it had
 * found before and finds no more are gone, and a gone one found again is back (restored from the
 * tablet's trash). The rules of `markListed` for Zotero links, for the same listing.
 *
 * An entry no listing has found yet is left alone: the listing right after a send can lag the
 * upload, so a miss before the first sighting says nothing. Such an entry never earns a `goneAt`
 * and is let go by its age instead ({@link dropExpired}).
 */
export function markListedSends(sends: StoredVaultSends, documentIds: readonly string[], nowIso: string): StoredVaultSends {
	const listed = new Set(documentIds);
	let next = sends;
	for (const docId of Object.keys(sends)) {
		const send = sendFor(sends, docId);
		if (send === null) continue;
		if (listed.has(docId)) {
			const { goneAt: _back, ...seen } = send;
			next = withSend(next, docId, { ...seen, seenAt: nowIso });
		} else if (send.seenAt !== undefined && send.goneAt === undefined) {
			next = withSend(next, docId, { ...send, goneAt: nowIso });
		}
	}
	return next;
}

/**
 * Is the copy still taken to be on the tablet, judged from what the syncs' listings recorded?
 *
 * Not gone, and either seen or sent less than a day ago -- the grace `documentsOnTablet` gives a
 * Zotero send, for the same listing lag. What a send over SSH says about an earlier copy it cannot
 * look at (§3) is read from here.
 */
export function stillOnTablet(send: VaultSend, now: Date): boolean {
	if (send.goneAt !== undefined) return false;
	return send.seenAt !== undefined || now.getTime() - Date.parse(send.sentAt) < SENT_GRACE_MS;
}

/**
 * The map without the entries whose documents have been gone long enough (§11 P5).
 *
 * Gone for 30 days, or never found by any listing 30 days after the send -- a copy deleted before the
 * next sync, which {@link markListedSends} never marks gone. An entry this build cannot read has no
 * date it could trust, and stays.
 */
export function dropExpired(sends: StoredVaultSends, now: Date): StoredVaultSends {
	const next: StoredVaultSends = {};
	for (const [docId, stored] of Object.entries(sends)) {
		const send = sendFor(sends, docId);
		const since = send === null ? undefined : (send.goneAt ?? (send.seenAt === undefined ? send.sentAt : undefined));
		if (since !== undefined && now.getTime() - Date.parse(since) >= SEND_RECORD_LIFETIME_MS) continue;
		next[docId] = stored;
	}
	return next;
}

/**
 * The map after a rename or move in the vault, or `null` when it moves no origin -- almost every
 * rename, and the reason `data.json` is not rewritten on each one.
 *
 * Reads the stored `origin` string directly rather than through {@link sendFor}, so an entry this
 * build cannot otherwise read still follows its file: whichever install reads it later finds the
 * path current. A folder move rewrites every origin below it at once; the per-file events Obsidian
 * fires after it then find nothing left to move.
 */
export function remapOrigins(sends: StoredVaultSends, renamed: Renamed): StoredVaultSends | null {
	let moved = false;
	const next: StoredVaultSends = {};
	for (const [docId, stored] of Object.entries(sends)) {
		const origin = isRecord(stored) ? asString(stored.origin) : undefined;
		const to = origin === undefined ? null : remapNotePath(renamed, origin);
		next[docId] = to === null ? stored : { ...asRecord(stored), origin: to };
		moved ||= to !== null;
	}
	return moved ? next : null;
}

/**
 * The map with what a sync found applied to it (§5).
 *
 * Applied to the live map when the sync ends, not to a copy taken at its start, so a rename or a
 * send made while it ran is still there afterwards. A document whose entry is gone by then gets no
 * new one: marks describe a send, they do not make one.
 */
export function applySyncMarks(sends: StoredVaultSends, marks: Readonly<Record<string, SyncMarks>>): StoredVaultSends {
	let next = sends;
	for (const [docId, mark] of Object.entries(marks)) {
		if (!isRecord(next[docId])) continue;
		next = { ...next, [docId]: { ...asRecord(next[docId]), ...mark } };
	}
	return next;
}
