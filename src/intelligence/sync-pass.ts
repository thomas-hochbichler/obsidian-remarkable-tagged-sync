/**
 * The Intelligence Engine's half of a sync run, one document at a time. The sync engine opens the
 * document, writes its transcript notes, and then hands this pass the live pages; this decides per
 * page whether it is new, changed or old (the seen-set), and turns new and changed pages into page
 * notes through {@link processPage}.
 *
 * Everything this touches lives in two index maps beside `rows` -- `seenPages` and `intelligenceRows`
 * -- and in the device-local base files. It never writes a transcript note.
 */

import { blockHashOf, type NoteStore, resolveFreePath, sanitizeFilenamePart } from "../note-builder";
import type { BaseStore, PageBase } from "./base-store";
import { rebuildBase } from "./base-store";
import { isoDay } from "./dates";
import type { ExtractionBackend } from "./extraction-backend";
import { compileItemFormat } from "./item-format";
import { processPage } from "./page-engine";
import { classifyUnit, type SeenEntry, switchOnStamp } from "./seen-set";
import { genericProfile, type IntelligenceSettings, modesFor, type ProfileDef, type SlotDef } from "./settings";
import { analyseTemplate, starterTemplate } from "./template";

/** One page note, in `SyncIndex.intelligenceRows`. Not a `SyncIndexRow`: those are diffed against live page tags. */
export interface IntelligenceRow {
	syncKey: string;
	/** Equals `syncKey` in 1.9.0 (§14). */
	unitKey: string;
	docId: string;
	pageId: string;
	tag: string;
	scope: "notebook" | "page";
	notePath: string;
	/** The mapping's folder when the note was created or last moved: the re-target check reads it. */
	folder: string;
	status: "active" | "orphaned";
	noteId: string;
	/** The Profile frozen for this page. */
	profileId: string;
	baseHash: string;
	syncedAt: string;
	frontmatterTags?: string[];
	frontmatterVersion?: number;
}

export interface IntelligenceState {
	seenPages: Record<string, SeenEntry>;
	rows: Record<string, IntelligenceRow>;
	/** Per tag, the `enabledAt` whose switch-on scan has completed. */
	scans: Record<string, string>;
}

export interface DocPage {
	id: string;
	/** 1-based position in the notebook, frozen into the note's name. */
	ordinal: number;
	/** The page's `.rm` hash; null for a page never drawn on. */
	hash: string | null;
	/** `cPages.pages[].modifed` as epoch ms, null when absent. */
	modified: number | null;
}

/** A mapped tag on this document, and the pages it covers -- every mapped tag, whatever its modes. */
export interface DocUnit {
	tag: string;
	scope: "notebook" | "page";
	pageIds: string[];
}

export interface IntelligenceDocument {
	docId: string;
	name: string;
	/** A `pages[]` document with no `modifed` at all: every page is old. */
	legacy: boolean;
	pages: DocPage[];
	/** Every mapped tag's unit: a row whose unit is missing here lost its tag on the tablet. */
	units: DocUnit[];
	/** Page texts, read once per sync and shared with the transcript notes; a page missing from the map could not be read. */
	transcribe: (pageIds: string[]) => Promise<Map<string, string>>;
	/** Writes the page render and returns its vault path. */
	writeRender: (pageId: string) => Promise<string>;
}

export interface IntelligencePassDeps {
	settings: IntelligenceSettings;
	tagFolderMap: Record<string, string>;
	/** The Profile's Slots with Free-tier locks applied (§11). */
	effectiveSlots: (profile: ProfileDef, slots: SlotDef[]) => SlotDef[];
	pro: boolean;
	noteStore: NoteStore;
	baseStore: BaseStore;
	backend: ExtractionBackend;
	/** The template note's text, or null when it is gone. */
	loadTemplate: (path: string) => Promise<string | null>;
	/** Creates a new note in one call (Templater, when installed, else `vault.create`). */
	createNote: (path: string, content: string) => Promise<void>;
	now: () => Date;
	newId: () => string;
	newNoteId: () => string;
	formatDate: (format: string | null) => string;
	formatTime: (format: string | null) => string;
	reviewLink: string;
}

export interface PassReport {
	notesWritten: number;
	notesUpdated: number;
	proposals: number;
	/** One line per page whose extraction failed this run, for diagnostics. */
	failures: string[];
	/** Things said to the user: a page failing a third time, a legacy notebook, a lost region. */
	notices: string[];
}

export const RETRY_NOTICE_AFTER = 3;

export function emptyReport(): PassReport {
	return { notesWritten: 0, notesUpdated: 0, proposals: 0, failures: [], notices: [] };
}

export function intelligenceSyncKey(docId: string, pageId: string, tag: string): string {
	return `${docId}:${pageId}:${tag}`;
}

