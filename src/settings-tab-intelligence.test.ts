import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../test-stubs/fake-clock";
import { createFragment, FakeApp, type FakeEl, type Setting, takeModals, takeNotices, takeSettings } from "../test-stubs/fake-obsidian";
import { NO_LICENCE } from "./licence-state";

vi.stubGlobal("createFragment", createFragment);

// The Intelligence section inside the real settings tab: that its controls reach `data.json`, the
// plugin folder and the confirmation dialog. What each control does is pinned in
// intelligence/settings-section.test.ts.

interface Plugin {
	data: { intelligence: { backend: string | null; model: string | null; engineDeviceId: string | null } };
	saves: unknown[];
	saved: unknown;
	settingTabs: { containerEl: FakeEl; display(): void }[];
}

async function tab(saved: Record<string, unknown> = {}) {
	const app = new FakeApp();
	const { default: TaggedSyncPlugin } = await import("./entry");
	const plugin = new (TaggedSyncPlugin as unknown as new (a: unknown, m: unknown) => Plugin)(app, { id: "tagged-sync", name: "Tagged Sync", version: "9.9.9" });
	plugin.saved = { ocrBackend: "off", licence: { ...NO_LICENCE }, ...saved };
	(plugin as unknown as { scheduler: FakeClock }).scheduler = new FakeClock();
	await (plugin as unknown as { onload(): Promise<void> }).onload();
	takeNotices();
	const draw = (): Setting[] => {
		takeSettings();
		plugin.settingTabs[0].display();
		return takeSettings();
	};
	return { app, plugin, draw };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const named = (settings: Setting[], name: string) => settings.find((s) => s.name === name)!;

describe("the Intelligence section in the settings tab", () => {
	it("saves a typed model without redrawing, and a picked backend with a redraw", async () => {
		const { plugin, draw } = await tab();
		named(draw(), "Extraction model").texts[0].type("my-model");
		await flush();
		expect(plugin.data.intelligence.model).toBe("my-model");
		const saves = plugin.saves.length;
		named(draw(), "Extraction backend").dropdowns[0].pick("");
		await flush();
		expect(plugin.saves.length).toBe(saves + 1);
	});

	it("asks before moving the engine from another device, with this device's id kept in the plugin folder", async () => {
		const { app, plugin, draw } = await tab({ intelligence: { engineDeviceId: "other-device" } });
		takeModals();
		const device = named(draw(), "Run page extraction on this device").toggles[0];
		// Clicked once the tab has read this device's id, as a user does: the switch listens from then on.
		await flush();
		device.toggle(true);
		await flush();
		const [dialog] = takeModals();
		expect((dialog.titleEl as unknown as FakeEl).text).toBe("Run the engine here");
		dialog.close();
		await flush();
		expect(plugin.data.intelligence.engineDeviceId).toBe("other-device");
		expect([...app.vault.adapterFiles.keys()]).toEqual([".obsidian/plugins/tagged-sync/device-id"]);
	});
});
