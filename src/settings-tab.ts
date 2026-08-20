import {
	type App,
	apiVersion,
	debounce,
	Notice,
	Platform,
	PluginSettingTab,
	Setting,
	TFolder,
} from "obsidian";
import { DEFAULT_ATTACHMENTS_FOLDER } from "./attachment-writer";
import { isMeteredProvider } from "./auto-sync";
import { buildDiagnostics } from "./diagnostics";
import { explainError } from "./explain-error";
import { activateKey, deactivateHere } from "./licence-check";
import {
	ACTIVATION_LIMIT_MESSAGE,
	licenceStatusText,
	MONEY_BACK_MESSAGE,
	OFFLINE_ACTIVATION_MESSAGE,
	trialDaysLeft,
	WITHDRAWN_KEY_MESSAGE,
	WRONG_KEY_MESSAGE,
} from "./licence-messages";
import { type LicenceOutcome, startTrial, withoutLicence } from "./licence-state";
import type TaggedSyncPlugin from "./main";
import { defaultOcrBackend, hasAlternativeBackends, hasCloudBackends, hasOnDeviceBackends } from "./ocr-resolution";
import { isListedBackend, ocrBackendEntries, ocrBackendEntry } from "./ocr-registry";
import { openSession } from "./remarkable-session";
import { collectTagNames, enumerateNotebookTags } from "./remarkable-tags";
import { invalidateRenders } from "./sync-engine";
import { planTagRouting } from "./tag-routing-view";
import { visionPlatformSupported, visionUnavailableReason } from "./vision-ocr-runtime";
import { visionRunStats } from "./vision-ocr-backend";

/**
 * The settings screen, whole.
 *
 * It is the only part of the plugin the user *reads*, and until this file existed it was also the
 * only part with nothing under it: every rule it applies -- the licence status sentence, the tag
 * routing plan, the backend listing rule, the money gate -- lives in a tested unit, and the wires
 * between them lived in `main.ts` beside the sync engine's wiring, where nothing could reach them.
 *
 * The class holds no rules of its own on purpose. Where a decision looks like it is being made here,
 * it is being *asked for*: `planTagRouting`, `isListedBackend`, `licenceStatusText`,
 * `isMeteredProvider`. What is left is the part that has to be characterised rather than unit-tested
 * -- which row, in which order, wired to which handler.
 */

const DEVICE_CONNECT_URL = "https://my.remarkable.com/device/browser/connect";
const ISSUES_URL = "https://github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync/issues";
const FEATURE_REQUEST_URL = `${ISSUES_URL}/new?template=feature_request.md`;
const FEATURE_VOTING_URL = `${ISSUES_URL}?q=is%3Aopen+label%3Aenhancement+sort%3Areactions-desc`;

/**
 * Where a licence is bought -- Polar's checkout, opened in the browser.
 *
 * This must be a **checkout link** (`buy.polar.sh/polar_cl_...`), which mints a fresh checkout
 * session per visitor. A session URL (`polar.sh/checkout/polar_c_...`) looks identical in a
 * browser but expires, and an expired one answers 404 -- which is exactly what happened to the
 * link shipped in 1.3.0 and 1.4.0.
 */
const PRO_BUY_URL = "https://buy.polar.sh/polar_cl_ri72ZVng24KrtsNUNu8poN2J0rsvTSbkWwoZp2ZIQbP";

/**
 * Polar's customer portal, where a buyer frees an activation slot themselves. The licence covers 50
 * devices and each vault counts as one, so someone whose old laptop is gone cannot use "Deactivate
 * this vault" -- that vault is unreachable. Without this they would have to write to support to get
 * back into something they already paid for.
 *
 * Polar mails this link with every order too; the button is convenience, not the only route.
 */
const PRO_PORTAL_URL = "https://polar.sh/hochbichler-com/portal";

