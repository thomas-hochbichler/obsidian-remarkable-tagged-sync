/**
 * The engine's commands. "Re-extract this note" and "Re-extract all synced notes" mirror the two
 * "Re-transcribe" commands (user, 2026-10-09): the same reaches, one verb for reading the page again
 * and one for extracting it again. Then what only insight notes have: "Review proposals" -- with the
 * `obsidian://tagged-sync-review` link the proposal callout in a note carries (spec §8), both opening
 * one Modal over all insight notes -- and "Change profile for this note".
 */

import { type App, type Command, Modal, Notice, Setting } from "obsidian";
import { confirmDialog } from "../confirm-modal";
import type { SyncIndex } from "../sync-engine";
import { isPageNote, markAllForReextract, markForRereading, markNoteForReextract, NOT_A_PAGE_NOTE, pageProfile, reextractableKeys, type RerunOutcome } from "./rerun";
import type { NoteStore } from "../note-builder";
import type { BaseStore } from "./base-store";
import { REVIEW_ACTION, REVIEW_LINK } from "./host";
import { type ApplyOutcome, applyReview, loadReview, type ReviewItem } from "./review-session";
import type { IntelligenceRow } from "./sync-pass";

const NO_REGION = "This note no longer has the heading for it, so nothing was written.";
const GONE = "This note or its record is gone, so nothing was written.";

/** One row per proposal, grouped by note; ✓ and ✗ per row, and "Accept all". Decided rows leave the list. */
export class ReviewModal extends Modal {
	constructor(
		app: App,
		private readonly items: ReviewItem[],
		private readonly apply: (item: ReviewItem, accept: boolean) => Promise<ApplyOutcome | typeof BUSY>,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Review proposals");
		if (this.items.length === 0) {
			this.contentEl.createEl("p", { text: "Nothing to review." });
			return;
		}
		const rows: { item: ReviewItem; el: HTMLElement }[] = [];
		const acceptAll = this.contentEl.createEl("button", { text: "Accept all", cls: "mod-cta" });
		acceptAll.addEventListener("click", () => {
			void (async () => {
				for (const row of [...rows]) await this.decide(row, true, rows);
			})();
		});
		let note: string | null = null;
		for (const item of this.items) {
			if (item.notePath !== note) {
				note = item.notePath;
				this.contentEl.createEl("h4", { text: note });
			}
			const el = this.contentEl.createDiv({ cls: "tagged-sync-proposal" });
			el.createDiv({ text: item.label });
			if (item.source !== null) el.createDiv({ cls: "tagged-sync-proposal-source", text: `On the page: “${item.source}”` });
			const row = { item, el };
			rows.push(row);
			el.createEl("button", { text: "✓", attr: { "aria-label": "Accept" } }).addEventListener("click", () => void this.decide(row, true, rows));
			el.createEl("button", { text: "✗", attr: { "aria-label": "Reject" } }).addEventListener("click", () => void this.decide(row, false, rows));
		}
	}

	private async decide(row: { item: ReviewItem; el: HTMLElement }, accept: boolean, rows: { item: ReviewItem; el: HTMLElement }[]): Promise<void> {
		// Out of the list before the await: a second click on the same row must not decide it twice.
		if (!rows.includes(row)) return;
		const at = rows.indexOf(row);
		rows.splice(at, 1);
		const outcome = await this.apply(row.item, accept);
		// A sync is writing the same notes and bases: the row stays, to be decided once it has finished.
		if (outcome === BUSY) {
			rows.splice(at, 0, row);
			return;
		}
		if (outcome === "applied" || outcome === "stale") {
			row.el.remove();
			return;
		}
		row.el.empty();
		row.el.createDiv({ text: outcome === "no-region" ? NO_REGION : GONE });
	}
}

