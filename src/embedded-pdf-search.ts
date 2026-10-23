// `Cmd+F` inside a PDF embedded in a note (ticket 26, research/25).
//
// Obsidian gives `Mod+F` to "Search current file", which asks the note's editor first, so a click into
// the embedded PDF and `Cmd+F` searches the note. Yet every PDF embed already carries the PDF viewer's
// find bar; nothing opens it. While the embed has the focus, a scope of ours takes `Mod+F` and opens it
// (`embedded-pdf-keys.ts`).
//
// The way to that find bar is Obsidian's internals (`_children`, `containerEl`, `viewer.child.findBar`),
// unminified and unchanged since 2023 but undocumented. When an update moves them, `Mod+F` opens the PDF
// in a tab instead, where `Cmd+F` searches it as the help documents. No error, no notice.

/** One node of a view's component tree, as far as this file reads it. Every field is internal. */
interface EmbedTreeNode {
	_children?: unknown;
	containerEl?: unknown;
	viewer?: { child?: { findBar?: { showSearch?: () => void } } | null };
}

/** The node under `root` whose `containerEl` is `el`, depth first. */
function nodeAt(root: unknown, el: unknown): EmbedTreeNode | null {
	const node = root as EmbedTreeNode | null;
	if (node === null || typeof node !== "object") return null;
	if (node.containerEl === el) return node;
	if (!Array.isArray(node._children)) return null;
	for (const child of node._children) {
		const found = nodeAt(child, el);
		if (found !== null) return found;
	}
	return null;
}

/**
 * Opens the find bar of the PDF embed whose element is `embedEl`, found under the note's view `root`;
 * or, where that way is gone, calls `openInTab`.
 */
export function searchEmbeddedPdf(root: unknown, embedEl: unknown, openInTab: () => void): void {
	const findBar = nodeAt(root, embedEl)?.viewer?.child?.findBar;
	if (typeof findBar?.showSearch === "function") findBar.showSearch();
	else openInTab();
}
