import { describe, expect, it } from "vitest";
import { BASE_VERSION, NO_FAILURES, type PageBase } from "./base-store";
import type { BaseItem, ListProposal, Proposal } from "./merge";
import { decide, pendingProposals } from "./review";

const LINK = "obsidian://tagged-sync-review";
const item = (id: string, text: string, extra: Partial<BaseItem> = {}): BaseItem => ({ id, text, fields: {}, done: false, source: text.toLowerCase(), origin: "engine", ...extra });

function page(listProposals: ListProposal[], textProposals: Proposal[] = [], items = [item("a", "Call Bob"), item("b", "Buy milk")]): PageBase {
	return {
		version: BASE_VERSION,
		noteId: "n",
		syncKey: "k",
		unitKey: "k",
		transcript: "t",
		settled: [],
		extraction: { ...NO_FAILURES },
		slots: {
			tasks: { shape: "checklist", heading: { level: 2, text: "Tasks" }, itemFormat: "- [ ] {{text}} 📅 {{due}}", list: { items, tombstones: [], proposals: listProposals } },
			summary: { shape: "text", heading: { level: 2, text: "Summary" }, text: "Met Bob.", proposals: textProposals },
		},
	};
}

const note = (tasksCallout: number, summaryCallout = 0) =>
	[
		"## Tasks",
		...(tasksCallout > 0 ? [`> [!todo] ${tasksCallout} ${tasksCallout === 1 ? "proposal" : "proposals"} — [Review](${LINK})`] : []),
		"- [ ] Call Bob",
		"- [ ] Buy milk",
		"",
		"## Summary",
		...(summaryCallout > 0 ? [`> [!todo] 1 proposal — [Review](${LINK})`] : []),
		"My own words.",
	];

const ADD: ListProposal = { kind: "add", id: "p1", text: "Email Anna", fields: { due: "2026-10-02" }, source: "email anna", done: false };
const REMOVE: ListProposal = { kind: "remove", id: "p2", itemId: "b" };
const CHANGE: ListProposal = { kind: "change", id: "p3", itemId: "a", text: "Call Bob", fields: { due: "2026-10-05" }, source: "call bob monday" };
const REPLACE: Proposal = { kind: "replace", id: "p4", text: "Met Bob and Anna." };
let n = 0;
const run = (base: PageBase, lines: string[], slotId: string, proposalId: string, accept: boolean) => decide({ base, lines, slotId, proposalId, accept, newId: () => `new${++n}`, reviewLink: LINK });

describe("pendingProposals", () => {
	it("lists every pending proposal of a page with its Slot", () => {
		expect(pendingProposals(page([ADD, REMOVE], [REPLACE])).map((p) => [p.slotId, p.proposal.id])).toEqual([
			["tasks", "p1"],
			["tasks", "p2"],
			["summary", "p4"],
		]);
	});
});

describe("decide > a new item", () => {
	it("✓ inserts the line after the last item and updates the callout's count", () => {
		const out = run(page([ADD, REMOVE]), note(2), "tasks", "p1", true);
		if (out.kind !== "applied") throw new Error(out.kind);
		expect(out.lines.slice(0, 5)).toEqual(["## Tasks", `> [!todo] 1 proposal — [Review](${LINK})`, "- [ ] Call Bob", "- [ ] Buy milk", "- [ ] Email Anna 📅 2026-10-02"]);
		expect(out.base.slots.tasks).toMatchObject({ list: { proposals: [REMOVE], items: [{ id: "a" }, { id: "b" }, { text: "Email Anna", origin: "engine", source: "email anna" }] } });
	});

	it("✗ writes a tombstone so the item stays out, and removes the callout with the last proposal", () => {
		const out = run(page([ADD]), note(1), "tasks", "p1", false);
		if (out.kind !== "applied") throw new Error(out.kind);
		expect(out.lines.slice(0, 3)).toEqual(["## Tasks", "- [ ] Call Bob", "- [ ] Buy milk"]);
		expect(out.base.slots.tasks).toMatchObject({ list: { proposals: [], tombstones: [{ id: "p1", text: "Email Anna", source: "email anna" }] } });
	});
});

