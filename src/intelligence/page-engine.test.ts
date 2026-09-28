import { describe, expect, it } from "vitest";
import { isoDay } from "./dates";
import type { ExtractionBackend, ExtractionInput } from "./extraction-backend";
import { processPage, type PageRun } from "./page-engine";
import { defaultSlots, genericProfile, type SlotDef } from "./settings";

const [TASKS, DECISIONS, SUMMARY, TAGS] = defaultSlots();
const TASKS_OFF: SlotDef = { ...TASKS, review: false };

/** A backend that answers with the given JSON-shaped answer and records what it was asked. */
function backend(answer: Record<string, unknown>, seen: ExtractionInput[] = []): ExtractionBackend {
	return {
		id: "fake",
		metered: false,
		async extract(input) {
			seen.push(input);
			const { parseExtraction } = await import("./extraction");
			return { kind: "ok", result: parseExtraction(answer, input.slots, input.referenceDate)! };
		},
	};
}
const failing = (reason: string): ExtractionBackend => ({ id: "fake", metered: false, extract: async () => ({ kind: "failed", reason }) });

const task = (text: string, source: string, extra: Record<string, unknown> = {}) => ({ source, reason: "", id: "new", text, due: null, done: false, ...extra });
const TEMPLATE = "# {{title}}\nWritten: {{ts.date.written}} · seen {{ts.date.firstSeen}} · synced {{ts.date.synced}}\n\n## Tasks\n{{ts.tasks}}\n\n## Summary\n{{ts.summary}}\n\n## Page\n{{ts.page.link}}\n";
const PAGE = "Mo 28.9. call Bob by Friday. buy milk. Met Bob about the budget.";

function run(overrides: Partial<PageRun> = {}): PageRun {
	let n = 0;
	return {
		unit: { key: "doc:p1:work", pageHash: "h1", transcript: PAGE, firstSeen: new Date(2026, 8, 28, 9).getTime() },
		noteId: "note-1",
		base: null,
		note: null,
		profile: genericProfile(false),
		slots: [TASKS, SUMMARY],
		template: TEMPLATE,
		backend: backend({ page_date_text: "Mo 28.9.", tasks: [task("Call Bob", "call Bob by Friday", { due: { words: "by Friday", rel: "none" } })], summary: "Met Bob." }),
		syncedAt: new Date(2026, 8, 29, 12),
		title: (date) => `${isoDay(date)} Work p1`,
		pageLink: "[[p1.png|Page 1]]",
		pageEmbed: "![[p1.png]]",
		reviewLink: "obsidian://review",
		formatDate: () => "D",
		formatTime: () => "T",
		newId: () => `id${++n}`,
		...overrides,
	};
}

describe("processPage > a new note", () => {
	it("renders the template with every Slot, the page's dates and link, and records the regions in the base", async () => {
		const out = await processPage(run());
		expect(out.kind).toBe("written");
		if (out.kind !== "written") return;
		expect(out.created).toBe(true);
		expect(out.content).toBe(
			"# 2026-09-28 Work p1\nWritten: 2026-09-28 · seen 2026-09-28 · synced 2026-09-29\n\n## Tasks\n- [ ] Call Bob 📅 2026-10-02\n\n## Summary\nMet Bob.\n\n## Page\n[[p1.png|Page 1]]\n",
		);
		expect(Object.keys(out.base.slots)).toEqual(["tasks", "summary"]);
		expect(out.base).toMatchObject({ noteId: "note-1", syncKey: "doc:p1:work", unitKey: "doc:p1:work", transcript: PAGE, settled: [] });
	});

	it("gives a Slot the template does not place its own heading at the end, and settles one filled inline", async () => {
		const out = await processPage(run({ template: "Mood of the day: {{ts.summary}}\n", slots: [TASKS, SUMMARY] }));
		if (out.kind !== "written") throw new Error(out.kind);
		expect(out.content).toBe("Mood of the day: Met Bob.\n\n## Tasks\n- [ ] Call Bob 📅 2026-10-02\n");
		expect(out.base.settled).toEqual(["summary"]);
		expect(Object.keys(out.base.slots)).toEqual(["tasks"]);
	});

	it("names the note after the sync day when the page has neither a written date nor a first-seen stamp", async () => {
		const out = await processPage(run({ unit: { key: "k", pageHash: "h", transcript: PAGE, firstSeen: null }, backend: backend({ tasks: [], summary: "" }), template: "{{title}}|{{ts.date.firstSeen}}|{{ts.date.written}}|{{ts.page.png}}" }));
		if (out.kind !== "written") throw new Error(out.kind);
		expect(out.content).toBe("2026-09-29 Work p1|||![[p1.png]]\n\n## Tasks\n\n\n## Summary\n\n");
	});

	it("writes a task already ticked on the page as ticked", async () => {
		const out = await processPage(run({ backend: backend({ tasks: [task("Buy milk", "buy milk", { done: true })], summary: "" }) }));
		if (out.kind !== "written") throw new Error(out.kind);
		expect(out.content).toContain("## Tasks\n- [x] Buy milk\n");
	});

	it("sends every Slot to the model, Values included", async () => {
		const seen: ExtractionInput[] = [];
		await processPage(run({ slots: [TASKS, TAGS], backend: backend({ tasks: [] }, seen) }));
		expect(seen[0].slots.map((s) => s.id)).toEqual(["tasks", "tags"]);
	});
});

