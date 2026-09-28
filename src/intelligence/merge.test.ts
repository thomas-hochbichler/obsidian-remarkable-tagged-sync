import { describe, expect, it } from "vitest";
import { inTranscript, mergeList, mergeProposals, mergeText, type BaseItem, type ListBase, type ModelItem, type NoteItem, type Proposal } from "./merge";

const ids = () => {
	let n = 0;
	return () => `n${++n}`;
};
const item = (id: string, text: string, source: string | null, extra: Partial<BaseItem> = {}): BaseItem => ({ id, text, fields: {}, done: false, source, origin: "engine", ...extra });
const line = (text: string, checkbox: string | null = " ", fields: Record<string, string> = {}): NoteItem => ({ text, fields, checkbox });
const said = (id: string | null, text: string, source: string | null, extra: Partial<ModelItem> = {}): ModelItem => ({ id, text, fields: {}, source, ...extra });
const baseOf = (...items: BaseItem[]): ListBase => ({ items, tombstones: [], proposals: [] });

const PAGE = "Mo 28.9. call Bob re invoice by Friday. buy milk";

describe("inTranscript", () => {
	it("finds a span despite OCR spacing and case drift", () => {
		expect(inTranscript("Call  Bob re Invoice", PAGE)).toBe(true);
		expect(inTranscript("call Anna", PAGE)).toBe(false);
	});

	it("never finds an empty or missing span", () => {
		expect(inTranscript(null, PAGE)).toBe(false);
		expect(inTranscript(" .. ", PAGE)).toBe(false);
	});
});

describe("mergeList > first extraction", () => {
	it("writes every item directly and drops one whose source is not on the page", () => {
		const result = mergeList({
			base: null,
			note: [],
			model: [said(null, "Call Bob", "call Bob re invoice", { fields: { due: "Friday" } }), said(null, "Fly to Rome", "fly to Rome"), said(null, "No source", null)],
			transcript: PAGE,
			review: true,
			newId: ids(),
		});
		expect(result.ops).toEqual([{ kind: "insert", text: "Call Bob", fields: { due: "Friday" }, done: false }]);
		expect(result.base.items).toEqual([item("n1", "Call Bob", "call Bob re invoice", { fields: { due: "Friday" } })]);
	});
});

describe("mergeList > the page did not change behind an item", () => {
	it("ignores a reworded item and a changed field while the ink is the same", () => {
		const base = baseOf(item("a", "Call Bob", "call Bob re invoice", { fields: { due: "Friday" } }));
		const result = mergeList({
			base,
			note: [line("Call Bob")],
			model: [said("a", "Phone Bob about the invoice", "call Bob re invoice", { fields: { due: "Thursday" } })],
			transcript: PAGE,
			review: false,
			newId: ids(),
		});
		// The note line had no due field, the base did: that is the user's edit, not the model's.
		expect(result.ops).toEqual([]);
		expect(result.base.items[0].text).toBe("Call Bob");
		expect(result.base.proposals).toEqual([]);
	});

	it("ignores an item the model forgot while its ink is still on the page", () => {
		const result = mergeList({ base: baseOf(item("a", "Buy milk", "buy milk")), note: [line("Buy milk")], model: [], transcript: PAGE, review: false, newId: ids() });
		expect(result.ops).toEqual([]);
		expect(result.base.items).toHaveLength(1);
	});
});

