import { beforeEach, describe, expect, it, vi } from "vitest";
import { asApp, FakeApp, takeModals, takeSettings } from "../test-stubs/fake-obsidian";
import type { ZoteroAttachment, ZoteroItem } from "./zotero-client";
import { askWhatToSend, NO_PDF, NO_RESULTS, type SendChoice, type SendDialogDeps } from "./zotero-send-dialog";

const ITEM: ZoteroItem = { key: "ITEM1", title: "Best Practices für Prompting", creator: "Smith", year: "2024", citationKey: null };
const OTHER: ZoteroItem = { key: "ITEM2", title: "Etwas anderes", creator: null, year: null, citationKey: null };

function attachment(overrides: Partial<ZoteroAttachment> = {}): ZoteroAttachment {
	return { key: "ATT1", parentKey: "ITEM1", filename: "paper.pdf", md5: null, title: "Full Text PDF", ...overrides };
}

function open(overrides: Partial<SendDialogDeps> = {}): { choice: Promise<SendChoice | null> } {
	const deps: SendDialogDeps = {
		search: async () => [ITEM],
		attachments: async () => [attachment()],
		tag: { kind: "use", tag: "#papers" },
		searchDelayMs: 0,
		...overrides,
	};
	return { choice: askWhatToSend(asApp(new FakeApp()), deps) };
}

/** Types into the dialog's one text field and lets the debounced search run. */
async function type(text: string): Promise<void> {
	const field = takeSettings().flatMap((setting) => setting.texts)[0];
	field.type(text);
	await vi.advanceTimersByTimeAsync(1);
	await Promise.resolve();
}

/**
 * Presses the button of the row whose name is `name`, or the only button where no name is given.
 *
 * ⚠️ `takeSettings()` *drains* the log, so a test that reads the rows first has to hand them in here
 * rather than let this call take a second, empty batch.
 */
function press(name?: string, rows = takeSettings()): void {
	const row =
		name === undefined
			? rows.find((setting) => setting.buttons.length > 0)
			: (rows.find((setting) => setting.name === name) ?? rows.find((setting) => setting.buttons[0]?.text === name));
	row?.buttons[0].click();
}

beforeEach(() => {
	vi.useFakeTimers();
	takeSettings();
	takeModals();
});

describe("finding the paper", () => {
	it("asks Zotero's own search, once the typing settles", async () => {
		const search = vi.fn(async () => [ITEM]);
		open({ search });
		await type("smith prompting");

		expect(search).toHaveBeenCalledWith("smith prompting");
	});

	// An empty dialog that reports nothing matched, before anything was typed, is telling the user
	// about a search they did not make.
	it("says nothing about a search nobody made", async () => {
		open();
		expect(takeSettings().map((setting) => setting.desc)).not.toContain(NO_RESULTS);
	});

	it("says so where the library has nothing like it", async () => {
		open({ search: async () => [] });
		await type("nothing at all");
		expect(takeSettings().map((setting) => setting.desc)).toContain(NO_RESULTS);
	});

	it("clears the list again when the field is emptied", async () => {
		open({ search: async () => [ITEM] });
		await type("s");
		await type("");

		const rows = takeSettings();
		expect(rows.map((setting) => setting.name)).not.toContain("Smith 2024 · Best Practices für Prompting");
		expect(rows.map((setting) => setting.desc)).not.toContain(NO_RESULTS);
	});

	// The default delay, which is what a user actually types against: a search per keystroke over a
	// library of thousands is a request the answer to which is already stale.
	it("waits for the typing to settle before it asks at all", async () => {
		const search = vi.fn(async () => [ITEM]);
		const deps: SendDialogDeps = { search, attachments: async () => [attachment()], tag: { kind: "use", tag: "#papers" } };
		askWhatToSend(asApp(new FakeApp()), deps);

		takeSettings().flatMap((setting) => setting.texts)[0].type("smith");
		await vi.advanceTimersByTimeAsync(100);
		expect(search).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(300);
		expect(search).toHaveBeenCalledWith("smith");
	});

	it("lists what it found, named the way the note names it", async () => {
		open({ search: async () => [ITEM, OTHER] });
		await type("s");
		expect(takeSettings().map((setting) => setting.name)).toContain("Smith 2024 · Best Practices für Prompting");
	});

	// ⚠️ The user is still typing while the first answer is in flight. Without the guard a slow answer
	// to "smi" replaces the list for "smith prompting" -- with results for a query that is no longer
	// in the field.
	it("never lets a slow answer to an older query replace a newer one", async () => {
		let release: (items: ZoteroItem[]) => void = () => {};
		const search = vi.fn((query: string) =>
			query === "old" ? new Promise<ZoteroItem[]>((resolve) => (release = resolve)) : Promise.resolve([OTHER]),
		);
		open({ search });

		const field = takeSettings().flatMap((setting) => setting.texts)[0];
		field.type("old");
		await vi.advanceTimersByTimeAsync(1);
		field.type("new");
		await vi.advanceTimersByTimeAsync(1);
		release([ITEM]);
		await Promise.resolve();

		expect(takeSettings().map((setting) => setting.name)).toContain("Etwas anderes");
	});
});

