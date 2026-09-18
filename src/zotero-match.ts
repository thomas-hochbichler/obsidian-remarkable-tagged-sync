/**
 * Which Zotero attachment a synced reMarkable document is, when nobody has said so yet.
 *
 * Spec §2.3, and the shape of that table is the whole design: **identity beats similarity, and a
 * question is asked once.** A document that Send put on the tablet was linked at upload and never
 * comes here at all; one that arrived some other way -- dragged in through the reMarkable app, mailed
 * to the device, synced from another machine -- is recognised by what it *is* (the bytes), asked
 * about when the bytes are ambiguous, and otherwise left alone.
 *
 * The rule that is easiest to get wrong is the one that is not written as code: **titles are never
 * compared.** "Smith 2024 - Prompting.pdf" on the tablet and "Prompting (Smith 2024).pdf" in Zotero
 * are the same paper to a human and are not evidence of anything to this function. A wrong link is
 * worse than no link: it writes somebody's highlights onto somebody else's paper, and the user has
 * no reason to look for it.
 *
 * Pure, and deliberately not async: every input is already in hand when a document is synced, and a
 * decision that cannot reach the network is a decision that can be driven through all nine rows of
 * the table in a unit test.
 */

import type { ZoteroAttachment } from "./zotero-client";
import type { ZoteroLink } from "./zotero-links";

/** Why an attachment is being proposed. The note and the picker word it; the matcher only decides. */
export type MatchEvidence =
	/** The tablet's bytes hash to this attachment's file. Identity, not resemblance. */
	| "hash"
	/** The tablet document's name is this attachment's filename. A coincidence is possible, so it is asked. */
	| "filename";

export type ZoteroMatch =
	/** Already linked, and the attachment is still there. Nothing is re-matched, ever (§2.3). */
	| { readonly kind: "linked"; readonly attachment: ZoteroAttachment }
	/**
	 * Linked to something Zotero no longer has: trashed, or deleted. The note keeps everything it has
	 * and loses its Zotero part; write-back does not run. The link itself stays, because the user may
	 * put the item back and because nothing else would remember what this document was.
	 */
	| { readonly kind: "gone"; readonly attachmentKey: string }
	/** One attachment has these exact bytes. Linked without asking, and the note says how (§2.3). */
	| { readonly kind: "link"; readonly attachment: ZoteroAttachment; readonly evidence: MatchEvidence }
	/** Put to the user once, with what there is to go on. */
	| { readonly kind: "ask"; readonly candidates: ZoteroAttachment[]; readonly evidence: MatchEvidence }
	/** Nothing to go on, or the user has already been asked. The note is written without a Zotero part. */
	| { readonly kind: "none" };

export interface MatchInput {
	/** What `data.json` holds for this document, or `null` when it holds nothing usable. */
	readonly link: ZoteroLink | null;
	/** True when the user has already been asked about this document and did not answer (§2.3, "ask once"). */
	readonly declined: boolean;
	/** Every PDF attachment in the library. Trashed ones are not in it -- which is what makes "gone" a fact rather than a guess. */
	readonly attachments: ZoteroAttachment[];
	/**
	 * MD5 of the bytes the tablet holds, or `null` where they were not read.
	 *
	 * The bytes, not our render: the tablet keeps the file it was given, byte for byte -- measured
	 * against Zotero's own storage on 2026-09-11, same 913830 bytes and same hash -- which is what
	 * makes a hash hit identity rather than evidence.
	 */
	readonly md5: string | null;
	/** The tablet document's name, as the device reports it -- commonly still carrying `.pdf`. */
	readonly visibleName: string;
}

/**
 * Does this tablet document's name name this file?
 *
 * Compared with and without a trailing `.pdf` because the reMarkable app keeps the extension when a
 * file is dragged in and drops it in other paths -- seen both ways on a real device (ticket 10). The
 * comparison is case-insensitive and trims, because a filename that differs only in case is the same
 * file on the two systems this plugin runs on, and because neither spelling is the user's doing.
 *
 * It is a *filename* comparison and nothing more. It is never applied to an item title: see the
 * warning at the top of this file.
 */
function namesTheSameFile(filename: string | null, visibleName: string): boolean {
	if (filename === null || filename === "") return false;
	const strip = (name: string) => name.trim().replace(/\.pdf$/i, "").toLowerCase();
	return strip(filename) === strip(visibleName);
}

/**
 * What to do about one synced document.
 *
 * The order of the branches is the order of the spec's table, and it is also an order of confidence:
 * a decision already made, then the bytes, then the name. Nothing below the bytes may overrule them.
 */
export function matchZoteroAttachment({ link, declined, attachments, md5, visibleName }: MatchInput): ZoteroMatch {
	// A link is a decision -- made by Send at upload, by a hash, or by the user in a picker -- and it
	// is never revisited. Re-matching a linked document would undo a correction the user made by hand
	// the moment the library grew a file with the same name.
	if (link !== null) {
		const attachment = attachments.find((candidate) => candidate.key === link.attachmentKey);
		return attachment ? { kind: "linked", attachment } : { kind: "gone", attachmentKey: link.attachmentKey };
	}

	if (declined) return { kind: "none" };

	// Identity. A linked file on the web connection has no `md5` at all, so `null === null` would
	// match every one of them to a document whose bytes could not be read -- hence both guards.
	const sameBytes = md5 === null ? [] : attachments.filter((candidate) => candidate.md5 !== null && candidate.md5 === md5);
	if (sameBytes.length === 1) return { kind: "link", attachment: sameBytes[0], evidence: "hash" };
	// The same file attached to two items is a real library, not a corrupt one: a paper filed under
	// two entries, or a duplicate the user has not merged. The bytes cannot say which entry they
	// meant, and picking either would be a coin toss the user never sees.
	if (sameBytes.length > 1) return { kind: "ask", candidates: sameBytes, evidence: "hash" };

	// Resemblance, and treated as such: exactly one, and still asked. Two files called `paper.pdf` in
	// one library say nothing at all, so they are not even offered.
	const sameName = attachments.filter((candidate) => namesTheSameFile(candidate.filename, visibleName));
	if (sameName.length === 1) return { kind: "ask", candidates: sameName, evidence: "filename" };

	return { kind: "none" };
}
