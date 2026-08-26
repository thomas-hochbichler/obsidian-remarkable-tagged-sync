import type { DocumentContent, LegacyDocumentContent, RemarkableApi } from "rmapi-js";
import { applyFrontmatter, deviceModified, formatLocalMinute, namespacedTags, removeFrontmatter } from "./frontmatter";
import type { NoteStore } from "./note-builder";
import { folderPathOf, inheritedFolderTagNames, tagNames } from "./remarkable-tags";
import type { SyncIndex } from "./sync-engine";

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

/**
 * Toggle-on: writes the keys into every already-synced note, so views are complete from day one.
 * Mutates `index.rows` in place (each reached row gets its `frontmatterTags`); the caller persists.
 * `synced` comes from each row's own `syncedAt` -- the pass touches the file's mtime once, but it
 * does not pretend the content is newer than the sync that wrote it.
 */
export async function backfillFrontmatter(api: PassApi, noteStore: NoteStore, index: SyncIndex): Promise<BackfillResult> {
	const result: BackfillResult = { written: 0, skipped: 0 };

	const byDoc = new Map<string, string[]>();
	for (const [syncKey, row] of Object.entries(index.rows)) {
		if (row.status !== "active") continue;
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

		for (const syncKey of syncKeys) {
			const row = index.rows[syncKey];
			const note = await noteStore.read(row.notePath);
			if (note === null) {
				result.skipped++;
				continue;
			}
			const applied = applyFrontmatter(
				note,
				{ ...base, tags: namespacedTags([...docTags, row.tag]), synced: formatLocalMinute(new Date(row.syncedAt)) },
				row.frontmatterTags ?? [],
			);
			if (applied.content !== note) await noteStore.write(row.notePath, applied.content);
			index.rows[syncKey] = { ...row, frontmatterTags: applied.ownTags };
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
		if (row.frontmatterTags !== undefined) {
			const { frontmatterTags: _removed, ...rest } = row;
			index.rows[syncKey] = rest;
		}
	}
	return cleaned;
}
