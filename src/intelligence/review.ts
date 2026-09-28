/**
 * Deciding one proposal: the note changes as the user said, and the base learns enough that the
 * same proposal does not come back on the next sync (spec §8: "✗ writes a tombstone").
 *
 * What ✗ teaches the base, per kind -- each is the smallest fact that stops the repeat:
 * - add: a tombstone, so the model's item stays out;
 * - remove: the item loses its source span, so the engine no longer owns it and never drops it;
 * - change: the item takes the new source span, so the same ink is no longer a change;
 * - replace: the base takes the model's text, so only a *new* summary is proposed again.
 */

import type { PageBase, SlotBase } from "./base-store";
import { compileItemFormat } from "./item-format";
import { matchItems } from "./matcher";
import type { Proposal } from "./merge";
import { writeProperty } from "./frontmatter-values";
import { applyListOps, findRegion, parseRegion, setProposalCallout, writeTextRegion } from "./regions";

export interface PendingProposal {
	slotId: string;
	proposal: Proposal;
}

/** Every pending proposal of a page, in Slot order. */
export function pendingProposals(base: PageBase): PendingProposal[] {
	return Object.entries(base.slots).flatMap(([slotId, slot]) => pending(slot).map((proposal) => ({ slotId, proposal })));
}

export type DecisionOutcome = { kind: "applied"; base: PageBase; lines: string[] } | { kind: "stale" } | { kind: "no-region" };

const pending = (slot: SlotBase): Proposal[] => ("list" in slot ? slot.list.proposals : slot.proposals);

/**
 * Applies ✓ or ✗ to one proposal. `stale` when the proposal is gone (decided elsewhere, or a sync
 * dropped it); `no-region` when the note no longer has the Slot's heading -- nothing is written then.
 */
export function decide(input: { base: PageBase; lines: readonly string[]; slotId: string; proposalId: string; accept: boolean; newId: () => string; reviewLink: string }): DecisionOutcome {
	const { base, slotId, proposalId, accept, newId } = input;
	const stored = base.slots[slotId];
	const proposal = stored === undefined ? undefined : pending(stored).find((p) => p.id === proposalId);
	if (stored === undefined || proposal === undefined) return { kind: "stale" };

	// A frontmatter Value has no region and no callout: ✓ writes the property, ✗ keeps the note's.
	if (stored.shape === "value" && stored.property !== null) {
		const value = (proposal as Extract<Proposal, { kind: "replace" }>).value ?? null;
		const lines = accept ? writeProperty(input.lines.join("\n"), stored.property, value).split("\n") : [...input.lines];
		const slot: SlotBase = { ...stored, value, proposals: stored.proposals.filter((p) => p.id !== proposalId) };
		return { kind: "applied", base: { ...base, slots: { ...base.slots, [slotId]: slot } }, lines };
	}

	const format = compileItemFormat("list" in stored ? stored.itemFormat : "- {{text}}");
	const region = findRegion(input.lines, stored.heading!, format, "list" in stored ? stored.list.items.map((item) => item.text) : []);
	if (region === null) return { kind: "no-region" };

	let lines = [...input.lines];
	let slot: SlotBase;
	if (stored.shape === "value") {
		const value = (proposal as Extract<Proposal, { kind: "replace" }>).value ?? null;
		if (accept) lines = writeTextRegion(lines, region, value === null ? "" : Array.isArray(value) ? value.join(", ") : value);
		slot = { ...stored, value, proposals: stored.proposals.filter((p) => p.id !== proposalId) };
	} else if (stored.shape === "text") {
		// Only a replace lives on a Text Slot.
		const text = (proposal as Extract<Proposal, { kind: "replace" }>).text;
		if (accept) lines = writeTextRegion(lines, region, text);
		slot = { ...stored, text, proposals: stored.proposals.filter((p) => p.id !== proposalId) };
	} else {
		const list = { ...stored.list, items: [...stored.list.items], tombstones: [...stored.list.tombstones], proposals: stored.list.proposals.filter((p) => p.id !== proposalId) };
		const noteItems = parseRegion(lines, region, format);
		const { lineToBase } = matchItems(noteItems, list.items);
		const lineOf = (itemId: string) => lineToBase.indexOf(itemId);
		switch (proposal.kind) {
			case "add":
				if (accept) {
					list.items.push({ id: newId(), text: proposal.text, fields: proposal.fields, done: proposal.done, source: proposal.source, origin: "engine" });
					lines = applyListOps(lines, region, noteItems, [{ kind: "insert", text: proposal.text, fields: proposal.fields, done: proposal.done }], format);
				} else {
					list.tombstones.push({ id: proposal.id, text: proposal.text, source: proposal.source });
				}
				break;
			case "remove": {
				const at = list.items.findIndex((item) => item.id === proposal.itemId);
				if (at === -1) break;
				const item = list.items[at];
				if (accept) {
					list.items.splice(at, 1);
					list.tombstones.push({ id: item.id, text: item.text, source: item.source });
					if (lineOf(item.id) !== -1) lines = applyListOps(lines, region, noteItems, [{ kind: "remove", line: lineOf(item.id) }], format);
				} else {
					list.items[at] = { ...item, source: null };
				}
				break;
			}
			case "change": {
				const at = list.items.findIndex((item) => item.id === proposal.itemId);
				if (at === -1) break;
				if (accept) {
					list.items[at] = { ...list.items[at], text: proposal.text, fields: proposal.fields, source: proposal.source };
					if (lineOf(proposal.itemId) !== -1) lines = applyListOps(lines, region, noteItems, [{ kind: "update", line: lineOf(proposal.itemId), text: proposal.text, fields: proposal.fields }], format);
				} else {
					list.items[at] = { ...list.items[at], source: proposal.source };
				}
				break;
			}
		}
		slot = { ...stored, list };
	}
	// Edits happen below the heading, so its line has not moved: the region is re-read from there,
	// which also holds for a heading the user renamed.
	const heading = { level: stored.heading!.level, text: lines[region.heading].replace(/^#+\s+/, "").trim() };
	lines = setProposalCallout(lines, findRegion(lines, heading, format)!, pending(slot).length, input.reviewLink);
	return { kind: "applied", base: { ...base, slots: { ...base.slots, [slotId]: slot } }, lines };
}
