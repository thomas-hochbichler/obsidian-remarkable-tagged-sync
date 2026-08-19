import type { OcrPageStatus } from "./ocr-backend";

export type OcrStatus = "ok" | "failed" | "skipped" | "unavailable";
/**
 * A transcription backend's id. Open by design: the registry decides which ids exist in a given
 * build, so the core cannot know the list. It was a closed union of every provider name, which both
 * went stale the moment a backend was added and published that list from code that ships to
 * everyone. Validity is answered by `isRegisteredOcrBackend`, not by this type.
 */
export type OcrBackend = string;

/**
 * One page's highlighted quotes, render-ready: sorted, normalized, non-empty (see the sync-engine's
 * collection). Rendered under a `###` heading that links into the embedded PDF page.
 */
export interface HighlightGroup {
	/** Callout-title label: the notebook page ordinal, or the note's `pageIndex` for a page-level note. */
	pageLabel: number;
	/** The `#page=` anchor into the embed: the page ordinal for a notebook-level note, `1` for a single-page embed. */
	embedPage: number;
	/** Ordered, normalized, non-empty highlighted quotes on the page. */
	quotes: string[];
}

/**
 * Everything the note itself needs. Sync-relevant attributes (identity, hashes, timestamps, OCR
 * status) live solely in the `data.json` index now, never in the note -- so a synced note carries
 * zero user-visible frontmatter. `docId`/`pageId`/`tag` remain only to disambiguate a brand-new
 * note's filename on a collision (see `resolveFreePath`).
 */
export interface NoteFields {
	docId: string;
	pageId: string | null;
	pageIndex: number | null;
	tag: string;
	source: string;
	/** Full vault path to the rendered PDF (from the attachment writer). */
	embedPath: string;
	/** Per-page highlighted quotes, in reading order. Empty when the unit has no text highlights. */
	highlights: HighlightGroup[];
	transcript: string;
	/**
	 * The `## Digest` body of an annotated PDF. When non-empty it replaces both the highlights and the
	 * transcript section: a digest already carries every highlight with its surrounding sentence, so
	 * rendering those beside it would only duplicate them.
	 */
	digest: string;
}

export interface NoteStore {
	read(path: string): Promise<string | null>;
	/**
	 * Whether anything at all occupies this path -- a note, a note whose name differs only in case,
	 * or a folder.
	 *
	 * Deliberately not `read(path) !== null`. `read` asks Obsidian's file index, which is an
	 * exact-string map; `Vault.create` asks the filesystem, which folds case on macOS and Windows.
	 * Asking the first and writing through the second is how the plugin used to pick a name it had
	 * just proved was free and then throw "File already exists." on it, once, and on every sync of
	 * that notebook afterwards.
	 */
	exists(path: string): Promise<boolean>;
	write(path: string, content: string): Promise<void>;
	ensureFolder(path: string): Promise<void>;
	/** Renames/moves an existing note, preserving vault backlinks. No-op if `fromPath` doesn't exist. */
	move(fromPath: string, toPath: string): Promise<void>;
}

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;
// Obsidian's own `normalizePath` rewrites both of these to an ordinary space before it writes, and
// `getFileByPath` does NOT normalize -- it is a raw lookup. So a name that still carries one is a
// name the plugin computed, Obsidian silently changed on the way to disk, and no later lookup of the
// stored path can find again. An EPUB's title metadata carries these routinely.
const NON_BREAKING_SPACES = /[\u00A0\u202F]/g;
// Windows refuses these outright, and Obsidian enforces it on Windows only. Applied on every
// platform on purpose: a vault synced between a Mac and a PC has to produce the same filename on
// both, and the alternative is one note per machine.
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
// Leaves room for a " — Page 999" or " (abcdef)" suffix and the ".md" extension under typical filesystem limits.
const MAX_BASENAME_LENGTH = 200;

