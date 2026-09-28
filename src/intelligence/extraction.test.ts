import { describe, expect, it } from "vitest";
import { calendarDay, isoDay } from "./dates";
import { buildPrompt, buildSchema, PAGE_DATE_KEY, parseExtraction } from "./extraction";
import { defaultSlots, genericProfile, type SlotDef } from "./settings";

const [TASKS, DECISIONS, SUMMARY, TAGS] = defaultSlots();
const TAGS_CLOSED: SlotDef = { ...TAGS, fields: [{ name: "tags", type: "choice", options: ["work", "home"] }] };
const MOOD: SlotDef = { id: "mood", name: "Mood", shape: "value", instruction: "", examples: [], fields: [{ name: "mood", type: "choice", options: ["good", "bad"] }], itemFormat: "", review: false };
const FREE: SlotDef = { id: "title", name: "Title", shape: "value", instruction: "", examples: [], fields: [], itemFormat: "", review: false };
const MON = calendarDay(2026, 8, 28);

describe("buildSchema", () => {
	it("asks for the page date and every Slot, all keys required, nothing extra", () => {
		const schema = buildSchema([TASKS, SUMMARY]);
		expect(schema).toMatchObject({ required: [PAGE_DATE_KEY, "tasks", "summary"], additionalProperties: false });
	});

	it("orders item keys evidence, reason, id, text, fields, done", () => {
		const items = (buildSchema([TASKS]).properties as Record<string, { items: { required: string[] } }>).tasks.items;
		expect(items.required).toEqual(["source", "reason", "id", "text", "due", "done"]);
		const decisions = (buildSchema([DECISIONS]).properties as Record<string, { items: { required: string[] } }>).decisions.items;
		expect(decisions.required).toEqual(["source", "reason", "id", "text"]);
	});

	it("closes a Value to its choice list, and makes the tags Value a list", () => {
		const props = buildSchema([MOOD, TAGS_CLOSED, FREE]).properties as Record<string, unknown>;
		expect(props.mood).toEqual({ anyOf: [{ type: "string", enum: ["good", "bad"] }, { type: "null" }] });
		expect(props.tags).toEqual({ type: "array", items: { type: "string", enum: ["work", "home"] } });
		expect(props.title).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
	});
});

describe("buildPrompt", () => {
	it("carries the Profile description, the date with its weekday, each Slot, the known ids and the page", () => {
		const slot: SlotDef = { ...TASKS, examples: [{ input: "call Bob", output: "Call Bob", positive: true }, { input: "Bob will call", output: "", positive: false }] };
		const { system, user } = buildPrompt({
			profile: { ...genericProfile(false), description: "Work meeting notes" },
			slots: [slot, MOOD],
			transcript: "call Bob by Friday",
			referenceDate: MON,
			known: { tasks: [{ id: "a1", text: "Call Bob" }] },
		});
		expect(system).toMatch(/recognition errors/);
		expect(user).toContain("Page type: Work meeting notes");
		expect(user).toContain("Monday, 2026-09-28");
		expect(user).toContain('Example: "call Bob" → Call Bob');
		expect(user).toContain('Not this: "Bob will call" → nothing');
		expect(user).toContain("- a1: Call Bob");
		expect(user).toContain("An empty list is valid.");
		expect(user).toContain("(one of: good, bad)");
		expect(user.endsWith("call Bob by Friday")).toBe(true);
	});
});

describe("parseExtraction", () => {
	it("reads items with resolved fields, known ids, ticks and a missing source", () => {
		const result = parseExtraction(
			{
				[PAGE_DATE_KEY]: null,
				tasks: [
					{ source: "call Bob by Friday", reason: "mine", id: "a1", text: "Call Bob", due: { words: "by Friday", rel: "none" }, done: false },
					{ source: "", reason: "", id: "new", text: "Buy milk", due: null, done: true },
				],
			},
			[TASKS],
			MON,
		)!;
		expect(result.slots.tasks).toEqual({
			kind: "items",
			items: [
				{ id: "a1", text: "Call Bob", fields: { due: "2026-10-02" }, source: "call Bob by Friday", done: false },
				{ id: null, text: "Buy milk", fields: { due: null }, source: null, done: true },
			],
		});
	});

	it("resolves due dates against the date written on the page when there is one", () => {
		const result = parseExtraction({ [PAGE_DATE_KEY]: "Di 22.9.", tasks: [{ source: "s", reason: "", id: "new", text: "t", due: { words: "morgen", rel: "tomorrow" }, done: false }] }, [TASKS], MON)!;
		expect(isoDay(result.writtenDate!)).toBe("2026-09-22");
		expect(result.slots.tasks).toMatchObject({ items: [{ fields: { due: "2026-09-23" } }] });
	});

	it("drops 'none' items and junk, and reads a missing Slot as empty", () => {
		const result = parseExtraction({ tasks: [{ text: "NONE" }, { text: "" }, { source: "no text" }, "junk", null], decisions: "not a list" }, [TASKS, DECISIONS, SUMMARY], MON)!;
		expect(result.slots).toEqual({ tasks: { kind: "items", items: [] }, decisions: { kind: "items", items: [] }, summary: { kind: "text", text: "" } });
		expect(result.pageDate).toEqual(MON);
	});

	it("reads a summary, and 'none' as an empty summary", () => {
		expect(parseExtraction({ summary: "  Met Bob. " }, [SUMMARY], MON)!.slots.summary).toEqual({ kind: "text", text: "Met Bob." });
		expect(parseExtraction({ summary: "None" }, [SUMMARY], MON)!.slots.summary).toEqual({ kind: "text", text: "" });
	});

	it("keeps a Value only inside its choice list, and de-duplicates tags", () => {
		const result = parseExtraction({ mood: "great", tags: ["work", "work", "cars", 3], title: "Sprint review" }, [MOOD, TAGS_CLOSED, FREE], MON)!;
		expect(result.slots).toEqual({ mood: { kind: "value", value: null }, tags: { kind: "value", value: ["work"] }, title: { kind: "value", value: "Sprint review" } });
		expect(parseExtraction({ mood: "good", tags: "work" }, [MOOD, TAGS_CLOSED], MON)!.slots).toEqual({ mood: { kind: "value", value: "good" }, tags: { kind: "value", value: [] } });
	});

	it("reads nothing from a choice Value whose option list was never filled", () => {
		const bare: SlotDef = { ...MOOD, fields: [{ name: "mood", type: "choice" }] };
		expect((buildSchema([bare]).properties as Record<string, unknown>).mood).toEqual({ anyOf: [{ type: "string", enum: [] }, { type: "null" }] });
		expect(parseExtraction({ mood: "good" }, [bare], MON)!.slots.mood).toEqual({ kind: "value", value: null });
	});

	it("fails an answer that is not an object, so the page is retried", () => {
		for (const junk of [null, "text", [], 3]) expect(parseExtraction(junk, [TASKS], MON)).toBeNull();
	});
});
