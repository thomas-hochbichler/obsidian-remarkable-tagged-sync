import { describe, expect, it } from "vitest";
import type { NoteStore } from "../note-builder";
import type { HostEnvironment } from "./host";
import { emptyIntelligence } from "./settings";
import { freeTemplatePath, settingsHostFor, templateFolder } from "./settings-host";

const reader = (files: Record<string, string>) => ({ read: async (path: string) => files[path] ?? null });

describe("templateFolder", () => {
	it("takes core Templates' folder, else Templater's, else the vault root", async () => {
		expect(await templateFolder(reader({ ".obsidian/templates.json": JSON.stringify({ folder: "Templates/" }) }), ".obsidian")).toBe("Templates");
		expect(await templateFolder(reader({ ".obsidian/templates.json": JSON.stringify({ folder: " " }), ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({ templates_folder: "Tpl" }) }), ".obsidian")).toBe("Tpl");
		expect(await templateFolder(reader({ ".obsidian/templates.json": "{broken", ".obsidian/plugins/templater-obsidian/data.json": JSON.stringify({ templates_folder: 3 }) }), ".obsidian")).toBe("");
	});
});

describe("freeTemplatePath", () => {
	it("never writes over a note", async () => {
		const taken = new Set(["T/My pages.md", "T/My pages 2.md"]);
		expect(await freeTemplatePath({ exists: async (p) => taken.has(p) }, "T/My pages.md")).toBe("T/My pages 3.md");
		expect(await freeTemplatePath({ exists: async () => false }, "T/Other.md")).toBe("T/Other.md");
	});
});

describe("settingsHostFor", () => {
	it("reads and writes the settings block, saves with and without a redraw, and creates a template in its folder", async () => {
		const written: string[] = [];
		const folders: string[] = [];
		const noteStore: NoteStore = { read: async () => null, exists: async () => false, write: async (p, c) => void written.push(`${p}=${c}`), ensureFolder: async (p) => void folders.push(p), move: async () => {} };
		const files: Record<string, string> = { "plugin/device-id": "dev" };
		const env: HostEnvironment = {
			pluginDir: "plugin",
			files: { read: async (p) => files[p] ?? null, write: async (p, c) => void (files[p] = c), remove: async () => {}, mkdir: async () => {} },
			noteStore,
			readVaultNote: async () => null,
			createNote: async () => {},
			configDir: ".obsidian",
			formatNow: () => "",
			randomId: () => "rid",
			now: () => new Date("2026-09-28T00:00:00.000Z"),
		};
		const data = { intelligence: emptyIntelligence(), tagFolderMap: { work: "Work" } };
		const log: string[] = [];
		const host = settingsHostFor({ env, data, pro: true, save: async () => void log.push("save"), redraw: () => void log.push("redraw"), confirm: async () => true });

		host.update({ ...host.settings(), model: "m" });
		expect(data.intelligence.model).toBe("m");
		expect(host.tagFolderMap()).toEqual({ work: "Work" });
		await host.save();
		await host.saveAndRedraw();
		expect(log).toEqual(["save", "save", "redraw"]);
		expect(await host.deviceId(false)).toBe("dev");
		expect(await host.confirm("t", "x", "ok")).toBe(true);
		expect(await host.templateFolder()).toBe("");
		expect(await host.createTemplate("Templates/My pages.md", "## Tasks")).toBe("Templates/My pages.md");
		expect(await host.createTemplate("Root.md", "x")).toBe("Root.md");
		expect(folders).toEqual(["Templates"]);
		expect(written).toEqual(["Templates/My pages.md=## Tasks", "Root.md=x"]);
		expect([host.pro, host.now().toISOString(), host.randomId()]).toEqual([true, "2026-09-28T00:00:00.000Z", "rid"]);
		expect(await host.readTemplate("T.md")).toBeNull();
	});
});
