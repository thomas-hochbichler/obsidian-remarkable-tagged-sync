/**
 * What the tag-routing section of the settings tab shows, decided without drawing anything.
 *
 * It exists because the free version's tag cap used to live inside a `Setting`-rendering method, and
 * a gate that can only be reached by rendering can only be tested by rendering -- which here meant
 * drawing six unrelated sections, one of which reaches an Obsidian global that does not exist under
 * vitest. The cap is half of what Pro sells, so "only reachable by rendering" was not an acceptable
 * place for it.
 *
 * The lines come back **in draw order**. That is not tidiness either: an earlier cut returned the two
 * notices as separate fields and let the renderer place them, which put the cap sentence *below* the
 * rows it explains while every test stayed green. Order is a decision, so it is decided here.
 */

import type { Entitlement } from "./licence-state";
import type { TagFolderMap } from "./tag-router";

/**
 * How many tag → folder mappings the free version allows. It gates *adding* a mapping and nothing
 * else: an existing mapping is never revoked, because unmapping a tag feeds `diffUnitTags`, which
 * orphans the row, and orphaning is index-only by design -- the folder would simply stop updating
 * with nothing said. Shipped from day one and published in the README, so it is a limit people knew
 * about rather than something taken away later.
 */
export const FREE_TAG_LIMIT = 1;

/**
 * The cap is licence-driven rather than hard-coded: unlimited tag mappings are half of what Pro
 * sells. A revoked licence falls back to the free cap, which is proportionate because the cap blocks
 * *adding* only -- every folder already mapped keeps syncing.
 */
export function tagLimitFor(entitlement: Entitlement): number {
	return entitlement.tier === "free" ? FREE_TAG_LIMIT : Number.POSITIVE_INFINITY;
}

/** Said under the mapped rows, because removal is the one action there whose effect is not obvious. */
export const REMOVAL_MESSAGE = "Removing a tag stops syncing it. Notes already in your vault stay where they are.";

/** A folder as the tab names it: the root by a name, never as "/". */
export function folderLabel(path: string): string {
	return path === "/" ? "Vault root" : path;
}

/** From this many tags the group offers a filter (settings-redesign 06 #4): fewer fit on one screen. */
const FILTER_FROM = 12;

/** A tag that syncs today: its folder can be changed, and it can be removed. */
export interface MappedTag {
	readonly tag: string;
	readonly folder: string;
	/** What the folder button says: "Vault root" for `/`, and "(missing)" after a folder that is gone. */
	readonly label: string;
	/** The folder was renamed or deleted since. The mapping keeps working, so it is said, not undone. */
	readonly missing: boolean;
}

/** An unmapped tag: found by the scan, no mapping yet. A capped one is shown and refused, not hidden. */
export interface UnmappedTag {
	readonly tag: string;
	readonly capped: boolean;
}

/** The lines between the mapped rows and the pills, each said only when it is true. */
export type TagRoutingLine = "scan-first" | "nothing-found" | "cap";

export interface TagRoutingView {
	/** Alphabetical. */
	readonly mapped: readonly MappedTag[];
	/** Alphabetical: found and not mapped. */
	readonly pills: readonly UnmappedTag[];
	/** In draw order, above the pills: the cap sentence explains the pills under it. */
	readonly lines: readonly TagRoutingLine[];
	readonly removalNote: boolean;
	readonly filter: boolean;
	/**
	 * Whether choosing a folder for a pill must re-check the licence with Polar first.
	 *
	 * It is only ever true on a render that was *above* the free limit and still offered pills to map --
	 * which means the user had Pro or a trial when the tab drew. So the case it catches is narrow and
	 * real: a licence that ended between the tab opening and the folder being picked.
	 */
	readonly recheckLicenceBeforeAdd: boolean;
}

export function planTagRouting(input: {
	mapping: TagFolderMap;
	/** What the last scan of this Obsidian session found, mapped tags included; `null` before the first. */
	foundTags: readonly string[] | null;
	/** Every folder the vault holds. The root is always among them, so a new vault has a valid target. */
	folderPaths: readonly string[];
	entitlement: Entitlement;
}): TagRoutingView {
	const { mapping, foundTags, folderPaths, entitlement } = input;
	const mapped = Object.keys(mapping)
		.sort()
		.map((tag): MappedTag => {
			const folder = mapping[tag];
			const missing = !folderPaths.includes(folder);
			return { tag, folder, label: missing ? `${folderLabel(folder)} (missing)` : folderLabel(folder), missing };
		});

	// The cap only ever blocks *adding*. It must never unmap a tag that is already mapped, and a silent
	// refusal reads as a bug -- so a capped pill is still drawn, and the reason is stated above it.
	const capped = mapped.length >= tagLimitFor(entitlement);
	const pills = (foundTags ?? [])
		.filter((tag) => !(tag in mapping))
		.sort()
		.map((tag) => ({ tag, capped }));

	const lines: TagRoutingLine[] = [];
	if (foundTags === null) lines.push("scan-first");
	else if (foundTags.length === 0) lines.push("nothing-found");
	if (pills.length > 0 && capped) lines.push("cap");

	return {
		mapped,
		pills,
		lines,
		removalNote: mapped.length > 0,
		filter: new Set([...Object.keys(mapping), ...(foundTags ?? [])]).size >= FILTER_FROM,
		recheckLicenceBeforeAdd: pills.length > 0 && !capped && mapped.length >= FREE_TAG_LIMIT,
	};
}
