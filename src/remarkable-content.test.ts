import { readFileSync } from "node:fs";
import type { RawRemarkableApi } from "rmapi-js";
import { describe, expect, it, vi } from "vitest";
import { parseContentText, tolerateSlimContent } from "./remarkable-content";

describe("parseContentText", () => {
	it("reads a .content that has only the six keys from issue #156", () => {
		const content = parseContentText(
			JSON.stringify({ coverPageNumber: -1, cPages: { pages: [] }, fileType: "notebook", formatVersion: 2, orientation: "portrait", pageCount: 0 }),
		);

		expect(content).toMatchObject({ fileType: "notebook", cPages: { pages: [] } });
	});

	it("rejects content that is not an object", () => {
		expect(() => parseContentText("[]")).toThrow("not a JSON object");
	});

	it("rejects a fileType that is not a string", () => {
		expect(() => parseContentText(JSON.stringify({ fileType: 3 }))).toThrow('"fileType" was not a string');
	});

	it("rejects tags that are not an array", () => {
		expect(() => parseContentText(JSON.stringify({ fileType: "notebook", tags: "work" }))).toThrow('"tags" was not an array');
	});

	it("rejects cPages without a pages array", () => {
		expect(() => parseContentText(JSON.stringify({ fileType: "notebook", cPages: {} }))).toThrow('"cPages.pages" was not an array');
	});
});

describe("tolerateSlimContent", () => {
	it("routes getContent through the lenient parse", async () => {
		const raw = { getText: vi.fn().mockResolvedValue(JSON.stringify({ fileType: "pdf" })), getContent: vi.fn() } as unknown as RawRemarkableApi;

		tolerateSlimContent(raw);
		const content = await raw.getContent("doc-1.content", "hash-1");

		expect(raw.getText).toHaveBeenCalledWith("doc-1.content", "hash-1");
		expect(content).toEqual({ fileType: "pdf" });
	});
});

// The same recorded contract as for metadata: the patch only helps while rmapi-js reaches content
// through `raw.getContent`. Rename or inline that, and issue #156 returns with every test green.
describe("the assumption the content patch rests on", () => {
	it("still has rmapi-js reach content through `raw.getContent`", () => {
		const source = readFileSync(new URL("../node_modules/rmapi-js/dist/index.js", import.meta.url), "utf8");

		expect(source.match(/this\.raw\.getContent\(/g)?.length ?? 0).toBeGreaterThan(0);
	});
});
