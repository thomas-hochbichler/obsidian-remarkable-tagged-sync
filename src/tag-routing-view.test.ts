import { describe, expect, it } from "vitest";
import type { Entitlement } from "./licence-state";
import { FREE_TAG_LIMIT, planTagRouting, tagLimitFor } from "./tag-routing-view";

// Gap G04. These import neither `obsidian` nor the plugin -- which is the point of the seam: the free
// version's tag cap used to be reachable only by rendering six settings sections.
//
// What the shipped tab does with this plan is `tag-routing-section.test.ts`.

const FREE: Entitlement = { tier: "free", reason: "never-bought" };
const REVOKED: Entitlement = { tier: "free", reason: "revoked" };
const TRIAL: Entitlement = { tier: "trial", endsAt: "2099-01-01T00:00:00.000Z" };
const PRO: Entitlement = { tier: "pro", since: "2026-01-01T00:00:00.000Z", stale: false };

const VAULT = ["/", "Home", "Work"];

function plan(input: {
	mapping?: Record<string, string>;
	foundTags?: string[] | null;
	folderPaths?: string[];
	entitlement?: Entitlement;
}) {
	return planTagRouting({
		mapping: input.mapping ?? {},
		foundTags: input.foundTags === undefined ? [] : input.foundTags,
		folderPaths: input.folderPaths ?? VAULT,
		entitlement: input.entitlement ?? FREE,
	});
}

/** Tags named a to l: twelve, the count the filter starts at. */
const TWELVE = "abcdefghijkl".split("");

describe("tagLimitFor", () => {
	it("gives the free tier exactly one mapping", () => {
		expect(tagLimitFor(FREE)).toBe(1);
		expect(FREE_TAG_LIMIT).toBe(1);
	});

	it("gives a paid or trialling user no limit", () => {
		expect(tagLimitFor(PRO)).toBe(Number.POSITIVE_INFINITY);
		expect(tagLimitFor(TRIAL)).toBe(Number.POSITIVE_INFINITY);
	});

	it("falls back to the free limit when a licence is revoked", () => {
		// Proportionate rather than punitive: the cap blocks adding, and every mapped folder keeps
		// syncing. See the `never revokes` test below, which is the half that matters.
		expect(tagLimitFor(REVOKED)).toBe(1);
	});
});

