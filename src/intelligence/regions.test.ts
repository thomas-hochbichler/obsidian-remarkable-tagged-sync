import { describe, expect, it } from "vitest";
import { compileItemFormat } from "./item-format";
import { applyListOps, findRegion, headings, parseRegion, readTextRegion, setProposalCallout, writeTextRegion } from "./regions";

const tasks = compileItemFormat("- [ ] {{text}} 📅 {{due}}");
const TASKS = { level: 2, text: "Tasks" };

const NOTE = [
	"# 2026-09-28 Work p3", // 0
	"", // 1
	"## Tasks", // 2
	"Things from the page:", // 3
	"- [ ] Call Bob 📅 2026-10-02", // 4
	"- [x] Buy milk ✅ 2026-09-28", // 5
	"- water plants", // 6
	"### Later", // 7
	"- [ ] Someday", // 8
	"", // 9
	"## Summary", // 10
	"Met Bob.", // 11
];

describe("headings", () => {
	it("ignores a heading inside fenced code", () => {
		expect(headings(["## A", "```", "## not a heading", "```", "## B"]).map((h) => h.text)).toEqual(["A", "B"]);
	});
});

describe("findRegion", () => {
	it("runs from the heading to the next heading of the same or a higher level", () => {
		expect(findRegion(NOTE, TASKS, tasks)).toEqual({ heading: 2, start: 3, end: 10 });
		expect(findRegion(NOTE, { level: 2, text: "Summary" }, tasks)).toEqual({ heading: 10, start: 11, end: 12 });
	});

	it("finds a renamed heading again through the items it holds", () => {
		const renamed = NOTE.map((line) => (line === "## Tasks" ? "## To do" : line));
		expect(findRegion(renamed, TASKS, tasks, ["Call Bob", "Buy milk"])?.heading).toBe(2);
	});

	it("takes the renamed heading that holds the most of the base's items", () => {
		const lines = ["## Errands", "- [ ] Buy milk", "## To do", "- [ ] Call Bob", "- [ ] Buy milk", "## Misc", "- [ ] Call Bob"];
		expect(findRegion(lines, TASKS, tasks, ["Call Bob", "Buy milk"])?.heading).toBe(2);
	});

	it("gives up rather than guess when no heading holds the base's items", () => {
		const renamed = NOTE.map((line) => (line === "## Tasks" ? "## To do" : line));
		expect(findRegion(renamed, TASKS, tasks, ["Fly to Rome"])).toBeNull();
		expect(findRegion(renamed, TASKS, tasks)).toBeNull();
	});
});

describe("parseRegion", () => {
	it("reads item lines, skips prose and sub-headings, and keeps a list line the format cannot read", () => {
		const items = parseRegion(NOTE, findRegion(NOTE, TASKS, tasks)!, tasks);
		expect(items).toEqual([
			{ text: "Call Bob", fields: { due: "2026-10-02" }, checkbox: " ", line: 4 },
			{ text: "Buy milk", fields: {}, checkbox: "x", line: 5 },
			{ text: "water plants", fields: {}, checkbox: null, line: 6 },
			{ text: "Someday", fields: {}, checkbox: " ", line: 8 },
		]);
	});
});

