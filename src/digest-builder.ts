// The digest's data model and its markdown (spec F1-F9). Pure: everything this module needs is
// handed to it, so the format is decided in one place and testable as a single string. The pipeline
// (T9) does the measuring, the OCR and the file writing; nothing of that leaks in here.
//
// The layout is the one the digest-presentation map settled: the *section* is the digest's `###`
// heading and runs on across page breaks, a highlight is body text rather than a callout, and every
// entry under a section heading ends with a link to the page it sits on. Only handwriting is still a
// callout. The page steps in as the heading where no section is known, and then it carries the link
// and its entries carry none.

import type { DigestAnchor } from "./digest-anchoring";
import { hashString } from "./note-builder";
import { highlightColorName } from "./highlight-color";
import type { PdfRect } from "./pdf-text";

/**
 * Where a note's ink sits in the embedded PDF: its page, and the ink's bounding box in PDF points
 * with **y measured from the page top**, which is the axis a pdf.js viewport uses.
 *
 * This is what replaced the crop attachment. The vault's PDF already has the handwriting drawn into
 * it (`renderAnnotatedPdf`), so page plus rectangle is enough to show it on request -- and the vault
 * keeps no image file at all.
 */
export interface NoteRegion {
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface DigestNote {
	/** Block id without the caret, e.g. `nt-4c8a17`. */
	id: string;
	anchor: DigestAnchor;
	/** "" when nothing was transcribed -- then the entry says so in words, see `NOT_TRANSCRIBED`. */
	text: string;
	/** Where to draw the handwriting from, or null where there is nothing to draw it out of. */
	region: NoteRegion | null;
	/**
	 * The ink's own box on the **source** page, in PDF points with the PDF's bottom-left origin --
	 * what a second reader of this document, one that never saw our render, would need to point at
	 * the same handwriting.
	 *
	 * Not the same thing as {@link DigestNote.region}, which is measured in the vault attachment we
	 * wrote out: that one is placed by the renderer's own transform (a page whose ink runs off the
	 * paper is drawn shrunk), and it is y-from-top because a pdf.js viewport is. The two agree for
	 * most pages and must not be confused on the ones they do not.
	 *
	 * Null on a page whose frame is a guess -- see {@link DigestPage.source}.
	 */
	rect: PdfRect | null;
	/** Scene y, for reading order. */
	top: number;
	/**
	 * True for the single entry a page added on the device produces: the whole page transcribed at
	 * once, rather than one note per line (F21). It changes only the callout's title -- such a page is
	 * not annotation *of* anything, so "at this heading" would be a claim about a document it is not
	 * part of.
	 */
	wholePage?: boolean;
}

export interface DigestHighlight {
	/** Block id without the caret, e.g. `hl-9f21c4`. */
	id: string;
	/** The full surrounding sentence, or the `.rm` highlight text alone (F4 soft fail). */
	sentence: string;
	/**
	 * The marked text's boxes on the **source** page, one per run the reader's gesture covered, in
	 * PDF points with the PDF's bottom-left origin.
	 *
	 * Kept per run rather than as the union the anchor cascade uses: a highlight over three wrapped
	 * lines is three boxes, and its union is the whole block of text including the unmarked ends of
	 * the first and last line. Anything drawing the marks back onto the page needs the runs.
	 *
	 * Empty where the page has no text layer at all. See {@link DigestPage.source} for the frame they
	 * are measured in.
	 */
	rects: PdfRect[];
	/**
	 * The highlighted runs inside `sentence`; empty when none is known (F4 soft fail).
	 *
	 * A list, not a single run: the device keeps every version of a selection the user adjusted, so
	 * one sentence commonly arrives as several overlapping `glyph_def` runs. The pipeline merges them
	 * into this one entry instead of printing the same sentence once per run.
	 */
	marked: string[];
	/**
	 * Which tool the reader marked this passage with.
	 *
	 * The digest renders both identically -- F9, and the reader wants the passage rather than the tool
	 * -- but they are not the same act, and something writing them into another reader's document has
	 * to say which: a swipe of the marker is a highlight, a line drawn under the words is an underline.
	 * Kept here rather than derived from `color`, which is null for a marker the device recorded
	 * without one as well as for every pen.
	 */
	tool: "marker" | "pen";
	/**
	 * The marker's color, or `null` for a pen mark and for a marker the device recorded without one.
	 *
	 * Rendered since F9 was revised (2026-09-13): a coloured mark is a `<mark>` carrying the name of the
	 * Zotero colour it becomes in the library, so the note and Zotero show the same green. F9 had
	 * kept every highlight a uniform `==...==` because colour *semantics* is the reader's private
	 * convention -- that still holds: the note shows the colour and says nothing about what it means.
	 */
	color: { r: number; g: number; b: number } | null;
	/** Notes anchored to this highlight, nested inside its callout (F5). */
	notes: DigestNote[];
	/** Nearest section heading. */
	section: string | null;
	top: number;
	/** Where the highlight sits in the page's reading order, where the page has one; `top` otherwise. See `pageEntries`. */
	order?: number;
}

/**
 * The page of the source document a digest page was measured against.
 *
 * `null` says the entries on this page **cannot be placed on the source document**, and it covers
 * the two cases that look different and are not: a page the reader added on the device, which has no
 * source page at all, and a page whose text layer could not be read, where the coordinate frame falls
 * back to the device screen and every rectangle on it names a place on the tablet rather than in the
 * PDF. Either way the rectangles below describe something other than the source page, so anything
 * writing them back into that document has one field to check instead of two conditions to re-derive.
 */
export interface DigestPageSource {
	/** 0-based index of the page in the source PDF. */
	index: number;
	/** The source page's width in PDF points. */
	widthPt: number;
	/** The source page's height in PDF points -- the axis every rectangle here is measured against. */
	heightPt: number;
}

export interface DigestPage {
	/**
	 * The page's own label in the source document -- its printed number, which is not always its
	 * ordinal. Null for a page added on the device: it has no page in the document at all, and the
	 * number beside it would be some other page's.
	 */
	pageLabel: string | null;
	embedPage: number;
	/** Which page of the source document this is, or `null` when it is not a page of it. */
	source: DigestPageSource | null;
	highlights: DigestHighlight[];
	/** Notes not nested under a highlight, each with its own `section` and, where the page has a text layer, its reading `order`. */
	notes: (DigestNote & { section: string | null; order?: number })[];
}

/**
 * Block id -> the `zotero://open-pdf/…` URL of the annotation that entry became, for the ` · [in
 * Zotero]` link a quote carries once it has been written back (spec §4).
 *
 * A plain record of strings rather than the link itself, so the one module that knows how a Zotero
 * URL is spelled (`zotero-note.ts`) stays the only one: here it is a string to print. Empty for
 * every sync that has nothing written back, which is most of them.
 */
export type ZoteroDigestLinks = Readonly<Record<string, string>>;

/** How many words of the nearest line the `line` anchor quotes before trailing off. */
const ANCHOR_LINE_WORDS = 4;

/**
 * The code block that carries a note's page and rectangle. The language is the plugin's own -- code
 * block languages are one global namespace across every plugin, so it is spelled out rather than
 * abbreviated -- and the two `key: value` lines stay readable where nothing renders them.
 */
export const REGION_LANGUAGE = "remarkable-note";

/**
 * What an entry says when OCR returned nothing. All fixed labels are English (F8).
 *
 * It is a body line rather than a title suffix because it also has to *be* the entry: with the crop
 * attachment gone, a note whose transcription is empty would otherwise be a callout with a title and
 * no content -- and the block id has to sit on a line of content.
 */
const NOT_TRANSCRIBED = "Handwriting that could not be transcribed.";

/**
 * The title of a page added on the device (F21). It says what the entry is -- a page of the reader's
 * own notes rather than a mark on someone else's text -- because that is the one thing about it a
 * reader cannot see from where it is printed.
 */
const WHOLE_PAGE_TITLE = "Handwritten page";

/**
 * Neutralises the markup a quoted passage can carry into the note. Every string that comes from the
 * PDF or from OCR goes through this; nothing the digest generates itself does.
 *
 * `<` is what makes this necessary rather than tidy. Markdown passes raw HTML through, so a document
 * that talks about XML -- and the acceptance document is a prompting guide, so it does it constantly
 * -- emits `<document index="n">` into the note as an *unclosed tag*, and Obsidian renders
 * everything after it as HTML. One quote on page 3 silently stopped the rest of the digest from
 * rendering at all. `&` is the same mechanism one step smaller: `&amp;` in the source would reach
 * the reader as a bare `&`.
 *
 * A leading `>` is escaped because a passage that starts with one would open a blockquote instead of
 * printing the character -- as the entry's own paragraph, and as a nested one inside a note callout.
 */
function escapeText(text: string): string {
	return text.replace(/[<&]/g, "\\$&").replace(/^>/, "\\>");
}

/**
 * The note callout's title.
 *
 * The anchor cascade (F5/F14) establishes where the note sat, and the layout now *shows* that: a
 * note printed under a section heading sat at that heading, one printed under a quote sat next to
 * that quote, and a note with no anchor at all sits under its page's own heading. Naming the anchor
 * there only repeats the position -- so the title says what the entry is, and nothing else.
 *
 * The line anchor is the exception, and the only one: nothing in the layout says which sentence the
 * note stood beside. It stays named. The cascade itself is untouched — it still decides where every
 * note is printed, which is the part the reader acts on.
 *
 * Every other anchor titles nothing at all. The word "Handwritten" said what the pen in the callout's
 * corner already says, and it said it in the one line a reader scans for where the note belongs -- so
 * an unanchored note leads with its page link instead. Obsidian prints the callout type as the title
 * where there is nothing else, which puts the word back exactly where it is the only thing to say.
 */
function anchorTitle(anchor: DigestAnchor): string {
	if (anchor.kind !== "line") return "";
	const words = anchor.line.split(/\s+/).filter((word) => word !== "");
	const head = words.slice(0, ANCHOR_LINE_WORDS).join(" ");
	return `at »${escapeText(head)}${words.length > ANCHOR_LINE_WORDS ? "…" : ""}«`;
}

/**
 * The class a coloured mark carries: the Zotero colour's name, painted by the plugin's own
 * `styles.css`, so the reader needs no snippet and a theme can still override it.
 */
const MARK_CLASS_PREFIX = "tagged-sync-hl-";

/**
 * Wraps every run at its first occurrence -- in `==...==`, or in a `<mark>` named for its colour when
 * the marker had one. A run covering the whole quote is marked like any other (decided 2026-09-18:
 * until then a quote three-quarters marked was printed plain, for contrast, and a highlight that
 * started at a paragraph's first word lost its colour with the marks). Escapes the text on the way
 * out, run by run: the runs are matched against the raw sentence,
 * and the markup is the digest's own rather than the document's, so `escapeText` cannot run over the
 * whole result -- it would turn the `<mark>` into text.
 *
 * The runs are separate selections over one passage, so they overlap, repeat and touch each other.
 * They are resolved to non-overlapping character ranges first: nested or crossing `==` markers are
 * not valid Markdown, and a character marked twice would print its own delimiters. Touching counts
 * as overlapping -- `==a====b==` is not a rendering of two adjacent runs.
 *
 * The caller guarantees each run is a substring, but a miss must not cost the reader the quote: the
 * plain sentence still says what the highlight was about, while throwing would drop the annotation
 * entirely.
 */
function markSentence(sentence: string, marked: string[], color: DigestHighlight["color"]): string {
	const found = marked
		.map((run) => ({ start: run === "" ? -1 : sentence.indexOf(run), length: run.length }))
		.filter((range) => range.start >= 0)
		.sort((a, b) => a.start - b.start || a.length - b.length);

	const ranges: { start: number; end: number }[] = [];
	for (const { start, length } of found) {
		const last = ranges[ranges.length - 1];
		// Runs parted by nothing but whitespace are bridged: on the device that was one continuous
		// stroke of the marker, and `==A== ==B==` renders the seam the reader never drew. Only
		// whitespace is swallowed -- real unmarked words in between stay outside the marks.
		if (last && sentence.slice(last.end, start).trim() === "") last.end = Math.max(last.end, start + length);
		else ranges.push({ start, end: start + length });
	}

	// Markdown's own mark where the colour is not known; HTML only where there is a colour to name,
	// so a pen mark and an older device read exactly as before.
	const [open, close] = color === null ? ["==", "=="] : [`<mark class="${MARK_CLASS_PREFIX}${highlightColorName(color)}">`, "</mark>"];
	let quoted = "";
	let cut = 0;
	for (const { start, end } of ranges) {
		quoted += `${escapeText(sentence.slice(cut, start))}${open}${escapeText(sentence.slice(start, end))}${close}`;
		cut = end;
	}
	return quoted + escapeText(sentence.slice(cut));
}

/** The block id (F7) terminates the entry's last text line -- it has to sit on content, not on a callout's title line and not on a code fence. */
function withBlockId(lines: string[], id: string): string[] {
	const last = lines.length - 1;
	return lines.map((line, index) => (index === last ? `${line} ^${id}` : line));
}

/**
 * The two lines that say where the handwriting is. Whole points: the rectangle only has to find the
 * ink again, and what is drawn from it is padded by whole points anyway.
 */
function regionBlock(region: NoteRegion): string[] {
	const rect = [region.x, region.y, region.width, region.height].map((value) => Math.round(value)).join(" ");
	return ["```" + REGION_LANGUAGE, `page: ${region.page}`, `rect: ${rect}`, "```"];
}

/**
 * A margin note, the one entry that is still a callout: it is the reader's own hand, and the box is
 * what tells it apart from the document's text around it.
 *
 * The type is the plugin's own. Obsidian renders an unknown callout type exactly like `[!note]`, so
 * the entry looks the same in a vault without the plugin -- while `data-callout="handwritten"` gives
 * the styling a selector that matches this entry and nothing else in the reader's vault.
 *
 * `prefix` is `> ` for a note of its own and `> > ` for one printed under a highlight.
 *
 * The locator rides on the **title** line rather than at the end of the entry, which is where a
 * highlight carries it. A note's last line is the region block, and a block id or a page link on a
 * code fence is not markup any more -- it is text inside the block. The title line is one place, and
 * it is the only line of the entry that is never part of the block.
 */
function renderNote(note: DigestNote, prefix: string, locator: string): string {
	// Split before escaping, not after: a page transcript is the one body that keeps its newlines, and
	// every line of it needs the callout prefix of its own -- plus `escapeText`'s leading-`>` guard,
	// which only ever looks at the start of the string it is given.
	const textLines = note.text === "" ? [NOT_TRANSCRIBED] : note.text.split("\n").map(escapeText);
	const title = note.wholePage ? WHOLE_PAGE_TITLE : anchorTitle(note.anchor);
	// The separator only earns its place between two things: a note with no title of its own carries
	// the bare page link, and one with neither carries an empty title line.
	const heading = title === "" ? locator.replace(/^ · /, "") : `${title}${locator}`;
	// The id goes on before the block, so it terminates the last *text* line: appended to the entry as
	// a whole it would land on the closing fence and take the block apart.
	const entry = withBlockId([`[!handwritten] ${heading}`.trimEnd(), ...textLines], note.id);
	const lines = note.region === null ? entry : [...entry, ...regionBlock(note.region)];
	return lines.map((line) => `${prefix}${line}`).join("\n");
}

/**
 * A highlight is body text: the sentence with its marked runs, then the locator and the block id.
 *
 * No callout. A quote is prose and reads as prose; the box around it was the digest's loudest
 * element and said nothing a reader could act on, and stacked against the note callouts it made the
 * page alternate grey and blue for its whole length. With the box gone the fold it existed to keep
 * short goes too -- a long quote is now simply a long paragraph.
 */
function renderHighlight(highlight: DigestHighlight, locator: string, zoteroUrl: string | undefined): string {
	// The block id goes on a line of its own, which is what keeps F7's "invisible in reading view"
	// true. Measured in a real Reading View: Obsidian hides a trailing `^id` inside a callout but
	// prints it as grey text at the end of a paragraph -- so moving the quote out of its callout made
	// every id visible. On its own line (no blank line, so it stays part of the entry) it is hidden
	// again and still resolves as a link target. A note keeps its id on the last body line: inside
	// the callout it was never visible.
	//
	// The Zotero link follows the vault's own, and it is per entry rather than per page because it
	// points at one annotation. So it is there even where the page heading carries the locator and
	// the entry itself has none -- a heading cannot hold a link to a single mark.
	const inZotero = zoteroUrl === undefined ? "" : ` · [in Zotero](${zoteroUrl})`;
	const quote = `${markSentence(highlight.sentence, highlight.marked, highlight.color)}${locator}${inZotero}\n^${highlight.id}`;
	// A note anchored to this highlight follows it as a block of its own -- there is no callout left
	// to nest inside. It repeats the locator rather than leaning on the quote above it: as a separate
	// box it reads as an entry, and an entry whose title lacks the link every other one has reads as
	// a link that went missing.
	const nested = highlight.notes.map((note) => `\n\n${renderNote(note, "> ", locator)}`);
	return `${quote}${nested.join("")}`;
}

interface DigestEntry {
	section: string | null;
	top: number;
	order?: number;
	/** `locator` is the entry's trailing page link, "" where the page is the heading and carries it. */
	render(locator: string): string;
}

/**
 * Reading order: section first, then along the page's reading order within the section.
 *
 * Sorting by `top` alone does not reproduce the sample. A note written *at* a heading sits slightly
 * above that heading's baseline, so by position it still belongs to the section above it and would be
 * printed before the section heading it introduces. Grouping by section fixes that, and it also settles the
 * exact `top` tie a heading produces between the last entry of one section and the first of the next.
 *
 * Sections themselves run in the order their first entry appears in the reading order -- the page
 * carries no heading positions of its own. Reading order and not `top`: on a two-column page the
 * abstract sits *below* the introduction's first lines and comes before them, and by `top` the
 * abstract's highlight printed after the introduction's (live, 2026-09-18). `order` is the reading
 * index the pipeline measured against the text layer; `top` stands in where there is none, and
 * breaks the tie of two entries on one line.
 */
function pageEntries(page: DigestPage, zotero: ZoteroDigestLinks): DigestEntry[] {
	const entries: DigestEntry[] = [
		...page.highlights.map((highlight) => ({
			section: highlight.section,
			top: highlight.top,
			order: highlight.order,
			render: (locator: string) => renderHighlight(highlight, locator, zotero[highlight.id]),
		})),
		...page.notes.map((note) => ({
			section: note.section,
			top: note.top,
			order: note.order,
			render: (locator: string) => renderNote(note, "> ", locator),
		})),
	];

	const rank = (entry: DigestEntry) => entry.order ?? entry.top;
	const sectionOrder = new Map<string | null, number>();
	for (const entry of [...entries].sort((a, b) => rank(a) - rank(b) || a.top - b.top)) {
		if (!sectionOrder.has(entry.section)) sectionOrder.set(entry.section, sectionOrder.size);
	}
	return entries.sort(
		(a, b) => (sectionOrder.get(a.section) ?? 0) - (sectionOrder.get(b.section) ?? 0) || rank(a) - rank(b) || a.top - b.top,
	);
}

/**
 * The whole `## Digest` section body, or "" when there is nothing to show. Starts with a blank line
 * and carries no trailing newline, the shape `buildManagedBlock` expects of a section body.
 *
 * One `###` heading per section, not per page. A section runs on across a page break, and repeating
 * its heading there would say nothing the entry's own page link does not -- the pages are the
 * locators, the sections are the structure. Where an entry has no section (a PDF with neither an
 * outline nor larger headings) its page is the heading instead, and then the heading carries the
 * link and the entries carry none.
 *
 * A page without a single entry contributes nothing, so it never appears as a bare heading: a page
 * with no annotation is not part of the digest.
 */
export function renderDigest(embedPath: string, pages: DigestPage[], zotero: ZoteroDigestLinks = {}): string {
	const blocks: string[] = [];
	let heading: string | null = null;

	for (const page of pages) {
		const pageLink = (label: string) => `[[${embedPath}#page=${page.embedPage}|${label}]]`;
		for (const entry of pageEntries(page, zotero)) {
			// Compared as the rendered line, which is what settles both cases at once: the same section
			// twice running is one heading, while two pages without a section are two -- their headings
			// differ, because each names its own page.
			const line = entry.section === null ? `### ${pageLink(page.pageLabel === null ? "Added page" : `Page ${page.pageLabel}`)}` : `### ${escapeText(entry.section)}`;
			if (line !== heading) {
				heading = line;
				blocks.push(line);
			}
			blocks.push(entry.render(entry.section === null ? "" : ` · ${pageLink(page.pageLabel === null ? "added page" : `p. ${page.pageLabel}`)}`));
		}
	}

	return blocks.length === 0 ? "" : `\n${blocks.join("\n\n")}`;
}

/**
 * The stable block id of a digest entry (F15). Derived from the device's own CRDT ids, so it survives
 * a better OCR backend, a recomputed sentence context and a re-sync -- the user's links into the note
 * keep pointing at the same annotation. Six hex chars keep the id readable in the markdown; a
 * collision would merge two entries' links, not lose an entry.
 */
export function digestId(prefix: "hl" | "nt", pageId: string, crdtId: string): string {
	return `${prefix}-${hashString(`${pageId}:${crdtId}`).slice(0, 6)}`;
}
