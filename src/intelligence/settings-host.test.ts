import { describe, expect, it } from "vitest";
import type { NoteStore } from "../note-builder";
import type { HostEnvironment } from "./host";
import { registerOcrBackend } from "../ocr-registry";
import type { SignDef } from "../signs";
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

// A reader that keeps no signs, and one that keeps them -- the registry is the host's only source.
registerOcrBackend({ id: "host-plain-text", label: "Plain text", metered: false, requiresLicence: false, needsBackgroundConsent: false, create: () => null, dropsSigns: (settings) => (settings.small ? "Small model" : null) });
registerOcrBackend({ id: "host-keeps-signs", label: "Keeps signs", metered: false, requiresLicence: false, needsBackgroundConsent: false, create: () => null });

describe("settingsHostFor", () => {
	// Ticket 43: said under the Insight notes toggle, so only when there are signs to lose.
	it("names the transcription backend that drops the user's signs, asking it with its own settings", () => {
		const dropsSigns = (ocrBackend: string, signs: SignDef[], small: boolean | null = true) =>
			settingsHostFor({
				env: {} as HostEnvironment,
				data: { intelligence: emptyIntelligence(), tagFolderMap: {}, ocrBackend, llmProviders: small === null ? {} : { [ocrBackend]: { small } }, signs },
				pro: false,
				save: async () => {},
				redraw: () => {},
				confirm: async () => true,
				dialog: () => undefined,
			}).dropsSigns();
		const bujo = [{ glyph: "•", meaning: "task-open" as const }];
		expect(dropsSigns("host-plain-text", bujo)).toBe("Small model");
		expect(dropsSigns("host-plain-text", bujo, false)).toBeNull();
		expect(dropsSigns("host-plain-text", bujo, null)).toBeNull();
		expect(dropsSigns("host-plain-text", [])).toBeNull();
		expect(dropsSigns("host-keeps-signs", bujo)).toBeNull();
		expect(dropsSigns("not-in-this-build", bujo)).toBeNull();
	});

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
		const data = { intelligence: emptyIntelligence(), tagFolderMap: { work: "Work" }, ocrBackend: "lmstudio", llmProviders: { lmstudio: { model: "m" } }, signs: [] };
		const log: string[] = [];
		const host = settingsHostFor({ env, data, pro: true, save: async () => void log.push("save"), redraw: () => void log.push("redraw"), confirm: async () => true, dialog: () => undefined });

		host.update({ ...host.settings(), model: "m" });
		expect(data.intelligence.model).toBe("m");
		expect(host.tagFolderMap()).toEqual({ work: "Work" });
		// No signs set, nothing to lose -- and the server keeps them anyway.
		expect(host.dropsSigns()).toBeNull();
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
		expect([host.transcriptionBackend(), host.providerSettings("lmstudio"), host.providerSettings("ollama")]).toEqual(["lmstudio", { model: "m" }, {}]);
	});
});
