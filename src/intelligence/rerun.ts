/**
 * The two note commands on an insight note (spec §9). "Re-run extraction" re-extracts the page from the
 * transcript its base holds -- no tablet needed -- and goes through merge and review like any sync.
 * "Re-transcribe" wants the page read again, which only a sync can do: it clears the page's seen
 * hash, so the next sync counts it as changed. A page whose base went missing takes that road too:
 * its transcript went with the base.
 */

import type { SyncIndex } from "../sync-engine";
import { type HostEnvironment, intelligenceNotices, prepareRun, reviewStoresFor, type RunInputs } from "./host";
import { EARLIER_PAGES_COMMAND, processDocument, type IntelligenceRow, type IntelligenceState } from "./sync-pass";

export { EARLIER_PAGES_COMMAND };

export interface RerunOutcome {
	message: string;
	/** The index to save; absent when nothing changed. */
	index?: SyncIndex;
}

export const NOT_A_PAGE_NOTE = "This note is not an insight note from the Intelligence Engine.";

function pageRow(index: SyncIndex, notePath: string): IntelligenceRow | undefined {
	return Object.values(index.intelligenceRows ?? {}).find((row) => row.notePath === notePath && row.status === "active");
}

/** Whether a note is an active insight note: what the two commands check before they are offered. */
export function isPageNote(index: SyncIndex, notePath: string): boolean {
	return pageRow(index, notePath) !== undefined;
}

/** The Profile an active insight note was made with, or null for any other note. */
export function pageProfile(index: SyncIndex, notePath: string): string | null {
	return pageRow(index, notePath)?.profileId ?? null;
}

/** Marks the page to be read again on the next sync. */
export function markForRereading(index: SyncIndex, notePath: string): RerunOutcome {
	const row = pageRow(index, notePath);
	if (row === undefined) return { message: NOT_A_PAGE_NOTE };
	const seen = index.seenPages?.[row.syncKey];
	return {
		message: "The page is read again on the next sync, and its note updated from it.",
		index: {
			...index,
			seenPages: { ...index.seenPages, [row.syncKey]: { scope: row.scope, firstSeen: seen?.firstSeen ?? null, noteId: row.noteId, pageHash: null } },
			// Nothing changes on the tablet, so the document has to be named for the next sync to open it.
			intelligencePending: [...new Set([...(index.intelligencePending ?? []), row.docId])],
		},
	};
}

/**
 * On a transcript note: marks the pages of its notebook that have no insight note -- left alone as
 * written before insight notes were switched on (spec §3.1) -- so the next sync makes theirs. The way
 * "Re-transcribe" marks one page: a cleared seen hash counts as changed. Switching insight notes off and
 * on again moves that point to now, and the pages written before it were lost to the engine with
 * nothing said (live test, 2026-10-02).
 */
export function wantEarlierPages(index: SyncIndex, notePath: string, pageNotesOn: (tag: string) => boolean): RerunOutcome {
	const row = Object.values(index.rows).find((candidate) => candidate.notePath === notePath && candidate.status === "active");
	if (row === undefined) return { message: "This note is not a transcript note from Tagged Sync." };
	if (!pageNotesOn(row.tag)) return { message: `Insight notes are off for the tag "${row.tag}". Switch them on under Tag routing first.` };
	const made = new Set(Object.values(index.intelligenceRows ?? {}).flatMap((page) => (page.status === "active" ? [page.syncKey] : [])));
	// A page-tag note covers its one page; a notebook note every page the engine has seen under its tag.
	const covers = (key: string) => (row.pageId === null ? key.startsWith(`${row.docId}:`) && key.endsWith(`:${row.tag}`) : key === `${row.docId}:${row.pageId}:${row.tag}`);
	const wanted = Object.entries(index.seenPages ?? {}).filter(([key, seen]) => covers(key) && !made.has(key) && seen.pageHash !== null);
	if (wanted.length === 0) return { message: "Every page of this notebook has its insight note, or waits for the next sync to make it." };
	return {
		message: `${wanted.length} earlier page${wanted.length === 1 ? "" : "s"} of this notebook get${wanted.length === 1 ? "s its" : " their"} insight note${wanted.length === 1 ? "" : "s"} on the next sync.`,
		index: {
			...index,
			seenPages: { ...index.seenPages, ...Object.fromEntries(wanted.map(([key, seen]) => [key, { ...seen, pageHash: null }])) },
			intelligencePending: [...new Set([...(index.intelligencePending ?? []), row.docId])],
		},
	};
}

export async function rerunExtraction(env: HostEnvironment, run: RunInputs, index: SyncIndex, notePath: string, renderPath: string): Promise<RerunOutcome> {
	const row = pageRow(index, notePath);
	if (row === undefined) return { message: NOT_A_PAGE_NOTE };
	const prepared = await prepareRun(env, { ...run, background: false });
	try {
		if (prepared.deps === undefined) return { message: prepared.paused ?? "Page extraction runs on another device. Switch it to this one under Insight notes in the settings." };
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
		const said = [...report.failures.map((line) => `Extraction failed: ${line.slice(line.indexOf(": ") + 2)}`), ...intelligenceNotices(null, report, false)];
		return {
			message: said.length > 0 ? said.join(" ") : report.notesUpdated > 0 ? "Extracted again; the note is updated." : "Extracted again; nothing on the page changed what the note says.",
			index: { ...index, seenPages: state.seenPages, intelligenceRows: state.rows },
		};
	} finally {
		// A local model started for this command stops with it.
		prepared.dispose();
	}
}
