/**
 * The Zotero half of a sync: spec §3.4, and the one place §2.3's decision is actually carried out.
 *
 * Everything Zotero does during a sync happens **after** the note is on disk. That is §3.4.1 --
 * "the Obsidian half completes first, always" -- and here it is a fact about the code rather than a
 * rule somebody has to remember: {@link ZoteroPass.run} is called with the note's path, so by the
 * time anything in this file talks to Zotero the note it is about already exists, already carries
 * every highlight the tablet had, and is already indexed. What this pass adds is a line in the
 * callout, a link per quote and two frontmatter keys -- and a second write of the same note.
 *
 * Two consequences, and both are the point:
 *
 * - **`run` never throws.** A Zotero that is closed, a key that was revoked, a library that answers
 *   an error -- each of them costs the Zotero part of one note and nothing else. The sync that
 *   contains it reports success, because it succeeded.
 * - **A skip is said out loud.** The note carries `not written back: <reason>` (§4) and the run
 *   carries a sentence for the reader (§3.4.2). A sync that silently stopped writing to Zotero the
 *   day a key expired is the failure this module is written against.
 *
 * The picker (§2.3, "ask once") is `deps.ask`, and it is **absent in a background run**. A modal on
 * a sync nobody is watching cannot be answered, and answering it for them -- by picking, or by
 * recording a refusal they never made -- would spend the one question the spec allows. Left
 * unasked, it is asked by the next sync the user starts themselves.
 */

import type { DigestPage, ZoteroDigestLinks } from "./digest-builder";
import { type MatchEvidence, matchZoteroAttachment } from "./zotero-match";
import { sameLibrary, type ZoteroAttachment, type ZoteroClient, ZoteroError, type ZoteroFailure, type ZoteroItem, type ZoteroLibrary } from "./zotero-client";
import { linkFor, type StoredZoteroLinks, wasDeclined, withDeclinedLink, withLink, type ZoteroLink } from "./zotero-links";
import { findLiteratureNote, formatLocalDate, type VaultNoteKeys, zoteroCalloutLine, zoteroDigestLinks, type ZoteroWriteBack } from "./zotero-note";
import { executeWriteBack, planWriteBack } from "./zotero-writeback";

/** What the engine knows about one written note, and this pass needs. */
export interface ZoteroUnit {
	readonly docId: string;
	/** The tablet's name for the document -- the filename half of §2.3's matching. */
	readonly visibleName: string;
	/** Where the note was just written. Excluded from the literature-note search: see {@link findLiteratureNote}. */
	readonly notePath: string;
	/** The digest's own entries, as `buildDigest` handed them out. Empty for a unit with no digest. */
	readonly pages: readonly DigestPage[];
	/** The source page indexes the digest was given -- see `WriteBackInput.covered`. */
	readonly covered: readonly number[];
	/**
	 * MD5 of the source PDF the tablet holds, or `null` where there is none.
	 *
	 * A function because it is a read of the whole file and most units never need it: a document that
	 * is already linked is never matched again (§2.3), and one the user declined is never asked about
	 * again either.
	 */
	md5(): Promise<string | null>;
}

/** The frontmatter keys of §4, in the three states `frontmatter.ts` reads (a key, `null`, absent). */
export interface ZoteroKeys {
	readonly zoteroKey?: string | null;
	/** The group's id for an item in a group library, `null` for the personal one (ticket 26). */
	readonly zoteroLibrary?: string | null;
	readonly citekey?: string | null;
}

/** Everything this pass adds to the note that was just written. */
export interface ZoteroNoteParts {
	/** The `Zotero: …` line of the ownership callout, or `null` for a note with no Zotero part. */
	readonly line: string | null;
	/** Block id -> the `in Zotero` link of that quote (§4). Empty unless write-back put something there. */
	readonly links: ZoteroDigestLinks;
	readonly keys: ZoteroKeys;
	/** Sentences for the run's report (§3.4.2, §3.4.3). Empty when there is nothing to say. */
	readonly notices: readonly string[];
}

/** A note with no Zotero part at all: not linked, not asked, or nothing here may run. */
const NOTHING: ZoteroNoteParts = { line: null, links: {}, keys: { zoteroKey: null, zoteroLibrary: null, citekey: null }, notices: [] };

