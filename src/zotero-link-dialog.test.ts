import { beforeEach, describe, expect, it, vi } from "vitest";
import { asApp, FakeApp, takeModals, takeSettings } from "../test-stubs/fake-obsidian";
import type { ZoteroAttachment, ZoteroItem } from "./zotero-client";
import { askWhichAttachment, askWhichPdf, askZoteroItem, EVIDENCE, ITEM_HAS_NO_PDF, NOTHING_FOUND } from "./zotero-link-dialog";
import type { ZoteroQuestion } from "./zotero-sync";

const ITEM: ZoteroItem = { key: "ITEM1", library: "user", title: "Best Practices für Prompting", creator: "Smith", year: "2024", citationKey: null };
const OTHER: ZoteroItem = { key: "ITEM2", library: "user", title: "Etwas anderes", creator: null, year: null, citationKey: null };

function attachment(overrides: Partial<ZoteroAttachment> = {}): ZoteroAttachment {
	return { key: "ATT1", library: "user", parentKey: "ITEM1", filename: "prompting.pdf", md5: null, title: "Full Text PDF", ...overrides };
}

function question(overrides: Partial<ZoteroQuestion> = {}): ZoteroQuestion {
	return {
		visibleName: "Best Practices für Prompting",
		evidence: "hash",
		candidates: [
			{ attachment: attachment(), item: ITEM },
			{ attachment: attachment({ key: "ATT2", parentKey: "ITEM2" }), item: OTHER },
		],
		...overrides,
	};
}

/** Types into the dialog's one text field and lets the debounced search run. */
async function type(text: string, rows = takeSettings()): Promise<void> {
	rows.flatMap((setting) => setting.texts)[0].type(text);
	await vi.advanceTimersByTimeAsync(1);
	await Promise.resolve();
}

/** Presses, then lets the async step behind the press (a listing, a search) finish rendering. */
async function pressAndSettle(name?: string, rows = takeSettings()): Promise<void> {
	press(name, rows);
	await vi.advanceTimersByTimeAsync(1);
}

