/**
 * The note commands of the Intelligence Engine (spec §9), the same two verbs and reaches as the
 * transcript's: "Re-transcribe" reads pages off the tablet again, "Re-extract" extracts them again from
 * the transcript already held; "this note" means the pages behind the note on screen, "all" every page.
 * Re-extracting one insight note runs here and now, from its base's transcript. Everything else marks
 * pages and leaves the reading to a sync, which the command starts at once -- only a sync can read a
 * page, and it brings the progress bar, Stop, and the extraction backend's consent.
 */

import type { SyncIndex } from "../sync-engine";
import { type HostEnvironment, intelligenceNotices, prepareRun, reviewStoresFor, type RunInputs } from "./host";
import { processDocument, type IntelligenceRow, type IntelligenceState } from "./sync-pass";

export interface RerunOutcome {
	message: string;
	/** The index to save; absent when nothing changed. */
	index?: SyncIndex;
	/** Pages were marked for a sync to read: the command starts one. */
	sync?: true;
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

/**
 * "Re-transcribe" on an insight note: its page is read off the tablet again. The page leaves the
 * transcript store of every transcript note of its document too, or the sync would hand the engine the
 * old text again; so the transcript note gets the new reading as well.
 */
export function markForRereading(index: SyncIndex, notePath: string): RerunOutcome {
	const row = pageRow(index, notePath);
	if (row === undefined) return { message: NOT_A_PAGE_NOTE };
	const seen = index.seenPages?.[row.syncKey];
	const rows = Object.fromEntries(
		Object.entries(index.rows).map(([key, r]) => [key, r.docId === row.docId && r.transcribedPages !== undefined ? { ...r, transcribedPages: r.transcribedPages.filter((page) => page.id !== row.pageId) } : r]),
	);
	return {
		message: "The page is read again now, and its insight note updated from it.",
		sync: true,
		index: {
			...index,
			rows,
			seenPages: { ...index.seenPages, [row.syncKey]: { scope: row.scope, firstSeen: seen?.firstSeen ?? null, noteId: row.noteId, pageHash: null } },
			// Nothing changes on the tablet, so the document has to be named for the sync to open it.
			intelligencePending: [...new Set([...(index.intelligencePending ?? []), row.docId])],
		},
	};
}

const tagOf = (key: string) => key.slice(key.lastIndexOf(":") + 1);
const docOf = (key: string) => key.slice(0, key.indexOf(":"));

/** Marks the given pages to be extracted again, and names their documents for the sync to open. */
function withReextract(index: SyncIndex, keys: readonly string[]): SyncIndex {
	return {
		...index,
		seenPages: { ...index.seenPages, ...Object.fromEntries(keys.map((key) => [key, { ...index.seenPages![key], reextract: true as const }])) },
		intelligencePending: [...new Set([...(index.intelligencePending ?? []), ...keys.map(docOf)])],
	};
}

const pages = (n: number) => `${n} page${n === 1 ? "" : "s"}`;

/**
 * "Re-extract" on a transcript note: every page of its notebook under its tag, those without an insight
 * note included -- a page written before insight notes were switched on gets its first. A page-tag
 * note covers its one page.
 */
export function markNoteForReextract(index: SyncIndex, notePath: string, extracts: (tag: string) => boolean): RerunOutcome {
	const row = Object.values(index.rows).find((candidate) => candidate.notePath === notePath && candidate.status === "active");
	if (row === undefined) return { message: "This note is not a note from Tagged Sync." };
	if (!extracts(row.tag)) return { message: `Insight notes are off for the tag "${row.tag}". Switch them on under Tag routing first.` };
	const covers = (key: string) => (row.pageId === null ? docOf(key) === row.docId && tagOf(key) === row.tag : key === `${row.docId}:${row.pageId}:${row.tag}`);
	const keys = Object.entries(index.seenPages ?? {}).filter(([key, seen]) => covers(key) && seen.pageHash !== null).map(([key]) => key);
	if (keys.length === 0) return { message: "The engine has not seen this notebook's pages yet. Sync now reads them." };
	return { message: `${pages(keys.length)} of this notebook ${keys.length === 1 ? "is" : "are"} extracted again now.`, index: withReextract(index, keys), sync: true };
}

/** The pages "Re-extract all synced notes" reaches: every page seen under a tag that has insight notes on. */
export function reextractableKeys(index: SyncIndex, extracts: (tag: string) => boolean): string[] {
	return Object.entries(index.seenPages ?? {})
		.filter(([key, seen]) => seen.pageHash !== null && extracts(tagOf(key)))
		.map(([key]) => key);
}

export function markAllForReextract(index: SyncIndex, extracts: (tag: string) => boolean): RerunOutcome {
	const keys = reextractableKeys(index, extracts);
	if (keys.length === 0) return { message: "No page is under a tag with insight notes on yet." };
	return { message: `${pages(keys.length)} ${keys.length === 1 ? "is" : "are"} extracted again now.`, index: withReextract(index, keys), sync: true };
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