describe("processPage > Value Slots", () => {
	const MOOD: SlotDef = { id: "mood", name: "Mood", shape: "value", instruction: "", examples: [], fields: [{ name: "mood", type: "choice", options: ["good", "ok", "bad"] }], itemFormat: "", review: false };
	const PROJECT: SlotDef = { id: "project", name: "Project", shape: "value", instruction: "", examples: [], fields: [{ name: "project", type: "choice", options: ["A", "B", "C", "D"] }], itemFormat: "", review: false, property: "project" };
	const TAGS_OPEN: SlotDef = { ...TAGS, fields: [{ name: "tags", type: "choice", options: ["budget", "hiring"] }] };
	const local = (answer: Record<string, unknown>): ExtractionBackend => ({ ...backend(answer), local: true });
	const TEMPLATE_V = "---\ntags:\n  - mine\n---\n## Mood\n{{ts.mood}}\n";

	it("writes a Value under its heading, a property into the frontmatter, and tags beside the user's", async () => {
		const out = await processPage(run({ template: TEMPLATE_V, slots: [MOOD, PROJECT, TAGS_OPEN], backend: backend({ mood: "good", project: "B", tags: ["budget"] }) }));
		if (out.kind !== "written") throw new Error(out.kind);
		expect(out.content).toBe("---\ntags:\n  - mine\n  - budget\nproject: B\n---\n## Mood\ngood\n");
		expect(out.base.slots).toMatchObject({ mood: { shape: "value", value: "good", property: null }, project: { value: "B", property: "project" }, tags: { added: ["budget"], buried: [] } });
	});

	it("proposes a local model's first topical pick instead of writing it, but writes a mood", async () => {
		const out = await processPage(run({ template: TEMPLATE_V, slots: [MOOD, PROJECT], backend: local({ mood: "ok", project: "C" }) }));
		if (out.kind !== "written") throw new Error(out.kind);
		expect(out.content).not.toContain("project:");
		expect(out.content).toContain("## Mood\nok");
		expect(out.proposals).toBe(1);
		const withBodyPick = await processPage(run({ template: "## Project\n{{ts.project}}\n", slots: [{ ...PROJECT, property: undefined }], backend: local({ project: "C" }) }));
		if (withBodyPick.kind !== "written") throw new Error(withBodyPick.kind);
		expect(withBodyPick.content).toBe("## Project\n\n");
		expect(withBodyPick.proposals).toBe(1);
		// A choice whose options were never filled in is no topical list: written directly.
		const bare = await processPage(run({ template: "## Mood\n{{ts.mood}}\n", slots: [{ ...MOOD, fields: [{ name: "mood", type: "choice" }] }], backend: local({ mood: null }) }));
		expect(bare).toMatchObject({ kind: "written", proposals: 0 });
	});

	it("follows the page while the user has not touched a Value, and proposes once they have", async () => {
		const first = await processPage(run({ template: TEMPLATE_V, slots: [MOOD, PROJECT], backend: backend({ mood: "good", project: "B" }) }));
		if (first.kind !== "written") throw new Error(first.kind);
		const again = await processPage(run({ template: TEMPLATE_V, slots: [MOOD, PROJECT], base: first.base, note: first.content, backend: backend({ mood: "bad", project: "A" }) }));
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.content).toContain("project: A");
		expect(again.content).toContain("## Mood\nbad");
		const edited = again.content!.replace("project: A", "project: D").replace("## Mood\nbad", "## Mood\nmeh");
		const third = await processPage(run({ template: TEMPLATE_V, slots: [MOOD, PROJECT], base: again.base, note: edited, backend: backend({ mood: "good", project: "C" }) }));
		if (third.kind !== "written") throw new Error(third.kind);
		expect(third.content).toContain("project: D");
		expect(third.content).toContain("## Mood\n> [!todo] 1 proposal — [Review](obsidian://review)\nmeh");
		expect(third.proposals).toBe(2);
	});

	it("reads a single tag written as a scalar, and clears a Value the page no longer holds", async () => {
		const out = await processPage(run({ template: "---\ntags: mine\n---\n## Mood\n{{ts.mood}}\n", slots: [MOOD, TAGS_OPEN], backend: backend({ mood: null, tags: ["budget"] }) }));
		if (out.kind !== "written") throw new Error(out.kind);
		expect(out.content).toBe("---\ntags:\n  - mine\n  - budget\n---\n## Mood\n\n");
		expect(out.base.slots.mood).toMatchObject({ value: null });
		const good = await processPage(run({ template: TEMPLATE_V, slots: [MOOD], backend: backend({ mood: "good" }) }));
		if (good.kind !== "written") throw new Error(good.kind);
		const gone = await processPage(run({ template: TEMPLATE_V, slots: [MOOD], base: good.base, note: good.content, backend: backend({ mood: null }) }));
		if (gone.kind !== "written") throw new Error(gone.kind);
		expect(gone.content).toContain("## Mood\n");
		expect(gone.content).not.toContain("good");
		expect(gone.base.slots.mood).toMatchObject({ value: null });
	});

	it("never adds back a tag the user removed", async () => {
		const first = await processPage(run({ template: TEMPLATE_V, slots: [TAGS_OPEN], backend: backend({ tags: ["budget"] }) }));
		if (first.kind !== "written") throw new Error(first.kind);
		const removed = first.content!.replace("  - budget\n", "");
		const again = await processPage(run({ template: TEMPLATE_V, slots: [TAGS_OPEN], base: first.base, note: removed, backend: backend({ tags: ["budget", "hiring"] }) }));
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.content).toContain("tags:\n  - mine\n  - hiring\n");
		expect(again.base.slots.tags).toMatchObject({ added: ["hiring"], buried: ["budget"] });
	});

	it("adds a Value Slot new to the Profile under its own heading, and adopts an empty one", async () => {
		const first = (await processPage(run({ slots: [TASKS] }))) as Extract<Awaited<ReturnType<typeof processPage>>, { kind: "written" }>;
		const again = await processPage(run({ slots: [TASKS, MOOD], base: first.base, note: first.content, backend: backend({ tasks: [], mood: "ok" }) }));
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.content).toContain("\n## Mood\nok");
		const adopt = await processPage(run({ template: "## Mood\n{{ts.mood}}\n", slots: [MOOD], base: { ...first.base, slots: {} }, note: "## Mood\n", backend: backend({ mood: "ok" }) }));
		if (adopt.kind !== "written") throw new Error(adopt.kind);
		expect(adopt.content).toBe("## Mood\nok");
		const nothing = await processPage(run({ template: "## Mood\n{{ts.mood}}\n", slots: [MOOD], base: { ...first.base, slots: {} }, note: "## Mood\n", backend: backend({ mood: null }) }));
		if (nothing.kind !== "written") throw new Error(nothing.kind);
		expect(nothing.base.slots.mood).toMatchObject({ value: null });
	});
});

