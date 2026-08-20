/**
 * Following a synced note the user moved.
 *
 * A note this plugin writes carries no frontmatter to re-find it by. The sync index is the only link
 * between a reMarkable page and the file it was written to, and that link is one string: the row's
 * `notePath`. Let it go stale and the row strands -- the next sync decides the note was never
 * written, writes it again, and the user finds a duplicate beside the one they moved. Nothing on
 * screen says so.
 *
 * Obsidian reports a folder move **twice over**: once for the folder, then once more for every
 * descendant, because renaming a folder does not move its children (`TFolder` never overrides
 * `setPath`, so each child is still indexed under the old prefix). Either half alone would leave the
 * rows correct. The folder half is here for the write count: without it a folder of two hundred
 * notes is two hundred writes of `data.json` -- a file Obsidian Sync is watching -- instead of one.
 */

/** A rename, with the one thing about the moved entry that changes the answer. */
export interface Renamed {
	readonly kind: "file" | "folder";
	readonly from: string;
	readonly to: string;
}

/**
 * Where a note at `notePath` ends up, or `null` if this rename does not move it.
 *
 * The two branches are exclusive on purpose. A row always holds a file path, so a *folder* whose
 * path happens to equal one is not that note being renamed, and matching it would rewrite a row on
 * an event that never touched its file.
 */
export function remapNotePath(renamed: Renamed, notePath: string): string | null {
	if (renamed.kind === "file") return notePath === renamed.from ? renamed.to : null;
	// The separator is part of the comparison. Without it a rename of `Notes` drags `Notes2` along,
	// and the rows would point into a folder the user never touched.
	const prefix = `${renamed.from}/`;
	return notePath.startsWith(prefix) ? `${renamed.to}/${notePath.slice(prefix.length)}` : null;
}

/**
 * The rows after `renamed`, or `null` when it moves none of them -- which is almost every rename in
 * a vault, and the reason `data.json` is not rewritten on each one.
 *
 * Nothing here looks at where a row lands, so a note renamed onto a path another row still claims
 * leaves two rows naming one file. Reachable when that row is orphaned and its own file deleted, so
 * the vault sees the path as free. Which row should lose is a product question, not this function's.
 */
export function remapRows<Row extends { readonly notePath: string }>(
	rows: Record<string, Row>,
	renamed: Renamed,
): Record<string, Row> | null {
	let moved = false;
	const next: Record<string, Row> = {};
	for (const [key, row] of Object.entries(rows)) {
		const notePath = remapNotePath(renamed, row.notePath);
		next[key] = notePath === null ? row : { ...row, notePath };
		moved ||= notePath !== null;
	}
	return moved ? next : null;
}
