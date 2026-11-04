import {
	type App,
	apiVersion,
	debounce,
	type ExtraButtonComponent,
	FuzzySuggestModal,
	Notice,
	Platform,
	PluginSettingTab,
	type Setting,
	type SettingDefinition,
	type SettingDefinitionGroup,
	type SettingDefinitionItem,
	type SettingDefinitionPage,
	type SettingDefinitionRender,
	TFolder,
} from "obsidian";
import { DEFAULT_ATTACHMENTS_FOLDER } from "./attachment-writer";
import { isMeteredProvider } from "./auto-sync";
import { buildDiagnostics } from "./diagnostics";
import { confirmDialog } from "./confirm-modal";
import { explainError } from "./explain-error";
import { frontmatterAllowed } from "./frontmatter";
import { activateKey, deactivateHere } from "./licence-check";
import { activationMessage, licenceStatusText, MONEY_BACK_MESSAGE, TAG_CAP_MESSAGE, trialDaysLeft, trialStartFailed } from "./licence-messages";
import { withoutLicence } from "./licence-state";
import type TaggedSyncPlugin from "./main";
import { startTrial, TrialStartError } from "./trial-ticket";
import { backendPromise, defaultOcrBackend, hasAlternativeBackends } from "./ocr-resolution";
import { BACKGROUND_CONSENT_NAME, ocrBackendEntries, ocrBackendEntry } from "./ocr-registry";
import { DeviceUnreachableError, USB_HOST } from "./ssh-connection";
import { pairDevice, PairingRefusedError, pairingGuidance } from "./ssh-pairing";
import { SSH_SEND_RESTART_NOTE } from "./ssh-send";
import { DEFAULT_SEND_TAG } from "./zotero-send";
import { allowedTransports, DEFAULT_SSH_SETTINGS, isPaired } from "./ssh-transport";
import type { TransportId, TransportSession } from "./transport";
import { collectTagNames, enumerateNotebookTags } from "./remarkable-tags";
import { createReadwiseClient } from "./readwise-client";
import {
	type ReadwiseConnection,
	readwiseClashed,
	readwiseConnectionLine,
	readwiseDiagnosticsLine,
	readwisePageEntry,
	readwiseProAllowed,
	startOverReadwise,
	tokenFingerprint,
} from "./readwise-push";
import { pendingOcrRetries } from "./sync-engine";
import { folderLabel, type MappedTag, planTagRouting, REMOVAL_MESSAGE, type UnmappedTag } from "./tag-routing-view";
import { DEFAULT_SEND_FOLDER } from "./zotero-send";
import { describeZoteroError } from "./zotero-writeback";
import { visionPlatformSupported, visionUnavailableReason } from "./vision-ocr-runtime";
import { linkedDocumentIds } from "./zotero-links";
import { webConfigured, zoteroDiagnosticsLine, zoteroPageEntry, zoteroProAllowed } from "./zotero-settings";
import type { ZoteroGroup } from "./zotero-client";
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
 * it is being *asked for*: `planTagRouting`, `backendPromise`, `licenceStatusText`,
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

/** Settings-redesign spec §2.2: what a row that threw says instead, and what the tab says if it cannot be built. */
const ROW_FAILED = "This row could not be drawn. Copy diagnostics under Help and report it.";

/** The text keys: saved through one debounce, as their fields always were (spec §2.3). */
const TYPED_KEYS = new Set(["attachmentsFolder", "zotero.apiKey", "zotero.folder", "zotero.sendTag"]);

/** What a typed or picked key stores (spec §6.1, §6.4, §7). */
const SET_RULES: Record<string, (typed: string) => unknown> = {
	// The Keychain picker hands back `null` when the choice is cleared; no entry is no name, not `""`.
	"readwise.tokenSecret": (picked) => picked || null,
	// `""` would be a configured connection that answers 401 to every call: a cleared field is no key.
	"zotero.apiKey": (typed) => (typed === "" ? null : typed),
	// Blank is the default rather than a folder with no name: a document put at the root of the tablet
	// is one the user has to go looking for.
	"zotero.folder": (typed) => typed.trim() || DEFAULT_SEND_FOLDER,
	"zotero.sendTag": (typed) => typed.trim(),
};

/** A group library's switch, `zotero.group:<id>` (spec §6.2). */
const GROUP_KEY = "zotero.group:";
const groupKey = (group: ZoteroGroup): string => `${GROUP_KEY}${group.id}`;

/**
 * *Sync interval*'s options. Not numeric keys: an object lists integer-like keys first, which would put
 * "Only on launch" last (spec §3.5).
 */
const INTERVALS: Record<string, string> = {
	launch: "Only on launch",
	h2: "Every 2 hours",
	h6: "Every 6 hours",
	h12: "Every 12 hours",
	h24: "Every 24 hours",
};

export class TaggedSyncSettingTab extends PluginSettingTab {
	private code = "";
	/**
	 * What the last scan found, kept for the Obsidian session -- the tab is built once, in `onload` --
	 * and never in `data.json`; `null` before the first scan (settings-redesign spec §4.1).
	 */
	private foundTags: string[] | null = null;
	private scanning = false;
	/** What the Tag routing filter holds, and the pill row's handle to filter its pills by it (spec §4.3). */
	private tagFilter = "";
	private pillRow: { filter(query: string): void } | null = null;
	/** What the last plan mapped and whether it offers the filter, for {@link matchTag}. */
	private mappedTags: readonly MappedTag[] = [];
	private filterShown = false;
	/** The heading's scan icon, which a redraw does not draw again. */
	private scanIcon: ExtraButtonComponent | null = null;
	/** What the pairing row holds between keystrokes. The password is dropped the moment it is used. */
	private deviceHost = "";
	private devicePassword = "";
	/** `data.json` is not written on every keystroke; the in-memory value is current at once. */
	private readonly persistTyped = debounce(() => void this.plugin.saveData(this.plugin.data), 500, true);
	/** The Zotero *Connection* line's probe, while the line is on screen (spec §2.8). */
	private refreshZoteroLine: (() => void) | null = null;
	/** The key field asks the line again once the typing stops. */
	private readonly recheckZotero = debounce(() => this.refreshZoteroLine?.(), 600, true);
	/** The Readwise *Connection* line's probe, while the line is on screen (spec §2.8). */
	private refreshReadwiseLine: (() => void) | null = null;

	constructor(
		app: App,
		private readonly plugin: TaggedSyncPlugin,
	) {
		super(app, plugin);
	}

	/**
	 * The whole tab, as Obsidian 1.13's declarative settings API asks for it (settings-redesign spec
	 * §3): eight groups on the root page, Zotero and Readwise as pages under *Integrations*. Asked for
	 * on every opening and by every `update()`, so it reads the state and does no network I/O.
	 *
	 * A row that changes the page calls `update()`, which keeps the reader's place itself (ticket 17's
	 * F1, spec §2.5).
	 *
	 * It runs inside `onload` too (`addSettingTab`), where a throw would stop the plugin, so a throw
	 * here becomes one row instead.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		try {
			const connected = this.plugin.transport().status().connected;
			return [
				this.connectionGroup(connected),
				...(connected ? [this.tagGroup()] : []),
				this.vaultGroup(),
				this.transcriptionGroup(),
				this.autoSyncGroup(),
				{
					type: "group",
					heading: "Integrations",
					cls: "tagged-sync-group-integrations",
					items: [this.zoteroPage(), this.readwisePage()],
				},
				this.proGroup(),
				this.helpGroup(),
			];
		} catch (error) {
			console.error("Tagged Sync: the settings could not be drawn", error);
			return [{ name: "The settings could not be drawn.", desc: "Report it with the steps that led here." }];
		}
	}

	/**
	 * A render callback that cannot blank the tab (spec §2.2): a throw is logged and the row says so,
	 * and every other row still draws. Tearing the row down writes what is still held for a text key.
	 */
	private guarded(name: string, render: SettingDefinitionRender["render"]): SettingDefinitionRender["render"] {
		return (setting, group) => {
			let cleanup: void | (() => void);
			try {
				cleanup = render(setting, group);
			} catch (error) {
				console.error(`Tagged Sync: the settings row "${name}" could not be drawn`, error);
				setting.settingEl.empty();
				setting.settingEl.addClass("setting-item");
				setting.settingEl.appendChild(setting.infoEl);
				setting.setDesc(ROW_FAILED);
			}
			return () => {
				cleanup?.();
				this.persistTyped.run();
			};
		};
	}

