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
import { renderFilename, sameLibrary, type ZoteroAttachment, type ZoteroClient, ZoteroError, type ZoteroFailure, type ZoteroItem, type ZoteroLibrary, type ZoteroNote } from "./zotero-client";
import { type LinkedRender, linkFor, type StoredZoteroLinks, wasDeclined, withDeclinedLink, withLink, type ZoteroLink } from "./zotero-links";
import { findLiteratureNote, formatLocalDate, openRenderUrl, type VaultNoteKeys, webReaderUrl, zoteroCalloutLine, zoteroDigestLinks, type ZoteroNoteInfo, type ZoteroWriteBack } from "./zotero-note";
import { type AddedPagesScope, executeNotes, formerPapers, hasAddedText, hasLiveNotes, planNotes } from "./zotero-notes";
import { judgeRender, NO_PARENT_ITEM, planRender, STORAGE_FULL } from "./zotero-render";
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
	/** The pages added on the tablet this unit speaks for -- see {@link AddedPagesScope}. Absent: none. */
	readonly addedPages?: AddedPagesScope;
	/** This write recreates a note the user deleted by hand -- see `WriteBackInput.noteWasDeleted`. */
	readonly noteWasDeleted?: boolean;
	/**
	 * The render exactly as written to the vault, for a whole-document unit only: a page-scoped one
	 * carries none (Zotero spec §4.1). Its MD5 is a function because only *Add the render to Zotero*
	 * ever asks for it.
	 */
	readonly render?: { readonly bytes: Uint8Array; md5(): string };
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
	/**
	 * The zotero.org username, only for a vault whose one reader is the web one: then every quote
	 * links into zotero.org's reader, because a `zotero://` link has nothing to open it. `null` where
	 * the desktop app is connected, and the quotes keep their `zotero://open-pdf` link.
	 */
	webReaderUser(): Promise<string | null>;
	/** Asks the user which attachment this is. Absent in a background run; see the file header. */
	ask?(question: ZoteroQuestion): Promise<ZoteroAttachment | null>;
	/**
	 * May this vault write into Zotero (spec §5)? Matching and the note's Zotero line run either way;
	 * with `false` the write step is skipped and the note says so. Read once per pass, because the
	 * licence is re-asked per run, not per document.
	 */
	readonly mayWriteBack: boolean;
	/**
	 * *Write text to Zotero* (Zotero spec §5): `false` creates, patches and trashes no annotation and no
	 * note, and leaves what is in Zotero as it is. Asked only where {@link mayWriteBack} is `true`.
	 */
	readonly writeText: boolean;
	/** *Add the render to Zotero* (Zotero spec §4). Asked only where {@link mayWriteBack} is `true`; independent of {@link writeText}. */
	readonly addRender: boolean;
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

/**
 * The `read-only` clause with the library named (ticket 26): "no write access to Lab reading group".
 *
 * Over zotero.org the thing refused is the *key*, and the fix is a checkbox on the key's own page
 * (e2e 2026-09-18: a key made without "Allow write access" read the library fine and was refused
 * on the first write). Naming the library alone would send the user to look at a membership they
 * do not lack.
 */