/**
 * A note whose Zotero identity we cannot tell either way, so the keys it already carries stay.
 *
 * The difference from {@link NOTHING} is `zoteroKey`: absent says "I do not know" and leaves the key
 * alone, `null` says "this document is not linked" and takes it out. An attachment that is gone from
 * the library is the first: the user may put it back, and stripping the key meanwhile would lose the
 * only record of what the document was.
 */
const keysUnknown: ZoteroKeys = {};

export interface ZoteroPass {
	/** The Zotero half for one written note. Never throws, whatever Zotero does. */
	run(unit: ZoteroUnit): Promise<ZoteroNoteParts>;
}

/** One question put to the user (§2.3): which of these attachments is the document they synced? */
export interface ZoteroQuestion {
	readonly visibleName: string;
	readonly evidence: MatchEvidence;
	readonly candidates: readonly ZoteroCandidate[];
}

/** One answer the picker may offer: the attachment, and the paper it hangs under where there is one. */
export interface ZoteroCandidate {
	readonly attachment: ZoteroAttachment;
	readonly item: ZoteroItem | null;
	/** Which library it is in, said only when the client reads more than one (ticket 26): the same file in the personal library and in a group is two answers. */
	readonly library?: string;
}

export interface ZoteroPassDeps {
	readonly client: ZoteroClient;
	/** The link map as `data.json` holds it *now* -- re-read per unit, because this pass writes it. */
	links(): StoredZoteroLinks;
	saveLinks(links: StoredZoteroLinks): Promise<void>;
	/**
	 * The notes of this vault that carry a Zotero key, for the literature-note link (§4).
	 *
	 * The caller filters out the plugin's own notes; this module only excludes the one it has just
	 * written, which is the one case the caller's own index cannot know about yet.
	 */
	vaultNotes(): readonly VaultNoteKeys[];
	/** The account's numeric user id, or `null` when the web connection is not configured -- then there is no web link (§4). */
	webUserId(): Promise<string | null>;
	/** Asks the user which attachment this is. Absent in a background run; see the file header. */
	ask?(question: ZoteroQuestion): Promise<ZoteroAttachment | null>;
	/**
	 * May this vault write into Zotero (spec §5)? Matching and the note's Zotero line run either way;
	 * with `false` the write step is skipped and the note says so. Read once per pass, because the
	 * licence is re-asked per run, not per document.
	 */
	readonly mayWriteBack: boolean;
	now(): Date;
}

// --- what a failure is called ------------------------------------------------------------------

/**
 * The clause the note carries after `not written back: ` (§4), one per way Zotero can say no.
 *
 * Short, and about Zotero rather than about us: the note is read months later by someone who wants
 * to know whether their marks are in their library, and "the desktop app was closed" answers that
 * where "ZoteroError: unreachable" does not.
 */
const REASONS: Record<ZoteroFailure, string> = {
	unreachable: "Zotero could not be reached",
	"not-enabled": "the Zotero desktop app is not letting other applications talk to it",
	denied: "Zotero refused this plugin permission",
	unauthorized: "Zotero rejected the API key",
	"rate-limited": "Zotero asked for a pause",
	"not-found": "the Zotero item was no longer found",
	"read-only": "no write access to the library",
	server: "Zotero answered with an error",
};

/** The `read-only` clause with the library named (ticket 26): "no write access to Lab reading group". */
export function noWriteAccess(libraryName: string): string {
	return `no write access to ${libraryName}`;
}

/** What went wrong, in the note's words. Anything that is not a {@link ZoteroError} keeps its own message. */
export function zoteroSkipReason(error: unknown): string {
	if (error instanceof ZoteroError) return REASONS[error.reason];
	return error instanceof Error ? error.message : String(error);
}

/** §3.4.2: the run says which document was skipped and why. The retry is not a promise, it is how the pass works. */
export function zoteroSkipNotice(visibleName: string, reason: string): string {
	return `Zotero: "${visibleName}" was not written back — ${reason}. The next sync tries again.`;
}