	/**
	 * A predicate that cannot blank the tab -- {@link guarded}'s twin for `visible`, `disabled`,
	 * `displayValue` and `status` (spec §2.2): a throw is logged and answers `safe`, the value that shows
	 * nothing broken (hidden, disabled, no value, no status).
	 */
	private guardedValue<T>(name: string, safe: T, test: () => T): () => T {
		return () => {
			try {
				return test();
			} catch (error) {
				console.error(`Tagged Sync: the settings row "${name}" could not be evaluated`, error);
				return safe;
			}
		};
	}

	/**
	 * A key into `data.json`, one level deep at most: `marginNotes`, `zotero.useWeb`, `readwise.push`, …
	 * (spec §2.3). `autoSync.interval` is *Sync interval*'s option key for `autoSync.intervalHours`, and
	 * `zotero.group:<id>` whether that group library is switched on.
	 */
	getControlValue(key: string): unknown {
		if (key.startsWith(GROUP_KEY)) return this.plugin.data.zotero.groups.some((group) => groupKey(group) === key);
		if (key === "autoSync.interval") {
			const hours = this.plugin.data.autoSync.intervalHours;
			return hours === null ? "launch" : `h${hours}`;
		}
		const [head, sub] = key.split(".");
		const value = (this.plugin.data as unknown as Record<string, unknown>)[head];
		return sub === undefined ? value : (value as Record<string, unknown>)[sub];
	}

