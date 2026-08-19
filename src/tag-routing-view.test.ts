import { describe, expect, it } from "vitest";
import { TAG_CAP_MESSAGE } from "./licence-messages";
import type { Entitlement } from "./licence-state";
import {
	CAPPED_DESC,
	FREE_TAG_LIMIT,
	MAPPABLE_DESC,
	planTagRouting,
	REMOVAL_MESSAGE,
	type TagRoutingItem,
	tagLimitFor,
} from "./tag-routing-view";

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
	discoveredTags?: string[];
	folderPaths?: string[];
	entitlement?: Entitlement;
}) {
	return planTagRouting({
		mapping: input.mapping ?? {},
		discoveredTags: input.discoveredTags ?? [],
		folderPaths: input.folderPaths ?? VAULT,
		entitlement: input.entitlement ?? FREE,
	});
}

/** The shape of the section, one letter per item, in draw order. */
function shape(items: readonly TagRoutingItem[]): string {
	return items.map((item) => ({ notice: "N", mapped: "M", mappable: "+", capped: "x" })[item.kind]).join("");
}

function tagsOf(items: readonly TagRoutingItem[], kind: TagRoutingItem["kind"]): string[] {
	return items.filter((item) => item.kind === kind && "tag" in item).map((item) => (item as { tag: string }).tag);
}

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
	it("draws nothing at all before a scan has found anything", () => {
		expect(plan({}).items).toEqual([]);
		expect(plan({}).recheckLicenceBeforeAdd).toBe(false);
	});

	it("offers the first tag a free user has found, with the whole vault to choose from", () => {
		const { items, recheckLicenceBeforeAdd } = plan({ discoveredTags: ["#work"] });

		expect(shape(items)).toBe("+");
		expect(items[0]).toMatchObject({ kind: "mappable", tag: "#work", desc: MAPPABLE_DESC });
		expect(items[0]).toHaveProperty("options", [
			{ value: "", label: "Choose a folder…" },
			{ value: "/", label: "Vault root" },
			{ value: "Home", label: "Home" },
			{ value: "Work", label: "Work" },
		]);
		// Nothing is mapped yet, so nothing is being unlocked -- a free user never talks to Polar.
		expect(recheckLicenceBeforeAdd).toBe(false);
	});

	it("refuses the second tag, and says why above the rows it refuses", () => {
		const { items } = plan({ mapping: { "#work": "Work" }, discoveredTags: ["#work", "#home", "#ideas"] });

		expect(shape(items)).toBe("MNNxx");
		expect(items[1]).toEqual({ kind: "notice", text: REMOVAL_MESSAGE });
		expect(items[2]).toEqual({ kind: "notice", text: TAG_CAP_MESSAGE });
		expect(items[3]).toEqual({ kind: "capped", tag: "#home", desc: CAPPED_DESC });
	});

	it("lets a paid user map the second tag", () => {
		const { items, recheckLicenceBeforeAdd } = plan({
			mapping: { "#work": "Work" },
			discoveredTags: ["#work", "#home"],
			entitlement: PRO,
		});

		expect(shape(items)).toBe("MN+");
		expect(items[2]).toMatchObject({ kind: "mappable", tag: "#home", desc: MAPPABLE_DESC });
		// Past the free limit, so the licence is re-checked at the moment it is used.
		expect(recheckLicenceBeforeAdd).toBe(true);
	});

	it("lets a trialling user map the second tag too", () => {
		const { items } = plan({ mapping: { "#work": "Work" }, discoveredTags: ["#work", "#home"], entitlement: TRIAL });
		expect(shape(items)).toBe("MN+");
	});

	it("never revokes a mapping the user already has, however far past the cap", () => {
		const { items } = plan({
			mapping: { "#work": "Work", "#home": "Home", "#ideas": "Ideas" },
			discoveredTags: ["#work", "#new"],
			entitlement: REVOKED,
		});

		expect(shape(items)).toBe("MMMNNx");
		expect(tagsOf(items, "mapped")).toEqual(["#home", "#ideas", "#work"]);
		expect(tagsOf(items, "capped")).toEqual(["#new"]);
	});

	it("sorts the mapped tags and leaves the unmapped ones in the order they were discovered", () => {
		const { items } = plan({
			mapping: { "#zebra": "Work", "#apple": "Home" },
			discoveredTags: ["#zebra", "#pear", "#apple", "#fig"],
			entitlement: PRO,
		});

		expect(tagsOf(items, "mapped")).toEqual(["#apple", "#zebra"]);
		// Discovery order, not alphabetical: the scan's own order is the only order the user saw.
		expect(tagsOf(items, "mappable")).toEqual(["#pear", "#fig"]);
	});

	it("says nothing about removal when there is nothing to remove", () => {
		expect(shape(plan({ discoveredTags: ["#work", "#home"], entitlement: PRO }).items)).toBe("++");
	});

	it("keeps a mapped folder selectable after it is renamed away, and labels it", () => {
		const { items } = plan({ mapping: { "#work": "Archive/2025" } });

		expect(items[0]).toHaveProperty("options", [
			{ value: "/", label: "Vault root" },
			{ value: "Home", label: "Home" },
			{ value: "Work", label: "Work" },
			{ value: "Archive/2025", label: "Archive/2025 (missing)" },
		]);
		// The row still reads as the folder it points at, missing or not.
		expect(items[0]).toMatchObject({ desc: "Archive/2025", folder: "Archive/2025" });
	});

	it("does not label a folder that is still there", () => {
		const { items } = plan({ mapping: { "#work": "Work" } });
		expect(items[0]).toHaveProperty("options", [
			{ value: "/", label: "Vault root" },
			{ value: "Home", label: "Home" },
			{ value: "Work", label: "Work" },
		]);
	});

	it("calls the vault root by a name, in the row as well as the dropdown", () => {
		const { items } = plan({ mapping: { "#work": "/" } });
		expect(items[0]).toMatchObject({ desc: "Vault root", folder: "/" });
	});

	it("offers only the root in an empty vault", () => {
		const { items } = plan({ discoveredTags: ["#work"], folderPaths: ["/"] });
		expect(items[0]).toHaveProperty("options", [
			{ value: "", label: "Choose a folder…" },
			{ value: "/", label: "Vault root" },
		]);
	});

	it("draws no unmapped section when everything discovered is already mapped", () => {
		const { items, recheckLicenceBeforeAdd } = plan({
			mapping: { "#work": "Work", "#home": "Home" },
			discoveredTags: ["#work", "#home"],
			entitlement: PRO,
		});

		expect(shape(items)).toBe("MMN");
		// No mappable row exists, so nothing can ask Polar. Never true without something to unlock.
		expect(recheckLicenceBeforeAdd).toBe(false);
	});

	it("asks for a re-check only past the free limit, never at it", () => {
		const under = plan({ discoveredTags: ["#a"], entitlement: PRO });
		const at = plan({ mapping: { "#a": "Work" }, discoveredTags: ["#a", "#b"], entitlement: PRO });

		expect(under.recheckLicenceBeforeAdd).toBe(false);
		expect(at.recheckLicenceBeforeAdd).toBe(true);
	});
});
