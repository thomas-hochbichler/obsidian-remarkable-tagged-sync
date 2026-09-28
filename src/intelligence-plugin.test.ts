import { describe, expect, it } from "vitest";
import { FakeApp, FakeEl, takeModals, takeNotices, TFile } from "../test-stubs/fake-obsidian";
import { FakeClock } from "../test-stubs/fake-clock";
import { ReviewModal } from "./intelligence/commands";

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

	it("re-transcribes a page note by marking its page for the next sync", async () => {
		const plugin = await load(withPageNote);
		takeNotices();
		await plugin.reTranscribeNote(file("Work/p.md"));
		expect(plugin.data.syncIndex.seenPages!["d:p:work"].pageHash).toBeNull();
		expect(takeNotices()).toEqual(["The page is read again on the next sync, and its note updated from it."]);
	});

	it("runs Re-run extraction on the note on screen, and says why when this device does not extract", async () => {
		const plugin = await load(withPageNote);
		const rerun = plugin.commands.find((command) => command.id === "rerun-extraction")!;
		takeNotices();
		for (const path of ["Work/p.md", "Other.md"]) {
			plugin.app.workspace.activeFile = file(path);
			rerun.checkCallback!(false);
			await settle();
			await settle();
		}
		expect(takeNotices()).toEqual(["Page extraction runs on another device. Switch it to this one under Intelligence in the settings.", "This note is not a page note from the Intelligence Engine."]);

		// A vault that never had a page note has no rows to look in at all.
		const fresh = await load({});
		fresh.app.workspace.activeFile = file("Any.md");
		fresh.commands.find((command) => command.id === "rerun-extraction")!.checkCallback!(false);
		await settle();
		await settle();
		expect(takeNotices()).toEqual(["This note is not a page note from the Intelligence Engine."]);
	});
});