// No begin marker: the managed block always starts at the top of the body (`buildNoteContent` writes
// frontmatter, block, then whatever follows), so marking the start said nothing the position did not
// already say -- and it cost a line of visible clutter in Live Preview, right above a callout saying
// the same thing. Dropping it also closes a small hole: text typed *above* the old marker fell
// outside the block, hashed to no change, and was silently overwritten. It is now part of the block,
// so it registers as an edit and freezes the note instead.
const FENCE_END = "<!-- tagged-sync:end -->";
// The transcript body inside the managed block: everything between the "## Transcript" heading and
// the closing fence. Non-greedy so it stops at the first fence end (see buildManagedBlock).
const TRANSCRIPT_RE = new RegExp(`(## Transcript\\n)[\\s\\S]*?(\\n${FENCE_END})`);
// The transcript's body alone, for reading it back out (see `readTranscript`).
const TRANSCRIPT_BODY_RE = new RegExp(`## Transcript\\n([\\s\\S]*?)\\n${FENCE_END}`);
// The whole section including its leading newline -- for removing it when a transcript goes away.
const TRANSCRIPT_SECTION_RE = new RegExp(`\\n## Transcript\\n[\\s\\S]*?\\n${FENCE_END}`);
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
// The whole note is the plugin's, and Reading View has to say so: the fence markers are HTML
// comments and render as nothing, so a reader saw no line between what a sync rewrites and what it
// keeps. Collapsed (`]-`), because it sits above the content of every note the user reads daily.
const OWNERSHIP_CALLOUT =
	"> [!info]- Generated by Tagged Sync — do not edit\n" +
	"> Every sync rewrites this note. Keep your own thoughts in a separate note and link back to this one.";
// `[!warning]` rather than the `[!quote]` the highlights use: same callout vocabulary, and the one
// place in the transcript where the note is reporting a problem rather than content.
const FAILED_PAGE_CALLOUT = "> [!warning] Could not read this page";
// The embed the managed block was written with, for a caller that has the note but not the sync's
// attachment path (see `reTranscribeAll`). Matches the `![[...]]` line `buildManagedBlock` writes.
const EMBED_RE = /!\[\[([^\]\n]+)\]\]/;

/**
 * Makes a title safe to be part of a vault filename: filesystem-illegal chars (`/ \ : * ? " < > |`)
 * become `-`, and the name is left in the exact form Obsidian would write it in.
 *
 * That last part is the whole reason the last three steps exist. `Vault.create` runs the path
 * through `normalizePath` -- non-breaking spaces to ordinary ones, then NFC -- while every lookup
 * (`getFileByPath`, `getFolderByPath`) compares the raw string. A name this function leaves in a
 * form `normalizePath` would change is therefore a note the plugin writes once and can never find
 * again: the next sync reads its own stored path, gets nothing, decides the note was deleted, writes
 * it a second time, and `create` throws "File already exists." on a path that looks identical to the
 * one it just asked for. Read out of obsidian-1.13.7's app.js, not assumed.
 */
export function sanitizeFilenamePart(name: string): string {
	const sanitized = name
		.replace(ILLEGAL_FILENAME_CHARS, "-")
		.replace(NON_BREAKING_SPACES, " ")
		.normalize("NFC")
		.trim();
	const capped = sanitized.length > MAX_BASENAME_LENGTH ? sanitized.slice(0, MAX_BASENAME_LENGTH).trim() : sanitized;

	// Windows rejects a name ending in a dot, and `trim()` does not remove one. A title that is
	// nothing but dots would leave an empty name -- and a filename starting with "." is hidden --
	// so it falls back to the same `-` the illegal characters become.
	const withoutTrailingDots = capped.replace(/\.+$/, "").trim();
	const base = withoutTrailingDots === "" ? "-" : withoutTrailingDots;

	return WINDOWS_RESERVED_NAMES.test(base) ? `${base}-` : base;
}

/** `<notebook>` for a notebook-level note, `<notebook> — Page N` for a page-level one. */
export function deriveBaseName(notebookName: string, pageIndex: number | null): string {
	const sanitized = sanitizeFilenamePart(notebookName);
	return pageIndex === null ? sanitized : `${sanitized} — Page ${pageIndex}`;
}

