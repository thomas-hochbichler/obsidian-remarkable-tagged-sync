import { App } from "obsidian";
import { describe, expect, it } from "vitest";
import { FakeEl, takeModals, takeNotices, TFile } from "../../test-stubs/fake-obsidian";
import type { SyncIndex } from "../sync-engine";
import type { NoteStore } from "../note-builder";
import { BASE_VERSION, createBaseStore, NO_FAILURES } from "./base-store";
import { openReview, registerIntelligenceCommands, reTranscribePageNote, ReviewModal, type IntelligenceCommandsHost } from "./commands";
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

function modal(items: ReviewItem[], outcome: (item: ReviewItem, accept: boolean) => ApplyOutcome = () => "applied") {
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
			rerun: async () => ({ message: "" }),
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
		expect(commands.map((c) => c.id)).toEqual(["review-proposals", "rerun-extraction"]);
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

	function commandHost(active: TFile | null) {
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
			rerun: async (path) => (reran.push(path), { message: "Extracted again; the note is updated.", index: { ...index, rootHash: "rerun" } }),
		};
		registerIntelligenceCommands(host);
		return { host, rerunCommand: commands.find((c) => c.id === "rerun-extraction")!, reran, index: () => index };
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
});
