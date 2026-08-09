import type { RawRemarkableApi } from "rmapi-js";
import { describe, expect, it, vi } from "vitest";
import { parseMetadataText, tolerateLegacyMetadata } from "./remarkable-metadata";

/** A document's metadata as the cloud sent it in issue #10: four legacy fields set to null. */
const LEGACY_NULLS = JSON.stringify({
	visibleName: "Meeting notes",
	lastModified: "1754000000000",
	parent: "",
	pinned: false,
	type: "DocumentType",
	deleted: null,
	metadatamodified: null,
	modified: null,
	synced: null,
});

describe("parseMetadataText", () => {
	it("reads metadata whose legacy fields are null", () => {
		const metadata = parseMetadataText(LEGACY_NULLS);

		expect(metadata.visibleName).toBe("Meeting notes");
		expect(metadata).not.toHaveProperty("deleted");
		expect(metadata).not.toHaveProperty("synced");
	});

	it("keeps a legacy field that carries a real value", () => {
		const metadata = parseMetadataText(JSON.stringify({ ...JSON.parse(LEGACY_NULLS), deleted: true }));

		expect(metadata.deleted).toBe(true);
	});

	it("names the field when a required one is missing", () => {
		const { visibleName: _dropped, ...rest } = JSON.parse(LEGACY_NULLS) as Record<string, unknown>;

		expect(() => parseMetadataText(JSON.stringify(rest))).toThrow(/visibleName/);
	});

	it("rejects a required field that is null, rather than reading it as absent", () => {
		const text = JSON.stringify({ ...JSON.parse(LEGACY_NULLS), pinned: null });

		expect(() => parseMetadataText(text)).toThrow(/pinned/);
	});

	it("rejects metadata that is not an object", () => {
		expect(() => parseMetadataText('"not an object"')).toThrow(/object/);
	});
});

describe("tolerateLegacyMetadata", () => {
	it("routes getMetadata through the lenient parse", async () => {
		const raw = {
			getText: vi.fn().mockResolvedValue(LEGACY_NULLS),
			getMetadata: vi.fn().mockRejectedValue(new Error("rmapi-js would have rejected this")),
		} as unknown as RawRemarkableApi;

		tolerateLegacyMetadata(raw);

		await expect(raw.getMetadata("doc-1.metadata", "hash-1")).resolves.toMatchObject({
			visibleName: "Meeting notes",
		});
		expect(raw.getText).toHaveBeenCalledWith("doc-1.metadata", "hash-1");
	});
});