/** What to say when someone has just pressed Activate. */
function activationMessage(outcome: LicenceOutcome): string {
	switch (outcome) {
		case "valid":
			return "Tagged Sync Pro is active in this vault.";
		case "activation-limit":
			return ACTIVATION_LIMIT_MESSAGE;
		case "unreachable":
			return OFFLINE_ACTIVATION_MESSAGE;
		case "withdrawn":
			return WITHDRAWN_KEY_MESSAGE;
		// Nothing was ever active here, so an unrecognised key is a typo rather than a withdrawal.
		default:
			return WRONG_KEY_MESSAGE;
	}
}

export class TaggedSyncSettingTab extends PluginSettingTab {
	private code = "";
	private discoveredTags: string[] = [];

	constructor(
		app: App,
		private readonly plugin: TaggedSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const connected = this.plugin.auth.isConnected();

		const connectionSetting = new Setting(containerEl)
			.setName("reMarkable connection")
			.setDesc(connected ? "Connected." : "Not connected.");

		if (connected) {
			connectionSetting.addButton((button) =>
				button.setButtonText("Disconnect").onClick(async () => {
					await this.plugin.auth.disconnect();
					this.display();
				}),
			);
		} else {
			this.code = "";
			new Setting(containerEl)
				.setName("Connect")
				.setDesc(
					createFragment((desc: DocumentFragment) => {
						desc.appendText("Enter the one-time code from ");
						desc.createEl("a", {
							text: DEVICE_CONNECT_URL,
							href: DEVICE_CONNECT_URL,
						});
						desc.appendText(".");
					}),
				)
				.addText((text) =>
					text.setPlaceholder("Eight-letter code").onChange((value) => {
						this.code = value;
					}),
				)
				.addButton((button) =>
					button
						.setButtonText("Connect")
						.setCta()
						.onClick(async () => {
							try {
								await this.plugin.auth.connect(this.code);
								new Notice("Connected to reMarkable.");
								this.display();
							} catch (error) {
								new Notice(explainError(error, "connect"), 10_000);
							}
						}),
				);
		}

		// Order follows how often a row is touched, not how it was built: what to sync is the setting a
		// user comes back to, transcription is chosen roughly once, and the links at the end are read
		// when something has already gone wrong.
		if (connected) {
			this.renderTagRouting(containerEl);
		}
		this.renderVaultOutput(containerEl);
		this.renderOcrSettings(containerEl);
		this.renderAutoSyncSettings(containerEl);
		this.renderPro(containerEl);
		this.renderActions(containerEl, connected);
	}

	/**
	 * Pro in one place, low in the tab. The gated features carry a sentence and a pointer down here
	 * rather than a buy button of their own: a row at the top would ask a free user to pay before
	 * they have seen the plugin work, which is the one backlash trigger the research actually
	 * measured. Actions stays last, because those links are read when something has gone wrong.
	 */
	private renderPro(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Tagged Sync Pro").setHeading();

		const entitlement = this.plugin.entitlement();
		const status = licenceStatusText(entitlement, this.plugin.data.licence);
		const statusRow = new Setting(containerEl).setName(status.heading).setDesc(status.body);

		if (entitlement.tier === "trial") {
			const left = trialDaysLeft(this.plugin.data.licence, new Date());
			statusRow.setDesc(`${status.body} ${left} day(s) left.`);
		}

		// One click, no key, no email. The trial is the only way a Windows or Linux user can judge
		// cloud transcription before paying, and it costs nothing to give: the tester pays their own
		// API bill. There is deliberately no restart button -- one would turn the purchase into a
		// donation.
		if (this.plugin.data.licence.trialStartedAt === null) {
			statusRow.addButton((button) =>
				button
					.setButtonText("Start free trial")
					.setCta()
					.onClick(async () => {
						this.plugin.data.licence = startTrial(this.plugin.data.licence, new Date());
						await this.plugin.saveData(this.plugin.data);
						this.display();
					}),
			);
		}

		if (entitlement.tier !== "pro") {
			statusRow.addButton((button) => button.setButtonText("Buy").onClick(() => window.open(PRO_BUY_URL)));
		}

		if (entitlement.tier === "pro") {
			statusRow.addButton((button) =>
				button.setButtonText("Manage devices").onClick(() => window.open(PRO_PORTAL_URL)),
			);
			statusRow.addButton((button) =>
				button.setButtonText("Deactivate this vault").onClick(async () => {
					await deactivateHere(this.plugin.data.licence, this.plugin.licenceApi);
					this.plugin.data.licence = withoutLicence(this.plugin.data.licence);
					await this.plugin.saveData(this.plugin.data);
					this.display();
				}),
			);
		} else {
			this.renderLicenceKeyField(containerEl);
			containerEl.createDiv({ cls: "tagged-sync-note", text: MONEY_BACK_MESSAGE });
		}
	}

