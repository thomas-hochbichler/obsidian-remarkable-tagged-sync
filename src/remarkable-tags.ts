import type { DocumentContent, LegacyDocumentContent, RemarkableApi, Tag } from "rmapi-js";

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

export async function enumerateNotebookTags(api: EnumerateApi): Promise<NotebookTags[]> {
	const items = await api.listItems();
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

		const tags = new Set([...tagNames(item.tags), ...tagNames(content.tags)]);
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