	/**
	 * Stores a control's value (spec §2.3). The value already stored is no change: a toggle's
	 * `setValue` fires its change again, and a re-render that sets would loop. A nested value replaces
	 * its object rather than mutating it, as the rows always have: a running sync may hold the old one.
	 * A key that names nothing in `data.json` is refused: writing it would change the file's shape.
	 *
	 * Then the key's side effect: an automatic-sync change re-arms the
	 * timer, so it takes effect now rather than at the next launch; a Zotero connection switch draws the
	 * page again, which is now about a different set of connections. The Readwise switch asks the line
	 * again; another Readwise token forgets what readwise.io said about the old one and draws the page
	 * again.
	 */
	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "autoSync.interval") return this.setControlValue("autoSync.intervalHours", value === "launch" ? null : Number(String(value).slice(1)));
		if (key.startsWith(GROUP_KEY)) return this.setZoteroGroup(key, value === true);
		const [head, sub] = key.split(".");
		const data = this.plugin.data as unknown as Record<string, unknown>;
		if (!(head in data) || (sub !== undefined && !(sub in (data[head] as object)))) throw new Error(`Tagged Sync: no setting "${key}"`);
		const stored = key in SET_RULES ? SET_RULES[key](String(value ?? "")) : value;
		if (this.getControlValue(key) === stored) return;
		// The next sync makes notes due if a switch still differs then (`settleMarginNotesChoice`,
		// `settleZoteroSwitches`), so a switch knocked off and back on reads nothing again. A vault that
		// has not recorded a value yet has the old one until then.
		if (key === "marginNotes") this.plugin.data.marginNotesSynced ??= this.plugin.data.marginNotes;
		if (key === "zotero.writeText" || key === "zotero.addRender") {
			const { writeText, addRender } = this.plugin.data.zotero;
			this.plugin.data.zoteroSwitchesSynced ??= { writeText, addRender };
		}
		data[head] = sub === undefined ? stored : { ...(data[head] as Record<string, unknown>), [sub]: stored };
		if (TYPED_KEYS.has(key)) this.persistTyped();
		else await this.plugin.saveData(this.plugin.data);
		if (head === "autoSync") this.plugin.rearmAutoSyncInterval();
		if (key === "zotero.useWeb" || key === "zotero.useLocal") this.update();
		if (key === "readwise.push") this.refreshReadwiseLine?.();
		if (key === "readwise.tokenSecret") {
			// What readwise.io said was about the old token (spec §5); the redraw asks about the new one.
			this.plugin.readwiseLastCheck = null;
			this.update();
		}
	}

	/** Settings may close with their own window; what was typed is written before they go. */
	hide(): void {
		this.persistTyped.run();
		super.hide();
	}

	/**
	 * Where this vault reads from, what it falls back to, and the two ways in: pairing and the cloud
	 * account (spec §3.1). *Sync now* first, once there is something to sync from (spec P1 (a)): it
	 * closes the setup path on one screen, and the palette was the only other way in.
	 *
	 * The sources come above the cloud account rather than beside it, because with two sources the
	 * first question is which one is in use -- and the row a free user sees here is the only place the
	 * direct-device feature explains itself before it is bought.
	 */
	private connectionGroup(connected: boolean): SettingDefinitionGroup {
		const data = this.plugin.data;
		const items: SettingDefinition[] = [];
		if (connected) {
			items.push({
				name: "Sync now",
				desc: "Fetch tagged notebooks and write them into your vault.",
				render: this.guarded("Sync now", (setting) => {
					setting.addButton((button) =>
						button
							.setButtonText("Sync")
							.setCta()
							.onClick(() => this.plugin.syncNow()),
					);
				}),
			});
		}
		items.push(
			{
				name: "Sync from",
				// What the choice *means*, not where the device is: the address belongs to the device row
				// below, and saying it twice makes the reader check whether the two agree.
				desc:
					data.primaryTransport === "ssh" ? "Read straight off the tablet. No reMarkable account is involved." : "Through your reMarkable account, as before.",
				aliases: ["source", "SSH", "USB", "Wi-Fi", "cloud"],
				render: this.guarded("Sync from", (setting) => this.renderSource(setting)),
			},
			{
				name: "If that is not reachable",
				desc: "Both sources hand this plugin the same content, so switching between them costs nothing and re-transcribes nothing.",
				render: this.guarded("If that is not reachable", (setting) => this.renderFallback(setting)),
			},
		);
		if (data.primaryTransport === "ssh" || data.fallbackTransport === "ssh") items.push(this.pairingRow());
		items.push(...this.cloudRows());
		return { type: "group", heading: "reMarkable connection", cls: "tagged-sync-group-connection", items };
	}

	private transportLabel(id: TransportId): string {
		return id === "ssh" ? "Your reMarkable directly (USB or Wi-Fi)" : "reMarkable cloud";
	}

	private renderSource(setting: Setting): void {
		const data = this.plugin.data;
		const allowed = allowedTransports(this.plugin.entitlement());
		setting.addDropdown((dropdown) => {
			for (const id of ["cloud", "ssh"] as const) {
				dropdown.addOption(id, allowed.includes(id) ? this.transportLabel(id) : `${this.transportLabel(id)} (Pro)`);
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
				this.update();
			});
		});
	}

	private renderFallback(setting: Setting): void {
		const data = this.plugin.data;
		const allowed = allowedTransports(this.plugin.entitlement());
		setting.addDropdown((dropdown) => {
			const other: TransportId = data.primaryTransport === "cloud" ? "ssh" : "cloud";
			dropdown.addOption("none", "Stop and say so");
			dropdown.addOption(other, `Try ${this.transportLabel(other)}`);
			if (!allowed.includes(other)) dropdown.selectEl.options[1].disabled = true;
			dropdown.setValue(data.fallbackTransport ?? "none");
			dropdown.onChange(async (value) => {
				data.fallbackTransport = value === "none" ? null : (value as TransportId);
				await this.plugin.saveData(data);
				this.update();
			});
		});
	}

	/**
	 * Pairing, which costs a root password once and a key from then on.
	 *
	 * The address field is optional on purpose: the cable answers at a fixed address, so somebody who
	 * has just plugged their tablet in should not have to go and look anything up.
	 */
	private pairingRow(): SettingDefinition {
		const ssh = this.plugin.data.ssh;
		if (!isPaired(ssh)) return this.connectDeviceRow();
		return {
			name: "Your reMarkable",
			desc: `Paired with root@${ssh.host} · host key pinned`,
			render: this.guarded("Your reMarkable", (setting) => {
				setting
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
							this.update();
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
							this.update();
						}),
					);
			}),
		};
	}

	private connectDeviceRow(): SettingDefinition {
		return {
			name: "Connect device",
			get desc() {
				return createFragment((desc: DocumentFragment) => {
					desc.appendText("Connect the tablet by USB, or give its Wi-Fi address. ");
					desc.appendText("The root password is on the tablet under Settings → Help → About → ");
					desc.appendText("Copyrights and licenses. It is used once and never stored.");
					// Before the attempt, not after it. On a Paper Pro or Paper Pure the answer to "nothing
					// happens" is a factory reset, and nobody should meet that fact halfway through pairing --
					// finding it out afterwards is the worst possible moment. Folded away so an rM2 owner, who
					// needs none of it, is not made to read it; in the description, because a group has no
					// loose text between its rows (spec P10).
					const help = desc.createEl("details", {
						cls: "tagged-sync-pairing-help",
					});
					help.createEl("summary", {
						text: "What your reMarkable needs before this works",
					});
					for (const line of pairingGuidance("unknown")) help.createEl("p", { text: line });
				});
			},
			render: this.guarded("Connect device", (setting) => {
				setting
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
			}),
		};
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
			this.update();
		}
	}

	/** The cloud account: one-time code in, device token out. Unchanged by the second transport. */
	private cloudRows(): SettingDefinition[] {
		const cloudStatus = this.plugin.cloudTransportStatus();
		const account: SettingDefinition = {
			// "reMarkable connection" was unambiguous while there was one; beside a paired tablet it reads
			// as though it might be either. This row is the account, and says so.
			name: "reMarkable cloud account",
			desc: cloudStatus.summary,
			render: this.guarded("reMarkable cloud account", (setting) => {
				if (!cloudStatus.connected) return;
				setting.addButton((button) =>
					button.setButtonText("Disconnect").onClick(async () => {
						await this.plugin.auth.disconnect();
						this.update();
					}),
				);
			}),
		};
		if (cloudStatus.connected) return [account];
		return [
			account,
			{
				name: "Connect",
				get desc() {
					return createFragment((desc: DocumentFragment) => {
						desc.appendText("Enter the one-time code from ");
						desc.createEl("a", {
							text: DEVICE_CONNECT_URL,
							href: DEVICE_CONNECT_URL,
						});
						desc.appendText(".");
					});
				},
				render: this.guarded("Connect", (setting) => {
					this.code = "";
					setting
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
										this.update();
									} catch (error) {
										new Notice(explainError(error, "connect"), 10_000);
									}
								}),
						);
				}),
			},
		];
	}

	/**
	 * Pro in one place, low in the tab. The gated features carry a sentence and a pointer down here
	 * rather than a buy button of their own: a row at the top would ask a free user to pay before
	 * they have seen the plugin work, which is the one backlash trigger the research actually
	 * measured. Help stays last, because those links are read when something has gone wrong.
	 */
	private proGroup(): SettingDefinitionGroup {
		const entitlement = this.plugin.entitlement();
		const status = licenceStatusText(entitlement, this.plugin.data.licence);
		const items: SettingDefinition[] = [
			{
				name: status.heading,
				desc: entitlement.tier === "trial" ? `${status.body} ${trialDaysLeft(this.plugin.data.licence, new Date())} day(s) left.` : status.body,
				render: this.guarded(status.heading, (setting) => this.renderLicenceButtons(setting)),
			},
		];
		// Where a bought key is pasted. Shown only while Pro is inactive, because a licensed vault has
		// nothing to type here -- and a key field standing under an active licence invites someone to
		// paste a second one over a working first. The money-back promise is its second sentence: a
		// group has no loose text between rows (spec P11).
		if (entitlement.tier !== "pro") {
			items.push({
				name: "Licence key",
				desc: `Paste the key from your purchase page. ${MONEY_BACK_MESSAGE}`,
				aliases: ["license"],
				render: this.guarded("Licence key", (setting) => this.renderLicenceKeyField(setting)),
			});
		}
		return { type: "group", heading: "Tagged Sync Pro", cls: "tagged-sync-group-pro", items };
	}

	/** The status row's buttons. Every one that changes the licence ends in `update()`: the "(Pro)" names everywhere depend on it. */
	private renderLicenceButtons(statusRow: Setting): void {
		const licenceRunning = this.plugin.entitlement().tier === "pro";
		// One click, no key, no email. The trial is the only way a Windows or Linux user can judge
		// cloud transcription before paying. There is deliberately no restart button -- one would turn
		// the purchase into a donation -- and since 1.8 the start date comes signed from taggedsync.com,
		// so deleting it by hand is not a restart either (`trial-ticket.ts`). A running licence has nothing
		// to try: the trial would unlock what it already unlocks.
		if (this.plugin.data.licence.trialStartedAt === null && !licenceRunning) {
			statusRow.addButton((button) =>
				button
					.setButtonText("Start free trial")
					.setCta()
					.onClick(async () => {
						const vault = await this.plugin.vaultHash();
						try {
							this.plugin.data.licence = await startTrial(
								this.plugin.data.licence,
								vault,
								this.plugin.trialIssuer,
								this.plugin.trialPublicKey,
							);
						} catch (error) {
							// `startTrial` throws nothing else: every failure inside it is caught and named.
							new Notice(trialStartFailed((error as TrialStartError).reason), 15_000);
							return;
						}
						await this.plugin.saveData(this.plugin.data);
						this.update();
					}),
			);
		}

		if (licenceRunning) {
			statusRow.addButton((button) =>
				button.setButtonText("Manage devices").onClick(() => window.open(PRO_PORTAL_URL)),
			);
			statusRow.addButton((button) =>
				button.setButtonText("Deactivate this vault").onClick(async () => {
					await deactivateHere(this.plugin.data.licence, this.plugin.licenceApi);
					this.plugin.data.licence = withoutLicence(this.plugin.data.licence);
					await this.plugin.saveData(this.plugin.data);
					this.update();
				}),
			);
		} else {
			statusRow.addButton((button) => button.setButtonText("Buy").onClick(() => window.open(PRO_BUY_URL)));
		}
	}

	private renderLicenceKeyField(setting: Setting): void {
		let typed = "";
		setting
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
					this.update();
				}),
			);
	}

	/** Where a synced notebook lands and what it carries -- the rows about the vault side (spec §3.3). */
	private vaultGroup(): SettingDefinitionGroup {
		// Shown and disabled for free users rather than hidden -- the same rule as the transport
		// dropdown above: a feature a free user cannot see is one they cannot want.
		const frontmatterUnlocked = frontmatterAllowed(this.plugin.entitlement());
		const frontmatterName = frontmatterUnlocked ? "Frontmatter properties" : "Frontmatter properties (Pro)";
		return {
			type: "group",
			heading: "Vault output",
			cls: "tagged-sync-group-vault",
			items: [
				{
					// Existing notes keep embedding the old path until their notebook next changes; moving the
					// files is the user's call, so the description says when the setting takes effect.
					name: "Attachments folder",
					desc: "Vault folder for the rendered PDFs. Applies to notebooks synced from now on; already-synced files stay where they are.",
					aliases: ["PDF folder", "render"],
					// A folder that does not exist yet is accepted and stored as typed (ticket 17's F3): it
					// is created at the first sync.
					control: {
						type: "folder",
						key: "attachmentsFolder",
						placeholder: DEFAULT_ATTACHMENTS_FOLDER,
						includeRoot: false,
					},
				},
				{
					// Off by default (F20). Named for what the reader put on a PDF rather than for handwriting
					// alone: since issue #247 it governs the text typed on a page added to a PDF as well
					// (zotero map ticket 01).
					name: "Your notes on PDFs",
					desc:
						"What you wrote or typed on an annotated PDF, beside the text or on a page you added. Handwriting is " +
						"transcribed where a transcription backend can run.",
					control: { type: "toggle", key: "marginNotes" },
				},
				{
					name: frontmatterName,
					desc: frontmatterUnlocked
						? "Write each note's reMarkable tags and metadata (folder, modified, type, …) into its frontmatter, for Dataview and Bases. " +
							"Turning this on writes the properties into every synced note; turning it off removes them again. Your own frontmatter lines are never touched."
						: "Write each note's reMarkable tags and metadata into its frontmatter, for Dataview and Bases. Part of Tagged Sync Pro -- see below.",
					// Drawn by our code, not a control: a refused switch has to be set back to what happened,
					// and Obsidian leaves a control showing what was clicked (ticket 17's F5).
					render: this.guarded(frontmatterName, (setting) => {
						setting.addToggle((toggle) => {
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
					}),
				},
			],
		};
	}

	/**
	 * Zotero, a page of its own under *Integrations* (settings-redesign spec §6, 05 #5): the connection
	 * group without a heading, then *Libraries*, *Into Zotero* and *Send to your tablet*. Each connection
	 * has a switch (asked for in the desk test of 2026-09-13): whether anything goes over the internet is
	 * then one visible thing, not "is the key field empty". Its entry on the root says what is set up
	 * (spec §5), read anew each time the root is drawn (ticket 17's F7).
	 *
	 * Shown to every vault: zotero.org, Send and the note's Zotero line are free (Zotero spec §5). The
	 * Pro rows -- the desktop app, the libraries, the two *Into Zotero* switches and Send over SSH -- are
	 * shown disabled with "(Pro)", the same rule as the transport dropdown and the frontmatter toggle: a
	 * feature a free user cannot see is one they cannot decide to buy.
	 */
	private zoteroPage(): SettingDefinitionPage {
		const pro = zoteroProAllowed(this.plugin.entitlement());
		const entry = () => zoteroPageEntry(this.plugin.data.zotero, this.plugin.entitlement());
		return {
			type: "page",
			name: "Zotero",
			displayValue: this.guardedValue("Zotero", "", () => entry().value),
			status: this.guardedValue<"warning" | null>("Zotero", null, () => entry().status),
			items: [this.zoteroConnectionGroup(pro), this.zoteroLibrariesGroup(pro), this.intoZoteroGroup(pro), this.zoteroSendGroup(pro)],
		};
	}

	/**
	 * The line, the two switches and the key (spec §6.1). Either switch changes what the whole page is
	 * about, so it ends in `update()` ({@link setControlValue}); the key row is in the page only while
	 * zotero.org is switched on, and a key pasted earlier stays in `data.json` for the day it is again.
	 */
	private zoteroConnectionGroup(pro: boolean): SettingDefinitionGroup {
		const items: SettingDefinition[] = [
			{
				name: "Connection",
				desc: pro
					? "Either connection is enough on its own. The desktop app works offline and knows where your PDFs are; zotero.org works with Zotero closed."
					: "zotero.org is enough: send papers to your tablet, and your notes know which paper they are. Writing your highlights into Zotero, and the desktop app connection, are part of Tagged Sync Pro.",
				render: this.guarded("Connection", (setting) => this.renderZoteroLine(setting)),
			},
			{
				name: "Use zotero.org",
				desc:
					"Your library is read over the internet, at zotero.org, and with write-back your highlights and notes are written there, and the render if you add it. " +
					"Works with Zotero closed; finds the PDFs synced to zotero.org. Off, nothing Zotero-related leaves this machine.",
				control: { type: "toggle", key: "zotero.useWeb" },
			},
		];
		if (this.plugin.data.zotero.useWeb) {
			items.push({
				name: "Zotero API key",
				desc: "From zotero.org → Settings → Security → New Key (Applications). Needs read and write access to your personal library. Stored locally in this vault's plugin data.",
				aliases: ["token"],
				render: this.guarded("Zotero API key", (setting) => this.renderZoteroKey(setting)),
			});
		}
		items.push({
			name: pro ? "Use the Zotero desktop app" : "Use the Zotero desktop app (Pro)",
			desc:
				'Needs Zotero 10 with "Allow other applications on this computer to communicate with Zotero" switched on (Settings → Advanced). ' +
				"Zotero asks your permission the first time this plugin writes something; choose Always Allow.",
			control: { type: "toggle", key: "zotero.useLocal", disabled: !pro },
		});
		return { type: "group", cls: "tagged-sync-group-zotero-connection", items };
	}

	/**
	 * The four states of §2.1, and the client is what says which one it is -- it knows what answered,
	 * which is not the same question as what is configured. Asked at draw and again after the key
	 * changes (found in the desk test of 2026-09-13: computed once, a wrong key kept reading "Connected
	 * via web." until the tab was reopened). Each probe is numbered, so a slow answer never lands on top
	 * of a newer one, and tearing the row down outdates the last one (spec §2.8).
	 */
	private renderZoteroLine(setting: Setting): () => void {
		const line = setting.descEl.createDiv({ cls: "tagged-sync-verdict" });
		// Coloured like the vision verdict under Model (asked for in the desk test of 2026-09-13): the
		// theme's own success and error tones, through a variable, so the answer reads at a glance.
		const paint = (text: string, color: string) => {
			line.setText(text);
			line.style.color = color;
		};
		let probe = 0;
		const refresh = () => {
			const client = this.plugin.zoteroClient();
			const mine = ++probe;
			if (client === null) {
				paint("Not connected.", "var(--text-error)");
				return;
			}
			paint("Checking…", "");
			// No rejection arm: `status()` is the one call on the client that answers instead of
			// throwing -- a probe is a question, and "nothing answered" is one of its answers.
			void client.status().then((reached) => {
				if (mine === probe) paint(reached.summary, reached.web || reached.local ? "var(--text-success)" : "var(--text-error)");
			});
		};
		refresh();
		this.refreshZoteroLine = refresh;
		return () => {
			probe++;
			// Before the row is drawn again (1.15.0's app.js, as the fake renderer models it), so the next draw sets its own.
			this.refreshZoteroLine = null;
		};
	}

	/**
	 * Typed into without a redraw (spec §6.1, P15): a redraw under the field takes its focus. A key that
	 * makes zotero.org a connection, or stops it being one, opens or shuts the render switch at once; the
	 * sentences that depend on it follow when the field is left.
	 */
	private renderZoteroKey(setting: Setting): void {
		const drawnWith = webConfigured(this.plugin.data.zotero);
		setting.addText((text) => {
			text.inputEl.type = "password";
			text.setValue(this.plugin.data.zotero.apiKey ?? "").onChange(async (value) => {
				const before = webConfigured(this.plugin.data.zotero);
				await this.setControlValue("zotero.apiKey", value);
				this.recheckZotero();
				if (webConfigured(this.plugin.data.zotero) !== before) this.refreshDomState();
			});
			text.inputEl.addEventListener("blur", () => {
				if (webConfigured(this.plugin.data.zotero) === drawnWith) return;
				// The redraw asks the line itself: one probe per change (spec §2.8).
				this.recheckZotero.cancel();
				this.update();
			});
		});
	}

	/**
	 * *Send to your tablet* (spec §6.4): the rows that put a paper on the tablet. The folder and the tag
	 * are trimmed when stored ({@link SET_RULES}).
	 */
	private zoteroSendGroup(pro: boolean): SettingDefinitionGroup {
		return {
			type: "group",
			heading: "Send to your tablet",
			cls: "tagged-sync-group-zotero-send",
			items: [
				{
					name: "Tablet folder for sent PDFs",
					desc: "Looked up by name and created if it is not there. Renaming it on the tablet is yours to do; this plugin never renames a folder.",
					control: { type: "text", key: "zotero.folder", placeholder: DEFAULT_SEND_FOLDER },
				},
				{
					name: "Send tag in Zotero",
					desc:
						"Tag a paper with it in Zotero, then run Send tagged Zotero papers to reMarkable: every paper carrying the tag goes to your tablet, " +
						"in the folder above, without a sync tag -- tag it on the tablet when you want it back. Tag the paper, not the PDF. No sync sends; only that command does.",
					control: { type: "text", key: "zotero.sendTag", placeholder: DEFAULT_SEND_TAG },
				},
				{
					name: pro ? "Send over SSH when the cloud is not connected" : "Send over SSH when the cloud is not connected (Pro)",
					// The spec's own wording, and it is here rather than in a notice afterwards because it is the
					// one thing about this plugin that interrupts the person holding the tablet. They agree to it
					// once, in advance, rather than finding out when their page closes.
					desc: `${SSH_SEND_RESTART_NOTE} The reading app is back in about six seconds.`,
					control: { type: "toggle", key: "zotero.sendOverSsh", disabled: !pro },
				},
			],
		};
	}

	/**
	 * *Into Zotero* (Zotero spec §1, words from ticket 05): what this vault writes into Zotero, apart
	 * from the connections that carry it -- the text, the render, and the privacy sentence about both.
	 * The render is not write-back (the glossary's write-back is text), so the heading says neither.
	 *
	 * Pro rows shown shut to a free vault, like the desktop-app switch. The render reaches Zotero over
	 * zotero.org only (ticket 04 #1), so its switch is shut without that connection, asked again as the
	 * key is typed, and says so in a sentence the connection rows' `update()`s choose (spec P15).
	 *
	 * Switching either one on makes the Zotero-linked documents due once ({@link setControlValue}).
	 */
	private intoZoteroGroup(pro: boolean): SettingDefinitionGroup {
		const renderName = pro ? "Add the render to Zotero" : "Add the render to Zotero (Pro)";
		const renderDesc =
			'Uploads the PDF as it looks on your tablet, ink and all and searchable, to Zotero Storage as an attachment "Annotated PDF" ' +
			"under the paper. Your handwriting then leaves this machine for zotero.org and counts against your storage there. Only " +
			"documents tagged as a whole, in your personal library. If your Zotero files sync over WebDAV, leave this off.";
		return {
			type: "group",
			heading: "Into Zotero",
			cls: "tagged-sync-group-zotero-into",
			items: [
				{
					name: pro ? "Write text to Zotero" : "Write text to Zotero (Pro)",
					desc:
						"Your tablet highlights become Zotero annotations, with your margin notes as their comments, and each page you added to a PDF " +
						"becomes a note under the paper. Everything carries the tag tagged-sync. Switched off, nothing new is written and what is " +
						"already in Zotero stays; filter by the tag in Zotero to remove it.",
					control: { type: "toggle", key: "zotero.writeText", disabled: !pro },
				},
				{
					name: renderName,
					desc: webConfigured(this.plugin.data.zotero) ? renderDesc : `Needs a zotero.org connection. ${renderDesc}`,
					control: {
						type: "toggle",
						key: "zotero.addRender",
						disabled: this.guardedValue(renderName, true, () => !pro || !webConfigured(this.plugin.data.zotero)),
					},
				},
				{
					name: "What leaves your machine",
					desc:
						"Your handwriting never does, unless you switch on Add the render to Zotero. With Write text to Zotero, the text of your " +
						"highlights, margin notes and added pages is written into your own Zotero library -- and to zotero.org, if that is the " +
						"connection carrying it.",
				},
			],
		};
	}

	/** What `client.groups()` last answered while this tab was open, or `null` before it has. See {@link zoteroLibrariesGroup}. */
	private zoteroGroups: ZoteroGroup[] | null = null;

	/**
	 * The libraries (ticket 26, spec §6.2): one switch per group library, all off until switched on by
	 * name (the personal library is always read and needs no row) -- a group is other people's work, and
	 * what write-back puts there is visible to everyone in it, which the row says.
	 *
	 * The groups are Zotero's to name, so they are asked for when the status row is drawn and the page
	 * is drawn again once the answer changes what it would show. Rows come from what is *stored* as well
	 * as from what was found: a group switched on stays a row while Zotero is closed, so it can be
	 * switched off again, and the name stored beside its id is what the row and the note call it
	 * meanwhile. Switched-on groups first, in the order they were switched on, then the rest as Zotero
	 * lists them. Pro (§5), and shown shut to a free vault like the desktop-app switch.
	 */
	private zoteroLibrariesGroup(pro: boolean): SettingDefinitionGroup {
		const name = pro ? "Group libraries" : "Group libraries (Pro)";
		const items: SettingDefinition[] = [
			{
				name,
				desc:
					"A group you switch on is searched, sent from and, with write-back, written into like your own library. " +
					"Highlights written into a group library are visible to everyone in that group.",
				render: this.guarded(name, (setting) => this.renderGroupsStatus(setting, pro)),
			},
		];
		if (pro) {
			const enabled = this.plugin.data.zotero.groups;
			const found = this.zoteroGroups;
			for (const group of [...enabled, ...(found ?? []).filter((candidate) => !enabled.some((on) => on.id === candidate.id))]) {
				items.push({
					name: group.name,
					desc: found !== null && !found.some((candidate) => candidate.id === group.id) ? "Not listed by Zotero right now; switched on earlier." : "",
					control: { type: "toggle", key: groupKey(group) },
				});
			}
		}
		return { type: "group", heading: "Libraries", cls: "tagged-sync-group-zotero-libraries", items };
	}

	/** The status under *Group libraries*, and the lookup that fills the rows below it. */
	private renderGroupsStatus(setting: Setting, pro: boolean): void {
		const status = setting.descEl.createDiv({ cls: "tagged-sync-verdict" });
		if (!pro) {
			// Shut like the desktop-app switch: a free vault sees the row as a Pro row, not as a bare paragraph.
			setting.addToggle((toggle) => toggle.setValue(false).setDisabled(true));
			return;
		}

		const enabled = this.plugin.data.zotero.groups;
		const client = this.plugin.zoteroClient();
		if (client === null) {
			status.setText("Set up a connection above to see your groups.");
		} else if (this.zoteroGroups === null) {
			status.setText("Looking up your groups…");
			client.groups().then(
				(found) => {
					const known = this.zoteroGroups;
					this.zoteroGroups = found;
					// Drawn again only when the answer adds a row: the same list twice is not a reason to
					// pull the screen out from under a person reading it.
					if (known === null || found.some((group) => !known.some((seen) => seen.id === group.id))) this.update();
				},
				(error: unknown) => status.setText(`Could not list your groups: ${describeZoteroError(error)}`),
			);
		} else if (this.zoteroGroups.length === 0 && enabled.length === 0) {
			status.setText("You are in no group.");
		}
	}

	/**
	 * `zotero.group:<id>` switched (spec §6.2): on, the group joins the stored list with the name Zotero
	 * gave it; off, it leaves. A group neither stored nor listed has no row, so it is no setting.
	 */
	private async setZoteroGroup(key: string, on: boolean): Promise<void> {
		const zotero = this.plugin.data.zotero;
		const group = [...zotero.groups, ...(this.zoteroGroups ?? [])].find((candidate) => groupKey(candidate) === key);
		if (group === undefined) throw new Error(`Tagged Sync: no setting "${key}"`);
		if (this.getControlValue(key) === on) return;
		const others = zotero.groups.filter((candidate) => candidate.id !== group.id);
		this.plugin.data.zotero = { ...zotero, groups: on ? [...others, group] : others };
		await this.plugin.saveData(this.plugin.data);
	}

	/**
	 * Readwise (Readwise spec §2, settings-redesign spec §7), built like Zotero: a live Connection line,
	 * the Pro switch, the token and the round-trip hint, in one group without a heading. Shown to every
	 * vault, the switch shut with "(Pro)" to a free one.
	 *
	 * The token is a Keychain entry, which this computer has or has not: `data.json` holds only the
	 * entry's name, and the token is read when the line asks readwise.io. Choosing another entry draws
	 * the page again ({@link setControlValue}): the line and *Start over* are about that token.
	 */
	private readwisePage(): SettingDefinitionPage {
		const pro = readwiseProAllowed(this.plugin.entitlement());
		const entry = () => readwisePageEntry(this.plugin.data, this.plugin.entitlement(), this.plugin.readwiseLastCheck, () => this.plugin.readwiseToken());
		const items: SettingDefinition[] = [
			{ name: "Connection", render: this.guarded("Connection", (setting) => this.renderReadwiseLine(setting)) },
			{
				name: pro ? "Push highlights to Readwise" : "Push highlights to Readwise (Pro)",
				desc:
					"Your highlights and margin notes become highlights in your Readwise library, one book or article per document, and come up in your Daily Review. " +
					"The text goes to readwise.io; your handwriting and page images never leave this machine. Needs a Readwise plan with API access " +
					"(Full or Highlights). Switching on re-reads every note once, and your margin notes go to your transcription backend again.",
				// Switching on needs nothing more here: the next sync starts the backfill (Readwise spec §5).
				control: { type: "toggle", key: "readwise.push", disabled: !pro },
			},
			{
				name: "Readwise access token",
				desc: "From readwise.io/access_token. Stored in Obsidian's keychain on this computer, not in the vault — add it on each computer that should push.",
				aliases: ["API key"],
				control: { type: "secret", key: "readwise.tokenSecret" },
			},
			{
				name: "Readwise's own Obsidian plugin",
				desc:
					"If you also use Readwise's own Obsidian plugin, it copies these books back into your vault, each highlight linking to your note. " +
					"To keep them out, turn on 'Select Items to be Exported' in Readwise and uncheck each new Tagged Sync book.",
			},
		];
		// Only while stopped, and on a computer with a token to start over with: it is the one way out once
		// neither token clears the clash (ticket 20, option C).
		if (this.plugin.data.readwiseAccountClash && this.plugin.readwiseToken() !== null) {
			const name = "Start over with this computer's token";
			items.push({
				name,
				desc:
					"Forgets what was pushed to Readwise; the next sync pushes every document again, into the account of this computer's token. " +
					"Books you deleted in Readwise come back, and your margin notes go to your transcription backend again.",
				render: this.guarded(name, (setting) => {
					setting.addButton((button) =>
						button
							.setButtonText("Start over")
							.setDestructive()
							.onClick(async () => {
								// A push in flight writes the state back when it ends (spec §4.1: it holds the run lock).
								if (this.plugin.isSyncing()) {
									new Notice("Wait for the sync to finish, then start over.");
									return;
								}
								startOverReadwise(this.plugin.data);
								await this.plugin.saveData(this.plugin.data);
								this.update();
							}),
					);
				}),
			});
		}
		return {
			type: "page",
			name: "Readwise",
			displayValue: this.guardedValue("Readwise", "", () => entry().value),
			status: this.guardedValue<"warning" | null>("Readwise", null, () => entry().status),
			items: [{ type: "group", cls: "tagged-sync-group-readwise", items }],
		};
	}

	/**
	 * The line of Readwise spec §2.1, asked again when the switch changes. Numbered like Zotero's probe,
	 * so a slow answer never lands on top of a newer one; an answer that lands is also what the page's
	 * entry on the root reads (settings-redesign spec §5).
	 */
	private renderReadwiseLine(setting: Setting): () => void {
		const line = setting.descEl.createDiv({ cls: "tagged-sync-verdict" });
		const paint = (connection: ReadwiseConnection) => {
			const { text, tone } = readwiseConnectionLine(connection, this.plugin.data.readwiseBooks);
			line.setText(text);
			line.style.color = tone === null ? "" : `var(--text-${tone})`;
		};
		let probe = 0;
		const refresh = () => {
			const mine = ++probe;
			const pro = readwiseProAllowed(this.plugin.entitlement());
			// The Keychain is read only when the line will ask readwise.io (ticket 20 item 2).
			const token = pro && this.plugin.data.readwise.push ? this.plugin.readwiseToken() : null;
			paint(!pro ? "free" : !this.plugin.data.readwise.push ? "off" : token === null ? "no-token" : "checking");
			if (token === null) return;
			void (async () => {
				// A clash is the state's to say, so readwise.io is not asked (spec §11 P4).
				const answer = readwiseClashed(this.plugin.data, await tokenFingerprint(token)) ? "clash" : await createReadwiseClient(token).check();
				// Kept for the root's entry while it is about the token in the Keychain, the page left or not;
				// another token redrew the page, so this line is gone too.
				if (this.plugin.readwiseToken() !== token) return;
				this.plugin.readwiseLastCheck = answer;
				if (mine === probe) paint(answer);
			})();
		};
		refresh();
		this.refreshReadwiseLine = refresh;
		return () => {
			probe++;
			this.refreshReadwiseLine = null;
		};
	}

	/**
	 * Help, last, because those links are read when something has gone wrong (spec §3.8). A fragment
	 * description is built on every read: a fragment is used up by the first render (spec §2.6).
	 */
	private helpGroup(): SettingDefinitionGroup {
		return {
			type: "group",
			heading: "Help",
			cls: "tagged-sync-group-help",
			items: [
				{
					name: "Report a problem",
					get desc() {
						return createFragment((desc: DocumentFragment) => {
							desc.appendText("Copy your setup details, then open an issue at ");
							desc.createEl("a", { text: "GitHub", href: ISSUES_URL });
							desc.appendText(" and paste them in. Nothing is sent from here.");
						});
					},
					render: this.guarded("Report a problem", (setting) => {
						setting.addButton((button) => button.setButtonText("Copy diagnostics").onClick(() => this.copyDiagnostics()));
					}),
				},
				{
					name: "Request a feature",
					get desc() {
						return createFragment((desc: DocumentFragment) => {
							desc.appendText("Suggest a feature on ");
							desc.createEl("a", { text: "GitHub", href: FEATURE_REQUEST_URL });
							desc.appendText(" or vote on ");
							desc.createEl("a", { text: "existing requests", href: FEATURE_VOTING_URL });
							desc.appendText(" with a 👍 reaction.");
						});
					},
				},
			],
		};
	}

	/** *Copy diagnostics*: the setup details on the clipboard, for an issue the user opens themselves. */
	private async copyDiagnostics(): Promise<void> {
		await navigator.clipboard.writeText(
			buildDiagnostics({
				pluginVersion: this.plugin.manifest.version,
				obsidianVersion: apiVersion,
				platform: Platform.isMacOS ? "macOS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "other",
				visionAvailability: visionUnavailableReason() ?? "available",
				backend: this.plugin.data.ocrBackend,
				visionRevision: visionRunStats.revision,
				unreadableInkRegions: visionRunStats.unreadableInkRegions,
				reusedPageTranscriptions: this.plugin.lastPageTranscriptions,
				textLayer: this.plugin.lastTextLayer,
				ocrTally: this.plugin.lastOcrTally,
				pendingOcrRetries: pendingOcrRetries(this.plugin.data.syncIndex),
				mappedTagCount: Object.keys(this.plugin.data.tagFolderMap).length,
				zotero: zoteroDiagnosticsLine(this.plugin.data.zotero, this.plugin.entitlement(), linkedDocumentIds(this.plugin.data.zoteroLinks).length),
				readwise: readwiseDiagnosticsLine(this.plugin.data, this.plugin.entitlement(), this.plugin.readwiseLastCheck, () => this.plugin.readwiseToken()),
				lastSyncAt: this.plugin.data.lastSyncAt,
				lastSyncError: this.plugin.lastSyncError,
			}),
		);
		new Notice("Diagnostics copied to the clipboard.");
	}

	/**
	 * The backend dropdown, and under it the selected backend's own rows in one host row (spec §3.4,
	 * P3): the registry contract and the backends' code stay, and the host is left out of settings
	 * search, as those rows always were.
	 */
	private transcriptionGroup(): SettingDefinitionGroup {
		// Null only for a stored id no build registers -- a downgrade, or a hand-edited `data.json`.
		// The row then says nothing rather than guessing which promise an unknown backend makes.
		const selected = ocrBackendEntry(this.plugin.data.ocrBackend);

		// What the transcripts of the *selected* backend will look like (structure-preserving-ocr spec
		// §3.2), as the second sentence of the row rather than a loose line under it: on its own it
		// read as a footnote with nothing to belong to. Vision's flat-text ceiling is named only while
		// Vision is chosen -- it used to be the fallback for every backend without a contract of its
		// own, so a reader on LM Studio was told to "choose an LLM backend".
		const contract =
			selected?.noteContract ??
			(selected?.id === "vision"
				? ["Transcripts are flat text, no headings or tables.", hasAlternativeBackends(ocrBackendEntries()) ? "Choose an LLM backend for structured Markdown." : ""]
						.filter(Boolean)
						.join(" ")
				: "");

		const items: SettingDefinition[] = [
			{
				name: "Backend",
				// The promise of the backend that is *selected*. The three cases are three different
				// promises (free-localhost-ocr spec §4.1) and this row used to make all of them at once,
				// which left a reader on LM Studio reading about Apple Vision and about cloud providers.
				// Where Vision cannot run, the dropdown option itself carries the macOS floor, so that is
				// not repeated here either.
				desc: selected ? [backendPromise(selected), contract].filter(Boolean).join(" ") : "",
				aliases: ["OCR", "handwriting", "transcription model"],
				render: this.guarded("Backend", (setting) => {
					setting.addDropdown((dropdown) => {
						for (const entry of ocrBackendEntries()) {
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
							this.update();
						});
					});
				}),
			},
		];

		if (selected?.renderSettings) {
			items.push({
				// Never shown: the row is emptied, and the backend draws its own rows into it.
				name: "Backend settings",
				searchable: false,
				render: this.guarded("Backend settings", (setting) => {
					// Emptied, not just stripped of its name and controls: Obsidian keeps this row across a
					// redraw and draws into it again, and the last backend's rows would stay above the new ones.
					setting.settingEl.empty();
					setting.settingEl.addClass("tagged-sync-backend-row");
					const host = setting.settingEl.createDiv({ cls: "tagged-sync-backend-host" });
					return selected.renderSettings?.(host, {
						settings: (this.plugin.data.llmProviders[selected.id] ??= {}),
						save: () => this.plugin.saveData(this.plugin.data),
						selectDefaultBackend: async () => {
							this.plugin.data.ocrBackend = defaultOcrBackend(visionPlatformSupported());
							await this.plugin.saveData(this.plugin.data);
							this.update();
						},
					});
				}),
			});
		}
		return { type: "group", heading: "Transcription", cls: "tagged-sync-group-transcription", items };
	}

	/**
	 * Opt-in background sync (auto-sync spec §"Settings & data model", settings-redesign spec §3.5),
	 * placed after Transcription because the consent rows depend on the chosen backend. The rows after
	 * the switch are in the page all along and shown while it is on, so switching it moves nothing;
	 * every change re-arms the interval timer ({@link setControlValue}).
	 */
	private autoSyncGroup(): SettingDefinitionGroup {
		const enabled = this.guardedValue("Automatic sync", false, () => this.plugin.data.autoSync.enabled);
		const selected = ocrBackendEntry(this.plugin.data.ocrBackend);
		const items: SettingDefinition[] = [
			{
				name: "Enable automatic sync",
				desc: "Sync on launch and periodically while Obsidian is open.",
				control: { type: "toggle", key: "autoSync.enabled" },
			},
			{
				name: "Sync interval",
				desc: "How often to re-sync during a long session. On-launch sync always runs.",
				visible: enabled,
				control: {
					type: "dropdown",
					key: "autoSync.interval",
					options: INTERVALS,
				},
			},
		];

		// The control for a backend whose background cost is not money but battery, heat and several
		// GB of RAM. Drawn by our code: the answer lives in the backend's opaque blob, and its
		// description reads the model directory from disk, which a definition must not.
		const consent = selected?.needsBackgroundConsent ? selected.backgroundConsent : undefined;
		if (selected && consent) {
			items.push({
				name: BACKGROUND_CONSENT_NAME,
				visible: enabled,
				render: this.guarded(BACKGROUND_CONSENT_NAME, (setting) => {
					const blob = (this.plugin.data.llmProviders[selected.id] ??= {});
					setting.setDesc(consent.description(blob)).addToggle((toggle) =>
						toggle.setValue(consent.get(blob)).onChange(async (value) => {
							consent.set(blob, value);
							await this.plugin.saveData(this.plugin.data);
							this.plugin.rearmAutoSyncInterval();
						}),
					);
				}),
			});
		}

		// Money-safety consent (spec §"Money-safety gate"): only meaningful for a metered cloud backend.
		// Same name as the battery/RAM row above, because it decides the same thing: with it off the
		// whole scheduled run is skipped, not just the transcription. It used to say "transcribe during
		// background sync", which promised a sync that arrives without transcripts, and that is not
		// what happens.
		if (isMeteredProvider(this.plugin.data.ocrBackend)) {
			const provider = selected?.label ?? "your provider";
			items.push({
				name: BACKGROUND_CONSENT_NAME,
				desc:
					`Each automatic sync sends your new pages to ${provider} and bills your API key. ` +
					"Off, automatic sync does nothing while this backend is chosen. A sync you start yourself still runs.",
				visible: enabled,
				control: { type: "toggle", key: "autoSync.autoTranscribeMetered" },
			});
		}
		return {
			type: "group",
			heading: "Automatic sync",
			cls: "tagged-sync-group-autosync",
			items,
		};
	}

	/**
	 * Tag routing (settings-redesign spec §4): the mapped tags as rows, then the found tags as pills to
	 * click, in one group -- readable with 20–50 tags on the tablet and few mapped (06 #1). What the rows
	 * show is `planTagRouting`'s to decide; this wires it.
	 */
	private tagGroup(): SettingDefinitionGroup {
		const folders = this.folderPaths();
		const view = planTagRouting({
			mapping: this.plugin.data.tagFolderMap,
			foundTags: this.foundTags,
			folderPaths: folders,
			entitlement: this.plugin.entitlement(),
		});
		// Read by `matchTag`, which Obsidian keeps from the group's first draw (see the return below).
		this.mappedTags = view.mapped;
		this.filterShown = view.filter;
		// With the filter hidden there is nothing to clear a query, and the pills would stay filtered by it.
		if (!view.filter) this.tagFilter = "";
		/**
		 * Every row of this group is a render row, so each draw can say on the group whether the filter box
		 * shows (see the return); a group of text rows alone would leave the class as it last was.
		 */
		const tagRow = (name: string, render: (setting: Setting) => void | (() => void) = () => undefined): SettingDefinitionRender["render"] =>
			this.guarded(name, (setting) => {
				setting.settingEl.closest(".tagged-sync-group-tags")?.toggleClass("tagged-sync-filter-on", view.filter);
				return render(setting);
			});

		/** Opens the folder picker for `tag`; choosing saves at once (06 #2). `adding` is a pill, not a mapped row. */
		const pick = (tag: string, adding: boolean): void =>
			new FolderPicker(this.app, tag, folders, async (path) => {
				// The one gated feature here: a mapping past the free cap. This is the moment the licence is
				// *used*, so it is the moment it is re-checked -- not on load, and never for a free user, who
				// cannot reach this branch at all. Re-pointing a mapped tag adds nothing, so it never asks.
				if (adding && view.recheckLicenceBeforeAdd && (await this.plugin.refreshLicence()).tier === "free") {
					this.update();
					return;
				}
				this.plugin.data.tagFolderMap[tag] = path;
				await this.plugin.saveData(this.plugin.data);
				this.update();
			}).open();

		const items: SettingDefinition[] = view.mapped.map((mapped) => ({
			name: mapped.tag,
			// The name the folder button shows, so "vault root" finds a tag mapped to "/".
			aliases: [folderLabel(mapped.folder)],
			render: tagRow(mapped.tag, (setting) => this.renderMappedTag(setting, mapped, () => pick(mapped.tag, false))),
		}));
		if (view.removalNote) {
			items.push({
				name: "Removing a tag",
				desc: REMOVAL_MESSAGE,
				searchable: false,
				// A footer to the rows above it rather than a row of its own (06 #6): small, muted, no border.
				render: tagRow("Removing a tag", (setting) => setting.settingEl.addClass("tagged-sync-row-note")),
			});
		}
		for (const line of view.lines) {
			if (line === "scan-first") {
				items.push({
					name: "Scan for tags",
					desc: "Scan to see which tags your reMarkable uses.",
					searchable: false,
					render: tagRow("Scan for tags", (setting) => {
						setting.addButton((button) =>
							button
								.setButtonText(this.scanning ? "Scanning…" : "Scan")
								.setDisabled(this.scanning)
								.onClick(() => this.scanTags()),
						);
					}),
				});
			} else if (line === "nothing-found") {
				items.push({
					name: "No tags found",
					desc: "Tag a notebook or page on your reMarkable, then scan again.",
					searchable: false,
					render: tagRow("No tags found"),
				});
			} else {
				items.push({ name: "One tag in the free version", desc: TAG_CAP_MESSAGE, searchable: false, render: tagRow("One tag in the free version") });
			}
		}
		if (view.pills.length > 0) {
			// Searchable, unlike the lines: settings search finds a tag the tablet carries, and the group's
			// filter, which asks only searchable rows, reaches the pills through this row (06 #4, P9).
			items.push({
				name: "Found tags",
				aliases: view.pills.map((found) => found.tag),
				render: tagRow("Found tags", (setting) => this.renderPills(setting, view.pills, (tag) => pick(tag, true))),
			});
		}

		// Obsidian builds a group's header once, when the group is first drawn -- before the first scan --
		// and `update()` keeps it (read from 1.15.0's app.js, `rue`; seen on the device in ticket 12). So
		// the search box is always declared and shown by the rows' class from twelve tags, its `match`
		// reads the tab rather than this call, and the scan icon is disabled through a handle.
		return {
			type: "group",
			heading: "Tag routing",
			cls: "tagged-sync-group-tags",
			extraButtons: [
				(button) => {
					this.scanIcon = button
						.setIcon("refresh-cw")
						.setTooltip("Scan for tags")
						.setDisabled(this.scanning)
						.onClick(() => void this.scanTags());
				},
			],
			search: { placeholder: "Filter tags", match: (def, query) => this.matchTag(def, query) },
			items,
		};
	}

	/**
	 * The filter (spec §4.3, P9), asked for each searchable row on every keystroke (ticket 17's F6): the
	 * pills follow the query as a side effect, and a mapped row stays when its tag or folder holds it.
	 */
	private matchTag(def: SettingDefinition, query: string): boolean {
		if (!this.filterShown) return true;
		this.tagFilter = query;
		this.pillRow?.filter(query);
		const mapped = this.mappedTags.find((candidate) => candidate.tag === def.name);
		const needle = query.toLowerCase();
		return mapped === undefined || mapped.tag.toLowerCase().includes(needle) || mapped.label.toLowerCase().includes(needle);
	}

	/** `/` and every folder below it, sorted: the root always exists, so even a new vault has a target. */
	private folderPaths(): string[] {
		return [
			"/",
			...this.app.vault
				.getAllLoadedFiles()
				.filter((file): file is TFolder => file instanceof TFolder && !file.isRoot())
				.map((folder) => folder.path)
				.sort(),
		];
	}

	/** *pill → folder button, ×* (06 #3): the folder can be changed, and the mapping removed without a question. */
	private renderMappedTag(setting: Setting, mapped: MappedTag, pick: () => void): void {
		// The tag in Obsidian's tag look in place of its name. Emptied first: Obsidian keeps this row across
		// a redraw and draws into it again.
		setting.nameEl.empty();
		setting.nameEl.createSpan({ cls: "tagged-sync-pill", text: mapped.tag });
		setting
			.addButton((button) => {
				button.setButtonText(mapped.label).onClick(pick);
				// The mapping keeps working; the colour says the folder it names is not there (P13).
				if (mapped.missing) button.buttonEl.addClass("tagged-sync-folder-missing");
			})
			.addExtraButton((button) =>
				button
					.setIcon("x")
					.setTooltip("Remove mapping")
					.onClick(async () => {
						delete this.plugin.data.tagFolderMap[mapped.tag];
						await this.plugin.saveData(this.plugin.data);
						this.update();
					}),
			);
	}

	/**
	 * The found tags as pills, full width, the row's name and controls gone (spec §4.2 row 6). A capped
	 * pill is shown faded and says why when clicked, under the pills, with the way to Pro (06 #7): a
	 * refusal nobody explains reads as a bug. Returns the cleanup that drops the filter handle.
	 */
	private renderPills(setting: Setting, pills: readonly UnmappedTag[], pick: (tag: string) => void): () => void {
		// Emptied, not just cleared of its name: Obsidian draws into the same row again on a redraw.
		setting.settingEl.empty();
		setting.settingEl.addClass("tagged-sync-pill-row");
		const wrap = setting.settingEl.createDiv({ cls: "tagged-sync-pills" });
		const capLine = setting.settingEl.createDiv({ cls: "tagged-sync-capped-line" });
		const drawn = pills.map(({ tag, capped }) => {
			// Without "#": a reMarkable tag may hold spaces, and "#Project X" reads as a broken Obsidian tag (06 #8).
			const el = wrap.createEl("button", { cls: capped ? "tagged-sync-pill is-capped" : "tagged-sync-pill", text: tag });
			el.addEventListener("click", () => (capped ? this.sayCapped(capLine, tag) : pick(tag)));
			return { tag: tag.toLowerCase(), el };
		});
		const filter = (query: string): void => {
			for (const { tag, el } of drawn) el.toggle(tag.includes(query.toLowerCase()));
		};
		filter(this.tagFilter);
		this.pillRow = { filter };
		// Run before the row is drawn again (it keeps its name), or after the redraw that left it out.
		return () => {
			this.pillRow = null;
		};
	}

	/** Under the pills, until the next redraw: another capped pill replaces it, and nothing is saved. */
	private sayCapped(line: HTMLElement, tag: string): void {
		line.empty();
		line.createSpan({ text: `Syncing ${tag} needs Tagged Sync Pro.` });
		line.createEl("button", { text: "See Pro" }).addEventListener("click", () =>
			this.containerEl.querySelector(".tagged-sync-group-pro")?.scrollIntoView({ behavior: "smooth", block: "start" }),
		);
	}

	/**
	 * One scan, from the heading icon or the pre-scan row. Through the same chain a sync uses, so a
	 * vault that configured a fallback gets one here too. A failed scan keeps what an earlier one found:
	 * a tablet that did not answer has not lost its tags.
	 */
	private async scanTags(): Promise<void> {
		if (this.scanning) return;
		this.scanning = true;
		this.scanIcon?.setDisabled(true);
		this.update();
		let session: TransportSession | null = null;
		try {
			session = (await this.plugin.openSource()).session;
			this.foundTags = collectTagNames(await enumerateNotebookTags(session.api));
			new Notice(`Found ${this.foundTags.length} tag(s).`);
		} catch (error) {
			new Notice(`Failed to discover tags: ${(error as Error).message}`);
		} finally {
			await session?.close();
			this.scanning = false;
			this.scanIcon?.setDisabled(false);
		}
		this.update();
	}
}

/**
 * The folder a tag syncs into (spec §4.4): existing folders only (06 #2), the root first and called
 * by a name. Opens in the window the settings are in (ticket 17's F4).
 */
class FolderPicker extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		tag: string,
		private readonly folders: string[],
		private readonly chosen: (path: string) => Promise<void>,
	) {
		super(app);
		this.setPlaceholder(`Choose a folder for ${tag}`);
	}

	getItems(): string[] {
		return this.folders;
	}

	getItemText(path: string): string {
		return folderLabel(path);
	}

	onChooseItem(path: string): void {
		void this.chosen(path);
	}
}
