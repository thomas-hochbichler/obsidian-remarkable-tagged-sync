/**
 * The decisions the plugin makes around the engine before a sync starts, as pure functions: which tag
 * is the free one, what each tag produces, which Slots a Free vault runs, whether this device runs
 * the engine, and which extraction backend it runs on (spec §9, §11).
 */

import type { Entitlement } from "../licence-state";
import type { TagModes } from "../tag-router";
import type { ExtractionBackendEntry } from "./extraction-registry";
import { type IntelligenceSettings, modesFor, type ProfileDef, type SlotDef, TASKS_FORMAT } from "./settings";

/**
 * The Intelligence Engine's Pro gate. Every Pro part of the engine -- tags beyond the free one, own and
 * extra Slots, cloud extraction -- asks this and nothing else; each is a line in `proCapabilities()`.
 */
export function intelligenceProAllowed(entitlement: Entitlement): boolean {
	return entitlement.tier !== "free";
}

/**
 * The one tag Intelligence Mode stays on for without Pro: the mapping switched on first, by
 * `firstEnabledAt` (never cleared), ties broken by tag name. Null when no mapping ever was.
 */
export function freeTag(settings: IntelligenceSettings, tagFolderMap: Record<string, string>): string | null {
	const candidates = Object.keys(tagFolderMap)
		.map((tag) => ({ tag, first: modesFor(settings, tagFolderMap, tag).firstEnabledAt }))
		.filter((c): c is { tag: string; first: string } => c.first !== undefined && modesFor(settings, tagFolderMap, c.tag).intelligence)
		// One key per tag, earliest first and then by name; tags are unique, so there is no tie left.
		.map((c) => ({ ...c, key: `${c.first}\u0000${c.tag}` }))
		.sort((a, b) => (a.key < b.key ? -1 : 1));
	return candidates[0]?.tag ?? null;
}

/** What each mapped tag produces. Without Pro, Intelligence Mode holds only on the free tag; the others keep their configuration and are no longer updated. */
export function effectiveModes(settings: IntelligenceSettings, tagFolderMap: Record<string, string>, pro: boolean): (tag: string) => TagModes {
	const free = pro ? null : freeTag(settings, tagFolderMap);
	return (tag) => {
		const modes = modesFor(settings, tagFolderMap, tag);
		return { transcript: modes.transcript, intelligence: modes.intelligence && (pro || tag === free) };
	};
}

/** The Slots a Free vault runs: Tasks and Summary only, Tasks in the Tasks-plugin format with review locked on (spec §11). */
export function freeSlots(slots: readonly SlotDef[]): SlotDef[] {
	return slots.filter((slot) => slot.id === "tasks" || slot.id === "summary").map((slot) => (slot.id === "tasks" ? { ...slot, itemFormat: TASKS_FORMAT, review: true } : slot));
}

export function effectiveSlotsFor(pro: boolean): (profile: ProfileDef, slots: SlotDef[]) => SlotDef[] {
	return (_profile, slots) => (pro ? slots : freeSlots(slots));
}

/** Extraction runs on one device only; sync and transcription run everywhere (spec §9). */
export function isEngineDevice(settings: IntelligenceSettings, localDeviceId: string | null): boolean {
	return localDeviceId !== null && settings.engineDeviceId === localDeviceId;
}

/** The tags whose switch-on scan has not run for their current `enabledAt`. */
export function scansDue(settings: IntelligenceSettings, tagFolderMap: Record<string, string>, pro: boolean, scanned: Record<string, string>): string[] {
	const modes = effectiveModes(settings, tagFolderMap, pro);
	return Object.keys(tagFolderMap).filter((tag) => {
		const enabledAt = modesFor(settings, tagFolderMap, tag).enabledAt;
		return modes(tag).intelligence && enabledAt !== undefined && scanned[tag] !== enabledAt;
	});
}

export type BackendChoice = { kind: "ready"; entry: ExtractionBackendEntry } | { kind: "paused"; reason: string };

/**
 * The extraction backend for this run. The setting wins; unset, the transcription backend when it is
 * also an extraction backend. A Pro backend without Pro falls back to the managed local model when it
 * is registered, else the engine pauses with a reason for the one notice (spec §6, §11).
 */
export function chooseExtractionBackend(input: { settings: IntelligenceSettings; transcriptionBackend: string; pro: boolean; lookup: (id: string) => ExtractionBackendEntry | null }): BackendChoice {
	const { settings, transcriptionBackend, pro, lookup } = input;
	const chosen = lookup(settings.backend ?? transcriptionBackend);
	if (chosen !== null && (pro || !chosen.requiresLicence)) return { kind: "ready", entry: chosen };
	const local = lookup("local");
	if (local !== null) return { kind: "ready", entry: local };
	if (chosen !== null) return { kind: "paused", reason: `Extraction with ${chosen.label} is part of Tagged Sync Pro. Pick your own server or the local model under Intelligence in the settings.` };
	return { kind: "paused", reason: "No extraction backend is set. Pick one under Intelligence in the settings." };
}
