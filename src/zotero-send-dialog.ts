/**
 * The *Send Zotero PDF to reMarkable…* dialog (spec §2.4).
 *
 * Two questions, asked only where they are questions: which paper, and which of its PDFs. A library
 * with one PDF per item therefore answers the second by itself, and the reader searches, presses
 * Choose, and is done -- which is the shape the command has to have to be worth a command. No sync
 * tag is asked for or put on (2026-09-13): the reader tags the document on the tablet.
 *
 * The search is Zotero's own (`q=`, `qmode=titleCreatorYear`, in `zotero-client.ts`), not a filter
 * over a list we hold: a real library is thousands of items, and the person looking for one of them
 * is typing half a title and an author's name in the order they remember it.
 */

import { type App, debounce, Modal, Setting } from "obsidian";
import type { ZoteroAttachment, ZoteroItem } from "./zotero-client";
import { itemLabel } from "./zotero-note";
import { pdfChoice } from "./zotero-send";

/** What the dialog needs to be able to ask. A `ZoteroClient` satisfies the first two. */
export interface SendDialogDeps {
	search(query: string): Promise<ZoteroItem[]>;
	/** Every PDF attachment in the library -- the same listing the matcher reads. */
	attachments(): Promise<ZoteroAttachment[]>;
	/** How long typing settles before the library is searched. Injectable so a test need not wait. */
	searchDelayMs?: number;
}

/** What the user decided. */
export interface SendChoice {
	readonly item: ZoteroItem;
	readonly attachment: ZoteroAttachment;
}

const SEARCH_DELAY_MS = 300;

/** Said in the list where a search found nothing, and where an item has no PDF to send. */
export const NO_RESULTS = "Nothing in your library matches that.";
export const NO_PDF = "That item has no PDF attachment.";

/**
 * Which question is on screen, and everything that question needs.
 *
 * A union rather than a step name beside nullable fields: the later steps cannot be rendered without
 * the item, and carrying it here means there is no state in which the dialog has to check whether it
 * knows what it is sending.
 */
type Step = { readonly kind: "search" } | { readonly kind: "no-pdf"; readonly item: ZoteroItem } | { readonly kind: "pdf"; readonly item: ZoteroItem; readonly options: ZoteroAttachment[] };

class SendDialog extends Modal {
	private step: Step = { kind: "search" };
	private query = "";
	private results: ZoteroItem[] = [];
	private searched = false;
	private choice: SendChoice | null = null;

	constructor(
		app: App,
		private readonly deps: SendDialogDeps,
		private readonly onChoice: (choice: SendChoice | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Send a Zotero PDF to your reMarkable");
		this.render();
	}

	/** The single exit, like `confirm-modal`: every way of leaving arrives here, and it answers. */
	onClose(): void {
		this.contentEl.empty();
		this.onChoice(this.choice);
	}

	private render(): void {
		this.contentEl.empty();
		const step = this.step;
		if (step.kind === "search") this.renderSearch();
		else if (step.kind === "no-pdf") this.renderNoPdf();
		else this.renderPdfs(step);
	}

	private renderSearch(): void {
		const search = debounce(
			() => {
				void this.runSearch();
			},
			this.deps.searchDelayMs ?? SEARCH_DELAY_MS,
			true,
		);

		new Setting(this.contentEl).setName("Search your library").setDesc("Title, author, year — Zotero's own search.").addText((text) => {
			text.setPlaceholder("smith prompting").setValue(this.query);
			text.onChange((value) => {
				this.query = value;
				search();
			});
		});

		for (const item of this.results) {
			new Setting(this.contentEl).setName(itemLabel(item)).addButton((button) =>
				button
					.setButtonText("Choose")
					.setCta()
					.onClick(() => void this.chooseItem(item)),
			);
		}
		// Only after a search has come back: an empty dialog that says "nothing matches" before the user
		// has typed anything is telling them about a search they did not make.
		if (this.searched && this.results.length === 0) new Setting(this.contentEl).setDesc(NO_RESULTS);
	}

	private async runSearch(): Promise<void> {
		const query = this.query.trim();
		if (query === "") {
			// A cleared field is not a search for nothing: the list goes, and so does the sentence about
			// having found nothing.
			this.results = [];
			this.searched = false;
			this.render();
			return;
		}
		const found = await this.deps.search(query);
		// A slower answer to an older query must not replace a newer one's: the dialog is a text field
		// and the user is still typing into it.
		if (query !== this.query.trim()) return;
		this.results = found;
		this.searched = true;
		this.render();
	}

	private async chooseItem(item: ZoteroItem): Promise<void> {
		const choice = pdfChoice(await this.deps.attachments(), item.key);
		if (choice.kind === "none") this.step = { kind: "no-pdf", item };
		else if (choice.kind === "ask") this.step = { kind: "pdf", item, options: choice.options };
		else {
			this.finish({ item, attachment: choice.attachment });
			return;
		}
		this.render();
	}

	private renderNoPdf(): void {
		new Setting(this.contentEl).setDesc(NO_PDF);
		new Setting(this.contentEl).addButton((button) =>
			button.setButtonText("Back").onClick(() => {
				this.step = { kind: "search" };
				this.render();
			}),
		);
	}

	private renderPdfs(step: Extract<Step, { kind: "pdf" }>): void {
		new Setting(this.contentEl).setName("Which PDF?").setDesc("The one you annotate is the one the highlights go back onto.").setHeading();
		for (const attachment of step.options) {
			new Setting(this.contentEl).setName(attachment.filename ?? attachment.title).addButton((button) =>
				button
					.setButtonText("Choose")
					.setCta()
					.onClick(() => this.finish({ item: step.item, attachment })),
			);
		}
	}

	private finish(choice: SendChoice): void {
		this.choice = choice;
		this.close();
	}
}

/** Opens the dialog and resolves to what the user chose, or `null` if they closed it. */
export function askWhatToSend(app: App, deps: SendDialogDeps): Promise<SendChoice | null> {
	return new Promise((resolve) => new SendDialog(app, deps, resolve).open());
}