/**
 * Presses the button of the row whose name is `name`, or the first button there is.
 *
 * ⚠️ `takeSettings()` *drains* the log, so a test that reads the rows first has to hand them in here.
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

describe("the sync's picker", () => {
	it("says why these are being offered, in the words of the row that offered them", async () => {
		const answer = askWhichAttachment(asApp(new FakeApp()), question({ evidence: "filename" }));
		const rows = takeSettings();

		expect(rows[0].desc).toBe(EVIDENCE.filename);
		press("None of these", rows);
		expect(await answer).toBeNull();
	});

	it("names the paper and the file, because two PDFs of one item differ in nothing else", async () => {
		const answer = askWhichAttachment(asApp(new FakeApp()), question());
		const rows = takeSettings();

		expect(rows.map((row) => row.name).filter((name) => name !== "")).toEqual(["Smith 2024 · Best Practices für Prompting", "Etwas anderes"]);
		expect(rows[1].desc).toBe("prompting.pdf");
		press(undefined, rows);
		expect(await answer).toEqual(attachment());
	});

	it("answers nothing when it is closed rather than answered", async () => {
		const answer = askWhichAttachment(asApp(new FakeApp()), question());
		takeModals()[0].close();

		expect(await answer).toBeNull();
	});

	it("falls back to the file's own title where the candidate hangs under no item", async () => {
		const standalone = question({ candidates: [{ attachment: attachment({ parentKey: null, filename: null }), item: null }] });
		const answer = askWhichAttachment(asApp(new FakeApp()), standalone);
		const rows = takeSettings();

		expect(rows[1].name).toBe("Full Text PDF");
		expect(rows[1].desc).toBe("Full Text PDF");
		press(undefined, rows);
		await answer;
	});
});

describe("the context action's PDF question", () => {
	it("offers the item's own PDFs under the paper's name", async () => {
		const options = [attachment(), attachment({ key: "ATT2", filename: "preprint.pdf" })];
		const answer = askWhichPdf(asApp(new FakeApp()), ITEM, options);
		const rows = takeSettings();

		expect(rows[0].desc).toBe("Which PDF is the one on your tablet?");
		expect(rows.map((row) => row.desc)).toContain("preprint.pdf");
		press(undefined, rows);
		expect(await answer).toEqual(attachment());
	});
});

describe("the Link to Zotero item… command", () => {
	function open(overrides: { search?: (query: string) => Promise<ZoteroItem[]>; attachments?: () => Promise<ZoteroAttachment[]> } = {}) {
		return askZoteroItem(asApp(new FakeApp()), {
			search: overrides.search ?? (async () => [ITEM]),
			attachments: overrides.attachments ?? (async () => [attachment()]),
			searchDelayMs: 0,
		});
	}

	it("asks Zotero's own search once the typing settles", async () => {
		const search = vi.fn(async () => [ITEM]);
		const answer = open({ search });
		await type("smith prompting");

		expect(search).toHaveBeenCalledWith("smith prompting");
		takeModals()[0].close();
		await answer;
	});

	it("links straight to the one PDF an item has, without a second question", async () => {
		const answer = open();
		await type("smith");
		await pressAndSettle("Smith 2024 · Best Practices für Prompting");

		expect(await answer).toEqual(attachment());
	});

	it("asks which PDF where the item has more than one", async () => {
		const answer = open({ attachments: async () => [attachment(), attachment({ key: "ATT2", filename: "preprint.pdf" })] });
		await type("smith");
		await pressAndSettle("Smith 2024 · Best Practices für Prompting");
		const rows = takeSettings();

		expect(rows[0].desc).toBe("Which PDF is the one on your tablet?");
		press(undefined, rows);
		expect(await answer).toEqual(attachment());
	});

	it("says so where the item has no PDF at all, and goes back rather than dead-ending", async () => {
		const answer = open({ attachments: async () => [] });
		await type("smith");
		await pressAndSettle("Smith 2024 · Best Practices für Prompting");
		const rows = takeSettings();

		expect(rows[0].desc).toBe(ITEM_HAS_NO_PDF);
		press("Back", rows);
		expect(takeSettings()[0].name).toBe("Search your library");
		takeModals()[0].close();
		expect(await answer).toBeNull();
	});

	it("says nothing matched only once a search has come back", async () => {
		const answer = open({ search: async () => [] });
		const before = takeSettings();
		expect(before.some((row) => row.desc === NOTHING_FOUND)).toBe(false);

		await type("nichts", before);

		expect(takeSettings().some((row) => row.desc === NOTHING_FOUND)).toBe(true);
		takeModals()[0].close();
		await answer;
	});

	it("clears the list when the field is cleared, rather than reporting an empty search", async () => {
		const answer = open();
		await type("smith");
		await type("");

		const rows = takeSettings();
		expect(rows.some((row) => row.desc === NOTHING_FOUND)).toBe(false);
		expect(rows.filter((row) => row.buttons.length > 0)).toEqual([]);
		takeModals()[0].close();
		await answer;
	});

	it("lets a slow answer to an old query be overtaken rather than replace a newer one", async () => {
		const search = vi.fn(async (query: string) => {
			await new Promise((resolve) => setTimeout(resolve, query === "smith" ? 50 : 0));
			return query === "smith" ? [ITEM] : [OTHER];
		});
		const answer = askZoteroItem(asApp(new FakeApp()), { search, attachments: async () => [attachment()], searchDelayMs: 0 });

		const field = takeSettings().flatMap((setting) => setting.texts)[0];
		field.type("smith");
		// Far enough for the first search to have *started* and not yet answered, so the second one is
		// a real second search rather than the same one debounced.
		await vi.advanceTimersByTimeAsync(1);
		field.type("etwas");
		await vi.advanceTimersByTimeAsync(1);
		takeSettings();
		// And now the slow one lands, naming a query the user has typed past.
		await vi.advanceTimersByTimeAsync(60);

		expect(takeSettings()).toEqual([]);
		takeModals()[0].close();
		await answer;
	});
});

describe("group libraries (ticket 26)", () => {
	// The same file in the personal library and in a group is told apart by nothing but the library.
	it("names the library after the file where the candidates come from more than one", async () => {
		const named = question({
			candidates: [
				{ attachment: attachment(), item: ITEM, library: "your library" },
				{ attachment: attachment({ library: { group: 4711 } }), item: ITEM, library: "Lab reading group" },
			],
		});
		const answer = askWhichAttachment(asApp(new FakeApp()), named);
		const rows = takeSettings();

		expect(rows[1].desc).toBe("prompting.pdf · your library");
		expect(rows[2].desc).toBe("prompting.pdf · Lab reading group");
		press("None of these", rows);
		await answer;
	});
});
