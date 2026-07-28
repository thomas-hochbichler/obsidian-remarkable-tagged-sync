import { describe, expect, it, vi } from "vitest";
import type { RawEntry } from "rmapi-js";
import { getPageHashes } from "./page-hash";

function rawEntry(id: string, hash: string): RawEntry {
	return { id, hash, type: 0, subfiles: 0, size: 0 };
}

function fakeApi(entries: RawEntry[]) {
	return { raw: { getEntries: vi.fn().mockResolvedValue({ entries }) } };
}

describe("getPageHashes", () => {
	it("maps each page's .rm entry to its content-addressed hash", async () => {
		const api = fakeApi([
			rawEntry("doc-1.content", "content-hash"),
			rawEntry("doc-1.metadata", "metadata-hash"),
			rawEntry("doc-1/page-a.rm", "hash-a"),
			rawEntry("doc-1/page-b.rm", "hash-b"),
		]);

		const hashes = await getPageHashes(api, "doc-1", "doc-hash-1");

		expect(hashes).toEqual(new Map([["page-a", "hash-a"], ["page-b", "hash-b"]]));
	});

	it("requests the document's own entry list by id and hash", async () => {
		const api = fakeApi([]);

		await getPageHashes(api, "doc-1", "doc-hash-1");

		expect(api.raw.getEntries).toHaveBeenCalledWith("doc-1.docSchema", "doc-hash-1");
	});

	it("ignores non-.rm subfiles (content/metadata)", async () => {
		const api = fakeApi([rawEntry("doc-1.content", "content-hash"), rawEntry("doc-1.metadata", "metadata-hash")]);

		const hashes = await getPageHashes(api, "doc-1", "doc-hash-1");

		expect(hashes.size).toBe(0);
	});

	it("returns an empty map for a document with no pages", async () => {
		const api = fakeApi([]);

		const hashes = await getPageHashes(api, "doc-1", "doc-hash-1");

		expect(hashes.size).toBe(0);
	});
});
