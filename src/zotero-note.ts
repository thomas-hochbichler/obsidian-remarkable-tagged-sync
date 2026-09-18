/**
 * The Zotero parts of a synced note: spec §4, as strings.
 *
 * Three additions to a note that is otherwise exactly what it was -- the frontmatter keys (in
 * `frontmatter.ts`, because they are merged into the user's block by the same line-level rules as
 * every other key), one line in the ownership callout, and one link per quote. Everything here is
 * arithmetic over what is already known; nothing talks to Zotero, and nothing reads the vault.
 *
 * The two links are different on purpose and both are correct:
 *
 * - `zotero://select/library/items/<itemKey>` opens the **item** in the Zotero app -- the paper,
 *   with its metadata and its notes. That is what a reader following "what is this?" wants.
 * - `zotero://open-pdf/library/items/<attachmentKey>?page=…&annotation=…` opens the **PDF reader**
 *   on the annotation itself. `page` is the physical page (0-based index plus one) because that is
 *   what Zotero's reader counts in, while the label beside it in the note is the document's own
 *   printed number. Two different numbers on one line is what the spec asks for and it is right:
 *   one names the page to a human, the other tells a program which sheet to turn to.
 */

import type { DigestPage, ZoteroDigestLinks } from "./digest-builder";
import type { ZoteroItem, ZoteroLibrary } from "./zotero-client";
import type { ZoteroLink } from "./zotero-links";

/**
 * The library half of a `zotero://` URL: `library` for the personal one, `groups/<id>` for a group
 * (ticket 26). Zotero's own spelling, on both the `select` and the `open-pdf` scheme.
 */
function librarySegment(library: ZoteroLibrary): string {
	return library === "user" ? "library" : `groups/${library.group}`;
}

/** What the callout line says about write-back, which is the one part of it that is about *us*. */
export type ZoteroWriteBack =
	| {
			readonly kind: "written";
			/** Local calendar date, see {@link formatLocalDate}. */
			readonly date: string;
			readonly written: number;
			readonly total: number;
	  }
	| { readonly kind: "not-written"; readonly reason: string }
	/** Write-back is Pro (spec §5) and this vault has the free half: nothing was tried. */
	| { readonly kind: "free" };

/** Everything the callout line needs. Assembled by the caller, because each part comes from elsewhere. */
export interface ZoteroNoteInfo {
	/** The **parent item**, not the attachment: the line names the paper. */
	readonly item: ZoteroItem;
	/** The account's numeric user id, or null when the web connection is not configured -- then there is no web link. */
	readonly webUserId: string | null;
	readonly writeBack: ZoteroWriteBack;
	/** The vault's own note about this paper, as its link text -- see {@link findLiteratureNote}. */
	readonly literatureNote: string | null;
	/**
	 * Was this link made by the plugin alone, off the file's hash (§2.3)?
	 *
	 * The one clause of this line that is about the plugin's own decision rather than about the paper.
	 * A hash hit is identity and it is not asked about -- so the note is the only place the user can
	 * ever find out that something linked their document to something in their library, and that has
	 * to be legible after the sync that did it is long forgotten.
	 */
	readonly matchedByHash?: boolean;
}

/**
 * A local calendar date, `2026-09-11`.
 *
 * Local rather than UTC for the same reason `remarkable-synced` is: the person reading it is sitting
 * in front of the vault, and a sync at half past midnight is not yesterday to them. No time of day --
 * the line records that it happened, and a second sync the same day says nothing new.
 */
