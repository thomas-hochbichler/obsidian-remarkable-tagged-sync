// What each digest entry becomes in Readwise (Readwise spec §1.3, §11 P8, P9, P12). Pure: the
// recorder (ticket 18) decides what is pending; this only says what the tablet shows right now.

import type { DigestHighlight, DigestPage } from "./digest-builder";

interface EntryPlace {
	/** `pageId:crdtId` -- the record's key in the state, and the end of `url`. */
	readonly key: string;
	/**
	 * A margin note of its own or a page added on the tablet, not a highlight: the key cannot tell them
	 * apart, and with margin notes off the recorder leaves these alone (spec §11 P20).
	 */
	readonly margin?: true;
	readonly location: number;
	/** What a new record's `highlight_url` is: its update key in Readwise, and the link back to the page in the vault. */
	readonly url: string;
}

/** One digest entry as Readwise should hold it. */
export interface ReadableEntry extends EntryPlace {
	readonly text: string;
	/** A highlight's margin notes; absent when it has none -- Readwise refuses `""` (spec §1.3). */
	readonly note?: string;
	/** A margin note written at this highlight could not be read this sync: keep the note Readwise holds (spec §11 P12). */
	readonly noteUnread?: true;
	readonly unread?: never;
}

/**
 * An entry whose handwriting -- or sentence -- could not be read this sync (spec §11 P12): it says
 * nothing about what the tablet holds, so the recorder leaves this one record as it is. Never the
 * whole page: the entries beside it were read.
 */
export interface UnreadEntry extends EntryPlace {
	readonly unread: true;
}

export type ReadwiseEntry = ReadableEntry | UnreadEntry;

/** A stretch of the sentence to print in bold, as `[start, end)`. */
type Span = readonly [number, number];

/**
 * Where the marked runs sit in the sentence, merged where they touch or overlap: the device keeps
 * every version of a selection the reader adjusted, so one passage often arrives as several runs over
 * the same words. A run the sentence does not contain is left out.
 */
function boldSpans({ sentence, marked }: DigestHighlight): Span[] {
	const found = marked
		.map((run) => run.trim())
		.filter((run) => run !== "" && sentence.includes(run))
		.map((run): Span => {
			const start = sentence.indexOf(run);
			return [start, start + run.length];
		})
		.sort((a, b) => a[0] - b[0]);
	const spans: Span[] = [];
	for (const [start, end] of found) {
		const last = spans[spans.length - 1];
		if (last && start <= last[1]) spans[spans.length - 1] = [last[0], Math.max(last[1], end)];
		else spans.push([start, end]);
	}
	return spans;
}

function withBold(text: string, spans: readonly Span[]): string {
	let out = "";
	let at = 0;
	for (const [start, end] of spans) {
		out += `${text.slice(at, start)}**${text.slice(start, end)}**`;
		at = end;
	}
	return out + text.slice(at);
}

/** Readwise's limit on `text` and `note`, in characters (research 01 §1). */
const TEXT_LIMIT = 8191;

/** What one bold run adds to a text: its opening and closing `**`. */
const BOLD_MARKS = "****".length;

/**
 * The text with `spans` in bold, cut so that the result -- bold marks included -- stays within
 * Readwise's limit, ending in "…" (spec §11 P9). A run past the cut is dropped and a run the cut goes
 * through is closed at it: never an unclosed `**`.
 */
function fitted(text: string, spans: readonly Span[] = []): string {
	if (text.length + BOLD_MARKS * spans.length <= TEXT_LIMIT) return withBold(text, spans);
	// Each run kept costs four characters of the text, and fewer characters keep fewer runs: the
	// fewest runs whose marks still fit beside what is left.
	const room = (kept: number) => TEXT_LIMIT - 1 - BOLD_MARKS * kept;
	let kept = 0;
	while (spans.filter(([start]) => start < room(kept)).length > kept) kept++;
	const cut = text.slice(0, room(kept)).trimEnd();
	return `${withBold(cut, spans.map(([start, end]): Span => [start, Math.min(end, cut.length)]).filter(([start, end]) => start < end))}…`;
}

/** The sentence with every marked run found in it in bold. */
function boldText(highlight: DigestHighlight): string {
	return fitted(highlight.sentence, boldSpans(highlight));
}