	/**
	 * Where a bought key is pasted. Shown only while Pro is inactive, because a licensed vault has
	 * nothing to type here -- and a key field standing under an active licence invites someone to
	 * paste a second one over a working first.
	 */
	private renderLicenceKeyField(containerEl: HTMLElement): void {
		let typed = "";
		new Setting(containerEl)
			.setName("Licence key")
			.setDesc("Paste the key from your purchase page.")
			.addText((text) => text.onChange((value) => (typed = value)))
			.addButton((button) =>
				button.setButtonText("Activate").onClick(async () => {
					if (typed.trim() === "") return;
					button.setDisabled(true);
					const result = await activateKey(
						this.plugin.data.licence,
						typed,
						this.plugin.licenceApi,
						this.plugin.licenceContext(),
					);
					this.plugin.data.licence = result.state;
					await this.plugin.saveData(this.plugin.data);
					new Notice(activationMessage(result.outcome));
					this.display();
				}),
			);
	}

	/** Where a synced notebook lands and what it carries -- the two rows about the vault side. */
	private renderVaultOutput(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Vault output").setHeading();

		// Existing notes keep embedding the old path until their notebook next changes; moving the
		// files is the user's call, so the description says when the setting takes effect.
		new Setting(containerEl)
			.setName("Attachments folder")
			.setDesc("Vault folder for the rendered PDFs. Applies to notebooks synced from now on; already-synced files stay where they are.")
			.addText((text) => {
				// Don't hit data.json on every keystroke; the in-memory value updates immediately.
				const persist = debounce(() => void this.plugin.saveData(this.plugin.data), 500, true);
				text
					.setPlaceholder(DEFAULT_ATTACHMENTS_FOLDER)
					.setValue(this.plugin.data.attachmentsFolder)
					.onChange((value) => {
						this.plugin.data.attachmentsFolder = value;
						persist();
					});
			});

		// Off by default (F20). The description says what it does and what it costs -- a transcription
		// per note -- and settles the question the old wording answered wrongly: nothing is written to
		// the vault, because the handwriting is drawn out of the PDF that is already there.
		new Setting(containerEl)
			.setName("Handwritten notes")
			.setDesc(
				"Include handwritten margin notes in the digest of annotated PDFs. Each note is transcribed where a " +
					"transcription backend can run, and every entry can show the handwriting itself, drawn from the " +
					"embedded PDF when you ask for it. No images are added to your vault.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.data.marginNotes).onChange(async (value) => {
					this.plugin.data.marginNotes = value;
					// The device has not changed, so nothing would re-run without this: the switch decides
					// what a note *contains*, and every already-synced note has to be rewritten to match.
					this.plugin.data.syncIndex = invalidateRenders(this.plugin.data.syncIndex);
					await this.plugin.saveData(this.plugin.data);
				}),
			);
	}

	/**
	 * Closes the setup path on one screen: connect → discover → map → sync, with no README. Sync was
	 * reachable only from the command palette, and the plugin registers no ribbon icon.
	 */
	private renderActions(containerEl: HTMLElement, connected: boolean): void {
		new Setting(containerEl).setName("Actions").setHeading();

		if (connected) {
			new Setting(containerEl)
				.setName("Sync now")
				.setDesc("Fetch tagged notebooks and write them into your vault.")
				.addButton((button) =>
					button
						.setButtonText("Sync")
						.setCta()
						.onClick(() => this.plugin.syncNow()),
				);
		}

		new Setting(containerEl)
			.setName("Report a problem")
			.setDesc(
				createFragment((desc: DocumentFragment) => {
					desc.appendText("Copy your setup details, then open an issue at ");
					desc.createEl("a", { text: "GitHub", href: ISSUES_URL });
					desc.appendText(" and paste them in. Nothing is sent from here.");
				}),
			)
			.addButton((button) =>
				button.setButtonText("Copy diagnostics").onClick(async () => {
					await navigator.clipboard.writeText(
						buildDiagnostics({
							pluginVersion: this.plugin.manifest.version,
							obsidianVersion: apiVersion,
							platform: Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "other",
							visionAvailability: visionUnavailableReason() ?? "available",
							backend: this.plugin.data.ocrBackend,
							visionRevision: visionRunStats.revision,
							unreadableInkRegions: visionRunStats.unreadableInkRegions,
							mappedTagCount: Object.keys(this.plugin.data.tagFolderMap).length,
							lastSyncAt: this.plugin.data.lastSyncAt,
							lastSyncError: this.plugin.lastSyncError,
						}),
					);
					new Notice("Diagnostics copied to the clipboard.");
				}),
			);

		new Setting(containerEl)
			.setName("Request a feature")
			.setDesc(
				createFragment((desc: DocumentFragment) => {
					desc.appendText("Suggest a feature on ");
					desc.createEl("a", { text: "GitHub", href: FEATURE_REQUEST_URL });
					desc.appendText(" or vote on ");
					desc.createEl("a", { text: "existing requests", href: FEATURE_VOTING_URL });
					desc.appendText(" with a 👍 reaction.");
				}),
			);
	}

	private renderOcrSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Transcription").setHeading();

		new Setting(containerEl)
			.setName("Backend")
			// Composed from what is actually registered, because the three cases are three different
			// promises and one sentence cannot make all of them (free-localhost-ocr spec §4.1).
			.setDesc(
				[
					"Apple Vision runs locally and privately on macOS 13 or later — no account, key, or network.",
					// Covers both unmetered families in one clause, because both are true of both: the
					// downloadable model and a server you run yourself. Not "sends nothing anywhere" --
					// a `custom` endpoint may well be another box on your LAN, and the honest claim is
					// about who owns it, not about whether a packet moves.
					hasOnDeviceBackends(ocrBackendEntries()) ? "A local model — downloaded, or a server you run yourself — needs no account and no key." : "",
					hasCloudBackends(ocrBackendEntries()) ? "The cloud providers send each page's render to that provider, using your own API key." : "",
				]
					.filter(Boolean)
					.join(" "),
			)
			.addDropdown((dropdown) => {
				for (const entry of ocrBackendEntries()) {
					// A backend whose gap its own setup card is already explaining is hidden rather than
					// shown disabled -- otherwise picking it would persist a setting that transcribes
					// nothing, since Obsidian saves a dropdown change the moment it is made.
					if (!isListedBackend(entry, this.plugin.data.ocrBackend)) continue;
					dropdown.addOption(entry.id, entry.label);
					// Show every backend; disable one that can't run here, so the gap explains itself in place (spec §4.2).
					const unavailable = entry.unavailableLabel?.();
					if (!unavailable) continue;
					// addOption() appends, so the entry just added is the last option.
					const option = dropdown.selectEl.options[dropdown.selectEl.options.length - 1];
					option.disabled = true;
					option.text = unavailable;
				}
				dropdown.setValue(this.plugin.data.ocrBackend);
				dropdown.onChange(async (value) => {
					this.plugin.data.ocrBackend = value;
					await this.plugin.saveData(this.plugin.data);
					this.display();
				});
			});

		// Flat-text ceiling hint (structure-preserving-ocr spec §3.2): the moment the user picks a
		// backend is where the Apple-Vision structure limit earns its place. Off macOS, Vision is not
		// selectable at all, so its ceiling is noise -- say nothing rather than name a limit of a
		// backend this system cannot run.
		//
		// The selected backend's own contract wins where it has one: with the local model chosen,
		// Vision's flat-text ceiling is no longer what the user's notes will look like, and claiming
		// parity with the cloud providers would be wrong in the other direction -- the single table in
		// the corpus came back as 24 bullets.
		const selectedContract = ocrBackendEntry(this.plugin.data.ocrBackend)?.noteContract;
		const hint =
			selectedContract ??
			[
				visionPlatformSupported() ? "Apple Vision: flat text only, no headings or tables." : "",
				hasAlternativeBackends(ocrBackendEntries()) ? "Choose an LLM backend for structured Markdown." : "",
			]
				.filter(Boolean)
				.join(" ");
		if (hint) containerEl.createDiv({ cls: "tagged-sync-note", text: hint });

		// One context shape for both hooks, so a backend's rows and its card get the same powers.
		const contextFor = (backendId: string) => ({
			settings: (this.plugin.data.llmProviders[backendId] ??= {}),
			save: () => this.plugin.saveData(this.plugin.data),
			isSelected: backendId === this.plugin.data.ocrBackend,
			selectDefaultBackend: async () => {
				this.plugin.data.ocrBackend = defaultOcrBackend(visionPlatformSupported());
				await this.plugin.saveData(this.plugin.data);
				this.display();
			},
		});

		const id = this.plugin.data.ocrBackend;
		ocrBackendEntry(id)?.renderSettings?.(containerEl, contextFor(id));

		// Setup cards, for *every* registered backend rather than the selected one. A backend that has
		// to be downloaded before it can be chosen is not selectable yet, so `renderSettings` above
		// would never fire for it and it would have no way to say what it needs.
		for (const entry of ocrBackendEntries()) {
			entry.renderSetup?.(containerEl, contextFor(entry.id));
		}
	}

	/**
	 * Opt-in background sync (auto-sync spec §"Settings & data model"), placed after OCR because the
	 * metered-consent toggle references the chosen backend. Conditional rows (interval, metered
	 * consent) appear only when relevant; every change persists, re-arms the interval timer, and
	 * re-renders so the conditional rows update.
	 */
	private renderAutoSyncSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Automatic sync").setHeading();

		const auto = this.plugin.data.autoSync;
		const persist = async () => {
			await this.plugin.saveData(this.plugin.data);
			this.plugin.rearmAutoSyncInterval();
			this.display();
		};

		new Setting(containerEl)
			.setName("Enable automatic sync")
			.setDesc("Sync on launch and periodically while Obsidian is open.")
			.addToggle((toggle) =>
				toggle.setValue(auto.enabled).onChange(async (value) => {
					auto.enabled = value;
					await persist();
				}),
			);

		if (!auto.enabled) return;

		new Setting(containerEl)
			.setName("Sync interval")
			.setDesc("How often to re-sync during a long session. On-launch sync always runs.")
			.addDropdown((dropdown) => {
				dropdown.addOption("launch", "Only on launch");
				dropdown.addOption("2", "Every 2 hours");
				dropdown.addOption("6", "Every 6 hours");
				dropdown.addOption("12", "Every 12 hours");
				dropdown.addOption("24", "Every 24 hours");
				dropdown.setValue(auto.intervalHours === null ? "launch" : String(auto.intervalHours));
				dropdown.onChange(async (value) => {
					auto.intervalHours = value === "launch" ? null : Number(value);
					await persist();
				});
			});

		// The canonical control for a backend whose background cost is not money but battery, fans and
		// several GB of RAM. It is asked a second time on that backend's own setup card, where the
		// runtime estimate is already on the user's eye; both write this same value.
		const selected = ocrBackendEntry(this.plugin.data.ocrBackend);
		if (selected?.needsBackgroundConsent && selected.backgroundConsent) {
			const consent = selected.backgroundConsent;
			const blob = (this.plugin.data.llmProviders[selected.id] ??= {});
			new Setting(containerEl)
				.setName("Transcribe during background sync")
				.setDesc(consent.description)
				.addToggle((toggle) =>
					toggle.setValue(consent.get(blob)).onChange(async (value) => {
						consent.set(blob, value);
						await persist();
					}),
				);
		}

		// Money-safety consent (spec §"Money-safety gate"): only meaningful for a metered cloud backend.
		if (isMeteredProvider(this.plugin.data.ocrBackend)) {
			new Setting(containerEl)
				.setName("Automatically transcribe during background sync (uses your paid API)")
				.setDesc("Off by default: background sync is suppressed on a metered backend until you allow it here. Manual syncs are unaffected.")
				.addToggle((toggle) =>
					toggle.setValue(auto.autoTranscribeMetered).onChange(async (value) => {
						auto.autoTranscribeMetered = value;
						await persist();
					}),
				);
		}
	}

	private renderTagRouting(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Tag routing").setHeading();

		new Setting(containerEl)
			.setName("Discover tags")
			.setDesc("Scan your reMarkable notebooks and pages for tags.")
			.addButton((button) =>
				button.setButtonText("Scan").onClick(async () => {
					button.setDisabled(true);
					try {
						const sessionToken = await this.plugin.auth.session();
						const api = openSession(sessionToken);
						const notebooks = await enumerateNotebookTags(api);
						this.discoveredTags = collectTagNames(notebooks);
						new Notice(`Found ${this.discoveredTags.length} tag(s).`);
					} catch (error) {
						new Notice(`Failed to discover tags: ${(error as Error).message}`);
					}
					this.display();
				}),
			);

		const mapping = this.plugin.data.tagFolderMap;
		const view = planTagRouting({
			mapping,
			discoveredTags: this.discoveredTags,
			// The root always exists, so even a brand-new empty vault has one valid target.
			folderPaths: [
				"/",
				...this.app.vault
					.getAllLoadedFiles()
					.filter((file): file is TFolder => file instanceof TFolder && !file.isRoot())
					.map((folder) => folder.path)
					.sort(),
			],
			entitlement: this.plugin.entitlement(),
		});

		const persist = async () => {
			await this.plugin.saveData(this.plugin.data);
			this.display();
		};

		for (const item of view.items) {
			if (item.kind === "notice") {
				containerEl.createDiv({ cls: "tagged-sync-note", text: item.text });
				continue;
			}
			const row = new Setting(containerEl).setName(item.tag).setDesc(item.desc);
			if (item.kind === "capped") continue;

			// A mapped tag used to render read-only, so a wrong first choice could only be undone by
			// editing data.json by hand. Harmless before the cap; a trap with it, since the one slot
			// would be stuck.
			row.addDropdown((dropdown) => {
				for (const option of item.options) dropdown.addOption(option.value, option.label);
				if (item.kind === "mapped") dropdown.setValue(item.folder);
				dropdown.onChange(async (value) => {
					if (!value) return;
					// The one gated feature that exists today: a mapping past the free cap. This is the
					// moment the licence is *used*, so it is the moment it is re-checked -- not on load,
					// and never for a free user, who cannot reach this branch at all.
					if (
						item.kind === "mappable" &&
						view.recheckLicenceBeforeAdd &&
						(await this.plugin.refreshLicence()).tier === "free"
					) {
						this.display();
						return;
					}
					mapping[item.tag] = value;
					await persist();
				});
			});
			if (item.kind !== "mapped") continue;
			row.addButton((button) => {
				button.setButtonText("Remove").onClick(async () => {
					delete mapping[item.tag];
					await persist();
				});
				// `setWarning()` is deprecated and `setDestructive()` needs 1.13, while the manifest
				// floor is 1.5.7 -- the class both of them set predates both.
				button.buttonEl.addClass("mod-warning");
			});
		}
	}
}