describe("choosing the PDF", () => {
	it("asks nothing where the item has one", async () => {
		const dialog = open();
		await type("s");
		press("Smith 2024 · Best Practices für Prompting");
		await Promise.resolve();

		expect(await dialog.choice).toEqual({ item: ITEM, attachment: attachment(), tag: "#papers" });
	});

	// A preprint beside the published version: the one the reader annotates is the one the highlights
	// go back onto, and the two do not have the same pages.
	it("asks which, where the item has two", async () => {
		const second = attachment({ key: "ATT2", filename: "preprint.pdf" });
		const dialog = open({ attachments: async () => [attachment(), second] });
		await type("s");
		press("Smith 2024 · Best Practices für Prompting");
		await Promise.resolve();

		const rows = takeSettings();
		expect(rows.map((setting) => setting.name)).toEqual(expect.arrayContaining(["paper.pdf", "preprint.pdf"]));

		press("preprint.pdf", rows);
		expect((await dialog.choice)?.attachment.key).toBe("ATT2");
	});

	it("says so for an item with nothing to send, and lets the user go back", async () => {
		open({ attachments: async () => [] });
		await type("s");
		press("Smith 2024 · Best Practices für Prompting");
		await Promise.resolve();

		const rows = takeSettings();
		expect(rows.map((setting) => setting.desc)).toContain(NO_PDF);

		press("Back", rows);
		expect(takeSettings().map((setting) => setting.name)).toContain("Search your library");
	});

	// A linked file whose path Zotero did not report has no filename at all, and a row with no name is
	// a row nobody can choose between.
	it("names a PDF with no filename by its Zotero title", async () => {
		const nameless = attachment({ key: "ATT2", filename: null, title: "Preprint" });
		open({ attachments: async () => [attachment(), nameless] });
		await type("s");
		press("Smith 2024 · Best Practices für Prompting");
		await Promise.resolve();

		expect(takeSettings().map((setting) => setting.name)).toContain("Preprint");
	});
});

describe("choosing the tag", () => {
	// §2.4: one mapped tag is not a question.
	it("is not asked where the vault maps one tag", async () => {
		const dialog = open();
		await type("s");
		press("Smith 2024 · Best Practices für Prompting");
		await Promise.resolve();

		expect((await dialog.choice)?.tag).toBe("#papers");
	});

	it("offers the mapped tags, with last time's answer selected", async () => {
		const dialog = open({ tag: { kind: "ask", options: ["#papers", "#read"], preferred: "#read" } });
		await type("s");
		press("Smith 2024 · Best Practices für Prompting");
		await Promise.resolve();

		const rows = takeSettings();
		const dropdown = rows.flatMap((setting) => setting.dropdowns)[0];
		expect(dropdown.options).toEqual({ "#papers": "#papers", "#read": "#read" });
		expect(dropdown.value).toBe("#read");

		press(undefined, rows);
		expect((await dialog.choice)?.tag).toBe("#read");
	});

	it("sends with the tag the user picked instead", async () => {
		const dialog = open({ tag: { kind: "ask", options: ["#papers", "#read"], preferred: null } });
		await type("s");
		press("Smith 2024 · Best Practices für Prompting");
		await Promise.resolve();

		const rows = takeSettings();
		rows.flatMap((setting) => setting.dropdowns)[0].pick("#read");
		press(undefined, rows);

		expect((await dialog.choice)?.tag).toBe("#read");
	});
});

describe("closing the dialog", () => {
	// The same rule `confirm-modal` follows: Escape, the background and a Cancel button are one path in
	// Obsidian, so the answer starts at "nothing" and only a choice moves it.
	it("answers nothing when it is dismissed", async () => {
		const dialog = open();
		takeModals()[0].close();
		expect(await dialog.choice).toBeNull();
	});
});
