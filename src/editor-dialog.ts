import { type App, Modal } from "obsidian";

/**
 * A dialog that edits one thing the settings tab lists -- a tag, a Profile, a Slot. The tab shows
 * each as one line; everything about it is edited here, so a list of ten stays ten lines long.
 *
 * It holds no state of its own: `draw` reads the settings as they stand and draws them, and the tab
 * calls {@link EditorDialog.redraw} whenever it redraws itself. So every change made in here goes the
 * one way changes already go -- save, then redraw -- and an inline card that collapsed on every redraw
 * (the tab redraws on nearly every change) was the alternative this avoids.
 */
export class EditorDialog extends Modal {
	constructor(
		app: App,
		private readonly titleText: string,
		private readonly draw: (containerEl: HTMLElement) => void,
		private readonly onClosed: (dialog: EditorDialog) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.titleText);
		this.redraw();
	}

	/** Draws the contents again, keeping the scroll position, as the tab keeps its own. */
	redraw(): void {
		const offset = this.contentEl.scrollTop;
		this.contentEl.empty();
		this.draw(this.contentEl);
		this.contentEl.scrollTop = offset;
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed(this);
	}
}
