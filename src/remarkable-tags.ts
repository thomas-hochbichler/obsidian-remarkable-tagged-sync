import type { DocumentContent, Entry, LegacyDocumentContent, RemarkableApi, Tag } from "rmapi-js";

export interface PageTagOccurrence {
	pageId: string;
	tag: string;
}

export interface NotebookTags {
	docId: string;
	visibleName: string;
	tags: string[];
	pageTags: PageTagOccurrence[];
}

type EnumerateApi = Pick<RemarkableApi, "listItems" | "getContent">;

export function tagNames(tags: Tag[] | string[] | undefined): string[] {
	if (!tags) return [];
	return tags.map((tag) => (typeof tag === "string" ? tag : tag.name));
}

/**
 * Tags applied to every collection above an item, nearest collection first.
 *
 * reMarkable stores a folder tag on the CollectionType entry itself; it does not copy that tag to
 * the documents inside it. Following the parent chain here lets a tagged folder act as a routing
 * rule for every notebook below it, including notebooks in nested folders. A malformed parent cycle
 * is stopped rather than hanging a sync.
 */
export function inheritedFolderTagNames(item: Entry, itemsById: ReadonlyMap<string, Entry>): string[] {
	const names = new Set<string>();
	const visited = new Set<string>();
	let parentId = item.parent;

	while (parentId && parentId !== "trash" && !visited.has(parentId)) {
		visited.add(parentId);
		const parent = itemsById.get(parentId);
		if (!parent || parent.type !== "CollectionType") break;
		for (const tag of tagNames(parent.tags)) names.add(tag);
		parentId = parent.parent;
	}

	return [...names];
}

/**
 * The device folder path an item sits in (`Work/Projekt X`), or null for an item at the root.
 * Walks the same parent chain {@link inheritedFolderTagNames} walks, with the same cycle stop.
 */
export function folderPathOf(item: Entry, itemsById: ReadonlyMap<string, Entry>): string | null {
	const names: string[] = [];
	const visited = new Set<string>();
	let parentId = item.parent;

	while (parentId && parentId !== "trash" && !visited.has(parentId)) {
		visited.add(parentId);
		const parent = itemsById.get(parentId);
		if (!parent || parent.type !== "CollectionType") break;
		names.unshift(parent.visibleName);
		parentId = parent.parent;
	}

	return names.length === 0 ? null : names.join("/");
}

/**
 * Whether an item sits in the device's trash -- directly, or inside a folder that was trashed.
 *
 * Deleting on the device only re-parents into `trash`; the tombstone (`deleted: true`) comes later,
 * with the next cloud sync. Until then the document still enumerates with its own tags and page
 * tags intact, so without this check "delete on the device" would not stop its notes from syncing.
 */
export function isInTrash(item: Entry, itemsById: ReadonlyMap<string, Entry>): boolean {
	const visited = new Set<string>();
	let parentId = item.parent;
	while (parentId && !visited.has(parentId)) {
		if (parentId === "trash") return true;
		visited.add(parentId);
		parentId = itemsById.get(parentId)?.parent;
	}
	return false;
}

export async function enumerateNotebookTags(api: EnumerateApi): Promise<NotebookTags[]> {
	const items = await api.listItems();
	const itemsById = new Map(items.map((item) => [item.id, item]));
	const notebooks: NotebookTags[] = [];

	for (const item of items) {
		if (item.type !== "DocumentType") continue;

		let content: DocumentContent | LegacyDocumentContent;
		try {
			// getContent for a DocumentType entry is always document content, never collection/template content.
			content = (await api.getContent(item.id, item.hash)) as DocumentContent | LegacyDocumentContent;
		} catch (error) {
			console.warn(`Tagged Sync: failed to read tags for "${item.visibleName}"`, error);
			continue;
		}

		const tags = new Set([
			...tagNames(item.tags),
			...tagNames(content.tags),
			...inheritedFolderTagNames(item, itemsById),
		]);
		const pageTags: PageTagOccurrence[] = (content.pageTags ?? []).map((pageTag) => ({
			pageId: pageTag.pageId,
			tag: pageTag.name,
		}));

		notebooks.push({
			docId: item.id,
			visibleName: item.visibleName,
			tags: [...tags],
			pageTags,
		});
	}

	return notebooks;
}

export function collectTagNames(notebooks: NotebookTags[]): string[] {
	const names = new Set<string>();
	for (const notebook of notebooks) {
		for (const tag of notebook.tags) names.add(tag);
		for (const { tag } of notebook.pageTags) names.add(tag);
	}
	return [...names].sort();
}