export function noWriteAccess(libraryName: string, connection?: "local" | "web"): string {
	if (connection === "web") return `the API key has no write access to ${libraryName} (allow it under zotero.org → Settings → Security)`;
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

/** §3.4.3, in the spec's own words, with the document named: several of these in one run are otherwise unreadable. Notes count with the highlights (Zotero spec §6). */
export function zoteroPartialNotice(visibleName: string, written: number, total: number): string {
	return `Zotero: ${written} of ${total} highlights and notes written for "${visibleName}", retry on next sync.`;
}

/** The clause of the added-page skip that is not a Zotero failure (Zotero spec §3); the other, {@link NO_PARENT_ITEM}, the render shares. */
export const NO_NOTES_ACCESS = "the API key has no notes access";

/** The one skip the user fixes outside the plugin, and the key they already have is enough (ticket 09 #2). */
export function zoteroNotesAccessNotice(visibleName: string): string {
	return `Zotero: the pages you added to "${visibleName}" were not written back — your zotero.org API key has no notes access. Allow it for the same key under zotero.org → Settings → Security; no new key is needed.`;
}

/** A render upload that failed (Zotero spec §4.3); the highlights are not affected, so the notice says only this. */
export function zoteroRenderNotice(visibleName: string, reason: string): string {
	return `Zotero: the render of "${visibleName}" was not added — ${reason}. The next sync tries again.`;
}

/** zotero.org answered 413: nothing the next sync can fix by itself (§10 P6). */
export function zoteroStorageFullNotice(visibleName: string): string {
	return `Zotero: the render of "${visibleName}" was not added — your Zotero Storage at zotero.org is full. Free some space there, or switch off "Add the render to Zotero".`;
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
	let webReaderUser: Promise<string | null> | null = null;

	const library = (): Promise<ZoteroAttachment[]> => (attachments ??= deps.client.attachments());
	const userId = (): Promise<string | null> => (webUserId ??= deps.webUserId());
	const readerUser = (): Promise<string | null> => (webReaderUser ??= deps.webReaderUser());

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

	/**
	 * A failed write, in the note's words. A refused one names the library it was refused by (ticket
	 * 26): "no write access to Lab reading group" is something to act on, "to the library" is not.
	 */
	const refusal = (error: unknown, library: ZoteroLibrary): string =>
		error instanceof ZoteroError && error.reason === "read-only" ? noWriteAccess(deps.client.libraryName(library), error.connection) : zoteroSkipReason(error);

	/** Our notes under a paper that may be gone: erased with its children, they are simply not there. */
	const notesUnder = async (paperKey: string, library: ZoteroLibrary): Promise<ZoteroNote[]> => {
		try {
			return await deps.client.ownNotes(paperKey, library);
		} catch (error) {
			if (error instanceof ZoteroError && error.reason === "not-found") return [];
			throw error;
		}
	};

	/**
	 * The pages added on the tablet, as notes under the paper (Zotero spec §2), after the highlights
	 * went in. Its own failures stay its own: the highlights are written whatever happens here, and
	 * the note says in a clause of its own why the added pages are not (§6).
	 *
	 * Nothing at all is asked of Zotero for a document with no added page to write and no note of ours
	 * to keep up -- which is almost every document, so this costs them nothing. A unit that speaks for
	 * no added page (*Your notes on PDFs* off, a failed build) touches nothing; the next one that does
	 * reconciles (Zotero spec §3).
	 */
	const writeAddedPages = async (
		unit: ZoteroUnit,
		attachment: ZoteroAttachment,
		item: ZoteroItem,
		link: ZoteroLink,
	): Promise<{ link: ZoteroLink; written: number; total: number; reason?: string; notices: string[] }> => {
		const nothing = { link, written: 0, total: 0, notices: [] };
		const scope = unit.addedPages ?? "none";
		if (scope === "none" || (!hasAddedText(unit.pages, scope) && !hasLiveNotes(link))) return nothing;
		// Zotero hangs notes on papers only. Re-read every sync, so *Create Parent Item* heals it (ticket 09 #1).
		const paperKey = attachment.parentKey;
		if (paperKey === null) return { ...nothing, reason: NO_PARENT_ITEM };
		// Frozen while the paper is in Zotero's trash, and carried on once it is restored (§10 P4).
		if (item.trashed) return nothing;
		try {
			// Only the personal library: an all-groups key reads a group's notes anyway (ticket 09 #2).
			if (link.library === "user" && (await deps.client.notesAccess()) === false) {
				return { ...nothing, reason: NO_NOTES_ACCESS, notices: [zoteroNotesAccessNotice(unit.visibleName)] };
			}
			const existing = await deps.client.ownNotes(paperKey, link.library);
			// Where the PDF hung before it was moved: our notes there follow it (ticket 09 #4).
			for (const former of formerPapers(link, paperKey)) existing.push(...(await notesUnder(former, link.library)));
			const plan = planNotes({ pages: unit.pages, scope, paperKey, link, existing, noteWasDeleted: unit.noteWasDeleted });
			const result = await executeNotes(deps.client, link, plan);
			const next: ZoteroLink = Object.keys(result.notes).length === 0 ? link : { ...link, notes: result.notes };
			await deps.saveLinks(withLink(deps.links(), unit.docId, next));
			return { link: next, written: result.written, total: result.total, notices: [] };
		} catch (error) {
			const reason = refusal(error, link.library);
			return { ...nothing, reason, notices: [zoteroSkipNotice(unit.visibleName, reason)] };
		}
	};

	/**
	 * The render as an attachment under the paper (Zotero spec §4), after the text went in and
	 * whatever happened to it: *Write text to Zotero* does not govern the render. Its failures stay its
	 * own, like the added pages': a clause on the line, a notice, and the next sync tries again.
	 */
	const addRender = async (unit: ZoteroUnit, attachment: ZoteroAttachment, link: ZoteroLink): Promise<{ link: ZoteroLink; render?: ZoteroNoteInfo["render"]; notices: string[] }> => {
		// Only switched on is the render hashed: a few megabytes per whole-document sync otherwise for nothing.
		const switchedOn = deps.mayWriteBack && deps.addRender;
		const md5 = switchedOn ? (unit.render?.md5() ?? null) : null;
		const plan = planRender({
			switchedOn,
			md5,
			library: link.library,
			paperKey: attachment.parentKey,
			web: deps.client.renders !== null,
			recorded: link.render,
			noteWasDeleted: unit.noteWasDeleted,
		});
		const done = async (): Promise<{ link: ZoteroLink; render?: ZoteroNoteInfo["render"]; notices: string[] }> => ({ link, ...(await renderLink(link)), notices: [] });
		if (plan.kind === "not-added") return { link, render: { reason: plan.reason }, notices: [] };
		if (plan.kind === "none" || plan.kind === "unchanged") return await done();
		// The planner finds, creates or checks only with both in hand.
		const renders = deps.client.renders!;
		const file = { bytes: unit.render!.bytes, md5: md5!, filename: renderFilename(attachment.filename ?? unit.visibleName) };
		const save = async (next: ZoteroLink): Promise<ZoteroLink> => {
			await deps.saveLinks(withLink(deps.links(), unit.docId, next));
			return next;
		};
		try {
			const found = plan.kind === "find" ? await renders.find(plan.parentKey) : null;
			let render: LinkedRender;
			let holds: string | null = null;
			let filename = file.filename;
			if (plan.kind === "check" || found !== null) {
				render = plan.kind === "check" ? plan.render : { key: found!.key, parentKey: plan.parentKey };
				const judged = judgeRender(file.md5, render, plan.kind === "check" ? await renders.state(render.key) : found);
				if (judged.kind === "theirs") {
					link = await save({ ...link, render: { ...render, theirs: judged.theirs } });
					return await done();
				}
				if (judged.kind === "unchanged") {
					link = await save({ ...link, render: { ...render, md5: file.md5 } });
					return await done();
				}
				holds = judged.holds;
				filename = judged.filename ?? filename;
			} else {
				render = { key: await renders.create(plan.parentKey, filename), parentKey: plan.parentKey };
				// Recorded before the upload, so one that fails fills this attachment next time rather than
				// leaving it empty beside a second one.
				link = await save({ ...link, render });
			}
			const outcome = await renders.upload(render.key, { ...file, filename }, holds);
			if (outcome === "quota") return { link, render: { reason: STORAGE_FULL }, notices: [zoteroStorageFullNotice(unit.visibleName)] };
			// `changed`: the file changed between our read and the upload. Left as it is; the next sync reads it again.
			if (outcome !== "changed") link = await save({ ...link, render: { ...render, md5: file.md5 } });
			return await done();
		} catch (error) {
			const reason = refusal(error, "user");
			return { link, render: { reason }, notices: [zoteroRenderNotice(unit.visibleName, reason)] };
		}
	};

	/**
	 * The line's link to a render that has a file: the desktop reader, or zotero.org's where that is the
	 * vault's one reader. One the user made theirs is said so, file or not.
	 */
	const renderLink = async (link: ZoteroLink): Promise<{ render?: ZoteroNoteInfo["render"] }> => {
		const render = link.render;
		if (render === undefined || (render.md5 === undefined && render.theirs === undefined)) return {};
		const username = await readerUser();
		const url = username === null ? openRenderUrl(render.key) : webReaderUrl({ username, itemKey: render.parentKey }, render.key, "user");
		return { render: { url, ...(render.theirs === undefined ? {} : { theirs: render.theirs }) } };
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
		let addedPagesNotWritten: string | undefined;
		if (!deps.mayWriteBack) {
			// The free half (§5): nothing is asked of Zotero here, not even the listing of our own
			// annotations -- a free vault makes no write-shaped request at all.
			writeBack = { kind: "free" };
		} else if (!deps.writeText) {
			// Switched off: not even our own annotations are listed. Switched on again, the next sync of
			// this document reconciles (§10 P7 makes sure there is one).
			writeBack = { kind: "off" };
		} else try {
			const existing = await deps.client.ownAnnotations(attachment.key, attachment.library);
			const plan = planWriteBack({ pages: [...unit.pages], covered: unit.covered, attachmentKey: attachment.key, link, existing, noteWasDeleted: unit.noteWasDeleted });
			const result = await executeWriteBack(deps.client, link, plan);
			link = { ...link, annotations: result.annotations };
			await deps.saveLinks(withLink(deps.links(), unit.docId, link));
			const added = await writeAddedPages(unit, attachment, item, link);
			link = added.link;
			addedPagesNotWritten = added.reason;
			notices.push(...added.notices);
			const written = result.written + added.written;
			const total = result.total + added.total;
			writeBack = { kind: "written", date: formatLocalDate(deps.now()), written, total };
			if (written < total) notices.push(zoteroPartialNotice(unit.visibleName, written, total));
		} catch (error) {
			writeBack = { kind: "not-written", reason: refusal(error, attachment.library) };
			notices.push(zoteroSkipNotice(unit.visibleName, writeBack.reason));
		}

		const rendered = await addRender(unit, attachment, link);
		link = rendered.link;
		notices.push(...rendered.notices);

		const line = zoteroCalloutLine({
			item,
			webUserId: await userId(),
			writeBack,
			...(addedPagesNotWritten === undefined ? {} : { addedPagesNotWritten }),
			...(rendered.render === undefined ? {} : { render: rendered.render }),
			literatureNote: findLiteratureNote(deps.vaultNotes(), item, new Set([unit.notePath])),
			matchedByHash: found.link.matchedBy === "hash",
		});
		const username = await readerUser();
		return {
			line,
			links: zoteroDigestLinks(link, unit.pages, username === null ? null : { username, itemKey: item.key }),
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