/**
 * Renders the `## Highlights` section body (a leading blank line + the heading + one `###` page
 * heading per page), or "" when there are no highlights (no empty heading). The page heading is a
 * link into the embedded PDF page and carries one `- <quote>` bullet per highlight.
 *
 * The `> [!quote]` callout this used to be went with the digest's boxes (digest-presentation ticket
 * 04): a page of them read as a stack of boxes, in the same vault and often the same folder as a
 * digest that no longer has any. The bullets stay, though -- these quotes are fragments, not
 * sentences (median 49 characters over the fixture, up to nine on one page), and a list is the
 * honest form for a list of fragments. This section is a fallback surface: a digest subsumes it, so
 * it is reached only by a notebook with highlighted typed text or a PDF whose digest build failed.
 */
function renderHighlights(embedPath: string, groups: HighlightGroup[]): string {
	if (groups.length === 0) return "";
	const sections = groups.map((group) => {
		const heading = `### [[${embedPath}#page=${group.embedPage}|Page ${group.pageLabel}]]`;
		const bullets = group.quotes.map((quote) => `- ${quote}`).join("\n");
		return `${heading}\n\n${bullets}`;
	});
	return `\n## Highlights\n\n${sections.join("\n\n")}\n`;
}

/**
 * One page of a unit, ready to render: its labels, what became of it, and its text. One entry per
 * page the *unit* covers -- including pages that never reached a backend -- so the summary line can
 * name them.
 */
export interface TranscriptPage {
	/** The notebook page ordinal a human reads. */
	pageLabel: number;
	/** The `#page=` anchor into the embed; `1` for a single-page embed. */
	embedPage: number;
	status: OcrPageStatus;
	/** The page's transcript. Empty unless `status` is "ok". */
	text: string;
}

/** Consecutive labels collapse to `a–b` from three up; a pair stays two entries, which reads no worse and is shorter. */
function collapseRuns(labels: number[]): string[] {
	const parts: string[] = [];
	for (let i = 0; i < labels.length; ) {
		let end = i;
		while (end + 1 < labels.length && labels[end + 1] === labels[end] + 1) end++;
		if (end - i + 1 >= 3) parts.push(`${labels[i]}–${labels[end]}`);
		else for (let k = i; k <= end; k++) parts.push(String(labels[k]));
		i = end + 1;
	}
	return parts;
}

/**
 * Renders the `## Transcript` body, page by page.
 *
 * A page that produced text gets a `###` heading linking into the embedded PDF page -- character for
 * character the form `renderHighlights` emits, so the managed block has one link vocabulary and not
 * two. Numbering follows the pages, so it *jumps*: a 5-page PDF written on 1, 3 and 5 shows Page 1,
 * Page 3, Page 5.
 *
 * Pages with nothing to read get no heading. They are named once, on an italic line after the last
 * page -- a footnote, not a headline, because on an ordinary notebook most pages are blank and a
 * callout would shout every time. A PDF page never drawn on and a notebook page whose transcription
 * came back empty are the same fact to a reader, so the note does not distinguish them.
 *
 * A page that *failed* keeps its heading and says so: a failure is actionable (re-sync, switch
 * backend) where a blank page is not, and it is left out of the summary line rather than named twice.
 *
 * `pages === null` means the backend had nothing per-page to say (`off`, unavailable, or an arity
 * violation `runOcr` refused to trust). The unlabelled text is returned as-is -- exactly what the
 * note looked like before transcripts were page-anchored.
 */