describe("mergeList > the ink behind an item changed", () => {
	const base = () => baseOf(item("a", "Call Bob", "call Bob re invoice by Monday", { fields: { due: "Monday" } }));
	const model = [said("a", "Call Bob", "call Bob re invoice by Friday", { fields: { due: "Friday" } })];

	it("proposes the new field with review on", () => {
		const result = mergeList({ base: base(), note: [line("Call Bob", " ", { due: "Monday" })], model, transcript: PAGE, review: true, newId: ids() });
		expect(result.ops).toEqual([]);
		expect(result.base.proposals).toEqual([{ kind: "change", id: "n1", itemId: "a", text: "Call Bob", fields: { due: "Friday" }, source: "call Bob re invoice by Friday" }]);
	});

	it("applies it with review off", () => {
		const result = mergeList({ base: base(), note: [line("Call Bob", " ", { due: "Monday" })], model, transcript: PAGE, review: false, newId: ids() });
		expect(result.ops).toEqual([{ kind: "update", line: 0, text: "Call Bob", fields: { due: "Friday" } }]);
		expect(result.base.items[0]).toMatchObject({ fields: { due: "Friday" }, source: "call Bob re invoice by Friday" });
	});

	it("proposes it even with review off when the user edited that line", () => {
		const result = mergeList({ base: base(), note: [line("Call Bob", " ", { due: "Tuesday" })], model, transcript: PAGE, review: false, newId: ids() });
		expect(result.ops).toEqual([]);
		expect(result.base.proposals.map((p) => p.kind)).toEqual(["change"]);
	});

	it("only moves the source when the model's answer is otherwise the same, an empty field included", () => {
		// The strict schema returns every Field, empty ones as null; the base never stored them.
		const result = mergeList({
			base: base(),
			note: [line("Call Bob", " ", { due: "Monday" })],
			model: [said("a", "Call Bob", "call Bob re invoice by Friday", { fields: { due: "Monday", owner: null } })],
			transcript: PAGE,
			review: true,
			newId: ids(),
		});
		expect(result.ops).toEqual([]);
		expect(result.base.proposals).toEqual([]);
		expect(result.base.items[0].source).toBe("call Bob re invoice by Friday");
	});
});

describe("mergeList > ticks", () => {
	it("ticks the note from the page directly, even with review on", () => {
		const result = mergeList({ base: baseOf(item("a", "Buy milk", "buy milk")), note: [line("Buy milk")], model: [said("a", "Buy milk", "buy milk", { done: true })], transcript: PAGE, review: true, newId: ids() });
		expect(result.ops).toEqual([{ kind: "tick", line: 0 }]);
		expect(result.base.items[0].done).toBe(true);
	});

	it("does not tick again a line the user unticked after the page ticked it", () => {
		const result = mergeList({ base: baseOf(item("a", "Buy milk", "buy milk", { done: true })), note: [line("Buy milk")], model: [said("a", "Buy milk", "buy milk", { done: true })], transcript: PAGE, review: true, newId: ids() });
		expect(result.ops).toEqual([]);
	});

	it("records the tick without a write when the note is already ticked", () => {
		const result = mergeList({ base: baseOf(item("a", "Buy milk", "buy milk")), note: [line("Buy milk", "x")], model: [said("a", "Buy milk", "buy milk", { done: true })], transcript: PAGE, review: true, newId: ids() });
		expect(result.ops).toEqual([]);
		expect(result.base.items[0].done).toBe(true);
	});

	it("takes a tick for a known item even when the model gave no source span", () => {
		const result = mergeList({ base: baseOf(item("a", "Buy milk", "buy milk")), note: [line("Buy milk")], model: [said("a", "Buy milk", null, { done: true })], transcript: PAGE, review: true, newId: ids() });
		expect(result.ops).toEqual([{ kind: "tick", line: 0 }]);
		expect(result.base.items[0].source).toBe("buy milk");
	});

	it("never unticks from the page", () => {
		const result = mergeList({ base: baseOf(item("a", "Buy milk", "buy milk")), note: [line("Buy milk", "x")], model: [said("a", "Buy milk", "buy milk", { done: false })], transcript: PAGE, review: false, newId: ids() });
		expect(result.ops).toEqual([]);
	});
});