describe("decide > a dropped item", () => {
	it("✓ removes the line and tombstones the item", () => {
		const out = run(page([REMOVE]), note(1), "tasks", "p2", true);
		if (out.kind !== "applied") throw new Error(out.kind);
		expect(out.lines.slice(0, 3)).toEqual(["## Tasks", "- [ ] Call Bob", ""]);
		expect(out.base.slots.tasks).toMatchObject({ list: { items: [{ id: "a" }], tombstones: [{ id: "b" }] } });
	});

	it("✗ keeps the line and takes the item out of the engine's hands for good", () => {
		const out = run(page([REMOVE]), note(1), "tasks", "p2", false);
		if (out.kind !== "applied") throw new Error(out.kind);
		expect(out.lines).toContain("- [ ] Buy milk");
		expect(out.base.slots.tasks).toMatchObject({ list: { items: [{ id: "a" }, { id: "b", source: null }] } });
	});

	it("✓ on an item whose line the user already deleted changes no line", () => {
		const lines = note(1).filter((line) => line !== "- [ ] Buy milk");
		const out = run(page([REMOVE]), lines, "tasks", "p2", true);
		if (out.kind !== "applied") throw new Error(out.kind);
		expect(out.lines.slice(0, 3)).toEqual(["## Tasks", "- [ ] Call Bob", ""]);
	});
});

describe("decide > a changed field", () => {
	it("✓ rewrites the line and the item", () => {
		const out = run(page([CHANGE]), note(1), "tasks", "p3", true);
		if (out.kind !== "applied") throw new Error(out.kind);
		expect(out.lines[1]).toBe("- [ ] Call Bob 📅 2026-10-05");
		expect(out.base.slots.tasks).toMatchObject({ list: { items: [{ id: "a", fields: { due: "2026-10-05" }, source: "call bob monday" }, { id: "b" }] } });
	});

	it("✗ keeps the line and moves the item's source, so the same ink is not proposed again", () => {
		const out = run(page([CHANGE]), note(1), "tasks", "p3", false);
		if (out.kind !== "applied") throw new Error(out.kind);
		expect(out.lines[1]).toBe("- [ ] Call Bob");
		expect(out.base.slots.tasks).toMatchObject({ list: { items: [{ id: "a", fields: {}, source: "call bob monday" }, { id: "b" }] } });
	});

	it("✓ with the line gone only updates the base", () => {
		const out = run(page([CHANGE]), note(1).filter((line) => line !== "- [ ] Call Bob"), "tasks", "p3", true);
		if (out.kind !== "applied") throw new Error(out.kind);
		expect(out.lines).not.toContain("- [ ] Call Bob 📅 2026-10-05");
	});
});

describe("decide > a summary", () => {
	it("✓ replaces the text; ✗ keeps it and remembers the model's text so only a new one is proposed", () => {
		const accepted = run(page([], [REPLACE]), note(0, 1), "summary", "p4", true);
		if (accepted.kind !== "applied") throw new Error(accepted.kind);
		expect(accepted.lines.slice(-2)).toEqual(["## Summary", "Met Bob and Anna."]);
		const rejected = run(page([], [REPLACE]), note(0, 1), "summary", "p4", false);
		if (rejected.kind !== "applied") throw new Error(rejected.kind);
		expect(rejected.lines.slice(-2)).toEqual(["## Summary", "My own words."]);
		expect(rejected.base.slots.summary).toMatchObject({ text: "Met Bob and Anna.", proposals: [] });
	});
});

describe("decide > nothing to decide", () => {
	it("is stale for a proposal or Slot that is gone, or an item that is gone", () => {
		expect(run(page([]), note(0), "tasks", "p1", true)).toEqual({ kind: "stale" });
		expect(run(page([]), note(0), "ideas", "p1", true)).toEqual({ kind: "stale" });
		const orphan = run(page([REMOVE, CHANGE], [], [item("x", "Other")]), note(2), "tasks", "p2", true);
		expect(orphan.kind).toBe("applied");
		expect(run(page([CHANGE], [], [item("x", "Other")]), note(1), "tasks", "p3", true).kind).toBe("applied");
	});

	it("writes nothing when the note has lost the Slot's heading", () => {
		expect(run(page([ADD]), ["## Other", "- [ ] Something else"], "tasks", "p1", true)).toEqual({ kind: "no-region" });
	});
});
