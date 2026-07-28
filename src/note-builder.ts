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
 * collection). Rendered as a single `> [!quote]` callout titled with a link into the embedded PDF page.
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
}

export interface NoteStore {
	read(path: string): Promise<string | null>;
	write(path: string, content: string): Promise<void>;
	ensureFolder(path: string): Promise<void>;
	/** Renames/moves an existing note, preserving vault backlinks. No-op if `fromPath` doesn't exist. */
	move(fromPath: string, toPath: string): Promise<void>;
}

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;
// Leaves room for a " — Page 999" or " (abcdef)" suffix and the ".md" extension under typical filesystem limits.
const MAX_BASENAME_LENGTH = 200;

const FENCE_BEGIN = "<!-- tagged-sync:begin — do not edit inside this block -->";
const FENCE_END = "<!-- tagged-sync:end -->";
// The transcript body inside the managed block: everything between the "## Transcript" heading and
// the closing fence. Non-greedy so it stops at the first fence end (see buildManagedBlock).
const TRANSCRIPT_RE = new RegExp(`(## Transcript\\n)[\\s\\S]*?(\\n${FENCE_END})`);
// The whole section including its leading newline -- for removing it when a transcript goes away.
const TRANSCRIPT_SECTION_RE = new RegExp(`\\n## Transcript\\n[\\s\\S]*?\\n${FENCE_END}`);
// No trailing \n? -- the free area (including its leading blank line) starts right after "end -->"
// and must be captured whole, or repeated re-syncs erode its separator by one newline each time.
const FENCE_RE = /<!-- tagged-sync:begin[^\n]*-->\n[\s\S]*?<!-- tagged-sync:end -->/;
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const DEFAULT_FREE_AREA = "\n\n<!-- user's own notes/annotations live here, preserved across re-syncs -->\n";

/** Replaces filesystem-illegal chars (`/ \ : * ? " < > |`) with `-` and trims to a safe length. */
export function sanitizeFilenamePart(name: string): string {
	const sanitized = name.replace(ILLEGAL_FILENAME_CHARS, "-").trim();
	return sanitized.length > MAX_BASENAME_LENGTH ? sanitized.slice(0, MAX_BASENAME_LENGTH).trim() : sanitized;
}

/** `<notebook>` for a notebook-level note, `<notebook> — Page N` for a page-level one. */
export function deriveBaseName(notebookName: string, pageIndex: number | null): string {
	const sanitized = sanitizeFilenamePart(notebookName);
	return pageIndex === null ? sanitized : `${sanitized} — Page ${pageIndex}`;
}

/**
 * Renders the `## Highlights` section body (a leading blank line + the heading + one `> [!quote]`
 * callout per page), or "" when there are no highlights (no empty heading). Each callout is titled
 * with a link into the embedded PDF page and carries one `> - <quote>` bullet per highlight.
 */
function renderHighlights(embedPath: string, groups: HighlightGroup[]): string {
	if (groups.length === 0) return "";
	const callouts = groups.map((group) => {
		const title = `[[${embedPath}#page=${group.embedPage}|Page ${group.pageLabel}]]`;
		const bullets = group.quotes.map((quote) => `> - ${quote}`).join("\n");
		return `> [!quote] ${title}\n${bullets}`;
	});
	return `\n## Highlights\n\n${callouts.join("\n\n")}\n`;
}

function buildManagedBlock(embedPath: string, highlights: HighlightGroup[], transcript: string): string {
	// No transcript (backend off/unavailable, or OCR found nothing) -> no empty heading in the note.
	const transcriptSection = transcript === "" ? "" : `\n## Transcript\n${transcript}`;
	return `${FENCE_BEGIN}\n![[${embedPath}]]\n${renderHighlights(embedPath, highlights)}${transcriptSection}\n${FENCE_END}`;
}