/** The margin notes written at a highlight: the readable ones as its note, and whether any was not read. */
function nestedNote({ notes }: DigestHighlight): { note?: string; noteUnread?: true } {
	const note = fitted(notes.map((nested) => nested.text).filter((text) => text !== "").join("\n\n"));
	return { ...(note === "" ? {} : { note }), ...(notes.some((nested) => nested.text === "") ? { noteUnread: true as const } : {}) };
}

/** Where a unit's links lead: the vault, and the unit's render by its file name. */
export interface LinkTarget {
	readonly vault: string;
	readonly pdf: string;
}

/**
 * Readwise's `highlight_url` for a new record: the update key, so frozen at the first record, and the
 * link back (ticket 27). Obsidian's own `open`, because a phone has no plugin to answer anything else.
 * The render, not the note: its name holds only ids, so a `#` in a document's name and a renamed note
 * cannot break the link. `highlight` is for Readwise, which needs one link per highlight on a page.
 */
export function highlightUrl({ vault, pdf }: LinkTarget, docId: string, key: string, embedPage: number): string {
	return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(`${pdf}#page=${embedPage}`)}&highlight=${encodeURIComponent(`${docId}/${key}`)}`;
}

/** The key of a record 1.11.0-beta.1 pushed, which stored none: a new one would make Readwise file the highlight twice. */
export function betaHighlightUrl(docId: string, key: string): string {
	return `obsidian://tagged-sync?highlight=${docId}/${key}`;
}

/** The page a key belongs to: everything before its first colon (spec §1.3). */
export function pageIdOf(key: string): string {
	return key.slice(0, key.indexOf(":"));
}

/** A printed label that is a page number, or null: "xii", "A-3" and "0" are none. */
function pageNumber(label: string | null): number | null {
	const trimmed = label?.trim() ?? "";
	return /^[1-9]\d*$/.test(trimmed) ? Number(trimmed) : null;
}

/**
 * Readwise's page number for an entry (spec §11 P8): from the document, never from the unit, because a
 * page-tag unit embeds its one page as page 1 and a number that differs between the units of one
 * document would be re-pushed by each of them in turn. Never `embedPage` for that reason.
 */
function location(page: DigestPage, key: string, pageOrder: readonly string[] | null): number {
	if (page.added) return page.added.relation === "before" ? 1 : (pageNumber(page.added.label) ?? page.added.sourceIndex + 1);
	// A typed page's label and source index are both its place in the unit (`typedTextSource`).
	if (pageOrder) return pageOrder.indexOf(pageIdOf(key)) + 1;
	// A PDF label that is no number came from the text layer, so the source page is known whenever it is needed.
	return pageNumber(page.pageLabel) ?? (page.source?.index ?? 0) + 1;
}

/**
 * Every entry of a digest as Readwise should hold it.
 *
 * `pageOrder` is the document's page order for a typed document or a notebook's typed pages, whose
 * pages are numbered by it; null for a PDF or an EPUB, whose pages carry their own numbers.
 */
export function readwiseHighlights(pages: readonly DigestPage[], docId: string, pageOrder: readonly string[] | null, target: LinkTarget): ReadwiseEntry[] {
	return pages.flatMap((page) => {
		const place = (key: string): EntryPlace => ({ key, location: location(page, key, pageOrder), url: highlightUrl(target, docId, key, page.embedPage) });
		const highlights = page.highlights.map((highlight): ReadwiseEntry =>
			highlight.sentence === "" ? { ...place(highlight.key), unread: true } : { ...place(highlight.key), text: boldText(highlight), ...nestedNote(highlight) },
		);
		// Every `""` margin note is unread: a note carries no status of its own, and its entry in the
		// vault says "could not be transcribed" for it (spec §4.2). A page added on the tablet says.
		const notes = page.notes.flatMap((note): ReadwiseEntry[] => {
			if (page.added?.unread || (!note.wholePage && note.text === "")) return [{ ...place(note.key), unread: true, margin: true }];
			return note.text === "" ? [] : [{ ...place(note.key), text: fitted(note.text), margin: true }];
		});
		return [...highlights, ...notes];
	});
}