/** §3.4.3, in the spec's own words, with the document named: several of these in one run are otherwise unreadable. */
export function zoteroPartialNotice(visibleName: string, written: number, total: number): string {
	return `Zotero: ${written} of ${total} highlights written for "${visibleName}", retry on next sync.`;
}

/** The line a note gets when the attachment it is linked to is not in the library any more (§2.3). */
export const ZOTERO_GONE_LINE = "Zotero: item no longer found";

/**
 * The line and the reason for a link into a group library the vault has since switched off
 * (ticket 26). The link stays -- switching the group back on is all it takes -- and nothing is
 * matched, read or written meanwhile: a library that is off is off for reading too.
 */
export const ZOTERO_LIBRARY_OFF_LINE = "Zotero: library switched off";
export const LIBRARY_OFF = "its Zotero library is switched off";

// --- the pass ----------------------------------------------------------------------------------

/**
 * The pass for one run.
 *
 * Per run and not per plugin, because of the one piece of state it holds: the library's attachment
 * listing, read once and reused by every document of the run. That listing is the matcher's whole
 * input (§2.3) and it is the single most expensive thing this feature does -- a library of a few
 * thousand items, paged a hundred at a time -- so reading it per document would make a sync of
 * twenty notebooks twenty times as slow at it. Held any longer than a run and it would go stale.
 */