/**
 * FNV-1a, as 8 lowercase hex chars. Only ever compared against another hash of the same block to
 * answer "is this still exactly what we wrote?", so collision resistance is not the property that
 * matters -- and a wrong answer costs a skipped update with a message, never a lost note. Hand-rolled
 * because the plugin bundles no hashing dependency and node's crypto is not available everywhere.
 */
function hashString(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The managed block as it currently sits in `content`, or null when the fence is gone or malformed. */
export function extractManagedBlock(content: string): string | null {
	return content.match(FENCE_RE)?.[0] ?? null;
}

/**
 * Hash of the managed block these fields render to. Stored on the index row at write time, so the
 * next sync can tell its own output from a block the user has edited by hand.
 */
export function managedBlockHash(fields: NoteFields): string {
	return hashString(buildManagedBlock(fields.embedPath, fields.highlights, fields.transcript));
}

/** Hash of a block read back off disk, for comparison against a row's stored {@link managedBlockHash}. */
export function blockHashOf(block: string): string {
	return hashString(block);
}

interface ParsedNote {
	/** Any leading `---…---` block, captured verbatim so it survives untouched (old notes keep their frontmatter; the plugin stops managing it). Empty string when there is none. */
	rawFrontmatter: string;
	/** Everything the plugin does not own: content after the managed fence (or the whole body, if the fence is missing/malformed). */
	freeArea: string;
}

function parseNote(content: string): ParsedNote {
	const frontmatterMatch = content.match(FRONTMATTER_RE);
	const rawFrontmatter = frontmatterMatch ? frontmatterMatch[0] : "";
	const body = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;

	const fenceMatch = body.match(FENCE_RE);
	const freeArea = fenceMatch ? body.slice((fenceMatch.index ?? 0) + fenceMatch[0].length) : body;

	return { rawFrontmatter, freeArea };
}

/**
 * Builds the full note text: freshly rendered managed block + preserved free area, with no
 * frontmatter of its own. A brand-new note is frontmatter-free; a re-written old note keeps whatever
 * frontmatter it already had, verbatim (the plugin no longer writes or manages any).
 */
export function buildNoteContent(fields: NoteFields, existingContent: string | null): string {
	const parsed = existingContent !== null ? parseNote(existingContent) : null;

	const managedBlock = buildManagedBlock(fields.embedPath, fields.highlights, fields.transcript);
	const rawFrontmatter = parsed ? parsed.rawFrontmatter : "";
	const freeArea = parsed ? parsed.freeArea : DEFAULT_FREE_AREA;

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
 */
async function resolveFreePath(store: NoteStore, folder: string, baseName: string, tag: string, docId: string): Promise<string> {
	const suffixes = ["", ` (${sanitizeFilenamePart(tag)})`, ` (${docId.slice(0, 6)})`];

	for (const suffix of suffixes) {
		const path = joinFolder(folder, `${baseName}${suffix}.md`);
		if ((await store.read(path)) === null) return path;
	}
	for (let n = 2; ; n++) {
		const path = joinFolder(folder, `${baseName} (${n}).md`);
		if ((await store.read(path)) === null) return path;
	}
}

/** Vault paths never start with a slash, so the root ("" after trimming) joins bare. */
function joinFolder(trimmedFolder: string, name: string): string {
	return trimmedFolder === "" ? name : `${trimmedFolder}/${name}`;
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
 * Rewrites just a note's transcript region (spec §8.4's re-transcribe), leaving the embed, the
 * user's free area, and any frontmatter untouched. Operates on the whole content so it works with or
 * without a leading frontmatter block. The section is grown when a transcript arrives for a note
 * written without one, and removed when a transcript goes away -- an empty "## Transcript" heading
 * never ships. Returns false (a no-op) if the note is gone, has no managed block, or nothing changes.
 */
export async function updateTranscript(store: NoteStore, path: string, transcript: string): Promise<boolean> {
	const content = await store.read(path);
	if (content === null) return false;

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
