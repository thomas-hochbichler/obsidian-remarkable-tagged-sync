import { describe, expect, it } from "vitest";
import { FakeApp, FakeEl, takeModals } from "../test-stubs/fake-obsidian";
import { FakeClock } from "../test-stubs/fake-clock";
import { ReviewModal } from "./intelligence/commands";

// The plugin-level seam of the review: the command and the callout's link are registered at load
// and reach the vault's own index. What the review does is pinned in intelligence/*.test.ts.

interface LoadedPlugin {
	commands: { id: string; callback?: () => unknown }[];
	protocolHandlers: Map<string, (params: Record<string, string>) => unknown>;
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
});
