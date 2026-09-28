/**
 * The engine's footing in the running plugin: the plugin folder for bases and the device id, the
 * vault for templates and new notes, and the per-run decisions of `plugin-rules.ts`. Everything
 * Obsidian-shaped arrives through {@link HostEnvironment}, so this is testable without the app.
 */

import type { NoteStore } from "../note-builder";
import type { BackendSettings } from "../ocr-registry";
import type { IntelligenceHook } from "../sync-engine";
import { createBaseStore, type BaseFiles } from "./base-store";
import { extractionBackendEntry } from "./extraction-registry";
import { chooseExtractionBackend, effectiveModes, effectiveSlotsFor, isEngineDevice, scansDue } from "./plugin-rules";
import { intelligenceFingerprint, type IntelligenceSettings } from "./settings";
import { completeScans, processDocument } from "./sync-pass";

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
	formatDate(format: string | null): string;
	formatTime(format: string | null): string;
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
}

/** Everything one sync needs from the engine side, decided once at its start. */
export async function prepareRun(env: HostEnvironment, input: RunInputs): Promise<IntelligenceRun> {
	const modes = effectiveModes(input.settings, input.tagFolderMap, input.pro);
	const fingerprint = intelligenceFingerprint(input.settings.mappings);
	const wanted = Object.keys(input.tagFolderMap).some((tag) => modes(tag).intelligence);
	if (!wanted || !isEngineDevice(input.settings, await localDeviceId(env, false))) return { modes, fingerprint, hook: undefined, paused: null };

	const choice = chooseExtractionBackend({ settings: input.settings, transcriptionBackend: input.transcriptionBackend, pro: input.pro, lookup: extractionBackendEntry });
	const backend = choice.kind === "ready" ? choice.entry.create(input.providerSettings[choice.entry.id] ?? {}, input.settings.model) : null;
	if (backend === null) {
		const reason = choice.kind === "paused" ? choice.reason : `The extraction backend ${choice.entry.label} is not set up yet: it needs its key or address. The engine is paused.`;
		return { modes, fingerprint, hook: undefined, paused: reason };
	}

	const deps = {
		settings: input.settings,
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
		formatDate: (format: string | null) => env.formatDate(format),
		formatTime: (format: string | null) => env.formatTime(format),
		reviewLink: REVIEW_LINK,
	};
	const hook: IntelligenceHook = {
		fingerprint,
		scansDue: (scanned) => scansDue(input.settings, input.tagFolderMap, input.pro, scanned),
		process: (doc, state) => processDocument(deps, doc, state),
		completeScans: (state) => completeScans(input.settings, input.tagFolderMap, Object.keys(input.tagFolderMap).filter((tag) => modes(tag).intelligence), state),
	};
	return { modes, fingerprint, hook, paused: null };
}
