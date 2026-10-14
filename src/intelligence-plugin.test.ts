import { describe, expect, it } from "vitest";
import { FakeApp, FakeEl, takeModals, takeNotices, takeSettings, TFile } from "../test-stubs/fake-obsidian";
import { FakeClock } from "../test-stubs/fake-clock";
import { ProfileChoiceModal, ReviewModal } from "./intelligence/commands";
import { NO_LICENCE } from "./licence-state";

// The plugin-level seam of the review: the command and the callout's link are registered at load
// and reach the vault's own index. What the review does is pinned in intelligence/*.test.ts.

interface LoadedPlugin {
	app: FakeApp;
	commands: { id: string; callback?: () => unknown; checkCallback?: (checking: boolean) => boolean }[];
	protocolHandlers: Map<string, (params: Record<string, string>) => unknown>;
	data: { syncIndex: { seenPages?: Record<string, { pageHash: string | null }> } };
	reTranscribeNote(file: TFile): Promise<void>;
}

async function load(saved: Record<string, unknown>): Promise<LoadedPlugin> {
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => LoadedPlugin & { saved: unknown })(new FakeApp(), { id: "tagged-sync", name: "Tagged Sync", version: "0.0.0" });
	plugin.saved = saved;
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	return plugin;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the review in the running plugin", () => {
	it("opens from the command palette and from the callout's link, on a vault that never synced and on one that did", async () => {
		const fresh = await load({});
		takeModals();
		fresh.commands.find((command) => command.id === "review-proposals")!.callback!();
		await settle();
		const synced = await load({
			syncIndex: {
				rootHash: null,
				rows: {},
				intelligenceRows: { k: { syncKey: "k", unitKey: "k", docId: "d", pageId: "p", tag: "work", scope: "notebook", notePath: "Work/p.md", folder: "Work", status: "active", noteId: "n1", profileId: "generic", baseHash: "", syncedAt: "" } },
			},
		});
		synced.protocolHandlers.get("tagged-sync-review")!({ action: "tagged-sync-review" });
		await settle();
		const modals = takeModals().filter((modal) => modal instanceof ReviewModal);
		expect(modals).toHaveLength(2);
		// No base on this device for the synced vault's note: nothing to review, said plainly.
		expect(modals.map((modal) => (modal.contentEl as unknown as FakeEl).allText())).toEqual([["Nothing to review."], ["Nothing to review."]]);
	});

	const PAGE_ROW = { syncKey: "d:p:work", unitKey: "d:p:work", docId: "d", pageId: "p", tag: "work", scope: "notebook", notePath: "Work/p.md", folder: "Work", status: "active", noteId: "n1", profileId: "generic", baseHash: "", syncedAt: "" };
	const withPageNote = { syncIndex: { rootHash: null, rows: {}, intelligenceRows: { "d:p:work": PAGE_ROW }, seenPages: { "d:p:work": { scope: "notebook", pageHash: "h", firstSeen: null, noteId: "n1" } } } };
	const file = (path: string) => Object.assign(Object.create(TFile.prototype) as TFile, { path, extension: "md", basename: path.replace(/\.md$/, "") });

	/** Counts the syncs a command starts, instead of running one against a tablet these tests do not have. */
	const counting = (plugin: LoadedPlugin) => {
		let syncs = 0;
		(plugin as unknown as { syncNow(): Promise<void> }).syncNow = async () => void syncs++;
		return () => syncs;
	};

	it("re-transcribes an insight note by marking its page and starting the sync that reads it", async () => {
		const plugin = await load(withPageNote);
		const syncs = counting(plugin);
		takeNotices();
		await plugin.reTranscribeNote(file("Work/p.md"));
		expect(plugin.data.syncIndex.seenPages!["d:p:work"].pageHash).toBeNull();
		expect(takeNotices()).toEqual(["The page is read again now, and its insight note updated from it."]);
		expect(syncs()).toBe(1);
	});

	it("re-extracts a transcript note's notebook only once insight notes are on for its tag", async () => {
		const transcript = { syncKey: "d::work", docId: "d", pageId: null, tag: "work", entryHash: "e", pageHash: null, notePath: "Work/Log.md", status: "active", syncedAt: "" };
		const plugin = await load({ ...withPageNote, syncIndex: { ...withPageNote.syncIndex, rows: { "d::work": transcript } } });
		plugin.app.workspace.activeFile = file("Work/Log.md");
		takeNotices();
		plugin.commands.find((command) => command.id === "re-extract-note")!.checkCallback!(false);
		await settle();
		// Insight notes are off for "work" in this vault, so the command says so and changes nothing.
		expect(takeNotices()).toEqual(['Insight notes are off for the tag "work". Switch them on under Tag routing first.']);
	});

	it("leaves an insight note alone while a sync runs, and stops a running sync's local server on unload", async () => {
		const plugin = await load(withPageNote);
		const internals = plugin as unknown as { syncing: boolean; runningIntelligence: { dispose(): void } | null; onunload(): void };
		internals.syncing = true;
		takeNotices();
		await plugin.reTranscribeNote(file("Work/p.md"));
		expect(plugin.data.syncIndex.seenPages!["d:p:work"].pageHash).toBe("h");
		expect(takeNotices()).toEqual(["A sync is running. Try again when it has finished."]);
		let disposed = 0;
		internals.runningIntelligence = { dispose: () => void disposed++ };
		internals.onunload();
		expect(disposed).toBe(1);
	});

	it("runs Re-extract this note on the note on screen, and says why when this device does not extract", async () => {
		const plugin = await load(withPageNote);
		const rerun = plugin.commands.find((command) => command.id === "re-extract-note")!;
		takeNotices();
		for (const path of ["Work/p.md", "Other.md"]) {
			plugin.app.workspace.activeFile = file(path);
			rerun.checkCallback!(false);
			await settle();
			await settle();
		}
		expect(takeNotices()).toEqual(["Page extraction runs on another device. Switch it to this one under Insight notes in the settings.", "This note is not a note from Tagged Sync."]);

		// A vault that never had an insight note has no rows to look in at all.
		const fresh = await load({});
		fresh.app.workspace.activeFile = file("Any.md");
		fresh.commands.find((command) => command.id === "re-extract-note")!.checkCallback!(false);
		await settle();
		await settle();
		expect(takeNotices()).toEqual(["This note is not a note from Tagged Sync."]);
	});

	it("offers Change profile with Pro and says it is Pro without", async () => {
		const trial = { ...NO_LICENCE, trialStartedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() };
		const pro = await load({ ...withPageNote, licence: trial, intelligence: { profiles: [{ id: "a", name: "A", description: "", template: null, slots: [] }] } });
		pro.app.workspace.activeFile = file("Work/p.md");
		takeModals();
		takeNotices();
		takeSettings();
		pro.commands.find((command) => command.id === "change-profile")!.checkCallback!(false);
		expect(takeModals().filter((modal) => modal instanceof ProfileChoiceModal)).toHaveLength(1);
		takeSettings().find((setting) => setting.name === "A")!.buttons[0].click();
		await settle();
		await settle();
		expect(takeNotices()).toEqual(["Page extraction runs on another device. Switch it to this one under Insight notes in the settings."]);

		const free = await load(withPageNote);
		free.app.workspace.activeFile = file("Work/p.md");
		free.commands.find((command) => command.id === "change-profile")!.checkCallback!(false);
		expect(takeNotices()).toEqual(["Changing the profile of one page is part of Tagged Sync Pro."]);
	});
});
