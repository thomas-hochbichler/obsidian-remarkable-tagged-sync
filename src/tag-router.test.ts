import { describe, expect, it } from "vitest";
import { mappingFingerprint, TagRouter } from "./tag-router";

describe("TagRouter", () => {
	it("resolves a mapped tag to its folder", () => {
		const router = new TagRouter({ sync: "reMarkable/Sync" });

		expect(router.resolveFolder("sync")).toBe("reMarkable/Sync");
	});

	it("returns null for an unmapped tag instead of a catch-all folder", () => {
		const router = new TagRouter({ sync: "reMarkable/Sync" });

		expect(router.resolveFolder("journal")).toBeNull();
	});

	it("returns null when nothing is mapped", () => {
		const router = new TagRouter({});

		expect(router.resolveFolder("sync")).toBeNull();
	});
});

// Gap G23. The fingerprint is what forces a full scan when the user changes a mapping -- the root
// hash only tracks the reMarkable side, so nothing else in the plugin can see a settings change at
// all. It had no test of its own: `sync-engine.test.ts` asserted it against `mappingFingerprint({...})`,
// which is the function agreeing with itself.
describe("mappingFingerprint", () => {
	it("is the same string whichever order the keys were written in", () => {
		// `data.json` is edited by hand, merged by Obsidian Sync and rewritten by two vaults. Key order
		// is not stable across any of that, and without the sort every reordering reads as a settings
		// change -- a full rescan of every notebook in the account, for nothing.
		expect(mappingFingerprint({ work: "Work", archive: "Archive", home: "Home" })).toBe(
			mappingFingerprint({ home: "Home", work: "Work", archive: "Archive" }),
		);
	});

	it("changes when a mapping is added, removed or re-targeted", () => {
		const one = mappingFingerprint({ work: "Work" });

		expect(mappingFingerprint({ work: "Work", home: "Home" })).not.toBe(one);
		expect(mappingFingerprint({})).not.toBe(one);
		expect(mappingFingerprint({ work: "Archive" })).not.toBe(one);
	});

	it("does not confuse a swap of two folders with the mapping it came from", () => {
		// The one reordering that is a real change: the same two tags and the same two folders, crossed
		// over. A fingerprint over sorted *values* would call these equal.
		expect(mappingFingerprint({ work: "Work", home: "Home" })).not.toBe(
			mappingFingerprint({ work: "Home", home: "Work" }),
		);
	});

	it("carries its version, asserted as a literal so a semantics change cannot forget the bump", () => {
		// Against the string, deliberately, and not against the function: the version exists so that a
		// change to what routing *means* makes every vault run one full scan, and the only thing that
		// can enforce it is a test that has to be edited by hand when the number moves.
		expect(mappingFingerprint({ work: "Work" })).toBe('3:[["work","Work"]]');
		expect(mappingFingerprint({})).toBe("3:[]");
	});

	it("is what the router reports about itself", () => {
		expect(new TagRouter({ work: "Work" }).fingerprint()).toBe(mappingFingerprint({ work: "Work" }));
	});
});
