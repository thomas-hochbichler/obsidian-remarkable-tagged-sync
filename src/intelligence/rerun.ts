/**
 * The two note commands on a page note (spec §9). "Re-run extraction" re-extracts the page from the
 * transcript its base holds -- no tablet needed -- and goes through merge and review like any sync.
 * "Re-transcribe" wants the page read again, which only a sync can do: it clears the page's seen
 * hash, so the next sync counts it as changed. A page whose base went missing takes that road too:
 * its transcript went with the base.
 */

import type { SyncIndex } from "../sync-engine";
import { type HostEnvironment, intelligenceNotices, prepareRun, reviewStoresFor, type RunInputs } from "./host";
import { processDocument, type IntelligenceRow, type IntelligenceState } from "./sync-pass";

export interface RerunOutcome {
	message: string;
	/** The index to save; absent when nothing changed. */
	index?: SyncIndex;
}

const NOT_A_PAGE_NOTE = "This note is not a page note from the Intelligence Engine.";

function pageRow(index: SyncIndex, notePath: string): IntelligenceRow | undefined {
	return Object.values(index.intelligenceRows ?? {}).find((row) => row.notePath === notePath && row.status === "active");
}

/** Whether a note is an active page note: what the two commands check before they are offered. */
export function isPageNote(index: SyncIndex, notePath: string): boolean {
	return pageRow(index, notePath) !== undefined;
}

/** Marks the page to be read again on the next sync. */
export function markForRereading(index: SyncIndex, notePath: string): RerunOutcome {
	const row = pageRow(index, notePath);
	if (row === undefined) return { message: NOT_A_PAGE_NOTE };
	const seen = index.seenPages?.[row.syncKey];
	return {
		message: "The page is read again on the next sync, and its note updated from it.",
		index: { ...index, seenPages: { ...index.seenPages, [row.syncKey]: { scope: row.scope, firstSeen: seen?.firstSeen ?? null, noteId: row.noteId, pageHash: null } } },
	};
}

export async function rerunExtraction(env: HostEnvironment, run: RunInputs, index: SyncIndex, notePath: string, renderPath: string): Promise<RerunOutcome> {
	const row = pageRow(index, notePath);
	if (row === undefined) return { message: NOT_A_PAGE_NOTE };
	const prepared = await prepareRun(env, { ...run, background: false });
	try {
		if (prepared.deps === undefined) return { message: prepared.paused ?? "Page extraction runs on another device. Switch it to this one under Intelligence in the settings." };
		const base = await reviewStoresFor(env, {}).baseStore.load(row.noteId);
		if (base?.transcript == null) return markForRereading(index, notePath);

		const seen = index.seenPages?.[row.syncKey];
		const state: IntelligenceState = { seenPages: { ...index.seenPages }, rows: { ...index.intelligenceRows }, scans: { ...index.intelligenceScans } };
		const transcript = base.transcript;
		const report = await processDocument(
			prepared.deps,
			{
				docId: row.docId,
				name: "",
				legacy: false,
				// The page as the seen-set knows it: forced, so the same hash still counts as a change.
				pages: [{ id: row.pageId, ordinal: 0, hash: seen?.pageHash ?? "", modified: seen?.firstSeen ?? null }],
				units: [{ tag: row.tag, scope: row.scope, pageIds: [row.pageId] }],
				transcribe: async () => new Map([[row.pageId, transcript]]),
				writeRender: async () => renderPath,
			},
			state,
			{ force: new Set([row.syncKey]), partial: true },
		);
		// The pass words a failure for a sync over many pages ("page 3 of …: reason"); here there is one.
		const said = [...report.failures.map((line) => `Extraction failed: ${line.slice(line.indexOf(": ") + 2)}`), ...intelligenceNotices(null, report)];
		return {
			message: said.length > 0 ? said.join(" ") : report.notesUpdated > 0 ? "Extracted again; the note is updated." : "Extracted again; nothing on the page changed what the note says.",
			index: { ...index, seenPages: state.seenPages, intelligenceRows: state.rows },
		};
	} finally {
		// A local model started for this command stops with it.
		prepared.dispose();
	}
}