function profileFor(deps: IntelligencePassDeps, tag: string, frozen: string | undefined): ProfileDef {
	const byId = (id: string | undefined) => deps.settings.profiles.find((profile) => profile.id === id);
	const allowed = modesFor(deps.settings, deps.tagFolderMap, tag).profiles;
	// Phase 1: one Profile per tag, so the first allowed one. Several + classifier is phase 3.
	return byId(frozen) ?? byId(allowed[0]) ?? genericProfile(deps.pro);
}

function slotsOf(deps: IntelligencePassDeps, profile: ProfileDef): SlotDef[] {
	const all = profile.slots.flatMap((id) => deps.settings.slots.filter((slot) => slot.id === id));
	return deps.effectiveSlots(profile, all);
}

async function templateFor(deps: IntelligencePassDeps, profile: ProfileDef, slots: SlotDef[]): Promise<string> {
	const stored = profile.template === null ? null : await deps.loadTemplate(profile.template);
	return stored ?? starterTemplate(slots);
}

function baseHash(base: PageBase): string {
	return blockHashOf(JSON.stringify(base));
}

/**
 * Runs the switch-on scan where it is due, then every new or changed page of every Intelligence-mapped
 * unit of this document through the engine. Mutates `state`; the caller checkpoints it.
 */
export async function processDocument(deps: IntelligencePassDeps, doc: IntelligenceDocument, state: IntelligenceState): Promise<PassReport> {
	const report = emptyReport();
	const pageById = new Map(doc.pages.map((page) => [page.id, page]));

	// Tag gone from the notebook or page on the tablet: the row is orphaned and its note stays. A tag
	// whose Intelligence Mode is merely off is still here, and its rows stay active and untouched.
	const present = new Set(doc.units.flatMap((unit) => unit.pageIds.map((pageId) => intelligenceSyncKey(doc.docId, pageId, unit.tag))));
	for (const [key, row] of Object.entries(state.rows)) if (row.docId === doc.docId && row.status === "active" && !present.has(key)) state.rows[key] = { ...row, status: "orphaned" };

	const work: { unit: DocUnit; page: DocPage; key: string; seen: SeenEntry | undefined }[] = [];
	let legacyRecorded = false;

	for (const unit of doc.units) {
		const modes = modesFor(deps.settings, deps.tagFolderMap, unit.tag);
		if (!modes.intelligence || modes.enabledAt === undefined) continue;
		const enabledAt = Date.parse(modes.enabledAt);
		const scanDue = state.scans[unit.tag] !== modes.enabledAt;

		for (const pageId of unit.pageIds) {
			const page = pageById.get(pageId);
			// A page never drawn on gets no note and no seen entry: its first ink is new.
			if (page === undefined || page.hash === null) continue;
			const key = intelligenceSyncKey(doc.docId, page.id, unit.tag);
			let seen = state.seenPages[key];

			// The scan re-stamps every page written up to the toggle, known or not, so pages written
			// while the mode was off count as old. A page written after it is left to the two questions.
			if (scanDue && switchOnStamp(page.modified, enabledAt)) {
				seen = { ...seen, scope: unit.scope, pageHash: page.hash, firstSeen: seen?.firstSeen ?? page.modified };
				state.seenPages[key] = seen;
				continue;
			}

			const kind = classifyUnit({ seen, pageHash: page.hash, modified: page.modified, enabledAt, legacy: doc.legacy });
			if (kind === "old") {
				if (doc.legacy && seen === undefined) legacyRecorded = true;
				state.seenPages[key] = { scope: unit.scope, pageHash: page.hash, firstSeen: page.modified };
			} else if (kind !== "unchanged") {
				work.push({ unit, page, key, seen });
			}
		}
	}
	if (legacyRecorded) report.notices.push(`"${doc.name}" was written before the tablet stamped page dates, so none of its pages counts as new. Write on a page to bring it in.`);
	if (work.length === 0) return report;

	const texts = await doc.transcribe([...new Set(work.map((item) => item.page.id))]);

	for (const { unit, page, key, seen } of work) {
		const row = state.rows[key];
		const noteText = row ? await deps.noteStore.read(row.notePath) : null;
		// One revive rule (§4.1): a row whose note is gone starts over with a fresh id and no base --
		// merging against the dead note's base would tombstone everything.
		const alive = row !== undefined && noteText !== null;
		const noteId = alive ? row.noteId : row !== undefined ? deps.newNoteId() : (seen?.noteId ?? deps.newNoteId());
		if (row !== undefined && !alive) await deps.baseStore.discard(row.noteId);
		state.seenPages[key] = { scope: unit.scope, pageHash: seen?.pageHash ?? null, firstSeen: seen?.firstSeen ?? page.modified, noteId };

		const transcript = texts.get(page.id);
		const profile = profileFor(deps, unit.tag, alive ? row.profileId : undefined);
		const slots = slotsOf(deps, profile);
		const template = await templateFor(deps, profile, slots);
		let base = await deps.baseStore.load(noteId);
		if (base === null && alive) {
			const placements = analyseTemplate(template, slots.map((slot) => slot.id));
			base = rebuildBase({
				lines: noteText.split("\n"),
				slots: slots.map((slot) => {
					const placement = placements[slot.id];
					const itemFormat = slot.shape === "list" || slot.shape === "checklist" ? slot.itemFormat : "- {{text}}";
					return { id: slot.id, shape: slot.shape, heading: placement.kind === "region" ? placement.heading : { level: 2, text: slot.name }, format: compileItemFormat(itemFormat), itemFormat: slot.itemFormat };
				}),
				noteId,
				syncKey: key,
				newId: deps.newId,
			});
		}

		if (transcript === undefined) {
			report.failures.push(`page ${page.ordinal} of "${doc.name}": the page could not be read`);
			continue;
		}

		const folder = `${deps.tagFolderMap[unit.tag].replace(/\/+$/, "")}/${sanitizeFilenamePart(doc.name)}`;
		const renderPath = await doc.writeRender(page.id);
		const outcome = await processPage({
			unit: { key, pageHash: page.hash, transcript, firstSeen: seen?.firstSeen ?? page.modified },
			noteId,
			base,
			note: alive ? noteText : null,
			profile,
			slots,
			template,
			backend: deps.backend,
			syncedAt: deps.now(),
			title: (pageDate) => `${isoDay(pageDate)} ${doc.name} p${page.ordinal}`,
			pageLink: `[[${renderPath}|Page ${page.ordinal}]]`,
			pageEmbed: `![[${renderPath}]]`,
			reviewLink: deps.reviewLink,
			formatDate: deps.formatDate,
			formatTime: deps.formatTime,
			newId: deps.newId,
		});

		if (outcome.kind === "failed") {
			await deps.baseStore.save(outcome.base);
			report.failures.push(`page ${page.ordinal} of "${doc.name}": ${outcome.reason}`);
			if (outcome.base.extraction.attempts === RETRY_NOTICE_AFTER) report.notices.push(`Page ${page.ordinal} of "${doc.name}" could not be extracted ${RETRY_NOTICE_AFTER} times: ${outcome.reason}`);
			continue;
		}

		let notePath = alive ? row.notePath : "";
		if (outcome.created) {
			const name = sanitizeFilenamePart(`${isoDay(outcome.pageDate)} ${doc.name} p${page.ordinal}`);
			await deps.noteStore.ensureFolder(folder);
			notePath = await resolveFreePath(deps.noteStore, folder, name, unit.tag, doc.docId);
			await deps.createNote(notePath, outcome.content!);
			report.notesWritten++;
		} else if (outcome.content !== null) {
			await deps.noteStore.write(notePath, outcome.content);
			report.notesUpdated++;
		}
		for (const id of outcome.missingRegions) report.notices.push(`"${notePath}": the heading for ${id} is gone, so it was not updated.`);
		report.proposals += outcome.proposals;

		await deps.baseStore.save(outcome.base);
		// The page's hash enters the seen-set only now, after success: a failed page retries next sync.
		state.seenPages[key] = { scope: unit.scope, pageHash: page.hash, firstSeen: seen?.firstSeen ?? page.modified, noteId };
		state.rows[key] = {
			...(alive ? row : {}),
			syncKey: key,
			unitKey: key,
			docId: doc.docId,
			pageId: page.id,
			tag: unit.tag,
			scope: unit.scope,
			notePath,
			folder: alive ? row.folder : deps.tagFolderMap[unit.tag],
			status: "active",
			noteId,
			profileId: profile.id,
			baseHash: baseHash(outcome.base),
			syncedAt: deps.now().toISOString(),
		};
	}
	return report;
}

/**
 * Marks the scan of each of `tags` done at its current `enabledAt`. Called only when a run walked every
 * document, and only for the tags that actually ran -- a tag held off without Pro was not scanned.
 */
export function completeScans(settings: IntelligenceSettings, tagFolderMap: Record<string, string>, tags: readonly string[], state: IntelligenceState): void {
	for (const tag of tags) {
		const modes = modesFor(settings, tagFolderMap, tag);
		if (modes.intelligence && modes.enabledAt !== undefined) state.scans[tag] = modes.enabledAt;
	}
}

/** The deleted-document sweep: rows of documents gone from the tablet are orphaned, their seen entries pruned. */
export function sweepDeletedDocuments(state: IntelligenceState, liveDocIds: ReadonlySet<string>): void {
	for (const [key, row] of Object.entries(state.rows)) if (row.status === "active" && !liveDocIds.has(row.docId)) state.rows[key] = { ...row, status: "orphaned" };
	for (const key of Object.keys(state.seenPages)) if (!liveDocIds.has(key.slice(0, key.indexOf(":")))) delete state.seenPages[key];
}