export interface IntelligenceCommandsHost {
	app: App;
	addCommand(command: Command): unknown;
	registerObsidianProtocolHandler(action: string, handler: () => void): void;
	/** What a review reads and writes, as it stands when the review opens. */
	review(): { rows: Record<string, IntelligenceRow>; baseStore: BaseStore; noteStore: NoteStore; newId: () => string };
	index(): SyncIndex;
	/** Persists a changed index. */
	setIndex(index: SyncIndex): Promise<void>;
	/**
	 * Runs `work` while no sync can start, or answers {@link BUSY} -- having said so -- while one runs.
	 * A command reads the index and writes notes and bases a sync is writing too; the sync saves the
	 * index it began with, so a command's change made meanwhile would be lost.
	 */
	exclusive<T>(work: () => Promise<T>): Promise<T | typeof BUSY>;
	/** "Re-extract this note" on one insight note, with this run's backend and settings. */
	rerun(notePath: string): Promise<RerunOutcome>;
	/** "Change Profile for this page" (Pro). */
	changeProfile(notePath: string, profileId: string): Promise<RerunOutcome>;
	profiles(): readonly { id: string; name: string; description: string }[];
	pro(): boolean;
	/** Whether insight notes are on for a tag. */
	pageNotesOn(tag: string): boolean;
	/** "Sync now", as the command: what a command that marked pages starts once the lock is free. */
	syncNow(): Promise<void>;
}

/** What {@link IntelligenceCommandsHost.exclusive} answers while a sync runs. */
export const BUSY = "busy";

export const CHANGE_PROFILE_PRO = "Changing the profile of one page is part of Tagged Sync Pro.";

/**
 * The Profiles to move one insight note to: a row each, named and described, the one the note has now
 * marked "Current". It was a row of bare buttons, which said neither which Profile the page has nor
 * what the others are for (live test, 2026-10-02). Choosing closes the Modal and hands the id on.
 */
export class ProfileChoiceModal extends Modal {
	constructor(
		app: App,
		private readonly profiles: readonly { id: string; name: string; description: string }[],
		/** The Profile the note has now; `generic` or a removed one is in no row. */
		private readonly current: string,
		private readonly choose: (id: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Change profile for this page");
		if (this.profiles.length === 0) {
			this.contentEl.createEl("p", { text: "There is no profile yet. Add one in the plugin settings." });
			return;
		}
		this.contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "The note is made again with the profile you pick. If you have edited it, it stays as it is and a second note is made beside it.",
		});
		// The generic profile is in no row; nor is one removed since. Either is said, so no row reads as current by mistake.
		if (this.current === "generic") this.contentEl.createEl("p", { cls: "setting-item-description", text: "This page has the generic profile now." });
		else if (!this.profiles.some((profile) => profile.id === this.current)) this.contentEl.createEl("p", { cls: "setting-item-description", text: "The profile this page was made with no longer exists." });
		for (const profile of this.profiles) {
			const row = new Setting(this.contentEl).setName(profile.name).setDesc(profile.description);
			if (profile.id === this.current) {
				row.addButton((button) => button.setButtonText("Current").setDisabled(true));
				continue;
			}
			row.addButton((button) =>
				button
					.setButtonText("Use")
					.setCta()
					.onClick(() => {
						this.close();
						this.choose(profile.id);
					}),
			);
		}
	}
}

async function say(host: IntelligenceCommandsHost, outcome: RerunOutcome): Promise<void> {
	if (outcome.index !== undefined) await host.setIndex(outcome.index);
	new Notice(outcome.message);
}

/**
 * Runs `work` under the lock and says what it did; when it marked pages for reading, starts the sync
 * once the lock is free. A command acts now, as "Re-transcribe" always has -- marking alone and leaving
 * the rest to whenever the next sync came read as if nothing had happened (user, 2026-10-09).
 */
async function act(host: IntelligenceCommandsHost, work: () => RerunOutcome | Promise<RerunOutcome>): Promise<void> {
	const outcome = await host.exclusive(async () => {
		const done = await work();
		await say(host, done);
		return done;
	});
	if (outcome !== BUSY && outcome.sync) await host.syncNow();
}

