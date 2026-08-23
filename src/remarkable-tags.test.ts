import { describe, expect, it, vi } from "vitest";
import type { Content, Entry } from "rmapi-js";
import { collectTagNames, enumerateNotebookTags } from "./remarkable-tags";

function documentEntry(overrides: Partial<Entry> = {}): Entry {
	return {
		id: "doc-1",
		hash: "hash-1",
		visibleName: "Notebook",
		lastModified: "0",
		pinned: false,
		parent: "",
		type: "DocumentType",
		fileType: "notebook",
		lastOpened: "0",
		...overrides,
	} as Entry;
}

function collectionEntry(overrides: Partial<Entry> = {}): Entry {
	return {
		id: "folder-1",
		hash: "hash-folder-1",
		visibleName: "Folder",
		lastModified: "0",
		pinned: false,
		parent: "",
		type: "CollectionType",
		...overrides,
	} as Entry;
}

function documentContent(overrides: Partial<Content> = {}): Content {
	return {
		coverPageNumber: 0,
		documentMetadata: {},
		extraMetadata: {},
		fileType: "notebook",
		fontName: "",
		lineHeight: -1,
		orientation: "portrait",
		pageCount: 1,
		textAlignment: "",
		textScale: 1,
		...overrides,
	} as Content;
}

function fakeApi(items: Entry[], contentById: Record<string, Content>) {
	return {
		listItems: vi.fn().mockResolvedValue(items),
		getContent: vi.fn(async (id: string) => {
			const content = contentById[id];
			if (!content) throw new Error(`no content for ${id}`);
			return content;
		}),
	};
}

