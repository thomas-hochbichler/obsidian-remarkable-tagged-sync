/**
 * The engine's footing in the running plugin: the plugin folder for bases and the device id, the
 * vault for templates and new notes, and the per-run decisions of `plugin-rules.ts`. Everything
 * Obsidian-shaped arrives through {@link HostEnvironment}, so this is testable without the app.
 */

import { normalizePath, TFile } from "obsidian";
import type { NoteStore } from "../note-builder";
import type { BackendSettings } from "../ocr-registry";
import type { IntelligenceHook } from "../sync-engine";
import { type BaseFiles, type BaseStore, createBaseStore } from "./base-store";
import { extractionBackendEntry } from "./extraction-registry";
import { backgroundExtractionAllowed, chooseExtractionBackend, effectiveModes, effectiveSlotsFor, isEngineDevice, scansDue } from "./plugin-rules";
import { intelligenceFingerprint, type IntelligenceSettings } from "./settings";
import { completeScans, followRetargets, type IntelligencePassDeps, type IntelligenceRow, type PassReport, processDocument } from "./sync-pass";

/** A plain file API over the plugin folder: `vault.adapter` in the app. */
export interface PluginFiles {
	read(path: string): Promise<string | null>;
	write(path: string, content: string): Promise<void>;
	remove(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

export interface HostEnvironment {
	/** `manifest.dir`: bases and the device id live below it, never in the synced `data.json`. */
	pluginDir: string;
	files: PluginFiles;
	noteStore: NoteStore;
	/** A vault note's text, or null when there is none at that path. */
	readVaultNote(path: string): Promise<string | null>;
	/** Creates a note in one call -- through Templater when it is installed (spec §5.4). */
	createNote(path: string, content: string): Promise<void>;
	/** The vault's config folder, where core Templates keeps its date and time formats. */
	configDir: string;
	/** Now, in a moment.js format -- `moment().format` in the app. */
	formatNow(format: string): string;
	randomId(): string;
	now(): Date;
}

export const REVIEW_ACTION = "tagged-sync-review";
export const REVIEW_LINK = `obsidian://${REVIEW_ACTION}`;

const deviceIdPath = (env: HostEnvironment) => `${env.pluginDir}/device-id`;

/**
 * This install's device id, minted on first use. A file in the plugin folder rather than
 * `localStorage` (Obsidian 1.8.7+, above this plugin's floor): the folder is not synced, and a
 * reinstall starts it fresh -- which spec §9 wants, since the bases went with it.
 */
export async function localDeviceId(env: HostEnvironment, mint: boolean): Promise<string | null> {
	const stored = (await env.files.read(deviceIdPath(env)))?.trim();
	if (stored) return stored;
	if (!mint) return null;
	const id = env.randomId();
	await env.files.write(deviceIdPath(env), id);
	return id;
}

function baseFiles(env: HostEnvironment): BaseFiles {
	let made = false;
	return {
		read: (path) => env.files.read(path),
		remove: (path) => env.files.remove(path),
		write: async (path, content) => {
			if (!made) await env.files.mkdir(`${env.pluginDir}/base`);
			made = true;
			await env.files.write(path, content);
		},
	};
}

export interface RunInputs {
	settings: IntelligenceSettings;
	tagFolderMap: Record<string, string>;
	pro: boolean;
	/** The OCR backend id the run transcribes with. */
	transcriptionBackend: string;
	/** `llmProviders`: a provider's key and URL, shared with transcription. */
	providerSettings: Record<string, BackendSettings>;
	/** A background sync: extraction runs only with its consent, and waits silently without it. */
	background: boolean;
}

export interface IntelligenceRun {
	/** The per-tag modes for `TagRouter`, on every device. */
	modes: ReturnType<typeof effectiveModes>;
	/** The modes print for the level-1 gate, on every device. */
	fingerprint: string;
	/** The engine, on the engine device with a backend; absent otherwise. */
	hook: IntelligenceHook | undefined;
	/** Why the engine will not run although a tag asks for it; said once per run. */
	paused: string | null;
	/** What the hook runs on; present exactly when `hook` is, for a run over a single note. */
	deps?: IntelligencePassDeps;
	/** Releases what the run's backend holds -- the local model's server. Called when the sync ends, however it ends. */
	dispose(): void;
}

const NOTHING_HELD = () => {};

/** What a review reads and writes, from the environment of the running app. */
export function reviewStoresFor(env: HostEnvironment, rows: Record<string, IntelligenceRow>): { rows: Record<string, IntelligenceRow>; baseStore: BaseStore; noteStore: NoteStore; newId: () => string } {
	return { rows, baseStore: createBaseStore(baseFiles(env), env.pluginDir), noteStore: env.noteStore, newId: () => env.randomId().slice(0, 8) };
}

/** The template's own `{{date:FORMAT}}`, else core Templates' setting, else Obsidian's default. */
const firstFormat = (own: string | null, core: string | null, fallback: string) => own ?? core ?? fallback;

/** Everything one sync needs from the engine side, decided once at its start. */
export async function prepareRun(env: HostEnvironment, input: RunInputs): Promise<IntelligenceRun> {
	const modes = effectiveModes(input.settings, input.tagFolderMap, input.pro);
	const fingerprint = intelligenceFingerprint(input.settings.mappings);
	const wanted = Object.keys(input.tagFolderMap).some((tag) => modes(tag).intelligence);
	if (!wanted || !isEngineDevice(input.settings, await localDeviceId(env, false))) return { modes, fingerprint, hook: undefined, paused: null, dispose: NOTHING_HELD };

	const choice = chooseExtractionBackend({ settings: input.settings, transcriptionBackend: input.transcriptionBackend, pro: input.pro, lookup: extractionBackendEntry });
	if (input.background && choice.kind === "ready" && !backgroundExtractionAllowed(choice.entry, input.settings)) return { modes, fingerprint, hook: undefined, paused: null, dispose: NOTHING_HELD };
	const backend = choice.kind === "ready" ? choice.entry.create(input.providerSettings[choice.entry.id] ?? {}, input.settings.model) : null;
	if (backend === null) {
		const reason = choice.kind === "paused" ? choice.reason : `The extraction backend ${choice.entry.label} is not set up yet: it needs its key or address. The engine is paused.`;
		return { modes, fingerprint, hook: undefined, paused: reason, dispose: NOTHING_HELD };
	}

	const formats = await coreTemplateFormats(env.files, env.configDir);
	// Without Pro, only the free tag keeps page notes: the run sees the others as off, so it neither
	// extracts nor re-runs them (spec §11). Their configuration stays untouched in `data.json`.
	const runSettings: IntelligenceSettings = {
		...input.settings,
		mappings: Object.fromEntries(Object.entries(input.settings.mappings).map(([tag, m]) => [tag, { ...m, intelligence: modes(tag).intelligence }])),
	};
	const deps: IntelligencePassDeps = {
		settings: runSettings,
		tagFolderMap: input.tagFolderMap,
		effectiveSlots: effectiveSlotsFor(input.pro),
		pro: input.pro,
		noteStore: env.noteStore,
		baseStore: createBaseStore(baseFiles(env), env.pluginDir),
		backend,
		loadTemplate: (path: string) => env.readVaultNote(path),
		createNote: (path: string, content: string) => env.createNote(path, content),
		now: () => env.now(),
		newId: () => env.randomId().slice(0, 8),
		newNoteId: () => env.randomId(),
		formatDate: (format: string | null) => env.formatNow(firstFormat(format, formats.date, "YYYY-MM-DD")),
		formatTime: (format: string | null) => env.formatNow(firstFormat(format, formats.time, "HH:mm")),
		reviewLink: REVIEW_LINK,
	};
	const hook: IntelligenceHook = {
		fingerprint,
		scansDue: (scanned) => scansDue(input.settings, input.tagFolderMap, input.pro, scanned),
		process: (doc, state) => processDocument(deps, doc, state),
		completeScans: (state) => completeScans(input.settings, input.tagFolderMap, Object.keys(input.tagFolderMap).filter((tag) => modes(tag).intelligence), state),
		beforeRun: async (state) => void (await followRetargets(state, input.tagFolderMap, env.noteStore)),
	};
	return { modes, fingerprint, hook, paused: null, deps, dispose: () => backend.dispose?.() };
}

/** The slice of `vault.adapter` the host needs. */
export interface AdapterLike {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	remove(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
}

/** The plugin folder through `vault.adapter`: absent reads as null, removing or making twice is harmless. */
export function adapterFiles(adapter: AdapterLike): PluginFiles {
	return {
		read: async (path) => ((await adapter.exists(path)) ? adapter.read(path) : null),
		write: (path, content) => adapter.write(path, content),
		remove: async (path) => {
			if (await adapter.exists(path)) await adapter.remove(path);
		},
		mkdir: async (path) => {
			if (!(await adapter.exists(path))) await adapter.mkdir(path);
		},
	};
}

/** The one Templater call the engine makes (spec §5.4). */
export interface TemplaterApi {
	create_new_note_from_template(template: string, folder: string, filename: string, openNewNote: boolean): Promise<unknown>;
}

/** Templater's API object when that plugin is installed and enabled; it is not in Obsidian's typings. */
export function templaterOf(app: unknown): TemplaterApi | null {
	const templater = (app as { plugins?: { plugins?: Record<string, { templater?: Partial<TemplaterApi> } | undefined> } }).plugins?.plugins?.["templater-obsidian"]?.templater;
	return typeof templater?.create_new_note_from_template === "function" ? (templater as TemplaterApi) : null;
}

/**
 * Creates a note in one call, never an empty file first: through Templater when it is there, so its
 * own syntax in the user's template runs; else the vault's `create`. A Templater that throws falls
 * back to `create` -- the page note matters more than the template's scripting.
 */
export function noteCreator(templater: TemplaterApi | null, create: (path: string, content: string) => Promise<unknown>): (path: string, content: string) => Promise<void> {
	return async (path, content) => {
		if (templater !== null) {
			const cut = path.lastIndexOf("/");
			try {
				await templater.create_new_note_from_template(content, cut === -1 ? "" : path.slice(0, cut), path.slice(cut + 1).replace(/\.md$/, ""), false);
				return;
			} catch (error) {
				console.warn("Tagged Sync: Templater could not create the page note, writing it plainly", error);
			}
		}
		await create(path, content);
	};
}

/** Core Templates' `dateFormat` / `timeFormat`, which `{{date}}` and `{{time}}` follow when set (spec §4). */
export async function coreTemplateFormats(files: Pick<PluginFiles, "read">, configDir: string): Promise<{ date: string | null; time: string | null }> {
	try {
		const raw = JSON.parse((await files.read(`${configDir}/templates.json`)) ?? "{}") as { dateFormat?: unknown; timeFormat?: unknown };
		return { date: typeof raw.dateFormat === "string" && raw.dateFormat !== "" ? raw.dateFormat : null, time: typeof raw.timeFormat === "string" && raw.timeFormat !== "" ? raw.timeFormat : null };
	} catch {
		return { date: null, time: null };
	}
}

/** What the user hears from the engine after a run: a pause, what it could not do, and pending proposals (spec §8, §9). */
export function intelligenceNotices(paused: string | null, report: PassReport): string[] {
	const lines = [...(paused === null ? [] : [paused]), ...report.notices];
	if (report.proposals > 0) {
		const proposals = `${report.proposals} ${report.proposals === 1 ? "proposal" : "proposals"}`;
		const notes = `${report.proposalNotes} ${report.proposalNotes === 1 ? "note" : "notes"}`;
		lines.push(`${proposals} in ${notes} waiting for review — run "Review proposals" or click the callout in a note.`);
	}
	return lines;
}

/** The slice of Obsidian's `App` the engine reaches. */
export interface AppLike {
	vault: {
		configDir: string;
		adapter: AdapterLike;
		getAbstractFileByPath(path: string): unknown;
		read(file: TFile): Promise<string>;
		create(path: string, content: string): Promise<unknown>;
	};
}

/**
 * The engine's environment in the running app. `clock` is Obsidian's `moment`, handed in rather than
 * imported so this stays testable where there is no app.
 */
export function hostEnvironmentFor(app: AppLike, manifest: { dir?: string; id: string }, noteStore: NoteStore, clock: () => { format(format: string): string }): HostEnvironment {
	const vault = app.vault;
	return {
		pluginDir: manifest.dir ?? `${vault.configDir}/plugins/${manifest.id}`,
		files: adapterFiles(vault.adapter),
		noteStore,
		readVaultNote: async (path) => {
			const file = vault.getAbstractFileByPath(normalizePath(path));
			return file instanceof TFile ? vault.read(file) : null;
		},
		createNote: noteCreator(templaterOf(app), (path, content) => vault.create(normalizePath(path), content)),
		configDir: vault.configDir,
		formatNow: (format) => clock().format(format),
		randomId: () => crypto.randomUUID(),
		now: () => new Date(),
	};
}
