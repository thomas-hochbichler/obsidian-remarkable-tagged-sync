import { describe, expect, it } from "vitest";
import { TagRouter } from "./tag-router";

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
