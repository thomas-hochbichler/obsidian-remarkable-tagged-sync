import { type App, Modal, Setting } from "obsidian";

/**
 * The yes/no dialog in front of the two things this plugin does that cannot be undone from inside it:
 * stopping a run, and re-transcribing every synced note.
 *
 * **The default is the whole design.** Escape, a click on the background and the Cancel button are
 * one path in Obsidian -- all three call `close()`, which runs `onClose` -- and nothing downstream
 * can tell them apart. So the answer is not set by whichever handler ran; it starts at *no* and only
 * the confirm button moves it. A dialog dismissed by a stray Escape must not re-fetch every notebook
 * in the account and rewrite every note in the vault.
 */
class ConfirmModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private readonly titleText: string,
		private readonly bodyText: string,
		private readonly confirmText: string,
		private readonly onChoice: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.titleText);
		this.contentEl.createEl("p", { text: this.bodyText });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.confirmText)
					.setCta()
					.onClick(() => {
						this.confirmed = true;
						this.close();
					}),
			);
	}

	/** The single exit. Every way of leaving this dialog arrives here, which is why it answers. */
	onClose(): void {
		this.contentEl.empty();
		this.onChoice(this.confirmed);
	}
}

/** Opens a {@link ConfirmModal} and resolves to the user's choice. */
export function confirmDialog(app: App, title: string, body: string, confirmText: string): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, title, body, confirmText, resolve).open());
}