describe("applyListOps", () => {
	const region = findRegion(NOTE, TASKS, tasks)!;
	const items = parseRegion(NOTE, region, tasks);

	it("updates a line in place, keeping its tick and the Tasks fields after it", () => {
		const out = applyListOps(NOTE, region, items, [{ kind: "update", line: 1, text: "Buy oat milk", fields: { due: "2026-09-30" } }], tasks);
		expect(out[5]).toBe("- [x] Buy oat milk 📅 2026-09-30 ✅ 2026-09-28");
		expect(out).toHaveLength(NOTE.length);
	});

	it("rewrites a loose list line through the format when it is updated", () => {
		expect(applyListOps(NOTE, region, items, [{ kind: "update", line: 2, text: "Water the plants", fields: {} }], tasks)[6]).toBe("- [ ] Water the plants");
	});

	it("keeps the indentation of an updated line", () => {
		const lines = ["## Tasks", "  - [ ] Call Bob"];
		const r = findRegion(lines, TASKS, tasks)!;
		expect(applyListOps(lines, r, parseRegion(lines, r, tasks), [{ kind: "update", line: 0, text: "Call Anna", fields: {} }], tasks)[1]).toBe("  - [ ] Call Anna");
	});

	it("ticks a line without touching the rest of it", () => {
		expect(applyListOps(NOTE, region, items, [{ kind: "tick", line: 0 }], tasks)[4]).toBe("- [x] Call Bob 📅 2026-10-02");
	});

	it("removes lines and inserts new ones after the last item, leaving every other line alone", () => {
		const out = applyListOps(
			NOTE,
			region,
			items,
			[
				{ kind: "remove", line: 0 },
				{ kind: "insert", text: "Email Anna", fields: {}, done: false },
				{ kind: "insert", text: "Pay rent", fields: {}, done: true },
			],
			tasks,
		);
		expect(out).toEqual([...NOTE.slice(0, 4), ...NOTE.slice(5, 9), "- [ ] Email Anna", "- [x] Pay rent", ...NOTE.slice(9)]);
	});

	it("inserts into an empty region under the heading and its callout, before the blank line", () => {
		const lines = ["## Tasks", "> [!todo] 1 proposal — [Review](x)", "", "## Summary"];
		const r = findRegion(lines, TASKS, tasks)!;
		expect(applyListOps(lines, r, [], [{ kind: "insert", text: "Email Anna", fields: {}, done: false }], tasks)).toEqual([
			"## Tasks",
			"> [!todo] 1 proposal — [Review](x)",
			"- [ ] Email Anna",
			"",
			"## Summary",
		]);
	});

	it("appends at the end of the note when the region is the last one", () => {
		const lines = ["## Tasks", "- [ ] Call Bob"];
		const r = findRegion(lines, TASKS, tasks)!;
		expect(applyListOps(lines, r, parseRegion(lines, r, tasks), [{ kind: "insert", text: "Email Anna", fields: {}, done: false }], tasks)).toEqual([
			"## Tasks",
			"- [ ] Call Bob",
			"- [ ] Email Anna",
		]);
	});
});

describe("Text regions", () => {
	const SUMMARY = { level: 2, text: "Summary" };

	it("reads the body without the proposal callout", () => {
		const lines = ["## Summary", "> [!todo] 1 proposal — [Review](x)", "Met Bob.", ""];
		expect(readTextRegion(lines, findRegion(lines, SUMMARY, tasks)!)).toBe("Met Bob.");
	});

	it("replaces the body, keeping the callout and the blank line before the next heading", () => {
		const lines = ["## Summary", "> [!todo] 1 proposal — [Review](x)", "Met Bob.", "", "## Tasks"];
		expect(writeTextRegion(lines, findRegion(lines, SUMMARY, tasks)!, "Met Bob\nand Anna.")).toEqual([
			"## Summary",
			"> [!todo] 1 proposal — [Review](x)",
			"Met Bob",
			"and Anna.",
			"",
			"## Tasks",
		]);
	});

	it("writes into the last region of the note", () => {
		expect(writeTextRegion(NOTE, findRegion(NOTE, SUMMARY, tasks)!, "Met Anna.").slice(-2)).toEqual(["## Summary", "Met Anna."]);
	});
});

describe("setProposalCallout", () => {
	const lines = ["## Tasks", "- [ ] Call Bob"];
	const region = { heading: 0, start: 1, end: 2 };

	it("adds the callout right under the heading", () => {
		expect(setProposalCallout(lines, region, 1, "obsidian://x")).toEqual(["## Tasks", "> [!todo] 1 proposal — [Review](obsidian://x)", "- [ ] Call Bob"]);
	});

	it("updates the count of an existing callout", () => {
		const withOne = setProposalCallout(lines, region, 1, "l");
		expect(setProposalCallout(withOne, { ...region, end: 3 }, 3, "l")[1]).toBe("> [!todo] 3 proposals — [Review](l)");
	});

	it("removes the callout once everything is decided, and leaves a region without one alone", () => {
		const withOne = setProposalCallout(lines, region, 2, "l");
		expect(setProposalCallout(withOne, { ...region, end: 3 }, 0, "l")).toEqual(lines);
		expect(setProposalCallout(lines, region, 0, "l")).toEqual(lines);
	});
});