describe("mergeList > items whose ink is gone", () => {
	const gone = () => baseOf(item("a", "Fly to Rome", "fly to Rome"));

	it("proposes the removal with review on", () => {
		const result = mergeList({ base: gone(), note: [line("Fly to Rome")], model: [], transcript: PAGE, review: true, newId: ids() });
		expect(result.ops).toEqual([]);
		expect(result.base.proposals).toEqual([{ kind: "remove", id: "n1", itemId: "a" }]);
	});

	it("removes the line with review off", () => {
		const result = mergeList({ base: gone(), note: [line("Fly to Rome")], model: [], transcript: PAGE, review: false, newId: ids() });
		expect(result.ops).toEqual([{ kind: "remove", line: 0 }]);
		expect(result.base.items).toEqual([]);
	});

	it("never removes a ticked line without review", () => {
		const result = mergeList({ base: gone(), note: [line("Fly to Rome", "x")], model: [], transcript: PAGE, review: false, newId: ids() });
		expect(result.ops).toEqual([]);
		expect(result.base.proposals.map((p) => p.kind)).toEqual(["remove"]);
	});

	it("never removes a line the user edited without review", () => {
		const result = mergeList({ base: gone(), note: [line("Fly to Rome on Sunday")], model: [], transcript: PAGE, review: false, newId: ids() });
		expect(result.base.proposals.map((p) => p.kind)).toEqual(["remove"]);
	});

	it("counts a field the user added as an edit", () => {
		const result = mergeList({ base: gone(), note: [line("Fly to Rome", " ", { due: "2026-10-02" })], model: [], transcript: PAGE, review: false, newId: ids() });
		expect(result.ops).toEqual([]);
		expect(result.base.proposals.map((p) => p.kind)).toEqual(["remove"]);
	});

	it("never removes a user-typed item without review once it gained a source", () => {
		const result = mergeList({ base: baseOf(item("a", "Fly to Rome", "fly to Rome", { origin: "user" })), note: [line("Fly to Rome")], model: [], transcript: PAGE, review: false, newId: ids() });
		expect(result.ops).toEqual([]);
		expect(result.base.proposals.map((p) => p.kind)).toEqual(["remove"]);
	});
});

describe("mergeList > the user's own lines", () => {
	it("keeps a typed line as a user item that is never a drop candidate", () => {
		const first = mergeList({ base: baseOf(), note: [line("Water plants")], model: [], transcript: PAGE, review: false, newId: ids() });
		expect(first.base.items).toEqual([item("n1", "Water plants", null, { origin: "user" })]);
		const second = mergeList({ base: first.base, note: [line("Water plants")], model: [], transcript: PAGE, review: false, newId: ids() });
		expect(second.ops).toEqual([]);
		expect(second.base.items).toHaveLength(1);
	});

	it("does not propose an item the user already typed", () => {
		const result = mergeList({ base: baseOf(), note: [line("Buy milk")], model: [said(null, "Buy milk", "buy milk")], transcript: PAGE, review: true, newId: ids() });
		expect(result.base.proposals).toEqual([]);
		expect(result.base.items[0]).toMatchObject({ origin: "user", source: "buy milk" });
	});

	it("drops a pending proposal the user has since typed themselves", () => {
		const pending: Proposal = { kind: "add", id: "p1", text: "Buy milk", fields: {}, source: "buy milk", done: false };
		const result = mergeList({ base: { items: [], tombstones: [], proposals: [pending] }, note: [line("Buy milk")], model: [], transcript: PAGE, review: true, newId: ids() });
		expect(result.base.proposals).toEqual([]);
	});

	it("turns a deleted line into a tombstone and never brings the item back", () => {
		const first = mergeList({ base: baseOf(item("a", "Buy milk", "buy milk")), note: [], model: [said("a", "Buy milk", "buy milk")], transcript: PAGE, review: false, newId: ids() });
		expect(first.base.tombstones).toEqual([{ id: "a", text: "Buy milk", source: "buy milk" }]);
		expect(first.ops).toEqual([]);
		const again = mergeList({ base: first.base, note: [], model: [said(null, "Get milk", "buy milk")], transcript: PAGE, review: false, newId: ids() });
		expect(again.ops).toEqual([]);
		expect(again.base.proposals).toEqual([]);
	});

	it("does not bring back a deleted item the model returns under new words and no known source", () => {
		const base: ListBase = { items: [], tombstones: [{ id: "a", text: "Call Bob re invoice", source: null }], proposals: [] };
		const result = mergeList({ base, note: [], model: [said(null, "Call Bob re invoice", "call Bob re invoice")], transcript: PAGE, review: false, newId: ids() });
		expect(result.ops).toEqual([]);
	});
});

