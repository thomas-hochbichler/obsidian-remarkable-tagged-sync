import { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { FakeEl, takeModals, takeNotices, takeSettings, TFile } from "../../test-stubs/fake-obsidian";
import type { SyncIndex } from "../sync-engine";
import type { NoteStore } from "../note-builder";
import { BASE_VERSION, createBaseStore, NO_FAILURES } from "./base-store";
import { BUSY, openReview, ProfileChoiceModal, registerIntelligenceCommands, reTranscribePageNote, ReviewModal, type IntelligenceCommandsHost } from "./commands";
import type { ApplyOutcome, ReviewItem } from "./review-session";

const item = (notePath: string, label: string, source: string | null = "words"): ReviewItem => ({
	notePath,
	noteId: notePath,
	slotId: "tasks",
	proposal: { kind: "add", id: label, text: label, fields: {}, source, done: false },
	label,
	source,
});

const buttons = (el: FakeEl): FakeEl[] => [...(el.tag === "button" ? [el] : []), ...el.children.flatMap(buttons)];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function modal(items: ReviewItem[], outcome: (item: ReviewItem, accept: boolean) => ApplyOutcome | typeof BUSY = () => "applied") {
	const calls: [string, boolean][] = [];
	const m = new ReviewModal(new App() as never, items, async (it, accept) => {
		calls.push([it.label, accept]);
		return outcome(it, accept);
	});
	m.open();
	const content = m.contentEl as unknown as FakeEl;
	return { m, content, calls };
}

describe("ReviewModal", () => {
	it("says there is nothing to review", () => {
		const { content } = modal([]);
		expect(content.allText()).toEqual(["Nothing to review."]);
	});

	it("groups proposals by note and shows each with the page's words", () => {
		const { content, m } = modal([item("A.md", "Add: Call Bob"), item("A.md", "Replace the summary", null), item("B.md", "Add: Email Anna")]);
		expect((m.titleEl as unknown as FakeEl).text).toBe("Review proposals");
		expect(content.allText()).toEqual(["Accept all", "A.md", "Add: Call Bob", "On the page: “words”", "✓", "✗", "Replace the summary", "✓", "✗", "B.md", "Add: Email Anna", "On the page: “words”", "✓", "✗"]);
	});

	it("applies ✓ and ✗ per row and takes a decided row out of the list, once", async () => {
		const { content, calls } = modal([item("A.md", "one"), item("A.md", "two")]);
		const [, accept1, , , reject2] = buttons(content);
		accept1.dispatch("click");
		accept1.dispatch("click");
		await flush();
		reject2.dispatch("click");
		await flush();
		expect(calls).toEqual([
			["one", true],
			["two", false],
		]);
		expect(content.allText()).toEqual(["Accept all", "A.md"]);
	});

	it("keeps a row to decide again when a sync was running", async () => {
		let busy = true;
		const { content, calls } = modal([item("A.md", "one")], () => (busy ? BUSY : "applied"));
		const [, accept] = buttons(content);
		accept.dispatch("click");
		await flush();
		expect(content.allText()).toEqual(["Accept all", "A.md", "one", "On the page: “words”", "✓", "✗"]);
		busy = false;
		accept.dispatch("click");
		await flush();
		expect(calls).toEqual([
			["one", true],
			["one", true],
		]);
		expect(content.allText()).toEqual(["Accept all", "A.md"]);
	});

	it("accepts everything left with Accept all, and says why a row could not be written", async () => {
		const { content, calls } = modal([item("A.md", "one"), item("A.md", "two"), item("B.md", "three")], (it) => (it.label === "two" ? "no-region" : it.label === "three" ? "gone" : "stale"));
		buttons(content)[0].dispatch("click");
		await flush();
		await flush();
		expect(calls.map(([label]) => label)).toEqual(["one", "two", "three"]);
		expect(content.allText()).toEqual(["Accept all", "A.md", "This note no longer has the heading for it, so nothing was written.", "B.md", "This note or its record is gone, so nothing was written."]);
	});
});

describe("registerIntelligenceCommands", () => {
	it("registers the command and the callout's link, both opening the review over every page note", async () => {
		const files = new Map<string, string>();
		const baseStore = createBaseStore({ read: async (p) => files.get(p) ?? null, write: async (p, c) => void files.set(p, c), remove: async () => {} }, "plugin");
		await baseStore.save({
			version: BASE_VERSION,
			noteId: "n1",
			syncKey: "k",
			unitKey: "k",
			transcript: "",
			settled: [],
			extraction: { ...NO_FAILURES },
			slots: { summary: { shape: "text", heading: { level: 2, text: "Summary" }, text: "", proposals: [{ kind: "replace", id: "p", text: "Met Bob." }] } },
		});
		const notes = new Map([["Work/n1.md", "## Summary\nMine."]]);
		const noteStore: NoteStore = { read: async (p) => notes.get(p) ?? null, exists: async () => true, write: async (p, c) => void notes.set(p, c), ensureFolder: async () => {}, move: async () => {} };
		const commands: { id: string; callback?: () => unknown; checkCallback?: (checking: boolean) => boolean }[] = [];
		const handlers: Record<string, () => void> = {};
		const host: IntelligenceCommandsHost = {
			app: new App() as never,
			index: () => ({ rootHash: null, rows: {} }),
			setIndex: async () => {},
			exclusive: (work) => work(),
			rerun: async () => ({ message: "" }),
			changeProfile: async () => ({ message: "" }),
			profiles: () => [],
			pro: () => true,
			addCommand: (command) => commands.push(command as { id: string; callback?: () => unknown }),
			registerObsidianProtocolHandler: (action, handler) => void (handlers[action] = handler),
			review: () => ({
				rows: { n1: { syncKey: "k", unitKey: "k", docId: "d", pageId: "p", tag: "work", scope: "notebook", notePath: "Work/n1.md", folder: "Work", status: "active", noteId: "n1", profileId: "generic", baseHash: "", syncedAt: "" } },
				baseStore,
				noteStore,
				newId: () => "x",
			}),
		};
		registerIntelligenceCommands(host);
		expect(commands.map((c) => c.id)).toEqual(["review-proposals", "change-profile", "rerun-extraction"]);
		expect(Object.keys(handlers)).toEqual(["tagged-sync-review"]);

		const modalOpened = await openReview(host);
		const content = modalOpened.contentEl as unknown as FakeEl;
		expect(content.allText()).toContain("Replace the summary with: Met Bob.");
		buttons(content)[1].dispatch("click");
		await flush();
		await flush();
		expect(notes.get("Work/n1.md")).toBe("## Summary\nMet Bob.");
		takeModals();
		commands[0].callback!();
		handlers["tagged-sync-review"]();
		await flush();
		await flush();
		expect(takeModals().filter((m) => m instanceof ReviewModal)).toHaveLength(2);
	});
});

describe("the page-note commands", () => {
	const row = { syncKey: "d:p:work", unitKey: "d:p:work", docId: "d", pageId: "p", tag: "work", scope: "notebook" as const, notePath: "Work/p.md", folder: "Work", status: "active" as const, noteId: "n1", profileId: "generic", baseHash: "", syncedAt: "" };

	function commandHost(active: TFile | null, pro = true, syncing = false) {
		let index: SyncIndex = { rootHash: null, rows: {}, intelligenceRows: { [row.syncKey]: row }, seenPages: { [row.syncKey]: { scope: "notebook", pageHash: "h", firstSeen: null, noteId: "n1" } } };
		const commands: { id: string; checkCallback?: (checking: boolean) => boolean }[] = [];
		const reran: string[] = [];
		const app = new App() as unknown as { workspace: { getActiveFile: () => TFile | null } };
		app.workspace.getActiveFile = () => active;
		const host: IntelligenceCommandsHost = {
			app: app as never,
			addCommand: (command) => commands.push(command as { id: string }),
			registerObsidianProtocolHandler: () => {},
			review: () => ({ rows: {}, baseStore: createBaseStore({ read: async () => null, write: async () => {}, remove: async () => {} }, "p"), noteStore: {} as NoteStore, newId: () => "x" }),
			index: () => index,
			setIndex: async (next) => void (index = next),
			exclusive: async (work) => (syncing ? BUSY : work()),
			rerun: async (path) => (reran.push(path), { message: "Extracted again; the note is updated.", index: { ...index, rootHash: "rerun" } }),
			changeProfile: async (path, id) => (reran.push(`${path}->${id}`), { message: "The note is made again." }),
			profiles: () => [
				{ id: "a", name: "A", description: "Meetings" },
				{ id: "b", name: "B", description: "Journal" },
			],
			pro: () => pro,
		};
		registerIntelligenceCommands(host);
		return { host, rerunCommand: commands.find((c) => c.id === "rerun-extraction")!, changeCommand: commands.find((c) => c.id === "change-profile")!, reran, index: () => index };
	}
	const file = (path: string, extension = "md") => Object.assign(Object.create(TFile.prototype) as TFile, { path, extension });

	it("offers Re-run extraction on a Markdown note only, and runs it on the one on screen, saying what happened", async () => {
		expect(commandHost(null).rerunCommand.checkCallback!(true)).toBe(false);
		expect(commandHost(file("a.pdf", "pdf")).rerunCommand.checkCallback!(true)).toBe(false);
		const { rerunCommand, reran, index } = commandHost(file("Work/p.md"));
		takeNotices();
		expect(rerunCommand.checkCallback!(true)).toBe(true);
		expect(reran).toEqual([]);
		rerunCommand.checkCallback!(false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(reran).toEqual(["Work/p.md"]);
		expect(index().rootHash).toBe("rerun");
		expect(takeNotices()).toEqual(["Extracted again; the note is updated."]);
	});

	it("marks a page note for reading on the next sync when it is re-transcribed, and leaves any other note to the transcript command", async () => {
		const { host, index } = commandHost(null);
		takeNotices();
		expect(await reTranscribePageNote(host, "Other.md")).toBe(false);
		expect(await reTranscribePageNote(host, "Work/p.md")).toBe(true);
		expect(index().seenPages!["d:p:work"].pageHash).toBeNull();
		expect(takeNotices()).toEqual(["The page is read again on the next sync, and its note updated from it."]);
	});

	it("changes a page note's Profile through a choice of Profiles, and says it is Pro without it", async () => {
		expect(commandHost(null).changeCommand.checkCallback!(true)).toBe(false);
		const { changeCommand, reran } = commandHost(file("Work/p.md"));
		expect(changeCommand.checkCallback!(true)).toBe(true);
		takeModals();
		takeNotices();
		takeSettings();
		changeCommand.checkCallback!(false);
		const [chooser] = takeModals();
		expect((chooser.titleEl as unknown as FakeEl).text).toBe("Change profile for this page");
		// A row per Profile, named and described; the page has the generic one, which is said above them.
		expect((chooser.contentEl as unknown as FakeEl).allText()).toContain("This page has the generic profile now.");
		const rows = takeSettings();
		expect(rows.map((r) => [r.name, r.desc, r.buttons[0].text])).toEqual([
			["A", "Meetings", "Use"],
			["B", "Journal", "Use"],
		]);
		rows[0].buttons[0].click();
		await flush();
		expect(reran).toEqual(["Work/p.md->a"]);
		expect(takeNotices()).toEqual(["The note is made again."]);
		commandHost(file("Work/p.md"), false).changeCommand.checkCallback!(false);
		expect(takeNotices()).toEqual(["Changing the profile of one page is part of Tagged Sync Pro."]);
	});

	it("does nothing to the index or the note while a sync runs", async () => {
		const { rerunCommand, changeCommand, reran, index, host } = commandHost(file("Work/p.md"), true, true);
		const before = index();
		rerunCommand.checkCallback!(false);
		changeCommand.checkCallback!(false);
		takeSettings().at(-1)!.buttons[0].click();
		expect(await reTranscribePageNote(host, "Work/p.md")).toBe(true);
		await flush();
		expect(reran).toEqual([]);
		expect(index()).toBe(before);
	});

	it("offers no choice on a note that is no longer a page note, such as one kept beside a new one", () => {
		const { changeCommand } = commandHost(file("Work/kept.md"));
		takeModals();
		takeNotices();
		changeCommand.checkCallback!(false);
		expect(takeModals()).toEqual([]);
		expect(takeNotices()).toEqual(["This note is not a page note from the Intelligence Engine."]);
	});

	it("says when the profile the page was made with no longer exists", () => {
		const modal = new ProfileChoiceModal(new App() as never, [{ id: "a", name: "A", description: "" }], "gone", () => undefined);
		modal.open();
		const text = (modal.contentEl as unknown as FakeEl).allText();
		expect(text).toContain("The profile this page was made with no longer exists.");
		expect(text).not.toContain("This page has the generic profile now.");
	});

	it("marks the Profile the page has now, and offers it no button to choose it again", () => {
		takeSettings();
		const modal = new ProfileChoiceModal(new App() as never, [{ id: "a", name: "A", description: "" }, { id: "b", name: "B", description: "" }], "b", () => undefined);
		modal.open();
		expect((modal.contentEl as unknown as FakeEl).allText()).not.toContain("This page has the generic profile now.");
		expect(takeSettings().map((r) => [r.name, r.buttons[0].text, r.buttons[0].disabled])).toEqual([
			["A", "Use", false],
			["B", "Current", true],
		]);
	});

	it("says there is no Profile yet when there is none to choose", () => {
		const modal = new ProfileChoiceModal(new App() as never, [], "generic", () => undefined);
		modal.open();
		expect((modal.contentEl as unknown as FakeEl).allText()).toEqual(["There is no profile yet. Add one in the plugin settings."]);
	});
});
