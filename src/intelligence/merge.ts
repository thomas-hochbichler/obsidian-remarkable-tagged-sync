/**
 * The item-level three-way merge: base (what the engine last wrote), note (what the user left in
 * Obsidian), model (what the extraction returned for the page as it is now). It never writes a
 * Markdown line itself -- it hands the region writer typed operations on the note's item lines.
 *
 * Two rules carry most of the weight, both measured: the model rewords 7-17 of 50 unchanged items,
 * and it forgets items it saw before. So neither a new wording nor a missing item counts as a change
 * unless the ink behind the item changed too -- its stored source span is no longer in the
 * transcript.
 */

import type { PropertyValue } from "./frontmatter-values";
import { matchItems, normaliseText } from "./matcher";

export type Fields = Record<string, string | null>;

export interface BaseItem {
	id: string;
	/** The engine's text as written; kept when the model rewords the same item. */
	text: string;
	fields: Fields;
	/** Done as read off the page; the page can tick, never untick. */
	done: boolean;
	/** The words on the page this item came from; null = the engine does not own it. */
	source: string | null;
	/** "user" for a line typed in Obsidian: never removed without review. */
	origin: "engine" | "user";
}

export interface Tombstone {
	id: string;
	text: string;
	source: string | null;
}

export type Proposal =
	| { kind: "add"; id: string; text: string; fields: Fields; source: string | null; done: boolean }
	| { kind: "remove"; id: string; itemId: string }
	| { kind: "change"; id: string; itemId: string; text: string; fields: Fields; source: string }
	| { kind: "replace"; id: string; text: string; value?: PropertyValue | null };

export type ListProposal = Exclude<Proposal, { kind: "replace" }>;

export interface ListBase {
	items: BaseItem[];
	tombstones: Tombstone[];
	proposals: ListProposal[];
}

/** An item line as parsed from the note's region, in note order. */
export interface NoteItem {
	text: string;
	fields: Record<string, string>;
	checkbox: string | null;
}

/** One item the model returned. `id` null means the model called it new. */
export interface ModelItem {
	id: string | null;
	text: string;
	fields: Fields;
	source: string | null;
	done?: boolean;
}

/** Operations on the region's item lines; `line` indexes the `note` array passed in. */
export type ListOp =
	| { kind: "insert"; text: string; fields: Fields; done: boolean }
	| { kind: "update"; line: number; text: string; fields: Fields }
	| { kind: "tick"; line: number }
	| { kind: "remove"; line: number };

export interface ListMergeInput {
	base: ListBase | null;
	note: readonly NoteItem[];
	model: readonly ModelItem[];
	transcript: string;
	/** The Slot's review toggle. Ticks from the page and user-typed items ignore it. */
	review: boolean;
	newId: () => string;
}

export interface ListMergeResult {
	base: ListBase;
	ops: ListOp[];
}

const isTicked = (checkbox: string | null) => checkbox === "x" || checkbox === "X";

function fieldsEqual(a: Fields, b: Record<string, string | null>): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) if ((a[key] ?? null) !== (b[key] ?? null)) return false;
	return true;
}

/** Whether a source span is (still) on the page. Compared normalised: OCR spacing and case drift. */
export function inTranscript(source: string | null, transcript: string): boolean {
	if (source === null) return false;
	const span = normaliseText(source);
	return span !== "" && normaliseText(transcript).includes(span);
}

function proposalKey(p: Proposal): string {
	switch (p.kind) {
		case "add":
			return `add:${normaliseText(p.text)}`;
		case "replace":
			return "replace";
		default:
			return `${p.kind}:${p.itemId}`;
	}
}

/** Pending proposals persist across syncs; a new one with the same key replaces the old content, keeping its id. */
export function mergeProposals<P extends Proposal>(pending: readonly P[], fresh: readonly P[]): P[] {
	const out = [...pending];
	for (const proposal of fresh) {
		const at = out.findIndex((old) => proposalKey(old) === proposalKey(proposal));
		if (at === -1) out.push(proposal);
		else out[at] = { ...proposal, id: out[at].id };
	}
	return out;
}

