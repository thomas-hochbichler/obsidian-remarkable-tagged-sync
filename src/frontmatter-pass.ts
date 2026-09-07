import type { DocumentContent, LegacyDocumentContent, RemarkableApi } from "rmapi-js";
import { applyFrontmatter, deviceModified, formatLocalMinute, namespacedTags, removeFrontmatter } from "./frontmatter";
import type { NoteStore } from "./note-builder";
import { folderPathOf, inheritedFolderTagNames, tagNames } from "./remarkable-tags";
import { contentPageOrder, FRONTMATTER_KEYS_VERSION, type SyncIndex, type SyncIndexRow } from "./sync-engine";

/**
 * The two one-time passes behind the "Frontmatter properties" toggle (spec: management policy
 * points 3 and 4). Explicit passes rather than a RENDER_VERSION bump on purpose: frontmatter is
 * not rendered content, and a bump would re-render -- and on a metered backend re-bill -- a whole
 * vault to change a few header lines. Both passes are idempotent, so an interrupted one is simply
 * run again.
 */

export interface BackfillResult {
	/** Notes now carrying the keys (whether this pass changed them or they were already current). */
	written: number;
	/** Active rows the pass could not reach: document gone from the device listing, or note gone from the vault. */
	skipped: number;
}

type PassApi = Pick<RemarkableApi, "listItems" | "getContent">;

export interface BackfillOptions {
	/**
	 * Which active rows to write, default all of them. The toggle-on pass wants every note; the
	 * key-set pass wants only the rows whose stamp is behind, so a vault that is already current
	 * costs one listing and no writes.
	 */
	select?: (row: SyncIndexRow) => boolean;
	/** Mints a missing `noteId`; injectable like `SyncDeps.newNoteId`. Defaults to `crypto.randomUUID`. */
	newNoteId?: () => string;
}

/**
 * Toggle-on: writes the keys into every already-synced note, so views are complete from day one.
 * Mutates `index.rows` in place (each reached row gets its `frontmatterTags`); the caller persists.
 * `synced` comes from each row's own `syncedAt` -- the pass touches the file's mtime once, but it
 * does not pretend the content is newer than the sync that wrote it.
 */
export async function backfillFrontmatter(api: PassApi, noteStore: NoteStore, index: SyncIndex, options: BackfillOptions = {}): Promise<BackfillResult> {
	const result: BackfillResult = { written: 0, skipped: 0 };
	const select = options.select ?? (() => true);
	const newNoteId = options.newNoteId ?? (() => crypto.randomUUID());

	const byDoc = new Map<string, string[]>();
	for (const [syncKey, row] of Object.entries(index.rows)) {
		if (row.status !== "active" || !select(row)) continue;
		byDoc.set(row.docId, [...(byDoc.get(row.docId) ?? []), syncKey]);
	}
	if (byDoc.size === 0) return result;

	const entries = await api.listItems();
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));

	for (const [docId, syncKeys] of byDoc) {
		const entry = entriesById.get(docId);
		if (entry === undefined) {
			result.skipped += syncKeys.length;
			continue;
		}
		let content: DocumentContent | LegacyDocumentContent;
		try {
			content = (await api.getContent(entry.id, entry.hash)) as DocumentContent | LegacyDocumentContent;
		} catch (error) {
			console.warn(`Tagged Sync: failed to read "${entry.visibleName}" during the frontmatter backfill, skipping`, error);
			result.skipped += syncKeys.length;
			continue;
		}

		// The same per-document base the sync engine builds, from the same sources.
		const docTags = [...new Set([...tagNames(entry.tags), ...inheritedFolderTagNames(entry, entriesById), ...tagNames(content.tags)])];
		const base = {
			modified: deviceModified(entry.lastModified),
			folder: folderPathOf(entry, entriesById),
			type: content.fileType === "epub" ? ("epub" as const) : content.fileType === "pdf" ? ("pdf" as const) : ("notebook" as const),
			pinned: entry.pinned,
			uuid: entry.id,
		};

		// Null for a legacy `pages[]` document that is not PDF-backed: its page list has to be filtered
		// against the document's files, which this pass does not fetch. Those notes get no page keys
		// rather than a count that is too high, and the document's next real sync -- which does have the
		// listing -- writes the right numbers.
		const pageOrder = contentPageOrder(content);

		for (const syncKey of syncKeys) {
			const row = index.rows[syncKey];
			const note = await noteStore.read(row.notePath);
			if (note === null) {
				result.skipped++;
				continue;
			}
			const noteId = row.noteId ?? newNoteId();
			const applied = applyFrontmatter(
				note,
				{
					...base,
					tags: namespacedTags([...docTags, row.tag]),
					synced: formatLocalMinute(new Date(row.syncedAt)),
					pages: pageOrder === null ? null : row.pageId === null ? pageOrder.length : 1,
					page: pageOrder === null || row.pageId === null ? null : pageOrder.indexOf(row.pageId) + 1 || null,
					noteId,
				},
				row.frontmatterTags ?? [],
			);
			if (applied.content !== note) await noteStore.write(row.notePath, applied.content);
			index.rows[syncKey] = { ...row, frontmatterTags: applied.ownTags, noteId, frontmatterVersion: FRONTMATTER_KEYS_VERSION };
			result.written++;
		}
	}

	return result;
}

/**
 * Toggle-off: removes the plugin's keys and its tracked tags from every note the index knows --
 * orphaned rows included, because their notes may still sit in the vault -- and forgets the
 * tracked tags. User frontmatter stays. Needs no device: everything it removes is written down
 * locally. Mutates `index.rows` in place; the caller persists. Returns how many notes changed.
 */
export async function cleanupFrontmatter(noteStore: NoteStore, index: SyncIndex): Promise<number> {
	let cleaned = 0;
	for (const [syncKey, row] of Object.entries(index.rows)) {
		const note = await noteStore.read(row.notePath);
		if (note !== null) {
			const stripped = removeFrontmatter(note, row.frontmatterTags ?? []);
			if (stripped !== null) {
				await noteStore.write(row.notePath, stripped);
				cleaned++;
			}
		}
		// The tracked tags and the key-set stamp go; `noteId` stays. Turning the feature back on should
		// give a note the identity it had before, not a new one -- and the row is where that lives.
		if (row.frontmatterTags !== undefined || row.frontmatterVersion !== undefined) {
			const { frontmatterTags: _tags, frontmatterVersion: _version, ...rest } = row;
			index.rows[syncKey] = rest;
		}
	}
	return cleaned;
}