export function renderTranscript(embedPath: string, pages: TranscriptPage[] | null, fallbackText: string): string {
	if (pages === null) return fallbackText;
	// A unit covering one page needs no heading: `deriveBaseName` already put "— Page 7" in the
	// filename and the highlight callout repeats it, so a third would be noise.
	if (pages.length <= 1) {
		const page = pages[0];
		if (page === undefined || page.status === "skipped") return "";
		return page.status === "ok" ? page.text : FAILED_PAGE_CALLOUT;
	}

	const sections: string[] = [];
	const noText: number[] = [];
	for (const page of pages) {
		if (page.status === "skipped") {
			noText.push(page.pageLabel);
			continue;
		}
		const heading = `### [[${embedPath}#page=${page.embedPage}|Page ${page.pageLabel}]]`;
		sections.push(`${heading}\n\n${page.status === "ok" ? page.text : FAILED_PAGE_CALLOUT}`);
	}

	if (noText.length > 0) {
		const parts = collapseRuns(noText);
		sections.push(noText.length === 1 ? `*No text on page ${parts[0]}.*` : `*No text on pages ${parts.join(", ")}.*`);
	}
	return sections.join("\n\n");
}

function buildManagedBlock(fields: NoteFields): string {
	const embed = `${OWNERSHIP_CALLOUT}\n\n![[${fields.embedPath}]]\n`;
	// A digest is the one section: it subsumes the highlights and stands in for the transcript.
	if (fields.digest !== "") return `${embed}\n## Digest\n${fields.digest}\n${FENCE_END}`;

	// No transcript (backend off/unavailable, or OCR found nothing) -> no empty heading in the note.
	const transcriptSection = fields.transcript === "" ? "" : `\n## Transcript\n${fields.transcript}`;
	return `${embed}${renderHighlights(fields.embedPath, fields.highlights)}${transcriptSection}\n${FENCE_END}`;
}

/**
 * FNV-1a, as 8 lowercase hex chars. Used to answer "is this still exactly what we wrote?" for a
 * managed block, and to derive stable ids for digest entries, so collision resistance is not the
 * property that matters -- and a wrong answer costs a skipped update with a message, never a lost
 * note. Hand-rolled because the plugin bundles no hashing dependency and node's crypto is not
 * available everywhere.
 */