describe("processPage > a failed extraction", () => {
	it("keeps the transcript in the base and counts attempts per page hash", async () => {
		const first = await processPage(run({ backend: failing("offline") }));
		expect(first).toMatchObject({ kind: "failed", reason: "offline", base: { transcript: PAGE, extraction: { attempts: 1, failedHash: "h1" } } });
		const second = await processPage(run({ backend: failing("offline"), base: first.base }));
		expect(second.base.extraction.attempts).toBe(2);
		const changed = await processPage(run({ backend: failing("offline"), base: second.base, unit: { ...run().unit, pageHash: "h2" } }));
		expect(changed.base.extraction).toEqual({ attempts: 1, reason: "offline", failedHash: "h2" });
	});
});

describe("processPage > an existing note", () => {
	async function created(overrides: Partial<PageRun> = {}) {
		const out = await processPage(run(overrides));
		if (out.kind !== "written") throw new Error(out.kind);
		return out;
	}

	it("changes nothing when the page says what it said", async () => {
		const first = await created();
		const again = await processPage(run({ base: first.base, note: first.content }));
		expect(again).toMatchObject({ kind: "written", content: null, created: false, proposals: 0 });
	});

	it("proposes a new task under review and puts the callout under the heading, leaving the user's lines alone", async () => {
		const first = await created();
		const edited = first.content!.replace("- [ ] Call Bob 📅 2026-10-02", "- [ ] Call Bob 📅 2026-10-02\n- [ ] My own task");
		const again = await processPage(
			run({
				base: first.base,
				note: edited,
				backend: backend({ tasks: [task("Call Bob", "call Bob by Friday", { id: "id1", due: { words: "by Friday", rel: "none" } }), task("Buy milk", "buy milk")], summary: "Met Bob." }),
			}),
		);
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.proposals).toBe(1);
		expect(again.content).toContain("## Tasks\n> [!todo] 1 proposal — [Review](obsidian://review)\n- [ ] Call Bob 📅 2026-10-02\n- [ ] My own task\n");
	});

	it("applies a new task directly with review off and replaces an untouched summary", async () => {
		const first = await created({ slots: [TASKS_OFF, SUMMARY] });
		const again = await processPage(
			run({ slots: [TASKS_OFF, SUMMARY], base: first.base, note: first.content, backend: backend({ tasks: [task("Call Bob", "call Bob by Friday", { id: "id1", due: { words: "by Friday", rel: "none" } }), task("Buy milk", "buy milk")], summary: "Met Bob about the budget." }) }),
		);
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.content).toContain("- [ ] Call Bob 📅 2026-10-02\n- [ ] Buy milk\n");
		expect(again.content).toContain("## Summary\nMet Bob about the budget.\n");
	});

	it("follows a renamed heading and keeps its new name in the base", async () => {
		const first = await created();
		const again = await processPage(run({ base: first.base, note: first.content!.replace("## Tasks", "## To do"), backend: backend({ tasks: [task("Call Bob", "call Bob by Friday", { id: "id1", done: true })], summary: "Met Bob." }) }));
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.content).toContain("## To do\n- [x] Call Bob 📅 2026-10-02");
		expect(again.base.slots.tasks.heading).toEqual({ level: 2, text: "To do" });
	});

	it("writes nothing into a region it cannot find, and reports it", async () => {
		const first = await created();
		const gutted = first.content!.replace("## Summary\nMet Bob.\n", "");
		const again = await processPage(run({ base: first.base, note: gutted, backend: backend({ tasks: [task("Call Bob", "call Bob by Friday", { id: "id1" })], summary: "Other." }) }));
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.missingRegions).toEqual(["summary"]);
		expect(again.base.slots.summary).toEqual(first.base.slots.summary);
	});

	it("adds a Slot new to the Profile right after the region before it, once", async () => {
		const first = await created();
		const slots = [TASKS, DECISIONS, SUMMARY];
		const answer = { tasks: [task("Call Bob", "call Bob by Friday", { id: "id1", due: { words: "by Friday", rel: "none" } })], decisions: [task("Budget stays", "Met Bob about the budget")], summary: "Met Bob." };
		const again = await processPage(run({ slots, base: first.base, note: first.content, backend: backend(answer) }));
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.content).toContain("- [ ] Call Bob 📅 2026-10-02\n\n## Decisions\n- Budget stays\n\n## Summary");
		const third = await processPage(run({ slots, base: again.base, note: again.content!.replace("\n## Decisions\n- Budget stays\n", ""), backend: backend(answer) }));
		if (third.kind !== "written") throw new Error(third.kind);
		expect(third.missingRegions).toEqual(["decisions"]);
		expect(third.content).toBeNull();
	});

	it("appends a new Slot at the end when no earlier Slot has a region, and settles one the template places inline", async () => {
		const noTasks = "## Summary\n{{ts.summary}}\n\n## Page\n{{ts.page.link}}\n";
		const first = await created({ slots: [SUMMARY], template: noTasks });
		const again = await processPage(run({ slots: [TASKS, SUMMARY], template: noTasks, base: first.base, note: first.content, backend: backend({ tasks: [task("Call Bob", "call Bob by Friday")], summary: "Met Bob." }) }));
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.content!.endsWith("## Page\n[[p1.png|Page 1]]\n\n## Tasks\n- [ ] Call Bob\n")).toBe(true);

		const inline = await processPage(run({ slots: [SUMMARY, DECISIONS], template: TEMPLATE + "Decided: {{ts.decisions}}\n", base: first.base, note: first.content, backend: backend({ summary: "Met Bob.", decisions: [] }) }));
		if (inline.kind !== "written") throw new Error(inline.kind);
		expect(inline.base.settled).toEqual(["decisions"]);
		expect(inline.content).toBeNull();
		const after = await processPage(run({ slots: [SUMMARY, DECISIONS], template: TEMPLATE + "Decided: {{ts.decisions}}\n", base: inline.base, note: first.content, backend: backend({ summary: "Met Bob.", decisions: [] }) }));
		expect(after).toMatchObject({ content: null });
	});

	it("adds a new Summary Slot the template does not place as a bare heading when there is nothing to say", async () => {
		const template = "## Tasks\n{{ts.tasks}}\n";
		const first = await created({ slots: [TASKS], template });
		const again = await processPage(run({ slots: [TASKS, SUMMARY], template, base: first.base, note: first.content, backend: backend({ tasks: [], summary: "" }) }));
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.content).toBe("## Tasks\n- [ ] Call Bob 📅 2026-10-02\n\n## Summary\n");
		expect(again.base.slots.summary).toMatchObject({ shape: "text", text: "" });
	});

	it("adopts the empty template heading a newly added Slot already has in the note", async () => {
		const first = await created({ slots: [TASKS] });
		expect(first.content).toContain("## Summary\n\n\n## Page");
		const again = await processPage(run({ slots: [TASKS, SUMMARY], base: first.base, note: first.content, backend: backend({ tasks: [], summary: "Met Bob." }) }));
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.content).toContain("## Summary\nMet Bob.\n\n## Page");
		expect(again.content!.match(/## Summary/g)).toHaveLength(1);
	});

	it("never overwrites what the user wrote under a heading a newly added Slot adopts", async () => {
		const first = await created({ slots: [SUMMARY] });
		const typed = first.content!.replace("## Tasks\n", "## Tasks\n- [ ] Water plants\n").replace("## Summary\nMet Bob.", "## Summary\nMy own words.");
		const again = await processPage(run({ slots: [TASKS, SUMMARY], base: { ...first.base, slots: {} }, note: typed, backend: backend({ tasks: [task("Buy milk", "buy milk")], summary: "Met Bob." }) }));
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.content).toContain("## Tasks\n> [!todo] 1 proposal — [Review](obsidian://review)\n- [ ] Water plants\n");
		expect(again.content).toContain("## Summary\n> [!todo] 1 proposal — [Review](obsidian://review)\nMy own words.");
		expect(again.proposals).toBe(2);
	});

	it("adopts an empty task heading by writing the page's tasks directly", async () => {
		const first = await created({ slots: [SUMMARY] });
		const again = await processPage(run({ slots: [TASKS, SUMMARY], base: first.base, note: first.content, backend: backend({ tasks: [task("Buy milk", "buy milk")], summary: "Met Bob." }) }));
		if (again.kind !== "written") throw new Error(again.kind);
		expect(again.content).toContain("## Tasks\n- [ ] Buy milk\n");
		expect(again.proposals).toBe(0);
	});

	it("passes the base's items with their ids to the model", async () => {
		const first = await created();
		const seen: ExtractionInput[] = [];
		await processPage(run({ base: first.base, note: first.content, backend: backend({ tasks: [], summary: "" }, seen) }));
		expect(seen[0].known).toEqual({ tasks: [{ id: "id1", text: "Call Bob" }] });
	});
});