export function mergeList(input: ListMergeInput): ListMergeResult {
	const { note, transcript, review, newId } = input;
	const model = input.model.filter((item) => item.source === null || inTranscript(item.source, transcript));
	const ops: ListOp[] = [];

	// First extraction of this Slot on this page: written directly, Free and Pro alike.
	if (input.base === null) {
		const items: BaseItem[] = [];
		for (const item of model) {
			if (item.source === null) continue;
			items.push({ id: newId(), text: item.text, fields: item.fields, done: item.done === true, source: item.source, origin: "engine" });
			ops.push({ kind: "insert", text: item.text, fields: item.fields, done: item.done === true });
		}
		return { base: { items, tombstones: [], proposals: [] }, ops };
	}

	const base = input.base;
	const tombstones = [...base.tombstones];
	const fresh: ListProposal[] = [];

	// 1 · The user's side: which line is which item, what was typed, what was deleted.
	const { lineToBase, deleted } = matchItems(note, base.items);
	const lineOf = new Map<string, number>();
	lineToBase.forEach((id, line) => id !== null && lineOf.set(id, line));
	const items: BaseItem[] = [];
	for (const item of base.items) {
		if (deleted.includes(item.id)) tombstones.push({ id: item.id, text: item.text, source: item.source });
		else items.push({ ...item });
	}
	lineToBase.forEach((id, line) => {
		if (id !== null) return;
		const added: BaseItem = { id: newId(), text: note[line].text, fields: { ...note[line].fields }, done: false, source: null, origin: "user" };
		items.push(added);
		lineOf.set(added.id, line);
	});
	const edited = (item: BaseItem): boolean => {
		const line = note[lineOf.get(item.id)!];
		return normaliseText(line.text) !== normaliseText(item.text) || !fieldsEqual(item.fields, line.fields);
	};

	// 2 · The model's side. An id it made up, or an item it called new that is really a live item or
	//     one the user already typed, is folded onto that item rather than proposed twice.
	const byId = new Map(items.map((item) => [item.id, item]));
	const tombstoned = new Set(tombstones.map((t) => t.id));
	const returned = new Map<string, ModelItem>();
	const unclaimed: ModelItem[] = [];
	for (const item of model) {
		if (item.id !== null && tombstoned.has(item.id)) continue;
		if (item.id !== null && byId.has(item.id) && !returned.has(item.id)) returned.set(item.id, item);
		else unclaimed.push(item);
	}
	const open = items.filter((item) => !returned.has(item.id));
	const { lineToBase: claim } = matchItems(unclaimed, open);
	const newItems: ModelItem[] = [];
	unclaimed.forEach((item, i) => {
		const id = claim[i];
		if (id !== null) returned.set(id, item);
		else newItems.push(item);
	});

	// 3 · Items the model returned: ticks, gained source spans, and changes behind changed ink.
	for (const [id, got] of returned) {
		const item = byId.get(id)!;
		const line = lineOf.get(id)!;
		if (got.done === true && !item.done) {
			item.done = true;
			if (!isTicked(note[line].checkbox)) ops.push({ kind: "tick", line });
		}
		if (got.source === null) continue;
		if (item.source === null) {
			item.source = got.source;
			continue;
		}
		if (inTranscript(item.source, transcript)) continue;
		if (normaliseText(got.text) === normaliseText(item.text) && fieldsEqual(item.fields, got.fields)) {
			item.source = got.source;
			continue;
		}
		if (review || edited(item) || item.origin === "user") {
			fresh.push({ kind: "change", id: newId(), itemId: id, text: got.text, fields: got.fields, source: got.source });
		} else {
			Object.assign(item, { text: got.text, fields: got.fields, source: got.source });
			ops.push({ kind: "update", line, text: got.text, fields: got.fields });
		}
	}

	// 4 · Items the model did not return: dropped only when their ink is gone.
	const removed = new Set<string>();
	for (const item of items) {
		if (returned.has(item.id) || item.source === null || inTranscript(item.source, transcript)) continue;
		const line = lineOf.get(item.id)!;
		if (review || isTicked(note[line].checkbox) || item.origin === "user" || edited(item)) {
			fresh.push({ kind: "remove", id: newId(), itemId: item.id });
		} else {
			ops.push({ kind: "remove", line });
			removed.add(item.id);
		}
	}
	const kept = items.filter((item) => !removed.has(item.id));

	// 5 · New items: never one the user deleted, never one the user already typed.
	for (const item of newItems) {
		if (item.source === null) continue;
		const buried = tombstones.some((t) => (t.source !== null && normaliseText(t.source) === normaliseText(item.source!)) || matchItems([item], [t]).lineToBase[0] !== null);
		if (buried) continue;
		if (review) {
			fresh.push({ kind: "add", id: newId(), text: item.text, fields: item.fields, source: item.source, done: item.done === true });
		} else {
			kept.push({ id: newId(), text: item.text, fields: item.fields, done: item.done === true, source: item.source, origin: "engine" });
			ops.push({ kind: "insert", text: item.text, fields: item.fields, done: item.done === true });
		}
	}

	// A pending "add" the user has meanwhile typed themselves is dropped silently.
	const userTexts = kept.filter((item) => item.origin === "user");
	const proposals = mergeProposals(base.proposals, fresh).filter((p) => {
		if (p.kind === "add") return matchItems([p], userTexts).lineToBase[0] === null;
		return kept.some((item) => item.id === p.itemId);
	});

	return { base: { items: kept, tombstones, proposals }, ops };
}

export interface TextMergeResult {
	/** The text now in the base. */
	base: string;
	/** Replacement for the region, or null to leave it alone. */
	write: string | null;
	proposals: Proposal[];
}

/**
 * A Text Slot (summary): untouched since the base → replaced; edited → the user's text stays and a
 * different model text becomes one "Replace …?" proposal, replacing any older one.
 */
export function mergeText(input: { base: string | null; note: string; model: string; proposals: readonly Proposal[]; newId: () => string }): TextMergeResult {
	const { base, note, model, proposals, newId } = input;
	if (base === null || normaliseText(note) === normaliseText(base)) {
		return { base: model, write: normaliseText(note) === normaliseText(model) ? null : model, proposals: proposals.filter((p) => p.kind !== "replace") };
	}
	if (normaliseText(model) === normaliseText(base)) return { base, write: null, proposals: [...proposals] };
	return { base, write: null, proposals: mergeProposals(proposals, [{ kind: "replace", id: newId(), text: model }]) };
}
