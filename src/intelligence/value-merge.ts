/**
 * The merge for Value Slots (spec §7.4): one value -- a mood, a project -- or a tag list.
 *
 * A single value is region-level: untouched since the base, it follows the page; edited by the user,
 * it stays, and a different model value becomes one "Replace …?" proposal.
 *
 * Tags have two owners, the plugin's own `remarkable/<tag>` entries and the Tags Slot's (spec §7.4):
 * each removes only what it added. The engine tracks what it added; a tag of its own the user removed
 * is buried and never added again; a user's or a template's tag is never touched.
 */

import type { PropertyValue } from "./frontmatter-values";
import { mergeProposals, type Proposal } from "./merge";

const same = (a: PropertyValue | null, b: PropertyValue | null) => JSON.stringify(a) === JSON.stringify(b);

export interface ValueMergeResult {
	base: PropertyValue | null;
	/** What to write; `undefined` = leave the note's value as it is. */
	write: PropertyValue | null | undefined;
	proposals: Proposal[];
}

/**
 * One value. `base` undefined is the first extraction of this Slot on the page: written directly --
 * unless `proposeFirst`, for a topical Choice read by a local model, whose first pick is biased by
 * the order of the options (research 15).
 */
export function mergeValue(input: { base: PropertyValue | null | undefined; note: PropertyValue | null; model: PropertyValue | null; proposals: readonly Proposal[]; proposeFirst: boolean; newId: () => string }): ValueMergeResult {
	const { base, note, model, proposals, newId } = input;
	const replace = (): Proposal[] => mergeProposals(proposals, [{ kind: "replace", id: newId(), text: Array.isArray(model) ? model.join(", ") : (model ?? ""), value: model }]);
	if (base === undefined) {
		if (input.proposeFirst && model !== null) return { base: null, write: undefined, proposals: replace() };
		return { base: model, write: same(note, model) ? undefined : model, proposals: [] };
	}
	if (same(note, base)) return { base: model, write: same(note, model) ? undefined : model, proposals: proposals.filter((p) => p.kind !== "replace") };
	if (same(model, base)) return { base, write: undefined, proposals: [...proposals] };
	return { base, write: undefined, proposals: replace() };
}

export interface TagMergeResult {
	/** The note's `tags` list after the merge; `undefined` = unchanged. */
	write: string[] | undefined;
	/** The tags the engine now owns in this note. */
	added: string[];
	/** Tags of the engine's the user removed; never added again. */
	buried: string[];
}

export function mergeTagList(input: { added: readonly string[]; buried: readonly string[]; note: readonly string[]; model: readonly string[] }): TagMergeResult {
	const note = [...input.note];
	const removedByUser = input.added.filter((tag) => !note.includes(tag));
	const buried = [...new Set([...input.buried, ...removedByUser])];
	let added = input.added.filter((tag) => note.includes(tag));
	// Dropped by the page: only the engine's own tags leave the note.
	const dropped = added.filter((tag) => !input.model.includes(tag));
	added = added.filter((tag) => !dropped.includes(tag));
	const next = note.filter((tag) => !dropped.includes(tag));
	for (const tag of input.model) {
		if (next.includes(tag) || buried.includes(tag)) continue;
		next.push(tag);
		added.push(tag);
	}
	return { write: same(next, [...input.note]) ? undefined : next, added, buried };
}
