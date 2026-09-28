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
		private readonly apply: (item: ReviewItem, accept: boolean) => Promise<ApplyOutcome>,
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
		rows.splice(rows.indexOf(row), 1);
		const outcome = await this.apply(row.item, accept);
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
	/** "Re-run extraction" on one page note, with this run's backend and settings. */
	rerun(notePath: string): Promise<RerunOutcome>;
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
	await say(host, markForRereading(host.index(), notePath));
	return true;
}

/** Opens the review over every pending proposal. */
export async function openReview(host: IntelligenceCommandsHost): Promise<ReviewModal> {
	const deps = host.review();
	const items = await loadReview(deps.rows, deps.baseStore);
	const modal = new ReviewModal(host.app, items, (item, accept) => applyReview(item, accept, { ...deps, reviewLink: REVIEW_LINK }));
	modal.open();
	return modal;
}

export function registerIntelligenceCommands(host: IntelligenceCommandsHost): void {
	host.addCommand({ id: "review-proposals", name: "Review proposals", callback: () => void openReview(host) });
	host.addCommand({
		id: "rerun-extraction",
		name: "Re-run extraction for this page note",
		// Offered on every Markdown file, like "Re-transcribe this note": an index lookup per keystroke
		// is what the palette must not do. A note that is not a page note earns a sentence at run time.
		checkCallback: (checking) => {
			const file = host.app.workspace.getActiveFile();
			if (file === null || file.extension !== "md") return false;
			if (!checking) void host.rerun(file.path).then((outcome) => say(host, outcome));
			return true;
		},
	});
	host.registerObsidianProtocolHandler(REVIEW_ACTION, () => void openReview(host));
}