export function formatLocalDate(date: Date): string {
	const pad = (part: number): string => String(part).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * `[` and `]` inside a link label end the label early and leave the rest as loose text with a bare
 * URL after it. Zotero titles carry them routinely -- `[Preprint]`, `[in press]`.
 */
function escapeLabel(text: string): string {
	return text.replace(/[[\]]/g, "\\$&");
}

/**
 * How the item is named in the note: `Smith 2024 · Best Practices für Prompting`.
 *
 * Each part is dropped where Zotero does not have it rather than replaced by a placeholder -- a
 * webpage saved without an author is not "Unknown 2024", it is its title. An item with no title at
 * all falls back to its key, which is at least the thing the link opens.
 */
export function itemLabel(item: ZoteroItem): string {
	const cite = [item.creator, item.year].filter((part) => part !== null && part !== "").join(" ");
	const title = item.title.trim();
	if (title === "") return cite === "" ? item.key : cite;
	return cite === "" ? title : `${cite} · ${title}`;
}

/**
 * The write-back clause.
 *
 * A partial run names both numbers: "12 of 30" is the difference between a sync that finished and
 * one that was cut short, and the note is where the reader finds out that the paper in front of
 * them is missing eighteen of their own marks. It does not repeat the status line's "retry on next
 * sync" -- the note is a record of what happened, not a notice about what will.
 *
 * The free clause says where the highlights *are* before it says what would put them in Zotero: a
 * reader who never buys Pro should still find the sentence true, and not an error message.
 */
function writeBackPhrase(writeBack: ZoteroWriteBack): string {
	if (writeBack.kind === "free") return "highlights stay in the vault — writing them into Zotero is Tagged Sync Pro";
	if (writeBack.kind === "not-written") return `not written back: ${writeBack.reason}`;
	const count = writeBack.written < writeBack.total ? `${writeBack.written} of ${writeBack.total} ` : "";
	return `${count}highlights written back ${writeBack.date}`;
}

/**
 * The `Zotero: …` line of the ownership callout (without the callout's own `> `, which is
 * `note-builder.ts`'s).
 *
 * One line and not a section: it is a fact about the note, and the callout is where this note
 * already says what it is and who wrote it.
 */
export function zoteroCalloutLine(info: ZoteroNoteInfo): string {
	const { item } = info;
	const parts = [`[${escapeLabel(itemLabel(item))}](zotero://select/${librarySegment(item.library)}/items/${item.key})`];
	// A group's web page needs no user id, but the same gate holds: a vault that does not talk to
	// zotero.org has no business printing a zotero.org URL into a note.
	if (info.webUserId !== null) {
		const web = item.library === "user" ? `users/${info.webUserId}` : `groups/${item.library.group}`;
		parts.push(`[web library](https://www.zotero.org/${web}/items/${item.key})`);
	}
	if (info.matchedByHash === true) parts.push("matched by file hash");
	parts.push(writeBackPhrase(info.writeBack));
	if (info.literatureNote !== null) parts.push(`literature note: [[${info.literatureNote}]]`);
	return `Zotero: ${parts.join(" · ")}`;
}

/** One note in the vault, as much of it as this module is allowed to know. */
export interface VaultNoteKeys {
	readonly path: string;
	/** What a wikilink to it says -- its basename, or its path where the basename is ambiguous. The caller's call, because only Obsidian can answer it. */
	readonly link: string;
	readonly zoteroKey: string | null;
	readonly citekey: string | null;
}

/**
 * The vault's own note about this paper -- a ZotLit or Zotero Integration literature note, or one
 * the user wrote by hand -- as the text a wikilink to it carries. Null when there is none.
 *
 * Found by the frontmatter keys alone, never by reading the note, and nothing is ever written into
 * it: it is the user's note about the paper, and this plugin's business with it ends at pointing
 * at it.
 *
 * `exclude` is not optional and it is not a convenience. Every note **we** write now carries
 * `zotero-key` as well, so a document synced under two mapped tags would otherwise find its own
 * twin -- or itself -- and print "literature note: [[…]]" pointing at a generated note. The caller
 * passes the paths it wrote; forgetting them is a wrong link, not a missing one.
 *
 * The key is tried before the citekey because it is Zotero's own identity and cannot be duplicated
 * by hand; among several matches the lowest path wins, so the line does not change when Obsidian's
 * cache hands them over in a different order.
 */
export function findLiteratureNote(notes: readonly VaultNoteKeys[], item: ZoteroItem, exclude: ReadonlySet<string>): string | null {
	const candidates = notes.filter((note) => !exclude.has(note.path));
	const byKey = candidates.filter((note) => note.zoteroKey === item.key);
	const byCitekey = item.citationKey === null ? [] : candidates.filter((note) => note.citekey === item.citationKey);
	const matches = byKey.length > 0 ? byKey : byCitekey;
	return matches.length === 0 ? null : [...matches].sort((a, b) => (a.path < b.path ? -1 : 1))[0].link;
}

/** Where Zotero's reader opens for one annotation. `page` is the physical sheet, 1-based; see the file header. */
export function openPdfUrl(attachmentKey: string, pageIndex: number, annotationKey: string, library: ZoteroLibrary = "user"): string {
	return `zotero://open-pdf/${librarySegment(library)}/items/${attachmentKey}?page=${pageIndex + 1}&annotation=${annotationKey}`;
}

/** The web reader a vault without the desktop app opens its quotes in: whose library, and which item the PDF hangs under. */
export interface WebReader {
	readonly username: string;
	/** The parent item's key; a standalone PDF is its own item, and then this is the attachment key. */
	readonly itemKey: string;
}

/**
 * Where zotero.org's reader opens the attachment. For a vault that has no desktop app: a
 * `zotero://` link there is "Get an app to open this 'zotero' link" on Windows and nothing on
 * the web, and this is the one reader such a user has.
 *
 * No page and no annotation: the web reader's URL takes neither (`?page=` is silently dropped,
 * tried 2026-09-18), so it opens on the first sheet with every annotation in its sidebar. The
 * personal library hangs under the username -- `/users/<id>/…/reader` is a 404, unlike the item
 * page -- so this link needs a name the callout's web link does not.
 */
export function webReaderUrl(web: WebReader, attachmentKey: string, library: ZoteroLibrary): string {
	const owner = library === "user" ? web.username : `groups/${library.group}`;
	const item = web.itemKey === attachmentKey ? `items/${attachmentKey}` : `items/${web.itemKey}/attachment/${attachmentKey}`;
	return `https://www.zotero.org/${owner}/${item}/reader`;
}

/**
 * The `in Zotero` link of every digest entry that has one, for {@link renderDigest}.
 *
 * Highlights only. A margin note becomes a sticky in Zotero all the same, but its entry in the note
 * is a callout whose locator rides on the title line, and spec §4 leaves it without a Zotero link:
 * what the reader would follow it for -- their own handwriting -- is in the vault's own PDF, which
 * the entry already points at, and a sticky in someone else's reader shows the transcript we made.
 *
 * An annotation the user deleted in Zotero is left out: we remember it as deleted and never create
 * it again (§3.3), so the link would open a reader on nothing.
 */
export function zoteroDigestLinks(link: ZoteroLink, pages: readonly DigestPage[], web: WebReader | null = null): ZoteroDigestLinks {
	const links: Record<string, string> = {};
	for (const page of pages) {
		const source = page.source;
		if (source === null) continue;
		for (const highlight of page.highlights) {
			const annotation = link.annotations[highlight.id];
			if (annotation === undefined || annotation.deleted === true) continue;
			links[highlight.id] = web === null ? openPdfUrl(link.attachmentKey, source.index, annotation.key, link.library) : webReaderUrl(web, link.attachmentKey, link.library);
		}
	}
	return links;
}