export function createZoteroPass(deps: ZoteroPassDeps): ZoteroPass {
	let attachments: Promise<ZoteroAttachment[]> | null = null;
	let webUserId: Promise<string | null> | null = null;

	const library = (): Promise<ZoteroAttachment[]> => (attachments ??= deps.client.attachments());
	const userId = (): Promise<string | null> => (webUserId ??= deps.webUserId());

	/** The paper this attachment hangs under, or the attachment standing in for one (§4 names a paper). */
	const itemOf = async (attachment: ZoteroAttachment): Promise<ZoteroItem> => {
		const parent = attachment.parentKey === null ? null : await deps.client.parentItem(attachment.parentKey, attachment.library);
		// A standalone PDF *is* the item in Zotero, and `zotero://select` opens it by its own key. The
		// same fallback covers a parent that has been deleted out from under a file Zotero still has.
		return parent ?? { key: attachment.key, library: attachment.library, title: attachment.title, creator: null, year: null, citationKey: null };
	};

	const libraryOn = (library: ZoteroLibrary): boolean => deps.client.libraries.some((enabled) => sameLibrary(enabled, library));

	/** Which attachment this document is, asking the user at most once (§2.3). `null` = no Zotero part. */
	const identify = async (unit: ZoteroUnit): Promise<{ attachment: ZoteroAttachment; link: ZoteroLink } | "gone" | "off" | null> => {
		const links = deps.links();
		const link = linkFor(links, unit.docId);
		const declined = wasDeclined(links, unit.docId);
		// Asked and refused: nothing more to do, and nothing to read the library for.
		if (link === null && declined) return null;
		// A link into a group the vault switched off (ticket 26): left as it is, and not matched again
		// -- the listing would not hold its attachment, and "gone" would be the wrong word for it.
		if (link !== null && !libraryOn(link.library)) return "off";

		const match = matchZoteroAttachment({
			link,
			declined,
			attachments: await library(),
			// Only ever read for a document that might still be matched: an already-linked one is never
			// matched again, so its bytes are never hashed again either.
			md5: link === null ? await unit.md5() : null,
			visibleName: unit.visibleName,
		});

		if (match.kind === "none") return null;
		if (match.kind === "gone") return "gone";
		if (match.kind === "linked") return { attachment: match.attachment, link: link! };
		if (match.kind === "link") return { attachment: match.attachment, link: await store(unit, match.attachment, "hash") };

		// A question, and only where there is somebody to answer it.
		if (deps.ask === undefined) return null;
		// The library is named beside each candidate only when there is more than one to name: with
		// groups on, the same PDF in the personal library and in a group is exactly this question.
		const named = deps.client.libraries.length > 1;
		const candidates = await Promise.all(
			match.candidates.map(async (attachment) => ({
				attachment,
				item: await itemOf(attachment),
				...(named ? { library: deps.client.libraryName(attachment.library) } : {}),
			})),
		);
		const chosen = await deps.ask({ visibleName: unit.visibleName, evidence: match.evidence, candidates });
		if (chosen === null) {
			// Closed without answering. Remembered, or the same picker opens on every sync from here on.
			await deps.saveLinks(withDeclinedLink(deps.links(), unit.docId));
			return null;
		}
		return { attachment: chosen, link: await store(unit, chosen, null) };
	};

	/** Writes a new link. `matchedBy` records a link the user was never asked about -- see {@link ZoteroLink.matchedBy}. */
	const store = async (unit: ZoteroUnit, attachment: ZoteroAttachment, matchedBy: "hash" | null): Promise<ZoteroLink> => {
		const link: ZoteroLink = {
			attachmentKey: attachment.key,
			library: attachment.library,
			...(matchedBy === null ? {} : { matchedBy }),
			annotations: {},
		};
		await deps.saveLinks(withLink(deps.links(), unit.docId, link));
		return link;
	};

	const runUnit = async (unit: ZoteroUnit): Promise<ZoteroNoteParts> => {
		const found = await identify(unit);
		if (found === null) return NOTHING;
		if (found === "gone") {
			// §2.3: the note keeps everything it has and loses its Zotero part, apart from this sentence.
			return { line: ZOTERO_GONE_LINE, links: {}, keys: keysUnknown, notices: [zoteroSkipNotice(unit.visibleName, REASONS["not-found"])] };
		}
		if (found === "off") return { line: ZOTERO_LIBRARY_OFF_LINE, links: {}, keys: keysUnknown, notices: [zoteroSkipNotice(unit.visibleName, LIBRARY_OFF)] };

		const { attachment } = found;
		const item = await itemOf(attachment);
		const notices: string[] = [];

		// Write-back is the only part that may fail on its own terms: the note still names the paper,
		// and says in one clause why its marks are not in the library yet (§3.4.2, §4).
		let link = found.link;
		let writeBack: ZoteroWriteBack;
		if (!deps.mayWriteBack) {
			// The free half (§5): nothing is asked of Zotero here, not even the listing of our own
			// annotations -- a free vault makes no write-shaped request at all.
			writeBack = { kind: "free" };
		} else try {
			const existing = await deps.client.ownAnnotations(attachment.key, attachment.library);
			const plan = planWriteBack({ pages: [...unit.pages], covered: unit.covered, attachmentKey: attachment.key, link, existing });
			const result = await executeWriteBack(deps.client, link, plan);
			link = { ...link, annotations: result.annotations };
			await deps.saveLinks(withLink(deps.links(), unit.docId, link));
			writeBack = { kind: "written", date: formatLocalDate(deps.now()), written: result.written, total: result.total };
			if (result.written < result.total) notices.push(zoteroPartialNotice(unit.visibleName, result.written, result.total));
		} catch (error) {
			// A refused write names the library it was refused by (ticket 26): "no write access to
			// Lab reading group" is something to act on, "to the library" is not.
			const reason = error instanceof ZoteroError && error.reason === "read-only" ? noWriteAccess(deps.client.libraryName(attachment.library)) : zoteroSkipReason(error);
			writeBack = { kind: "not-written", reason };
			notices.push(zoteroSkipNotice(unit.visibleName, reason));
		}

		const line = zoteroCalloutLine({
			item,
			webUserId: await userId(),
			writeBack,
			literatureNote: findLiteratureNote(deps.vaultNotes(), item, new Set([unit.notePath])),
			matchedByHash: found.link.matchedBy === "hash",
		});
		return {
			line,
			links: zoteroDigestLinks(link, unit.pages),
			keys: { zoteroKey: item.key, zoteroLibrary: item.library === "user" ? null : String(item.library.group), citekey: item.citationKey },
			notices,
		};
	};

	return {
		async run(unit) {
			try {
				return await runUnit(unit);
			} catch (error) {
				// The listing, the picker, saving the link: whatever it was, the note is already written
				// and stays exactly as it is. Its keys are left alone rather than stripped -- we did not
				// find out that this document is unlinked, we found out that we cannot ask.
				return { line: null, links: {}, keys: keysUnknown, notices: [zoteroSkipNotice(unit.visibleName, zoteroSkipReason(error))] };
			}
		},
	};
}
