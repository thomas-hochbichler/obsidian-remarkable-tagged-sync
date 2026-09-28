/**
 * The review Modal's data: every pending proposal over every page note (spec §8: "one Modal over all
 * notes"), and the one step that applies a decision -- read the note and its base, decide, write both.
 */

import type { NoteStore } from "../note-builder";
import type { BaseStore, PageBase } from "./base-store";
import type { Fields, Proposal } from "./merge";
import { decide, pendingProposals } from "./review";
import type { IntelligenceRow } from "./sync-pass";

export interface ReviewItem {
	notePath: string;
	noteId: string;
	slotId: string;
	proposal: Proposal;
	/** What the proposal does, in words. */
	label: string;
	/** The words on the page behind it -- shown instead of a model explanation (spec §8). */
	source: string | null;
}

const fieldText = (fields: Fields) =>
	Object.values(fields)
		.filter((value): value is string => value !== null && value !== "")
		.join(" · ");

const withFields = (text: string, fields: Fields) => (fieldText(fields) === "" ? text : `${text} (${fieldText(fields)})`);

function describe(base: PageBase, slotId: string, proposal: Proposal): { label: string; source: string | null } {
	const slot = base.slots[slotId];
	const items = "list" in slot ? slot.list.items : [];
	const item = (id: string) => items.find((candidate) => candidate.id === id);
	switch (proposal.kind) {
		case "add":
			return { label: `Add: ${withFields(proposal.text, proposal.fields)}`, source: proposal.source };
		case "remove": {
			const gone = item(proposal.itemId);
			return { label: `Remove: ${gone?.text ?? "an item"}`, source: gone?.source ?? null };
		}
		case "change":
			return { label: `Change: ${withFields(proposal.text, proposal.fields)}`, source: proposal.source };
		case "replace":
			return { label: slot.shape === "value" ? `Set ${slotId} to: ${proposal.text === "" ? "nothing" : proposal.text}` : `Replace the summary with: ${proposal.text}`, source: null };
	}
}

/** Every pending proposal of every active page note whose base is here, grouped by note in index order. */
export async function loadReview(rows: Record<string, IntelligenceRow>, baseStore: BaseStore): Promise<ReviewItem[]> {
	const items: ReviewItem[] = [];
	for (const row of Object.values(rows)) {
		if (row.status !== "active") continue;
		const base = await baseStore.load(row.noteId);
		if (base === null) continue;
		for (const { slotId, proposal } of pendingProposals(base)) items.push({ notePath: row.notePath, noteId: row.noteId, slotId, proposal, ...describe(base, slotId, proposal) });
	}
	return items;
}

export type ApplyOutcome = "applied" | "stale" | "no-region" | "gone";

/** Applies ✓ or ✗ to one item: the note is written only when it changed; the base always. */
export async function applyReview(item: ReviewItem, accept: boolean, deps: { baseStore: BaseStore; noteStore: NoteStore; newId: () => string; reviewLink: string }): Promise<ApplyOutcome> {
	const base = await deps.baseStore.load(item.noteId);
	const note = await deps.noteStore.read(item.notePath);
	if (base === null || note === null) return "gone";
	const outcome = decide({ base, lines: note.split("\n"), slotId: item.slotId, proposalId: item.proposal.id, accept, newId: deps.newId, reviewLink: deps.reviewLink });
	if (outcome.kind !== "applied") return outcome.kind;
	const content = outcome.lines.join("\n");
	if (content !== note) await deps.noteStore.write(item.notePath, content);
	await deps.baseStore.save(outcome.base);
	return "applied";
}
