/**
 * What the tag-routing section of the settings tab shows, decided without drawing anything.
 *
 * It exists because the free version's tag cap used to live inside a `Setting`-rendering method, and
 * a gate that can only be reached by rendering can only be tested by rendering -- which here meant
 * drawing six unrelated sections, one of which reaches an Obsidian global that does not exist under
 * vitest. The cap is half of what Pro sells, so "only reachable by rendering" was not an acceptable
 * place for it.
 *
 * The section's items come back **in draw order**, notices included. That is not tidiness either: an
 * earlier cut returned the two notices as separate fields and let the renderer place them, which put
 * the cap sentence *below* the rows it explains while every test stayed green. Order is a decision,
 * so it is decided here.
 */

import { TAG_CAP_MESSAGE } from "./licence-messages";
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

/** A discovered tag nobody has routed yet. */
export const MAPPABLE_DESC = "Not synced until mapped to a folder.";
/** The same tag, once the cap refuses it. A different sentence, because it is a different situation. */
export const CAPPED_DESC = "Not synced.";
const CHOOSE_LABEL = "Choose a folder…";
const ROOT_LABEL = "Vault root";

/** One entry of a row's folder dropdown. */
export interface FolderOption {
	readonly value: string;
	readonly label: string;
}

/** A tag that syncs today. Its folder can be changed, and it can be removed. */
export interface MappedItem {
	readonly kind: "mapped";
	readonly tag: string;
	readonly desc: string;
	readonly folder: string;
	readonly options: readonly FolderOption[];
}

/** A discovered tag the user may map right now. */
export interface MappableItem {
	readonly kind: "mappable";
	readonly tag: string;
	readonly desc: string;
	readonly options: readonly FolderOption[];
}

/** A discovered tag the cap refuses. Stated, not silently disabled -- a silent refusal reads as a bug. */
export interface CappedItem {
	readonly kind: "capped";
	readonly tag: string;
	readonly desc: string;
}

/** One thing the section draws, in the order it draws it. */
export type TagRoutingItem = { readonly kind: "notice"; readonly text: string } | MappedItem | MappableItem | CappedItem;

export interface TagRoutingView {
	readonly items: readonly TagRoutingItem[];
	/**
	 * Whether choosing a folder on a `mappable` row must re-check the licence with Polar first.
	 *
	 * It is only ever true on a render that was *above* the free limit and still offered dropdowns --
	 * which means the user had Pro or a trial when the tab drew. So the case it catches is narrow and
	 * real: a licence that ended between the tab opening and the folder being picked.
	 */
	readonly recheckLicenceBeforeAdd: boolean;
}

function labelFor(path: string): string {
	return path === "/" ? ROOT_LABEL : path;
}

export function planTagRouting(input: {
	mapping: TagFolderMap;
	discoveredTags: readonly string[];
	/** Every folder the vault holds. The root is always among them, so a new vault has a valid target. */
	folderPaths: readonly string[];
	entitlement: Entitlement;
}): TagRoutingView {
	const { mapping, discoveredTags, folderPaths, entitlement } = input;
	const mappedTags = Object.keys(mapping).sort();
	const folderOptions = folderPaths.map((path) => ({ value: path, label: labelFor(path) }));
	const items: TagRoutingItem[] = [];

	// Mapped and unmapped tags used to carry a heading each, which put three headings on one list and
	// read as three sections. Each row already says which it is, so the grouping is carried by the rows.
	for (const tag of mappedTags) {
		const folder = mapping[tag];
		items.push({
			kind: "mapped",
			tag,
			desc: labelFor(folder),
			folder,
			// The mapped folder may have been renamed or deleted since. Keep it selectable either way: a
			// dropdown that cannot show its own value would re-map the tag on the next thing the user did.
			options: folderPaths.includes(folder)
				? folderOptions
				: [...folderOptions, { value: folder, label: `${folder} (missing)` }],
		});
	}
	if (mappedTags.length > 0) items.push({ kind: "notice", text: REMOVAL_MESSAGE });

	const unmappedTags = discoveredTags.filter((tag) => !(tag in mapping));
	if (unmappedTags.length === 0) return { items, recheckLicenceBeforeAdd: false };

	// The cap only ever blocks *adding*. It must never unmap a tag that is already mapped, and a silent
	// refusal reads as a bug -- so the reason is stated, above the rows it applies to.
	if (mappedTags.length >= tagLimitFor(entitlement)) {
		items.push({ kind: "notice", text: TAG_CAP_MESSAGE });
		for (const tag of unmappedTags) items.push({ kind: "capped", tag, desc: CAPPED_DESC });
		return { items, recheckLicenceBeforeAdd: false };
	}

	for (const tag of unmappedTags) {
		items.push({
			kind: "mappable",
			tag,
			desc: MAPPABLE_DESC,
			options: [{ value: "", label: CHOOSE_LABEL }, ...folderOptions],
		});
	}
	return { items, recheckLicenceBeforeAdd: mappedTags.length >= FREE_TAG_LIMIT };
}
