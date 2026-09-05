// The per-page transcript store (issue #117): what a notebook's pages were read as last time, so a
// page whose ink has not moved is not read again.
//
// **The identity lives here, the text lives in the note.** The index row carries hashes only -- no
// transcript text ever enters `data.json`, which `checkpoint()` rewrites in full after every
// document. The note already holds the text, one `### [[...|Page N]]` section per page, and this
// module is the reader for it.
//
// The note anchors by *ordinal*, and an ordinal is not an identity: inserting a page renumbers every
// heading below it. That is why a stored page keeps the `label` it was written under and is found by
// id -- insertion, deletion and reordering are then all the same lookup.
//
// Wayfinder map: `.scratch/issue-117-changed-pages-only/`, tickets 01 and 02.

import { hashString } from "./note-builder";

/**
 * One page the backend read successfully, as the index remembers it.
 *
 * Only successful pages are here. A blank page and a page of typed text are decided from the
 * *current* scene every sync, so remembering them says nothing; a failed page is always retried, so
 * remembering it would only delay the retry.
 */
export interface StoredPage {
	/** The page's own id on the device -- the identity, and the only stable one. */
	id: string;
	/** `pageContentHash` when this text was written: the page's own `.rm` hash. */
	hash: string;
	/** The notebook ordinal its `### ... |Page N]]` heading was written under. */
	label: number;
	/**
	 * How many highlight quotes were folded in above the text (#115 ticket 05), so the parser knows to
	 * drop them. Stored rather than re-derived: folding happens only when the unit has a digest, and
	 * whether the digest still covers the same pages is not something this lookup can see.
	 */
	quotes: number;
}

/** What one unit's note was written from, as far as the store is concerned. */
export interface TranscriptStore {
	/** `transcriptFingerprint` at the time of writing; a mismatch discards every page below. */
	with: string;
	pages: StoredPage[];
}

/**
 * Bumped when the transcription prompt or the per-page pipeline changes -- the sibling of
 * `RENDER_VERSION`, and it is not optional.
 *
 * Without it this feature would take something away. **Today** a prompt improvement reaches every
 * page of every document the user afterwards touches, because a changed document re-transcribes all
 * of its pages. **With the store and no version** it would reach none of them, ever: the pages are
 * unchanged, so they are never read again. This hands that control back.
 */
export const TRANSCRIPT_VERSION = 1;

/** The opaque string a row stores, and compares against on the next sync. */
export function transcriptFingerprint(backendFingerprint: string): string {
	return hashString(`${TRANSCRIPT_VERSION}|${backendFingerprint}`);
}

/** A page the sync is about to transcribe, and what the store needs to know to judge it. */
export interface ReuseCandidate {
	id: string;
	/** `pageContentHash` now. */
	hash: string;
	/**
	 * False for a page whose render would have changed since the note was written -- typed text, or
	 * ink the parser had to place. Those are the ~4 % `reusableTranscript` already refuses to keep
	 * across a `RENDER_VERSION` bump, and the reason the bump exists; here the same veto costs one
	 * page instead of the whole unit.
	 */
	renderSafe: boolean;
}

// The two footnote lines `renderTranscript` writes *after* the last page section -- the collapsed runs
// of pages with no text and of pages that are typed text. They belong to the unit, not to the page
// whose section they happen to follow, so they are trimmed off the tail before anything is split.
const FOOTNOTE_RE = /^\*(?:No text on pages? \d|Pages? \d[^\n]*typed text)/;

/**
 * The transcript region split back into `label -> body`, for the sections that have a heading.
 *
 * Deliberately tolerant of what it cannot recognise: an unparseable region yields fewer entries, and
 * every caller treats a missing entry as "read this page again". It never guesses.
 */
export function transcriptSections(body: string): Map<number, string> {
	// Both footnotes can be present, so this loops rather than trimming once. Trimming here and not
	// per section is what keeps the *last* page readable: its section is the one they follow, and
	// refusing every notebook that has a blank page would have made the store nearly useless.
	let region = body.trimEnd();
	for (;;) {
		const lastBreak = region.lastIndexOf("\n\n");
		if (lastBreak === -1 || !FOOTNOTE_RE.test(region.slice(lastBreak + 2))) break;
		region = region.slice(0, lastBreak);
	}

	const sections = new Map<number, string>();
	for (const chunk of region.split(/\n(?=### )/)) {
		const match = chunk.match(/^### \[\[[^\]\n]*\|Page (\d+)\]\]\n\n([\s\S]*)$/);
		if (match === null) continue;
		sections.set(Number(match[1]), match[2].trimEnd());
	}
	return sections;
}

/**
 * One page's transcribed text, with the folded-in quotes removed, or null when the section is not
 * something this module is willing to read back.
 *
 * `pageBody` joins its parts with a blank line and puts the quote bullets first, so dropping the
 * first blank-line-separated chunk drops exactly the bullets -- the bullet list itself is joined with
 * single newlines and cannot contain one.
 */
export function pageText(section: string, quotes: number): string | null {
	let text = section;
	if (quotes > 0) {
		const split = text.indexOf("\n\n");
		if (split === -1) return null; // quotes were written, so there must be a break after them
		text = text.slice(split + 2);
	}
	// A failed page's callout and the run footnotes are not transcript text. Neither should be here at
	// all -- a failed page is never stored, and `transcriptSections` trims the footnotes off the tail --
	// so their presence means the split went wrong, and a wrong split is the one outcome worth refusing
	// over.
	if (text.startsWith("> [!")) return null;
	if (text.split("\n\n").some((paragraph) => FOOTNOTE_RE.test(paragraph))) return null;
	const trimmed = text.trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * The text each candidate page may keep, by page id. Everything not in the map is transcribed.
 *
 * Fail-soft throughout, as `reusableTranscript` already is: a missing store, a fingerprint that has
 * moved, an unreadable note, a heading that is not there, a body that parses to nothing -- each one
 * falls through to reading the page again. The tie-breaker this whole feature was decided under is
 * that a wrong transcript is undetectable, permanent, and lands in the user's own notes, while a
 * wasted request costs a few seconds; so anything short of certainty re-transcribes.
 */
export function reusableTranscripts(
	store: TranscriptStore | undefined,
	fingerprint: string,
	transcriptBody: string | null,
	candidates: readonly ReuseCandidate[],
): Map<string, string> {
	const reusable = new Map<string, string>();
	if (store === undefined || store.with !== fingerprint || transcriptBody === null) return reusable;

	const stored = new Map(store.pages.map((page) => [page.id, page]));
	const sections = transcriptSections(transcriptBody);
	for (const candidate of candidates) {
		if (!candidate.renderSafe) continue;
		const page = stored.get(candidate.id);
		if (page === undefined || page.hash !== candidate.hash) continue;
		const section = sections.get(page.label);
		if (section === undefined) continue;
		const text = pageText(section, page.quotes);
		if (text !== null) reusable.set(candidate.id, text);
	}
	return reusable;
}
