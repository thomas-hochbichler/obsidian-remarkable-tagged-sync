/**
 * The engine's commands: "Review proposals", and the `obsidian://tagged-sync-review` link the
 * proposal callout in a note carries (spec §8). Both open one Modal over all page notes.
 */

import { type App, type Command, Modal, Notice } from "obsidian";
import type { SyncIndex } from "../sync-engine";
import { isPageNote, markForRereading, type RerunOutcome } from "./rerun";
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
	/** "Re-run extraction" on one page note, with this run's backend and settings. */
	rerun(notePath: string): Promise<RerunOutcome>;
	/** "Change Profile for this page" (Pro). */
	changeProfile(notePath: string, profileId: string): Promise<RerunOutcome>;
	profiles(): readonly { id: string; name: string }[];
	pro(): boolean;
}

/** What {@link IntelligenceCommandsHost.exclusive} answers while a sync runs. */
export const BUSY = "busy";

export const CHANGE_PROFILE_PRO = "Changing the profile of one page is part of Tagged Sync Pro.";

/** One button per Profile; choosing closes the Modal and hands the id on. */
export class ProfileChoiceModal extends Modal {
	constructor(
		app: App,
		private readonly profiles: readonly { id: string; name: string }[],
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
		for (const profile of this.profiles) {
			this.contentEl.createEl("button", { text: profile.name }).addEventListener("click", () => {
				this.close();
				this.choose(profile.id);
			});
		}
	}
}

async function say(host: IntelligenceCommandsHost, outcome: RerunOutcome): Promise<void> {
	if (outcome.index !== undefined) await host.setIndex(outcome.index);
	new Notice(outcome.message);
}

/**
 * "Re-transcribe" on a page note: the page is read again on the next sync (spec §9). False for any
 * other note, which the transcript-note command then handles as it always has.
 */
export async function reTranscribePageNote(host: IntelligenceCommandsHost, notePath: string): Promise<boolean> {
	if (!isPageNote(host.index(), notePath)) return false;
	await host.exclusive(() => say(host, markForRereading(host.index(), notePath)));
	return true;
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
		name: "Change profile for this page note",
		checkCallback: (checking) => {
			const file = host.app.workspace.getActiveFile();
			if (file === null || file.extension !== "md") return false;
			if (checking) return true;
			if (!host.pro()) new Notice(CHANGE_PROFILE_PRO);
			else new ProfileChoiceModal(host.app, host.profiles(), (id) => void host.exclusive(async () => say(host, await host.changeProfile(file.path, id)))).open();
			return true;
		},
	});
	host.addCommand({
		id: "rerun-extraction",
		name: "Re-run extraction for this page note",
		// Offered on every Markdown file, like "Re-transcribe this note": an index lookup per keystroke
		// is what the palette must not do. A note that is not a page note earns a sentence at run time.
		checkCallback: (checking) => {
			const file = host.app.workspace.getActiveFile();
			if (file === null || file.extension !== "md") return false;
			if (!checking) void host.exclusive(async () => say(host, await host.rerun(file.path)));
			return true;
		},
	});
	host.registerObsidianProtocolHandler(REVIEW_ACTION, () => void openReview(host));
}