describe("mergeList > new items", () => {
	it("proposes a new item with review on and inserts it with review off", () => {
		const model = [said(null, "Buy milk", "buy milk")];
		expect(mergeList({ base: baseOf(), note: [], model, transcript: PAGE, review: true, newId: ids() }).base.proposals).toEqual([
			{ kind: "add", id: "n1", text: "Buy milk", fields: {}, source: "buy milk", done: false },
		]);
		const off = mergeList({ base: baseOf(), note: [], model, transcript: PAGE, review: false, newId: ids() });
		expect(off.ops).toEqual([{ kind: "insert", text: "Buy milk", fields: {}, done: false }]);
	});

	it("keeps one pending proposal across syncs instead of piling up copies", () => {
		const model = [said(null, "Buy milk", "buy milk")];
		const first = mergeList({ base: baseOf(), note: [], model, transcript: PAGE, review: true, newId: ids() });
		const second = mergeList({ base: first.base, note: [], model, transcript: PAGE, review: true, newId: ids() });
		expect(second.base.proposals).toEqual(first.base.proposals);
	});

	it("folds an item the model calls new onto the live item it really is", () => {
		const result = mergeList({ base: baseOf(item("a", "Buy milk", "buy milk")), note: [line("Buy milk")], model: [said("zz", "Buy milk today", "buy milk", { done: true })], transcript: PAGE, review: true, newId: ids() });
		expect(result.base.proposals).toEqual([]);
		expect(result.ops).toEqual([{ kind: "tick", line: 0 }]);
	});

	it("ignores a new item without a source span", () => {
		const result = mergeList({ base: baseOf(), note: [], model: [said(null, "Buy milk", null)], transcript: PAGE, review: false, newId: ids() });
		expect(result.ops).toEqual([]);
	});

	it("ignores an id the user deleted", () => {
		const base: ListBase = { items: [], tombstones: [{ id: "a", text: "Buy milk", source: "buy milk" }], proposals: [] };
		const result = mergeList({ base, note: [], model: [said("a", "Buy milk", "buy milk")], transcript: PAGE, review: false, newId: ids() });
		expect(result.ops).toEqual([]);
	});
});

describe("mergeProposals", () => {
	it("replaces the content of a pending proposal with the same key and keeps its id", () => {
		const old: Proposal = { kind: "change", id: "p1", itemId: "a", text: "x", fields: { due: "Mon" }, source: "s" };
		const fresh: Proposal = { kind: "change", id: "p9", itemId: "a", text: "x", fields: { due: "Fri" }, source: "t" };
		expect(mergeProposals([old], [fresh])).toEqual([{ ...fresh, id: "p1" }]);
	});
});

describe("mergeText", () => {
	it("writes the first summary", () => {
		expect(mergeText({ base: null, note: "", model: "Met Bob.", proposals: [], newId: ids() })).toEqual({ base: "Met Bob.", write: "Met Bob.", proposals: [] });
	});

	it("replaces an untouched summary and drops a stale replace proposal", () => {
		const stale: Proposal = { kind: "replace", id: "p1", text: "old" };
		expect(mergeText({ base: "Met Bob.", note: "Met Bob.", model: "Met Bob and Anna.", proposals: [stale], newId: ids() })).toEqual({ base: "Met Bob and Anna.", write: "Met Bob and Anna.", proposals: [] });
	});

	it("writes nothing when the untouched summary already reads the same", () => {
		expect(mergeText({ base: "Met Bob.", note: "Met Bob.", model: "met Bob", proposals: [], newId: ids() }).write).toBeNull();
	});

	it("keeps an edited summary and proposes the new one once", () => {
		const first = mergeText({ base: "Met Bob.", note: "Met Bob. Good talk.", model: "Met Bob and Anna.", proposals: [], newId: ids() });
		expect(first).toEqual({ base: "Met Bob.", write: null, proposals: [{ kind: "replace", id: "n1", text: "Met Bob and Anna." }] });
		const second = mergeText({ base: "Met Bob.", note: "Met Bob. Good talk.", model: "Met Anna and Bob.", proposals: first.proposals, newId: ids() });
		expect(second.proposals).toEqual([{ kind: "replace", id: "n1", text: "Met Anna and Bob." }]);
	});

	it("proposes nothing when the model says what the base already said", () => {
		expect(mergeText({ base: "Met Bob.", note: "Met Bob. Good talk.", model: "Met Bob.", proposals: [], newId: ids() }).proposals).toEqual([]);
	});
});
