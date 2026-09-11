/**
 * "Which paper is this?" -- the two places the user answers that themselves (spec §2.3).
 *
 * One dialog, because they are one question asked from two directions. A sync that found a file
 * hash in two items, or a filename in one, opens it on the candidates it already has; the *Link to
 * Zotero item…* command opens it on an empty search field, because there the plugin has nothing to
 * offer at all. Both end at an attachment, which is what a link is made of.
 *
 * What this dialog must never do is choose. Every path out of it that is not a press on *Choose*
 * answers `null`, and the caller treats that as a refusal to be remembered (§2.3, "ask once") --
 * exactly as `confirm-modal` starts at *no*: Escape, the background and the close button are one
 * path in Obsidian, and a stray keystroke must not link somebody's notes to the wrong paper.
 */

import { type App, debounce, Modal, Setting } from "obsidian";
import type { ZoteroAttachment, ZoteroItem } from "./zotero-client";
import { itemLabel } from "./zotero-note";
import { pdfChoice } from "./zotero-send";
import type { ZoteroCandidate, ZoteroQuestion } from "./zotero-sync";

/** Said where a search found nothing, and where the item the user picked has no PDF to link to. */
export const NOTHING_FOUND = "Nothing in your library matches that.";
export const ITEM_HAS_NO_PDF = "That item has no PDF attachment.";

/** Why these candidates are being offered, in the words of §2.3's two rows. */
export const EVIDENCE: Record<ZoteroQuestion["evidence"], string> = {
	hash: "Your library holds this exact file under more than one item. Which one is this?",
	filename: "Your library has a PDF with this filename. It may be the same paper, or it may not — filenames are not identity.",
};

export interface LinkDialogDeps {
	/** Zotero's own quick search, for the command. Absent when the dialog opens on candidates it was handed. */
	search?(query: string): Promise<ZoteroItem[]>;
	/** Every PDF attachment in the library -- needed only to find the PDFs of a searched-for item. */
	attachments?(): Promise<ZoteroAttachment[]>;
	/** How long typing settles before the library is searched. Injectable so a test need not wait. */
	searchDelayMs?: number;
}

const SEARCH_DELAY_MS = 300;

type Step =
	| { readonly kind: "search" }
	| { readonly kind: "no-pdf" }
	/** The answers on offer, with the sentence that says where they came from. */
	| { readonly kind: "choose"; readonly why: string; readonly candidates: readonly ZoteroCandidate[] };

class LinkDialog extends Modal {
	private query = "";
	private results: ZoteroItem[] = [];
	private searched = false;
	private chosen: ZoteroAttachment | null = null;

	constructor(
		app: App,
		private readonly deps: LinkDialogDeps,
		private step: Step,
		private readonly title: string,
		private readonly onChoice: (attachment: ZoteroAttachment | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		this.render();
	}

	/** The single exit, like `confirm-modal`: every way of leaving arrives here, and it answers. */
	onClose(): void {
		this.contentEl.empty();
		this.onChoice(this.chosen);
	}

	private render(): void {
		this.contentEl.empty();
		if (this.step.kind === "search") this.renderSearch();
		else if (this.step.kind === "no-pdf") this.renderNoPdf();
		else this.renderChoices(this.step);
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
		// Only after a search has come back: "nothing matches" before anything was typed is an answer to
		// a question the user never asked.
		if (this.searched && this.results.length === 0) new Setting(this.contentEl).setDesc(NOTHING_FOUND);
	}

	private async runSearch(): Promise<void> {
		const query = this.query.trim();
		if (query === "") {
			this.results = [];
			this.searched = false;
			this.render();
			return;
		}
		const found = await this.deps.search!(query);
		// A slower answer to an older query must not replace a newer one's: the user is still typing.
		if (query !== this.query.trim()) return;
		this.results = found;
		this.searched = true;
		this.render();
	}

	private async chooseItem(item: ZoteroItem): Promise<void> {
		const choice = pdfChoice(await this.deps.attachments!(), item.key);
		if (choice.kind === "none") this.step = { kind: "no-pdf" };
		else if (choice.kind === "use") return this.finish(choice.attachment);
		else this.step = { kind: "choose", why: "Which PDF is the one on your tablet?", candidates: choice.options.map((attachment) => ({ attachment, item })) };
		this.render();
	}

	private renderNoPdf(): void {
		new Setting(this.contentEl).setDesc(ITEM_HAS_NO_PDF);
		new Setting(this.contentEl).addButton((button) =>
			button.setButtonText("Back").onClick(() => {
				this.step = { kind: "search" };
				this.render();
			}),
		);
	}

	private renderChoices(step: Extract<Step, { kind: "choose" }>): void {
		new Setting(this.contentEl).setDesc(step.why);
		for (const candidate of step.candidates) {
			new Setting(this.contentEl)
				.setName(candidate.item === null ? candidate.attachment.title : itemLabel(candidate.item))
				// The filename below the paper, because two PDFs of one item are told apart by nothing else.
				.setDesc(candidate.attachment.filename ?? candidate.attachment.title)
				.addButton((button) =>
					button
						.setButtonText("Choose")
						.setCta()
						.onClick(() => this.finish(candidate.attachment)),
				);
		}
		// Named rather than "Cancel": this closes the dialog *and* is the answer, and the answer is
		// remembered. A user who means "not now" closes it the same way -- there is no third outcome to
		// offer them, and a button that pretended otherwise would be a lie about what happens next.
		new Setting(this.contentEl).addButton((button) => button.setButtonText("None of these").onClick(() => this.close()));
	}

	private finish(attachment: ZoteroAttachment): void {
		this.chosen = attachment;
		this.close();
	}
}

/** The sync's picker: the candidates the matcher found, and why (§2.3). `null` = the user did not answer. */
export function askWhichAttachment(app: App, question: ZoteroQuestion): Promise<ZoteroAttachment | null> {
	const step: Step = { kind: "choose", why: EVIDENCE[question.evidence], candidates: question.candidates };
	return new Promise((resolve) => new LinkDialog(app, {}, step, `Is "${question.visibleName}" one of these?`, resolve).open());
}

/**
 * Which of an item's PDFs is the one on the tablet -- the context action's half of §2.4's question.
 *
 * The same list the sync's picker shows, asked for the other reason: there the plugin does not know
 * which paper, here it does and the paper has two files. Which one matters just as much, because the
 * one the reader annotates is the one the highlights go back onto.
 */
export function askWhichPdf(app: App, item: ZoteroItem, options: readonly ZoteroAttachment[]): Promise<ZoteroAttachment | null> {
	const step: Step = { kind: "choose", why: "Which PDF is the one on your tablet?", candidates: options.map((attachment) => ({ attachment, item })) };
	return new Promise((resolve) => new LinkDialog(app, {}, step, itemLabel(item), resolve).open());
}

/** The *Link to Zotero item…* command: the same question with nothing to go on, so it starts at a search field. */
export function askZoteroItem(app: App, deps: Required<Omit<LinkDialogDeps, "searchDelayMs">> & Pick<LinkDialogDeps, "searchDelayMs">): Promise<ZoteroAttachment | null> {
	return new Promise((resolve) => new LinkDialog(app, deps, { kind: "search" }, "Link this note to a Zotero item", resolve).open());
}
