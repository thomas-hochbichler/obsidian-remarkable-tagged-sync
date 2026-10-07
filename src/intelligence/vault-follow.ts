/**
 * What a rename or move in the vault changes in `data.json`: the path of every note the plugin owns
 * -- transcript notes and page notes alike -- and the path of every Profile's template (spec §4.1,
 * §5.4). Everything is keyed by identity, never by path, so the path is the only thing to follow.
 */

import { remapNotePath, remapRows, type Renamed } from "../note-rename";
import type { SyncIndex } from "../sync-engine";
import type { IntelligenceSettings } from "./settings";

/** The new index and settings, or null when the rename touched nothing the plugin keeps. */
export function followVaultRename(state: { syncIndex: SyncIndex; intelligence: IntelligenceSettings }, renamed: Renamed): { syncIndex: SyncIndex; intelligence: IntelligenceSettings } | null {
	const rows = remapRows(state.syncIndex.rows, renamed);
	const pageRows = remapRows(state.syncIndex.intelligenceRows ?? {}, renamed);
	let templates = false;
	const profiles = state.intelligence.profiles.map((profile) => {
		const template = profile.template === null ? null : remapNotePath(renamed, profile.template);
		if (template === null) return profile;
		templates = true;
		return { ...profile, template };
	});
	if (rows === null && pageRows === null && !templates) return null;
	return {
		syncIndex: { ...state.syncIndex, rows: rows ?? state.syncIndex.rows, ...(pageRows === null ? {} : { intelligenceRows: pageRows }) },
		intelligence: templates ? { ...state.intelligence, profiles } : state.intelligence,
	};
}