export function hashString(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Everything up to and including the closing fence, or -1 when the note carries no fence at all. */
function fenceEndOffset(body: string): number {
	const index = body.indexOf(FENCE_END);
	return index === -1 ? -1 : index + FENCE_END.length;
}

/**
 * The managed block as it currently sits in `content`: the body from its first character to the
 * closing fence, frontmatter excluded. Null when the fence is gone.
 *
 * A note written before the fence lost its begin marker yields that marker as part of the block,
 * which is exactly right -- it is what the last sync wrote, so the block still hashes to the value
 * stored on its row and is regenerated rather than mistaken for a hand edit.
 */
export function extractManagedBlock(content: string): string | null {
	const body = content.slice(content.match(FRONTMATTER_RE)?.[0].length ?? 0);
	const end = fenceEndOffset(body);
	return end === -1 ? null : body.slice(0, end);
}

/**
 * Hash of the managed block these fields render to. Stored on the index row at write time, so the
 * next sync can tell its own output from a block the user has edited by hand.
 */
export function managedBlockHash(fields: NoteFields): string {
	return hashString(buildManagedBlock(fields));
}

/** Hash of a block read back off disk, for comparison against a row's stored {@link managedBlockHash}. */
export function blockHashOf(block: string): string {
	return hashString(block);
}

interface ParsedNote {
	/** Any leading `---…---` block, captured verbatim so it survives untouched (old notes keep their frontmatter; the plugin stops managing it). Empty string when there is none. */
	rawFrontmatter: string;
	/**
	 * Content after the managed fence (or the whole body, if the fence is missing/malformed). New
	 * notes no longer offer this region -- the note is the plugin's, and own text belongs in a note
	 * of the user's own -- but whatever an older version invited them to write here is still carried
	 * through every re-write, because deleting a user's own words is the one loss with no undo.
	 */
	freeArea: string;
}

function parseNote(content: string): ParsedNote {
	const frontmatterMatch = content.match(FRONTMATTER_RE);
	const rawFrontmatter = frontmatterMatch ? frontmatterMatch[0] : "";
	const body = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;

	// No trailing \n? -- the free area (including its leading blank line) starts right after "end -->"
	// and must be captured whole, or repeated re-syncs erode its separator by one newline each time.
	const end = fenceEndOffset(body);
	const freeArea = end === -1 ? body : body.slice(end);

	return { rawFrontmatter, freeArea };
}

/**
 * Builds the full note text: freshly rendered managed block + preserved free area, with no
 * frontmatter of its own. A brand-new note is frontmatter-free; a re-written old note keeps whatever
 * frontmatter it already had, verbatim (the plugin no longer writes or manages any).
 */
export function buildNoteContent(fields: NoteFields, existingContent: string | null): string {
	const parsed = existingContent !== null ? parseNote(existingContent) : null;

	const managedBlock = buildManagedBlock(fields);
	const rawFrontmatter = parsed ? parsed.rawFrontmatter : "";
	// A brand-new note ends at the fence, bar the trailing newline: nothing invites writing below it.
	const freeArea = parsed ? parsed.freeArea : "\n";

	return `${rawFrontmatter}${managedBlock}${freeArea}`;
}

/**
 * The first path in `folder` no file yet occupies, for a brand-new unit. There's no in-note identity
 * left to compare, so a new unit never reuses or overwrites an occupied path (a user's file, or a
 * fence-bearing note whose index row was lost) -- per Approach A, a lost index yields a duplicate,
 * never a clobber. Suffixes escalate: `<base> (tag)` disambiguates two tags of the same unit routed
 * to one folder; `(docId6)` backs it up for two different notebooks sharing a name; a numeric tail
 * guarantees termination when even those collide. Once chosen, the path is persisted in the index
 * and reused via `existingPath`.
 *
 * "Occupies" is `store.exists`, not `store.read`: see the interface. A path this returns is one the
 * vault will actually accept, which is the whole difference.
 */
async function resolveFreePath(store: NoteStore, folder: string, baseName: string, tag: string, docId: string): Promise<string> {
	const suffixes = ["", ` (${sanitizeFilenamePart(tag)})`, ` (${docId.slice(0, 6)})`];

	for (const suffix of suffixes) {
		const path = joinFolder(folder, `${baseName}${suffix}.md`);
		if (!(await store.exists(path))) return path;
	}
	for (let n = 2; ; n++) {
		const path = joinFolder(folder, `${baseName} (${n}).md`);
		if (!(await store.exists(path))) return path;
	}
}

/** Vault paths never start with a slash, so the root ("" after trimming) joins bare. */
function joinFolder(trimmedFolder: string, name: string): string {
	return trimmedFolder === "" ? name : `${trimmedFolder}/${name}`;
}

/** True when `path` already sits directly in `folder` -- i.e. where `writeNote` would have put it. */
export function isInFolder(path: string, folder: string): boolean {
	const cut = path.lastIndexOf("/");
	return (cut === -1 ? "" : path.slice(0, cut)) === folder.replace(/\/+$/, "");
}

/** Writes fields at an already-resolved path -- no collision handling, the caller owns that. */
async function writeNoteAt(store: NoteStore, path: string, fields: NoteFields): Promise<string> {
	const existingContent = await store.read(path);
	const content = buildNoteContent(fields, existingContent);

	// A root-level path has no parent to create; slicing at lastIndexOf would mangle it.
	if (path.includes("/")) await store.ensureFolder(path.slice(0, path.lastIndexOf("/")));
	await store.write(path, content);
	return path;
}

/**
 * Writes a note and returns its path. `existingPath` (the unit's `notePath` from the index) makes
 * this an in-place overwrite -- the index is authoritative, so a note keeps its filename even if the
 * source notebook was renamed on the device (filenames are cosmetic; identity is the row). Without
 * it, the unit is new: derive a filename and take the first free path.
 */
export async function writeNote(store: NoteStore, folder: string, fields: NoteFields, existingPath?: string | null): Promise<string> {
	if (existingPath != null) return writeNoteAt(store, existingPath, fields);

	const trimmedFolder = folder.replace(/\/+$/, "");
	const baseName = deriveBaseName(fields.source, fields.pageIndex);
	const path = await resolveFreePath(store, trimmedFolder, baseName, fields.tag, fields.docId);
	return writeNoteAt(store, path, fields);
}

/**
 * Moves an existing note to a new folder (preserving vault backlinks via the store's `move`), then
 * rewrites it in place. Used when a unit's routing tag changes to a different folder-tag, so the
 * note keeps its history instead of being orphaned + duplicated. The target goes through the same
 * first-free-path resolution as a fresh write, so a rename landing on a path some unrelated note
 * already occupies gets suffixed rather than clobbering it -- except when the natural target *is*
 * `fromPath` (two tags both routing to the same folder): that's the note's own path, not a foreign collision.
 */
export async function moveNote(store: NoteStore, fromPath: string, toFolder: string, fields: NoteFields): Promise<string> {
	const trimmedFolder = toFolder.replace(/\/+$/, "");
	const baseName = deriveBaseName(fields.source, fields.pageIndex);
	const candidatePath = joinFolder(trimmedFolder, `${baseName}.md`);

	const toPath = candidatePath === fromPath ? candidatePath : await resolveFreePath(store, trimmedFolder, baseName, fields.tag, fields.docId);

	if (fromPath !== toPath) {
		if (trimmedFolder !== "") await store.ensureFolder(trimmedFolder);
		await store.move(fromPath, toPath);
	}
	return writeNoteAt(store, toPath, fields);
}

/**
 * The transcript a note already carries, or null when it has none (no section, or the note is gone).
 *
 * The mirror of `updateTranscript`, and it exists for the same reason the section is addressable at
 * all: a re-render triggered by a renderer change alone has a perfectly good transcript already, and
 * re-running the backend to get the same text back would bill a metered backend for nothing.
 */
export function readTranscript(content: string): string | null {
	return content.match(TRANSCRIPT_BODY_RE)?.[1] ?? null;
}

/**
 * The embed a managed note points at, or null when it has none.
 *
 * For the re-transcribe path, which holds a note and its pages but not the sync's attachment folder,
 * and needs the embed path to build the per-page headings.
 */
export function readEmbedPath(content: string): string | null {
	return content.match(EMBED_RE)?.[1] ?? null;
}

/**
 * Rewrites just a note's transcript region (spec §8.4's re-transcribe), leaving the embed, the
 * user's free area, and any frontmatter untouched. Operates on the whole content so it works with or
 * without a leading frontmatter block. The section is grown when a transcript arrives for a note
 * written without one, and removed when a transcript goes away -- an empty "## Transcript" heading
 * never ships. Returns false (a no-op) if the note is gone, has no managed block, or nothing changes.
 *
 * A digest note is left alone: re-transcribe rewrites the transcript region only, while a digest is
 * regenerated as a whole by a full sync -- so a partial rewrite here could only damage it.
 */
export async function updateTranscript(store: NoteStore, path: string, transcript: string): Promise<boolean> {
	const content = await store.read(path);
	if (content === null) return false;
	if (extractManagedBlock(content)?.includes("\n## Digest\n")) return false;

	let newContent: string;
	if (TRANSCRIPT_RE.test(content)) {
		// Function replacements so a `$` in the OCR text isn't treated as a replacement pattern.
		newContent =
			transcript === ""
				? content.replace(TRANSCRIPT_SECTION_RE, () => `\n${FENCE_END}`)
				: content.replace(TRANSCRIPT_RE, (_match, heading: string, fenceEnd: string) => `${heading}${transcript}${fenceEnd}`);
	} else if (transcript !== "" && content.includes(FENCE_END)) {
		// The note was written while transcription was off: grow the section just above the fence end.
		newContent = content.replace(`\n${FENCE_END}`, () => `\n## Transcript\n${transcript}\n${FENCE_END}`);
	} else {
		return false;
	}

	await store.write(path, newContent);
	return true;
}