describe("enumerateNotebookTags", () => {
	it("reads document-level tags from the entry", async () => {
		const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
		const api = fakeApi([entry], { "doc-1": documentContent() });

		const notebooks = await enumerateNotebookTags(api);

		expect(notebooks).toEqual([
			{ docId: "doc-1", visibleName: "Notebook", tags: ["sync"], pageTags: [] },
		]);
	});

	it("reads document-level tags from content.tags", async () => {
		const entry = documentEntry();
		const api = fakeApi([entry], {
			"doc-1": documentContent({ tags: [{ name: "journal", timestamp: 0 }] }),
		});

		const notebooks = await enumerateNotebookTags(api);

		expect(notebooks[0].tags).toEqual(["journal"]);
	});

	it("merges and dedupes entry tags with content tags", async () => {
		const entry = documentEntry({ tags: [{ name: "sync", timestamp: 0 }] });
		const api = fakeApi([entry], {
			"doc-1": documentContent({ tags: [{ name: "sync", timestamp: 0 }, { name: "journal", timestamp: 0 }] }),
		});

		const notebooks = await enumerateNotebookTags(api);

		expect(notebooks[0].tags.sort()).toEqual(["journal", "sync"]);
	});

	it("handles legacy string[] tags", async () => {
		const entry = documentEntry({ tags: ["legacy-tag"] });
		const api = fakeApi([entry], {
			"doc-1": documentContent({ tags: ["legacy-tag"] } as Partial<Content>),
		});

		const notebooks = await enumerateNotebookTags(api);

		expect(notebooks[0].tags).toEqual(["legacy-tag"]);
	});

	it("reads page-level tags pinned to a pageId", async () => {
		const entry = documentEntry();
		const api = fakeApi([entry], {
			"doc-1": documentContent({
				pageTags: [{ name: "todo", timestamp: 0, pageId: "page-a" }],
			}),
		});

		const notebooks = await enumerateNotebookTags(api);

		expect(notebooks[0].pageTags).toEqual([{ pageId: "page-a", tag: "todo" }]);
	});

	it("handles pages: null without crashing", async () => {
		const entry = documentEntry();
		const api = fakeApi([entry], {
			"doc-1": documentContent({
				pages: null,
				pageTags: [{ name: "todo", timestamp: 0, pageId: "page-a" }],
			}),
		});

		const notebooks = await enumerateNotebookTags(api);

		expect(notebooks[0].pageTags).toEqual([{ pageId: "page-a", tag: "todo" }]);
	});

	it("inherits tags from every ancestor folder", async () => {
		const outer = collectionEntry({
			id: "folder-outer",
			tags: [{ name: "obsidian", timestamp: 0 }],
		});
		const inner = collectionEntry({
			id: "folder-inner",
			parent: "folder-outer",
			tags: [{ name: "journal", timestamp: 0 }],
		});
		const entry = documentEntry({
			parent: "folder-inner",
			tags: [{ name: "direct", timestamp: 0 }],
		});
		const api = fakeApi([outer, inner, entry], {
			"doc-1": documentContent({ tags: [{ name: "content", timestamp: 0 }] }),
		});

		const notebooks = await enumerateNotebookTags(api);

		expect(notebooks[0].tags).toEqual(["direct", "content", "journal", "obsidian"]);
	});

	// Gap G40. A document the user moved to the trash keeps its `parent` chain, and the folder it came
	// out of keeps its tags -- so without the `trash` guard a deleted notebook goes on syncing into
	// the vault forever, and deleting it on the device does nothing.
	it("stops at the trash, so a deleted notebook stops inheriting tags", async () => {
		// The device lists a `trash` collection of its own, and a deleted item's `parent` points at it
		// while keeping everything else about the item intact. Without the guard, any tag on that
		// collection -- or on anything above it -- routes every deleted notebook in the account into
		// the vault, and deleting a notebook on the device does nothing at all.
		const trash = collectionEntry({ id: "trash", parent: "", tags: [{ name: "obsidian", timestamp: 0 }] });
		const entry = documentEntry({ parent: "trash" });
		const api = fakeApi([trash, entry], { "doc-1": documentContent() });

		const notebooks = await enumerateNotebookTags(api);

		expect(notebooks[0].tags).toEqual([]);
	});

	it("stops safely when the folder parent chain contains a cycle", async () => {
		const first = collectionEntry({ id: "folder-1", parent: "folder-2", tags: ["one"] });
		const second = collectionEntry({ id: "folder-2", parent: "folder-1", tags: ["two"] });
		const entry = documentEntry({ parent: "folder-1" });
		const api = fakeApi([first, second, entry], { "doc-1": documentContent() });

		const notebooks = await enumerateNotebookTags(api);

		expect(notebooks[0].tags).toEqual(["one", "two"]);
	});

	it("skips non-document entries", async () => {
		const collection: Entry = {
			id: "col-1",
			hash: "hash-c",
			visibleName: "Folder",
			lastModified: "0",
			pinned: false,
			type: "CollectionType",
		} as Entry;
		const api = fakeApi([collection], {});

		const notebooks = await enumerateNotebookTags(api);

		expect(notebooks).toEqual([]);
		expect(api.getContent).not.toHaveBeenCalled();
	});

	it("skips a document whose content fails to load, and keeps the rest", async () => {
		const broken = documentEntry({ id: "doc-broken", hash: "hash-broken" });
		const ok = documentEntry({
			id: "doc-1",
			tags: [{ name: "sync", timestamp: 0 }],
		});
		const api = fakeApi([broken, ok], { "doc-1": documentContent() });

		const notebooks = await enumerateNotebookTags(api);

		expect(notebooks).toHaveLength(1);
		expect(notebooks[0].docId).toBe("doc-1");
	});
});

describe("collectTagNames", () => {
	it("dedupes and sorts tags across notebooks, docs, and pages", () => {
		const names = collectTagNames([
			{
				docId: "doc-1",
				visibleName: "A",
				tags: ["sync", "journal"],
				pageTags: [{ pageId: "p1", tag: "todo" }],
			},
			{
				docId: "doc-2",
				visibleName: "B",
				tags: ["sync"],
				pageTags: [{ pageId: "p2", tag: "journal" }],
			},
		]);

		expect(names).toEqual(["journal", "sync", "todo"]);
	});
});
