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
import { confirmDialog } from "./confirm-modal";
import { explainError } from "./explain-error";
import { frontmatterAllowed } from "./frontmatter";
import { activateKey, deactivateHere } from "./licence-check";
import { activationMessage, licenceStatusText, MONEY_BACK_MESSAGE, trialDaysLeft } from "./licence-messages";
import { startTrial, withoutLicence } from "./licence-state";
import type TaggedSyncPlugin from "./main";
import { defaultOcrBackend, hasAlternativeBackends, hasCloudBackends, hasOnDeviceBackends } from "./ocr-resolution";
import { isListedBackend, ocrBackendEntries, ocrBackendEntry } from "./ocr-registry";
import { DeviceUnreachableError, USB_HOST } from "./ssh-connection";
import { pairDevice, PairingRefusedError, pairingGuidance } from "./ssh-pairing";
import { allowedTransports, DEFAULT_SSH_SETTINGS, isPaired } from "./ssh-transport";
import type { TransportId, TransportSession } from "./transport";
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

export class TaggedSyncSettingTab extends PluginSettingTab {
	private code = "";
	private discoveredTags: string[] = [];
	/** What the pairing row holds between keystrokes. The password is dropped the moment it is used. */
	private deviceHost = "";
	private devicePassword = "";

	constructor(
		app: App,
		private readonly plugin: TaggedSyncPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const connected = this.plugin.transport().status().connected;
		this.renderSources(containerEl);

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
	 * Where this vault reads from, and what it falls back to.
	 *
	 * Rendered above the cloud account rather than beside it, because with two sources the first
	 * question is which one is in use -- and the row a free user sees here is the only place the
	 * direct-device feature explains itself before it is bought.
	 */
	private renderSources(containerEl: HTMLElement): void {
		const data = this.plugin.data;
		const allowed = allowedTransports(this.plugin.entitlement());
		const label = (id: TransportId): string => (id === "ssh" ? "Your reMarkable directly (USB or Wi-Fi)" : "reMarkable cloud");

		// A heading, like every other group on this page. Without one these rows read as loose settings
		// belonging to nothing, and once there are two sources and a fallback that is three or four of
		// them in a row -- which is exactly where the eye needs somewhere to start.
		new Setting(containerEl).setName("Where your notes come from").setHeading();

		const source = new Setting(containerEl)
			.setName("Sync from")
			// What the choice *means*, not where the device is: the address belongs to the device row
			// below, and saying it twice makes the reader check whether the two agree.
			.setDesc(
				data.primaryTransport === "ssh"
					? "Read straight off the tablet. No reMarkable account is involved."
					: "Through your reMarkable account, as before.",
			);
		source.addDropdown((dropdown) => {
			for (const id of ["cloud", "ssh"] as const) {
				dropdown.addOption(id, allowed.includes(id) ? label(id) : `${label(id)} (Pro)`);
				// Shown and disabled rather than hidden: a feature a free user cannot see is one they
				// cannot decide to buy, and Obsidian saves a dropdown change the moment it is made.
				if (!allowed.includes(id)) {
					dropdown.selectEl.options[dropdown.selectEl.options.length - 1].disabled = true;
				}
			}
			dropdown.setValue(data.primaryTransport);
			dropdown.onChange(async (value) => {
				data.primaryTransport = value as TransportId;
				if (data.fallbackTransport === data.primaryTransport) data.fallbackTransport = null;
				await this.plugin.saveData(data);
				this.display();
			});
		});

		new Setting(containerEl)
			.setName("If that is not reachable")
			.setDesc(
				"Both sources hand this plugin the same content, so switching between them costs nothing and re-transcribes nothing.",
			)
			.addDropdown((dropdown) => {
				const other: TransportId = data.primaryTransport === "cloud" ? "ssh" : "cloud";
				dropdown.addOption("none", "Stop and say so");
				dropdown.addOption(other, `Try ${label(other)}`);
				if (!allowed.includes(other)) dropdown.selectEl.options[1].disabled = true;
				dropdown.setValue(data.fallbackTransport ?? "none");
				dropdown.onChange(async (value) => {
					data.fallbackTransport = value === "none" ? null : (value as TransportId);
					await this.plugin.saveData(data);
					this.display();
				});
			});

		if (data.primaryTransport === "ssh" || data.fallbackTransport === "ssh") this.renderDevicePairing(containerEl);
		this.renderCloudConnection(containerEl);
	}

	/**
	 * Pairing, which costs a root password once and a key from then on.
	 *
	 * The address field is optional on purpose: the cable answers at a fixed address, so somebody who
	 * has just plugged their tablet in should not have to go and look anything up.
	 */
	private renderDevicePairing(containerEl: HTMLElement): void {
		const ssh = this.plugin.data.ssh;

		if (isPaired(ssh)) {
			new Setting(containerEl)
				.setName("Your reMarkable")
				.setDesc(`Paired with root@${ssh.host} · host key pinned`)
				.addButton((button) =>
					// Offered here because it is the action every failure message asks for -- a refused key
					// and a changed host key both end in "pair again", and both leave the address correct.
					button.setButtonText("Re-pair").onClick(async () => {
						// Carried into the form below rather than left in `data.ssh` alone, where it would be
						// stored and invisible: somebody re-pairing a tablet they reached over Wi-Fi is doing
						// it *because* it stopped answering, and making them go and find the address again at
						// that moment is the worst time to ask. The cable's address is the field's default
						// anyway, so there is nothing to carry for a cable-paired device.
						this.deviceHost = ssh.host === USB_HOST ? "" : ssh.host;
						this.plugin.data.ssh = { ...ssh, privateKey: null, hostKeyFingerprint: null };
						await this.plugin.saveData(this.plugin.data);
						this.display();
					}),
				)
				.addButton((button) =>
					button.setButtonText("Forget device").onClick(async () => {
						// The key stays on the tablet: removing it would need the password again, and this
						// button is what somebody presses *because* they can no longer reach the device.
						this.deviceHost = "";
						this.plugin.data.ssh = { ...DEFAULT_SSH_SETTINGS };
						this.plugin.data.sshHashes = {};
						await this.plugin.saveData(this.plugin.data);
						this.display();
					}),
				);
			return;
		}

		new Setting(containerEl)
			.setName("Connect device")
			.setDesc(
				createFragment((desc: DocumentFragment) => {
					desc.appendText("Connect the tablet by USB, or give its Wi-Fi address. ");
					desc.appendText("The root password is on the tablet under Settings → Help → About → ");
					desc.appendText("Copyrights and licenses. It is used once and never stored.");
				}),
			)
			.addText((text) =>
				text
					.setPlaceholder(`Address (default ${USB_HOST})`)
					// So the field on screen and what a "Pair" would actually use are never two different
					// things -- which is what an address carried in from "Re-pair", or left over from an
					// attempt that failed, would otherwise be.
					.setValue(this.deviceHost)
					.onChange((value) => {
						this.deviceHost = value.trim();
					}),
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setPlaceholder("Root password").onChange((value) => {
					this.devicePassword = value;
				});
			})
			.addButton((button) =>
				button
					.setButtonText("Pair")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						await this.pairDevice();
						button.setDisabled(false);
					}),
			);

		// Before the attempt, not after it. On a Paper Pro or Paper Pure the answer to "nothing
		// happens" is a factory reset, and nobody should meet that fact halfway through pairing --
		// finding it out afterwards is the worst possible moment. Folded away so an rM2 owner, who
		// needs none of it, is not made to read it.
		const help = containerEl.createEl("details", { cls: "tagged-sync-pairing-help" });
		help.createEl("summary", { text: "What your reMarkable needs before this works" });
		for (const line of pairingGuidance("unknown")) help.createEl("p", { text: line });
	}

	/** One pairing attempt, and what to say about however it ended. */
	private async pairDevice(): Promise<void> {
		const host = this.deviceHost === "" ? null : this.deviceHost;
		try {
			const settings = await pairDevice({
				host,
				password: this.devicePassword,
				confirmHostKey: (fingerprint) =>
					confirmDialog(
						this.app,
						"Trust this reMarkable?",
						`The device identifies itself as ${fingerprint}. This vault will refuse to connect if it ever presents a different key.`,
						"Trust",
					),
				confirmWifi: () =>
					confirmDialog(
						this.app,
						"Allow SSH over Wi-Fi?",
						"Your reMarkable can keep accepting connections over Wi-Fi, so syncing does not need the cable. " +
							"It means the tablet listens for SSH on whatever network it joins. Say no to keep it cable-only.",
						"Allow",
					),
				report: (step) => new Notice(step),
			});
			this.plugin.data.ssh = settings;
			await this.plugin.saveData(this.plugin.data);
			new Notice(`Paired with your reMarkable at ${settings.host}.`);
		} catch (error) {
			if (error instanceof PairingRefusedError) {
				new Notice(error.message);
				return;
			}
			// A tablet that did not answer at all is the case worth a paragraph rather than a line: on a
			// Paper Pro or Paper Pure the answer is a factory reset, and nobody should meet that fact
			// halfway through.
			if (error instanceof DeviceUnreachableError) {
				// Which tablet this is cannot be known when it did not answer, so the guidance covers both
				// -- including, out loud, the one whose answer is a factory reset.
				new Notice(pairingGuidance("unknown").join("\n\n"), 20_000);
				return;
			}
			new Notice(this.plugin.transportError(error, "connect"), 15_000);
		} finally {
			// However it went. A root password kept in a settings tab after the attempt that needed it is
			// one nobody asked to store, and the redraw is what makes the emptied field visible rather
			// than leaving the box on screen full of a password the next "Pair" would no longer send.
			this.devicePassword = "";
			this.display();
		}
	}

	/** The cloud account: one-time code in, device token out. Unchanged by the second transport. */
	private renderCloudConnection(containerEl: HTMLElement): void {
		const cloudStatus = this.plugin.cloudTransportStatus();
		const connectionSetting = new Setting(containerEl)
			// "reMarkable connection" was unambiguous while there was one; beside a paired tablet it reads
			// as though it might be either. This row is the account, and says so.
			.setName("reMarkable cloud account")
			.setDesc(cloudStatus.summary);

		if (cloudStatus.connected) {
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

		// Shown and disabled for free users rather than hidden -- the same rule as the transport
		// dropdown above: a feature a free user cannot see is one they cannot want.
		const frontmatterUnlocked = frontmatterAllowed(this.plugin.entitlement());
		new Setting(containerEl)
			.setName(frontmatterUnlocked ? "Frontmatter properties" : "Frontmatter properties (Pro)")
			.setDesc(
				frontmatterUnlocked
					? "Write each note's reMarkable tags and metadata (folder, modified, type, …) into its frontmatter, for Dataview and Bases. " +
							"Turning this on writes the properties into every synced note; turning it off removes them again. Your own frontmatter lines are never touched."
					: "Write each note's reMarkable tags and metadata into its frontmatter, for Dataview and Bases. Part of Tagged Sync Pro -- see below.",
			)
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.data.frontmatter).setDisabled(!frontmatterUnlocked);
				toggle.onChange(async (value) => {
					// A click that changes nothing (see below) must not run a pass.
					if (value === this.plugin.data.frontmatter) return;
					// The plugin runs the backfill/cleanup pass and persists only what actually happened, so
					// the toggle is set back to the outcome instead of assuming the click succeeded. setValue
					// fires this handler again (read out of obsidian-1.13.7's app.js); the guard above is
					// what keeps a refused enable from turning into a spurious cleanup pass.
					await this.plugin.setFrontmatterEnabled(value);
					toggle.setValue(this.plugin.data.frontmatter);
				});
			});
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
					let session: TransportSession | null = null;
					try {
						// Through the same chain a sync uses, so a vault that configured a fallback gets one
						// here too rather than only on the job this was written for.
						session = (await this.plugin.openSource()).session;
						const notebooks = await enumerateNotebookTags(session.api);
						this.discoveredTags = collectTagNames(notebooks);
						new Notice(`Found ${this.discoveredTags.length} tag(s).`);
					} catch (error) {
						new Notice(`Failed to discover tags: ${(error as Error).message}`);
					} finally {
						await session?.close();
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