describe("planTagRouting", () => {
	it("asks for a scan before the first one, and offers nothing to map", () => {
		expect(plan({ foundTags: null })).toEqual({
			mapped: [],
			pills: [],
			lines: ["scan-first"],
			removalNote: false,
			filter: false,
			recheckLicenceBeforeAdd: false,
		});
	});

	it("says a scan found nothing, so an empty tablet is not read as a broken scan", () => {
		expect(plan({ foundTags: [] }).lines).toEqual(["nothing-found"]);
	});

	it("offers the first tag a free user has found as a pill, without asking Polar", () => {
		const view = plan({ foundTags: ["work"] });

		expect(view.pills).toEqual([{ tag: "work", capped: false }]);
		expect(view.lines).toEqual([]);
		// Nothing is mapped yet, so nothing is being unlocked -- a free user never talks to Polar.
		expect(view.recheckLicenceBeforeAdd).toBe(false);
	});

	it("caps every further pill for a free user, and says why above them", () => {
		const view = plan({ mapping: { work: "Work" }, foundTags: ["work", "home", "ideas"] });

		expect(view.mapped.map((row) => row.tag)).toEqual(["work"]);
		expect(view.pills).toEqual([
			{ tag: "home", capped: true },
			{ tag: "ideas", capped: true },
		]);
		expect(view.lines).toEqual(["cap"]);
		expect(view.removalNote).toBe(true);
		expect(view.recheckLicenceBeforeAdd).toBe(false);
	});

	it("lets a paid user map the second tag, and re-checks the licence when they do", () => {
		const view = plan({ mapping: { work: "Work" }, foundTags: ["work", "home"], entitlement: PRO });

		expect(view.pills).toEqual([{ tag: "home", capped: false }]);
		expect(view.lines).toEqual([]);
		// Past the free limit, so the licence is re-checked at the moment it is used.
		expect(view.recheckLicenceBeforeAdd).toBe(true);
	});

	it("lets a trialling user map the second tag too", () => {
		expect(plan({ mapping: { work: "Work" }, foundTags: ["work", "home"], entitlement: TRIAL }).pills).toEqual([{ tag: "home", capped: false }]);
	});

	it("never revokes a mapping the user already has, however far past the cap", () => {
		const view = plan({
			mapping: { work: "Work", home: "Home", ideas: "Ideas" },
			foundTags: ["work", "new"],
			entitlement: REVOKED,
		});

		expect(view.mapped.map((row) => row.tag)).toEqual(["home", "ideas", "work"]);
		expect(view.pills).toEqual([{ tag: "new", capped: true }]);
	});

	it("sorts mapped tags and pills alphabetically", () => {
		const view = plan({
			mapping: { zebra: "Work", apple: "Home" },
			foundTags: ["zebra", "pear", "apple", "fig"],
			entitlement: PRO,
		});

		expect(view.mapped.map((row) => row.tag)).toEqual(["apple", "zebra"]);
		expect(view.pills.map((pill) => pill.tag)).toEqual(["fig", "pear"]);
	});

	it("says nothing about removal when there is nothing to remove", () => {
		expect(plan({ foundTags: ["work", "home"], entitlement: PRO }).removalNote).toBe(false);
	});

	it("labels a mapped folder that is gone, and keeps the mapping", () => {
		expect(plan({ mapping: { work: "Archive/2025" } }).mapped).toEqual([
			{ tag: "work", folder: "Archive/2025", label: "Archive/2025 (missing)", missing: true },
		]);
	});

	it("does not label a folder that is still there", () => {
		expect(plan({ mapping: { work: "Work" } }).mapped).toEqual([{ tag: "work", folder: "Work", label: "Work", missing: false }]);
	});

	it("calls the vault root by a name", () => {
		expect(plan({ mapping: { work: "/" } }).mapped).toEqual([{ tag: "work", folder: "/", label: "Vault root", missing: false }]);
	});

	it("draws neither pills nor a line when every tag found is already mapped", () => {
		const view = plan({ mapping: { work: "Work", home: "Home" }, foundTags: ["work", "home"], entitlement: PRO });

		expect(view.pills).toEqual([]);
		expect(view.lines).toEqual([]);
		// Nothing can be added, so nothing can ask Polar.
		expect(view.recheckLicenceBeforeAdd).toBe(false);
	});

	it("keeps asking for a scan beside the mapped rows until one has run this session", () => {
		const view = plan({ mapping: { work: "Work" }, foundTags: null });

		expect(view.mapped.map((row) => row.tag)).toEqual(["work"]);
		expect(view.lines).toEqual(["scan-first"]);
	});

	it("offers the filter from twelve tags, counting a mapped tag the scan found once", () => {
		expect(plan({ foundTags: TWELVE.slice(0, 11), entitlement: PRO }).filter).toBe(false);
		expect(plan({ foundTags: TWELVE, entitlement: PRO }).filter).toBe(true);
		// Found tags include the mapped ones, so `a` is one tag, not two.
		expect(plan({ mapping: { a: "Work" }, foundTags: TWELVE.slice(0, 11), entitlement: PRO }).filter).toBe(false);
		// A mapped tag the scan did not find counts too.
		expect(plan({ mapping: { zz: "Work" }, foundTags: TWELVE.slice(0, 11), entitlement: PRO }).filter).toBe(true);
	});

	it("asks for a re-check only past the free limit, never at it", () => {
		const under = plan({ foundTags: ["a"], entitlement: PRO });
		const at = plan({ mapping: { a: "Work" }, foundTags: ["a", "b"], entitlement: PRO });

		expect(under.recheckLicenceBeforeAdd).toBe(false);
		expect(at.recheckLicenceBeforeAdd).toBe(true);
	});
});
