import { readFileSync } from "node:fs";
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

	// Issue #69: the cloud can omit `parent` -- rmapi-js's own Entry type documents it as
	// '"" (empty string) for the root directory ... or omitted for root'.
	it("reads a missing parent as the root directory", () => {
		const { parent: _dropped, ...rest } = JSON.parse(LEGACY_NULLS) as Record<string, unknown>;

		expect(parseMetadataText(JSON.stringify(rest)).parent).toBe("");
	});

	it("reads a null parent as the root directory", () => {
		const text = JSON.stringify({ ...JSON.parse(LEGACY_NULLS), parent: null });

		expect(parseMetadataText(text).parent).toBe("");
	});

	it("still rejects a parent that is present but not a string", () => {
		const text = JSON.stringify({ ...JSON.parse(LEGACY_NULLS), parent: 7 });

		expect(() => parseMetadataText(text)).toThrow(/parent/);
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

// Gap G40, and the one on that list with real teeth. The patch above only helps if rmapi-js's own
// `listItems()` actually goes through `raw.getMetadata` -- and nothing verified that. If upstream
// renames it, inlines it, or fetches metadata another way, the patch becomes a no-op, issue #10
// returns for every account with one legacy document, and every test in this repo stays green.
//
// A recorded contract, in ticket 06's sense: it reads the shipped library rather than mocking it, so
// the day the assumption stops holding is the day `npm update` turns this red.
describe("the assumption the patch rests on", () => {
	const rmapiSource = (): string =>
		readFileSync(new URL("../node_modules/rmapi-js/dist/index.js", import.meta.url), "utf8");

	it("still finds a `raw.getMetadata` for the patch to replace", () => {
		expect(rmapiSource()).toMatch(/this\.raw\.getMetadata\(/);
	});

	it("still has `listItems` reach metadata through the raw API, not around it", () => {
		// `listItems` -> `listIds` + `#convertEntry`, and the conversion is what asks for metadata.
		// Asserted as "some path from listItems reaches raw.getMetadata", because pinning the private
		// method name would go red on a refactor that changed nothing that matters here.
		const source = rmapiSource();

		expect(source).toMatch(/async listItems\(/);
		expect(source.match(/this\.raw\.getMetadata\(/g)?.length ?? 0).toBeGreaterThan(0);
	});

	it("is pinned to the version this assumption was checked against", () => {
		// rmapi-js 11.1.2 was read by hand: `listItems` -> `#convertEntry` -> `this.raw.getMetadata`.
		// A major bump is where a rename would arrive, so it has to be looked at rather than absorbed.
		const version = (JSON.parse(readFileSync(new URL("../node_modules/rmapi-js/package.json", import.meta.url), "utf8")) as { version: string }).version;

		expect(version.split(".")[0]).toBe("11");
	});
});
