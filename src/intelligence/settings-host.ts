/**
 * What the Intelligence settings reach in the running plugin: the settings block, the device id, the
 * template folder and a place to create a starter template (spec §5.4, §10).
 */

import type { NoteStore } from "../note-builder";
import { localDeviceId, type HostEnvironment, type PluginFiles } from "./host";
import type { IntelligenceSettingsHost } from "./settings-section";
import type { IntelligenceSettings } from "./settings";

/**
 * Core Templates' folder (`templates.json`), else Templater's (`templates_folder` in its data), else
 * the vault root (spec §5.4). A folder spelled with a trailing slash is taken without it.
 */
export async function templateFolder(files: Pick<PluginFiles, "read">, configDir: string): Promise<string> {
	const read = async (path: string, key: string): Promise<string | null> => {
		try {
			const value = (JSON.parse((await files.read(path)) ?? "{}") as Record<string, unknown>)[key];
			return typeof value === "string" && value.trim() !== "" ? value.trim().replace(/\/+$/, "") : null;
		} catch {
			return null;
		}
	};
	return (await read(`${configDir}/templates.json`, "folder")) ?? (await read(`${configDir}/plugins/templater-obsidian/data.json`, "templates_folder")) ?? "";
}

/** `path`, or `name 2.md`, `name 3.md`… -- a starter template never writes over a note. */
export async function freeTemplatePath(noteStore: Pick<NoteStore, "exists">, path: string): Promise<string> {
	if (!(await noteStore.exists(path))) return path;
	const stem = path.replace(/\.md$/, "");
	for (let n = 2; ; n++) if (!(await noteStore.exists(`${stem} ${n}.md`))) return `${stem} ${n}.md`;
}

export interface SettingsHostInput {
	env: HostEnvironment;
	data: { intelligence: IntelligenceSettings; tagFolderMap: Record<string, string> };
	pro: boolean;
	save: () => Promise<void>;
	redraw: () => void;
	confirm: (title: string, text: string, cta: string) => Promise<boolean>;
}

export function settingsHostFor(input: SettingsHostInput): IntelligenceSettingsHost {
	const { env, data } = input;
	return {
		settings: () => data.intelligence,
		update: (next) => void (data.intelligence = next),
		tagFolderMap: () => data.tagFolderMap,
		pro: input.pro,
		saveAndRedraw: async () => {
			await input.save();
			input.redraw();
		},
		save: () => input.save(),
		deviceId: (mint) => localDeviceId(env, mint),
		confirm: input.confirm,
		templateFolder: () => templateFolder(env.files, env.configDir),
		createTemplate: async (path, content) => {
			const free = await freeTemplatePath(env.noteStore, path);
			const cut = free.lastIndexOf("/");
			if (cut !== -1) await env.noteStore.ensureFolder(free.slice(0, cut));
			await env.noteStore.write(free, content);
			return free;
		},
		readTemplate: (path) => env.readVaultNote(path),
		now: () => env.now(),
		randomId: () => env.randomId(),
	};
}
