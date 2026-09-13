import type { Entries, RawEntry } from "rmapi-js";
import { describe, expect, it, vi } from "vitest";
import { openSession } from "./remarkable-session";

/**
 * A notebook's `.content` as the cloud sent it in issue #156: only these six keys, none of the
 * fields rmapi-js's document schema requires (`documentMetadata`, `extraMetadata`, `fontName`,
 * `lineHeight`, `textAlignment`, `textScale`). The key list is exact -- it is what the reporter's
 * ZodError named as "unrecognized" for the collection branch of the content union.
 */
const MINIMAL_CONTENT = JSON.stringify({
	coverPageNumber: -1,
	cPages: { lastOpened: { timestamp: "1:1", value: "" }, original: { timestamp: "1:1", value: -1 }, pages: [], uuids: null },
	fileType: "notebook",
	formatVersion: 2,
	orientation: "portrait",
	pageCount: 0,
	tags: [{ name: "work", timestamp: 1 }],
});

const METADATA = JSON.stringify({
	visibleName: "Slim notebook",
	lastModified: "1757700000000",
	parent: "",
	pinned: false,
	type: "DocumentType",
});

const entry = (id: string, hash: string): RawEntry => ({ hash, type: 0, id, subfiles: 0, size: 1 });

describe("openSession", () => {
	it("lists a notebook whose .content has only the six keys from issue #156", async () => {
		const api = openSession("session-token");
		const raw = api.raw;
		raw.getRootHash = vi.fn().mockResolvedValue(["root-hash", 1, 4]);
		raw.getEntries = vi.fn(async (fileName: string): Promise<Entries> =>
			fileName === "root.docSchema"
				? { id: "root", size: 1, entries: [entry("doc-1", "doc-hash")] }
				: { id: "doc-1", size: 2, entries: [entry("doc-1.metadata", "meta-hash"), entry("doc-1.content", "content-hash")] },
		);
		raw.getText = vi.fn(async (fileName: string) => (fileName.endsWith(".content") ? MINIMAL_CONTENT : METADATA));

		const items = await api.listItems();

		expect(items).toEqual([expect.objectContaining({ id: "doc-1", type: "DocumentType", fileType: "notebook", tags: [{ name: "work", timestamp: 1 }] })]);
	});
});
