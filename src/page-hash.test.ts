import { describe, expect, it, vi } from "vitest";
import type { RawEntry } from "rmapi-js";
import { getDocumentFiles } from "./page-hash";

function rawEntry(id: string, hash: string): RawEntry {
	return { id, hash, type: 0, subfiles: 0, size: 0 };
}

function fakeApi(entries: RawEntry[]) {
	return { raw: { getEntries: vi.fn().mockResolvedValue({ entries }) } };
}

describe("getDocumentFiles", () => {
	it("maps each page's .rm entry to its content-addressed hash", async () => {
		const api = fakeApi([
			rawEntry("doc-1.content", "content-hash"),
			rawEntry("doc-1.metadata", "metadata-hash"),
			rawEntry("doc-1/page-a.rm", "hash-a"),
			rawEntry("doc-1/page-b.rm", "hash-b"),
		]);

		const { pages } = await getDocumentFiles(api, "doc-1", "doc-hash-1");

		expect(pages).toEqual(new Map([["page-a", "hash-a"], ["page-b", "hash-b"]]));
	});

	it("requests the document's own entry list by id and hash", async () => {
		const api = fakeApi([]);

		await getDocumentFiles(api, "doc-1", "doc-hash-1");

		expect(api.raw.getEntries).toHaveBeenCalledWith("doc-1.docSchema", "doc-hash-1");
	});

	it("ignores non-.rm subfiles (content/metadata)", async () => {
		const api = fakeApi([rawEntry("doc-1.content", "content-hash"), rawEntry("doc-1.metadata", "metadata-hash")]);

		const { pages } = await getDocumentFiles(api, "doc-1", "doc-hash-1");

		expect(pages.size).toBe(0);
	});

	it("returns empty maps for a document with no pages", async () => {
		const api = fakeApi([]);

		const files = await getDocumentFiles(api, "doc-1", "doc-hash-1");

		expect(files.pages.size).toBe(0);
		expect(files.images.size).toBe(0);
	});

	it("keys a page's pictures by file name, and keeps the entry id it takes to fetch one", async () => {
		// The device puts them in a folder named for the page: this is what an imported article's
		// illustrations look like in the index.
		const api = fakeApi([
			rawEntry("doc-1/page-a.rm", "hash-a"),
			rawEntry("doc-1/page-a/5e2cbab0.png", "hash-png"),
			rawEntry("doc-1/page-a/20921767.JPG", "hash-jpg"),
		]);

		const { pages, images } = await getDocumentFiles(api, "doc-1", "doc-hash-1");

		expect(pages).toEqual(new Map([["page-a", "hash-a"]]));
		expect(images).toEqual(
			new Map([
				["5e2cbab0.png", { id: "doc-1/page-a/5e2cbab0.png", hash: "hash-png" }],
				["20921767.JPG", { id: "doc-1/page-a/20921767.JPG", hash: "hash-jpg" }],
			]),
		);
	});
});
