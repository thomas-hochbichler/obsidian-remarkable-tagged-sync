import { Setting } from "obsidian";
import { BULLET_JOURNAL, dropsSignsSentence, MEANING_LABELS, SIGN_PALETTE, type SignDef, type SignMeaning } from "./signs";

/** What the signs rows read and do, from the settings tab. */
export interface SignsHost {
	/** The live table in `data.json`: edited in place. */
	signs: SignDef[];
	/** Persists; redraws the tab when `redraw` (a text field keeps its focus without). */
	save(redraw: boolean): Promise<void>;
	/** The table was edited since the tab opened: the "from now on" line shows. */
	changed: boolean;
	/** The selected transcription backend's name when its transcripts keep no signs. */
	dropsSigns: string | null;
	reTranscribeAll(): void;
}

const OTHER = "other";

/** The user's signs under Transcription (ticket 43): one row a sign, filled from a palette or the Bullet Journal. */
export function renderSignsSettings(containerEl: HTMLElement, host: SignsHost): void {
	const { signs } = host;
	let after: Setting | null = null;
	const edited = async (redraw: boolean) => {
		after?.settingEl.toggle(true);
		await host.save(redraw);
	};

	// One card with the signs as a table. A card a sign ran six cards down the tab, each with its fields somewhere else.
	const card = containerEl.createDiv({ cls: "tagged-sync-card" });
	const head = new Setting(card)
		.setName("Signs")
		.setDesc("The sign a line starts with, and what it means. Transcripts copy these signs; insight notes read them. Checkboxes and struck-through lines are always read.")
		.addButton((button) =>
			button.setButtonText("Bullet journal").onClick(async () => {
				for (const preset of BULLET_JOURNAL) {
					const sign = signs.find((candidate) => candidate.glyph === preset.glyph);
					// A sign already there keeps its meaning and gets only the look it lacks.
					if (sign) sign.drawn ??= preset.drawn;
					else signs.push({ ...preset });
				}
				await edited(true);
			}),
		)
		.addDropdown((dropdown) => {
			dropdown.addOption("", "Add a sign…");
			for (const glyph of SIGN_PALETTE) dropdown.addOption(glyph, glyph);
			dropdown.addOption(OTHER, "Another sign");
			dropdown.setValue("");
			dropdown.onChange(async (glyph) => {
				if (glyph === "") return;
				signs.push({ glyph: glyph === OTHER ? "" : glyph, meaning: "note" });
				await edited(true);
			});
		});

	// Ticket 43: with a reader that keeps no signs, the table is void, and finished work comes back as open.
	if (host.dropsSigns !== null && signs.length > 0) {
		head.descEl.createDiv({ cls: "tagged-sync-verdict mod-warning", text: dropsSignsSentence(host.dropsSigns) });
	}

	const table = card.createDiv({ cls: "tagged-sync-signs" });
	if (signs.length > 0) for (const label of ["Sign", "Looks like", "Meaning", ""]) table.createDiv({ cls: "tagged-sync-signs-label", text: label });
	for (const sign of signs) {
		const row = new Setting(table)
			.addText((text) => {
				text.inputEl.addClass("tagged-sync-sign-glyph");
				text
					.setPlaceholder("Sign")
					.setValue(sign.glyph)
					.onChange(async (glyph) => {
						sign.glyph = glyph.trim();
						await edited(false);
					});
			})
			.addText((text) =>
				text
					.setPlaceholder("Optional")
					.setValue(sign.drawn ?? "")
					.onChange(async (drawn) => {
						sign.drawn = drawn.trim() || undefined;
						await edited(false);
					}),
			)
			.addDropdown((dropdown) => {
				for (const [meaning, label] of Object.entries(MEANING_LABELS)) dropdown.addOption(meaning, label);
				dropdown.setValue(sign.meaning);
				dropdown.onChange(async (meaning) => {
					sign.meaning = meaning as SignMeaning;
					await edited(true);
				});
			})
			.addExtraButton((button) =>
				button
					.setIcon("x")
					.setTooltip("Remove this sign")
					.onClick(async () => {
						signs.splice(signs.indexOf(sign), 1);
						await edited(true);
					}),
			);
		// After the remove button, so the grid puts it on a line of its own under the sign's look and meaning.
		if (sign.meaning === "custom") {
			row.addText((text) => {
				text.inputEl.addClass("tagged-sync-sign-words");
				text
					.setPlaceholder("What it means")
					.setValue(sign.text ?? "")
					.onChange(async (meaning) => {
						sign.text = meaning.trim() || undefined;
						await edited(false);
					});
			});
		}
	}

	// Transcripts already written keep their signs as they were read (TRANSCRIPT_VERSION stays, user 2026-10-09).
	after = new Setting(card).setDesc("Applies to pages transcribed from now on.").addButton((button) => button.setButtonText("Re-transcribe all synced notes").onClick(() => host.reTranscribeAll()));
	after.settingEl.toggle(host.changed);
}