/**
 * "Re-transcribe this note" on an insight note: its page is read off the tablet again, now (spec §9).
 * False for any other note, which the transcript-note command then handles as it always has.
 */
export async function reTranscribePageNote(host: IntelligenceCommandsHost, notePath: string): Promise<boolean> {
	if (!isPageNote(host.index(), notePath)) return false;
	await act(host, () => markForRereading(host.index(), notePath));
	return true;
}

/**
 * "Re-extract this note": an insight note is extracted again from its base's transcript, here and now;
 * a transcript note has every page of its notebook extracted again, those without an insight note
 * included, by the sync it starts.
 */
export async function reExtractNote(host: IntelligenceCommandsHost, notePath: string): Promise<void> {
	await act(host, () => (isPageNote(host.index(), notePath) ? host.rerun(notePath) : markNoteForReextract(host.index(), notePath, (tag) => host.pageNotesOn(tag))));
}

/** "Re-extract all synced notes": every page under a tag with insight notes on, once asked -- it costs a request a page. */
export async function reExtractAll(host: IntelligenceCommandsHost): Promise<void> {
	const count = reextractableKeys(host.index(), (tag) => host.pageNotesOn(tag)).length;
	if (count === 0) {
		new Notice("No page is under a tag with insight notes on yet.");
		return;
	}
	const pages = `${count} page${count === 1 ? "" : "s"}`;
	const asked = await confirmDialog(
		host.app,
		"Re-extract all synced notes",
		`Extract ${pages} again from the transcripts already held? Pages without an insight note get their first, pages written before insight notes were switched on included. Each page is one request to the extraction backend.`,
		"Re-extract",
	);
	if (asked) await act(host, () => markAllForReextract(host.index(), (tag) => host.pageNotesOn(tag)));
}

/** Opens the review over every pending proposal. */
export async function openReview(host: IntelligenceCommandsHost): Promise<ReviewModal> {
	const deps = host.review();
	const items = await loadReview(deps.rows, deps.baseStore);
	const modal = new ReviewModal(host.app, items, (item, accept) => host.exclusive(() => applyReview(item, accept, { ...deps, reviewLink: REVIEW_LINK })));
	modal.open();
	return modal;
}

export function registerIntelligenceCommands(host: IntelligenceCommandsHost): void {
	host.addCommand({ id: "review-proposals", name: "Review proposals", callback: () => void openReview(host) });
	host.addCommand({
		id: "change-profile",
		name: "Change profile for this note",
		checkCallback: (checking) => {
			const file = host.app.workspace.getActiveFile();
			if (file === null || file.extension !== "md") return false;
			if (checking) return true;
			if (!host.pro()) {
				new Notice(CHANGE_PROFILE_PRO);
				return true;
			}
			// Asked before the choice opens: a note kept beside a new one after a change is the user's
			// now, and offering it Profiles read as if it still had one (live test, 2026-10-02).
			const current = pageProfile(host.index(), file.path);
			if (current === null) new Notice(NOT_A_PAGE_NOTE);
			else new ProfileChoiceModal(host.app, host.profiles(), current, (id) => void host.exclusive(async () => say(host, await host.changeProfile(file.path, id)))).open();
			return true;
		},
	});
	host.addCommand({
		id: "re-extract-note",
		name: "Re-extract this note",
		// Offered on every Markdown file, like "Re-transcribe this note": an index lookup per keystroke
		// is what the palette must not do. A note the plugin did not make earns a sentence at run time.
		checkCallback: (checking) => {
			const file = host.app.workspace.getActiveFile();
			if (file === null || file.extension !== "md") return false;
			if (!checking) void reExtractNote(host, file.path);
			return true;
		},
	});
	host.addCommand({ id: "re-extract-all", name: "Re-extract all synced notes", callback: () => void reExtractAll(host) });
	host.registerObsidianProtocolHandler(REVIEW_ACTION, () => void openReview(host));
}
