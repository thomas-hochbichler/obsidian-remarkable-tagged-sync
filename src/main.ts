import {
	type App,
	apiVersion,
	debounce,
	Modal,
	normalizePath,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	setIcon,
	Setting,
	type TAbstractFile,
	TFile,
	TFolder,
	type Vault,
} from "obsidian";
import { session as remarkableSession } from "rmapi-js";
import { type AttachmentStore, DEFAULT_ATTACHMENTS_FOLDER, normalizeAttachmentsFolder } from "./attachment-writer";
import { isIntervalSyncDue, isMeteredProvider } from "./auto-sync";
import { buildDiagnostics } from "./diagnostics";
import { explainError } from "./explain-error";
import type { NoteStore, OcrBackend as OcrBackendId } from "./note-builder";
import type { OcrBackend as OcrBackendAdapter } from "./ocr-backend";
import { type BackendSettings, isRegisteredOcrBackend, ocrBackendEntries, ocrBackendEntry } from "./ocr-registry";
import { type AuthStore, RemarkableAuth } from "./remarkable-auth";
import { collectTagNames, enumerateNotebookTags } from "./remarkable-tags";
import { EMPTY_SYNC_INDEX, reTranscribeAll, runSync, type SyncIndex, type SyncProgress } from "./sync-engine";
import { TagRouter, type TagFolderMap } from "./tag-router";
import { UnavailableOcrBackend } from "./vision-ocr-backend";
import { visionBackend } from "./vision-register";
import { visionPlatformSupported, visionUnavailableReason } from "./vision-ocr-runtime";

const DEVICE_CONNECT_URL = "https://my.remarkable.com/device/browser/connect";
const ISSUES_URL = "https://github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync/issues";

/**
 * How many tag → folder mappings the free version allows. It gates *adding* a mapping and nothing
 * else: an existing mapping is never revoked, because unmapping a tag feeds `diffUnitTags`, which
 * orphans the row, and orphaning is index-only by design -- the folder would simply stop updating
 * with nothing said. Shipped from day one and published in the README, so it is a limit people knew
 * about rather than something taken away later.
 */
const FREE_TAG_LIMIT = 1;

/** How long after `onload` to fire the on-launch auto-sync — a few seconds so auth/network are ready and startup isn't janked (auto-sync spec §Triggers). */
const AUTO_SYNC_LAUNCH_DELAY_MS = 4_000;

/** Opt-in background sync (auto-sync spec §"Settings & data model"). */
interface AutoSyncSettings {
	/** Master toggle; default off. */
	enabled: boolean;
	/** Interval backstop in hours; `null` means on-launch only (interval disabled). */
	intervalHours: number | null;
	/** Durable one-time consent to auto-run a metered cloud backend; default off. */
	autoTranscribeMetered: boolean;
}

const DEFAULT_AUTO_SYNC: AutoSyncSettings = {
	enabled: false,
	intervalHours: 6,
	autoTranscribeMetered: false,
};

interface TaggedSyncData {
	deviceToken: string | null;
	tagFolderMap: TagFolderMap;
	syncIndex: SyncIndex;
	ocrBackend: OcrBackendId;
	/**
	 * Each backend's own settings blob, keyed by backend id and remembered across backend switches
	 * (multi-provider spec §4). Opaque here — only the backend that owns a blob reads inside it.
	 */
	llmProviders: Record<string, BackendSettings>;
	/** Set once the platform "no transcription here" notice has been shown, so it never nags again (spec §6.2). */
	ocrUnavailableNoticeShown: boolean;
	autoSync: AutoSyncSettings;
	/** ISO timestamp of the last *completed* sync (manual or auto); drives the interval backstop. */
	lastSyncAt: string | null;
	/** Vault folder for rendered PDFs (spec §8: configurable, default `tagged-sync/attachments`). Stored raw; normalized at use. */
	attachmentsFolder: string;
}

const DEFAULT_DATA: TaggedSyncData = {
	deviceToken: null,
	tagFolderMap: {},
	syncIndex: EMPTY_SYNC_INDEX,
	// Placeholder only -- the effective default is platform-derived on load (multi-provider spec §7).
	ocrBackend: "vision",
	llmProviders: {},
	ocrUnavailableNoticeShown: false,
	autoSync: DEFAULT_AUTO_SYNC,
	lastSyncAt: null,
	attachmentsFolder: DEFAULT_ATTACHMENTS_FOLDER,
};

/**
 * Platform default backend (multi-provider spec §7): Apple Vision where it runs. Elsewhere Vision is
 * still offered but disabled, so defaulting to it would select an option the user cannot use and
 * cannot change away from without first understanding why. `off` is the honest default there: notes
 * still sync with the render, and nothing pretends text is coming.
 */
function defaultOcrBackend(): OcrBackendId {
	return visionPlatformSupported() ? "vision" : "off";
}

/** The backends every build has. Neither transcribes over a network, and neither has settings. */
const BUILT_IN_BACKENDS: ReadonlySet<string> = new Set(["vision", "off"]);

/**
 * Whether this build has a backend beyond the built-in ones. Every string that offers the user a
 * different backend has to ask first: pointing someone at an API key on a screen that has no such
 * setting is worse than saying nothing. Counting entries would not do — `off` is an entry too.
 */
function hasAlternativeBackends(): boolean {
	return ocrBackendEntries().some((entry) => !BUILT_IN_BACKENDS.has(entry.id));
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
	if (vault.getFolderByPath(path)) return;
	await vault.createFolder(path);
}

function createNoteStore(app: App): NoteStore {
	const { vault } = app;
	return {
		read: async (path) => {
			const file = vault.getFileByPath(path);
			return file ? vault.read(file) : null;
		},
		write: async (path, content) => {
			const file = vault.getFileByPath(path);
			// process() over modify(): a sync writes notes the user may have open in an editor.
			if (file) await vault.process(file, () => content);
			else await vault.create(path, content);
		},
		move: async (fromPath, toPath) => {
			const file = vault.getFileByPath(fromPath);
			if (file) await app.fileManager.renameFile(file, toPath);
		},
		ensureFolder: (path) => ensureFolder(vault, path),
	};
}

function createAttachmentStore(vault: Vault): AttachmentStore {
	return {
		ensureFolder: (path) => ensureFolder(vault, path),
		writeBinary: async (path, data) => {
			const file = vault.getFileByPath(path);
			if (file) await vault.modifyBinary(file, data);
			else await vault.createBinary(path, data);
		},
	};
}

export default class TaggedSyncPlugin extends Plugin {
	data: TaggedSyncData = DEFAULT_DATA;
	auth!: RemarkableAuth;
	private statusBar!: HTMLElement;
	private syncing = false;
	/**
	 * Raw text of the last failure, for "Copy diagnostics". Held in memory rather than persisted: it
	 * is wanted right after something went wrong, and a reverse-engineered API's raw error is often
	 * the whole diagnosis -- but it is not state the plugin should carry around in `data.json`.
	 */
	lastSyncError: string | null = null;
	private autoSyncLaunchTimer: number | null = null;
	private autoSyncIntervalTimer: number | null = null;

	async onload() {
		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("tagged-sync-status");
		this.statusBar.hide();
		const saved = (await this.loadData()) as (Partial<TaggedSyncData> & { ocrBackendChoice?: unknown }) | null;
		// Migration (multi-provider spec §7): coerce any backend that isn't a currently-valid literal to
		// the platform default. Old installs stored the choice under `ocrBackendChoice`, so "vision"
		// survives; the retired "llm-vision"/"tesseract" reset. The old single `llmVisionApiKey` is
		// dropped by not carrying it forward -- users re-enter their key once under the new per-provider model.
		const savedBackend = saved?.ocrBackend ?? saved?.ocrBackendChoice;
		this.data = {
			deviceToken: saved?.deviceToken ?? DEFAULT_DATA.deviceToken,
			tagFolderMap: saved?.tagFolderMap ?? {},
			syncIndex: saved?.syncIndex ?? EMPTY_SYNC_INDEX,
			ocrBackend: isRegisteredOcrBackend(savedBackend) ? savedBackend : defaultOcrBackend(),
			llmProviders: saved?.llmProviders ?? {},
			ocrUnavailableNoticeShown: saved?.ocrUnavailableNoticeShown ?? false,
			autoSync: { ...DEFAULT_AUTO_SYNC, ...saved?.autoSync },
			lastSyncAt: saved?.lastSyncAt ?? null,
			attachmentsFolder: saved?.attachmentsFolder ?? DEFAULT_DATA.attachmentsFolder,
		};

		const store: AuthStore = {
			getDeviceToken: () => this.data.deviceToken,
			setDeviceToken: async (token) => {
				this.data.deviceToken = token;
				await this.saveData(this.data);
			},
		};
		this.auth = new RemarkableAuth(store);

		this.addSettingTab(new TaggedSyncSettingTab(this.app, this));
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => this.syncNow(),
		});
		this.addCommand({
			id: "re-transcribe-all",
			name: "Re-transcribe all synced notes",
			// Pointless without a backend that produces text (Off, or Vision on Windows/Linux):
			// hidden from the palette rather than failing at run time.
			checkCallback: (checking) => {
				const backend = this.resolveOcrBackend(true);
				if (backend.id === "off" || backend instanceof UnavailableOcrBackend) return false;
				if (!checking) void this.reTranscribeAll();
				return true;
			},
		});

		// Keep data.json note paths accurate across user renames/moves (invisible-sync-state 01).
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath)));

		// On-launch auto-sync (spec §Triggers): wait for the workspace to finish loading, then a few
		// seconds more so auth/network are ready.
		this.app.workspace.onLayoutReady(() => {
			this.autoSyncLaunchTimer = window.setTimeout(() => this.triggerAutoSync(), AUTO_SYNC_LAUNCH_DELAY_MS);
		});
		this.rearmAutoSyncInterval();
	}

	onunload() {
		if (this.autoSyncLaunchTimer !== null) window.clearTimeout(this.autoSyncLaunchTimer);
		if (this.autoSyncIntervalTimer !== null) window.clearInterval(this.autoSyncIntervalTimer);
	}

	/**
	 * Keeps `data.json` note paths accurate when the user renames or moves a synced note (or a folder
	 * containing one) -- the note has no frontmatter to re-find it by, so without this its row would
	 * strand and the next sync would duplicate it. Ignored during a sync: a sync moves notes itself
	 * and replaces the whole index when it finishes, so reacting mid-run would only persist a transient
	 * state the sync immediately overwrites.
	 */
	private async onVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (this.syncing) return;

		const remap = (notePath: string): string | null => {
			if (file instanceof TFile && notePath === oldPath) return file.path;
			const prefix = `${oldPath}/`;
			if (file instanceof TFolder && notePath.startsWith(prefix)) return `${file.path}/${notePath.slice(prefix.length)}`;
			return null;
		};

		const rows = this.data.syncIndex.rows;
		let changed = false;
		for (const [key, row] of Object.entries(rows)) {
			const newPath = remap(row.notePath);
			if (newPath !== null) {
				rows[key] = { ...row, notePath: newPath };
				changed = true;
			}
		}
		if (changed) await this.saveData(this.data);
	}

	/**
	 * Selects the OCR backend for a run (multi-provider spec §6). The registry owns every backend's
	 * own rules; this only handles the case a backend cannot decide for itself — an entry that returns
	 * `null` is configured too incompletely to run and wants the free-local fallback below.
	 */
	private resolveOcrBackend(silent = false): OcrBackendAdapter {
		const id = this.data.ocrBackend;
		const entry = ocrBackendEntry(id);
		// A backend that is selected but not in this build (settings carried over from another build)
		// transcribes nothing rather than falling back to something the user did not choose.
		if (!entry) return new UnavailableOcrBackend(id);
		return entry.create(this.data.llmProviders[id] ?? {}) ?? this.notConfiguredFallback(entry.id, entry.label, silent);
	}

	/**
	 * A backend that needs configuration it hasn't got: fall back to free local Vision on macOS, else
	 * `unavailable` — never an auto-spend (spec §6). The notice is suppressed when `silent` (a
	 * background auto-sync run), which must never interrupt with a popup (auto-sync spec §Failure);
	 * the fallback itself still happens.
	 */
	private notConfiguredFallback(id: OcrBackendId, label: string, silent: boolean): OcrBackendAdapter {
		if (visionPlatformSupported()) {
			if (!silent) new Notice(`No API key set for ${label} — using Apple Vision (local) for this sync.`);
			return visionBackend();
		}
		return new UnavailableOcrBackend(id);
	}

	/** Lucide icon per sync state, rendered via setIcon() so it follows the theme (no raw glyphs). */
	private static readonly STATUS_ICONS = { busy: "refresh-cw", ok: "check", failed: "x" } as const;

	private setStatus(state: keyof typeof TaggedSyncPlugin.STATUS_ICONS, text: string): void {
		this.statusBar.empty();
		setIcon(this.statusBar.createSpan({ cls: "tagged-sync-status-icon" }), TaggedSyncPlugin.STATUS_ICONS[state]);
		this.statusBar.createSpan({ text });
		this.statusBar.show();
	}

	private showProgress(progress: SyncProgress): void {
		this.setStatus(
			"busy",
			progress.phase === "scanning"
				? "Tagged Sync: scanning…"
				: `Tagged Sync: ${progress.index}/${progress.total} · ${progress.name}`,
		);
	}

	async syncNow(): Promise<void> {
		if (!this.auth.isConnected()) {
			new Notice("Connect to reMarkable first.");
			return;
		}
		// A sync can run for minutes; a second one started on top of it would race on the shared index.
		if (this.syncing) {
			new Notice("A sync is already running.");
			return;
		}
		await this.runSyncNow(this.resolveOcrBackend(), false);
	}

	/**
	 * The sync run shared by the manual `Sync now` command and background auto-sync. Both hold the
	 * `syncing` guard, persist the index + `lastSyncAt`, and reflect state in the status bar. The
	 * `auto` flag flips the notice behaviour (auto-sync spec §Notifications): a background run is
	 * ambient — no "syncing…"/"up to date" popups, and it stays silent on failure (status bar only).
	 * It still announces *new* notes, the one thing worth interrupting for. Caller has already checked
	 * `isConnected` and (for auto) the money gate; `backend` is passed pre-resolved so it is resolved
	 * exactly once per run.
	 */
	private async runSyncNow(backend: OcrBackendAdapter, auto: boolean): Promise<void> {
		this.syncing = true;
		if (!auto) new Notice("Syncing…");
		this.setStatus("busy", "Tagged Sync: starting…");
		try {
			const sessionToken = await this.auth.session();
			const api = remarkableSession(sessionToken);
			const result = await runSync(
				{
					api,
					tagRouter: new TagRouter(this.data.tagFolderMap),
					noteStore: createNoteStore(this.app),
					attachmentStore: createAttachmentStore(this.app.vault),
					attachmentsFolder: normalizePath(normalizeAttachmentsFolder(this.data.attachmentsFolder)),
					ocrBackend: backend,
					now: () => new Date().toISOString(),
					onProgress: (progress) => this.showProgress(progress),
					// Checkpoint after each document, so an interrupted sync can't strand written notes
					// without index rows and duplicate them on the next run.
					saveIndex: async (index) => {
						this.data.syncIndex = index;
						await this.saveData(this.data);
					},
				},
				this.data.syncIndex,
			);

			this.data.syncIndex = result.index;
			this.data.lastSyncAt = new Date().toISOString();
			if (!auto) this.maybeShowUnavailableNotice(result.unavailableOcrUnits);
			await this.saveData(this.data);

			const wrote = result.notesWritten > 0;
			this.setStatus("ok", wrote ? `Tagged Sync: ${result.notesWritten} note(s)` : "Tagged Sync: up to date");
			if (wrote) new Notice(`Synced ${result.notesWritten} note(s).`);
			else if (!auto) new Notice("Already up to date.");
			// Both of these used to be console-only while the notice still reported plain success.
			if (!auto) this.reportPartialOutcomes(result);
		} catch (error) {
			this.lastSyncError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			this.setStatus("failed", "Tagged Sync: sync failed");
			if (!auto) new Notice(explainError(error, "sync"));
		} finally {
			this.syncing = false;
			// Re-anchor the interval to this run so the next auto-sync counts from the last sync, not
			// from load — otherwise the launch sync's few-second offset makes the first tick fall short.
			this.rearmAutoSyncInterval();
		}
	}

	/**
	 * (Re)installs the interval backstop after settings change, on load, or after each run (auto-sync spec
	 * §"Coexistence & scheduling"). Clears any existing timer first, then re-arms only when auto-sync
	 * is enabled with a non-null interval. Each tick fires an auto-sync only when the interval has
	 * actually elapsed since the last completed sync, so a manual `Sync now` pushes the next auto-run
	 * out rather than triggering a redundant one.
	 */
	rearmAutoSyncInterval(): void {
		if (this.autoSyncIntervalTimer !== null) {
			window.clearInterval(this.autoSyncIntervalTimer);
			this.autoSyncIntervalTimer = null;
		}
		const { enabled, intervalHours } = this.data.autoSync;
		if (!enabled || intervalHours === null) return;
		// Deliberately not registerInterval(): that would pile up a leaked interval on every re-arm,
		// since registered intervals are only cleared on unload. This one id is cleared above and in
		// onunload.
		this.autoSyncIntervalTimer = window.setInterval(() => {
			if (isIntervalSyncDue(this.data.lastSyncAt, intervalHours, Date.now())) this.triggerAutoSync();
		}, intervalHours * 3_600_000);
	}

	/**
	 * A single gated background sync (auto-sync spec §"Money-safety gate"/§Failure). Every pre-flight
	 * check that fails just returns silently — no notice, no error: disabled, an in-flight sync, no
	 * connection, or a metered backend the user hasn't consented to auto-run. Only a clean gate reaches
	 * the actual run.
	 */
	private async triggerAutoSync(): Promise<void> {
		if (!this.data.autoSync.enabled) return;
		if (this.syncing) return;
		if (!this.auth.isConnected()) return;
		const backend = this.resolveOcrBackend(true);
		if (backend.metered && !this.data.autoSync.autoTranscribeMetered) return;
		await this.runSyncNow(backend, true);
	}

	/**
	 * Reports the two ways a sync can finish "successfully" while quietly not doing what the user
	 * expected: notes it refused to overwrite, and documents it could not read or render. Both were
	 * `console.warn` only, which nobody sees, while the notice said the sync had worked.
	 */
	private reportPartialOutcomes(result: { editedNotesSkipped: number; documentsSkipped: number; failedOcrUnits: number }): void {
		// A failed transcription used to leave an empty "## Transcript", a console.warn nobody reads,
		// and a notice announcing plain success -- so the note looked synced and simply had no text.
		if (result.failedOcrUnits > 0) {
			const noun = result.failedOcrUnits === 1 ? "note" : "notes";
			new Notice(
				`${result.failedOcrUnits} ${noun} synced without a transcript because transcription failed. ` +
					"The handwriting render is still there. Press Copy diagnostics in settings if it keeps happening.",
				15_000,
			);
		}
		if (result.editedNotesSkipped > 0) {
			const noun = result.editedNotesSkipped === 1 ? "note was" : "notes were";
			new Notice(
				`${result.editedNotesSkipped} ${noun} not updated because they were edited inside the sync block. ` +
					"Move your edits below the block, then sync again.",
				15_000,
			);
		}
		if (result.documentsSkipped > 0) {
			const noun = result.documentsSkipped === 1 ? "notebook was" : "notebooks were";
			new Notice(`${result.documentsSkipped} ${noun} skipped — see the developer console for details.`, 10_000);
		}
	}

	/** Once, on the first sync that produces an `unavailable` unit, explain the platform gap; then stay silent forever (spec §6.2). Caller persists `this.data`. */
	private maybeShowUnavailableNotice(unavailableOcrUnits: number): void {
		if (unavailableOcrUnits === 0 || this.data.ocrUnavailableNoticeShown) return;
		this.data.ocrUnavailableNoticeShown = true;
		// State the limit; promise nothing. Pointing at an API key setting this build does not have is
		// worse than silence, and a promise of a future fix would be a debt.
		new Notice(
			"Text transcription needs macOS 13 or later. On this system, notes sync with the handwriting render only." +
				(hasAlternativeBackends() ? " Choose another OCR backend in settings to transcribe here." : ""),
			15_000,
		);
	}

	/**
	 * Re-runs OCR over every already-synced note and rewrites just its transcript (spec §8.4). Opt-in
	 * and confirmed first, because for LLM-vision it re-fetches every `.rm` and spends money -- a
	 * destructive-by-cost operation must never be automatic.
	 */
	async reTranscribeAll(): Promise<void> {
		if (!this.auth.isConnected()) {
			new Notice("Connect to reMarkable first.");
			return;
		}
		if (this.syncing) {
			new Notice("A sync is already running.");
			return;
		}

		const backend = this.resolveOcrBackend();
		const unitCount = Object.values(this.data.syncIndex.rows).filter((row) => row.status === "active").length;
		if (unitCount === 0) {
			new Notice("No synced notes to re-transcribe yet.");
			return;
		}
		// Only a metered cloud adapter actually spends money; local/vision/unavailable backends do not.
		const costCaveat = backend.metered ? " and re-sends every page to your OCR provider, using your API quota" : "";
		const confirmed = await confirmDialog(
			this.app,
			"Re-transcribe synced notes",
			`Re-transcribe ${unitCount} synced note(s) with the "${backend.id}" backend? This re-fetches each notebook from reMarkable${costCaveat}.`,
			"Re-transcribe",
		);
		if (!confirmed) return;

		this.syncing = true;
		this.setStatus("busy", "Tagged Sync: re-transcribing…");
		try {
			const sessionToken = await this.auth.session();
			const api = remarkableSession(sessionToken);
			const { updated, index } = await reTranscribeAll(
				{
					api,
					noteStore: createNoteStore(this.app),
					ocrBackend: backend,
					onProgress: (progress) => this.showProgress(progress),
				},
				this.data.syncIndex,
			);
			// Carries the refreshed block hashes -- without saving, the next sync would read this
			// re-transcribe as a hand edit and refuse to update every note it touched.
			this.data.syncIndex = index;
			await this.saveData(this.data);
			this.setStatus("ok", `Tagged Sync: re-transcribed ${updated} note(s)`);
			new Notice(`Re-transcribed ${updated} note(s).`);
		} catch (error) {
			this.lastSyncError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			this.setStatus("failed", "Tagged Sync: re-transcribe failed");
			new Notice(explainError(error, "sync"));
		} finally {
			this.syncing = false;
		}
	}
}

/**
 * A modal confirm dialog with Cancel / confirm buttons. Resolves `true` only on the confirm
 * button; dismissing it any other way (Cancel, Escape, click-outside) resolves `false`. Preferred
 * over `window.confirm`, which blocks the UI thread and reads poorly in an Obsidian pane.
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

	onClose(): void {
		this.contentEl.empty();
		this.onChoice(this.confirmed);
	}
}

/** Opens a {@link ConfirmModal} and resolves to the user's choice. */
function confirmDialog(app: App, title: string, body: string, confirmText: string): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, title, body, confirmText, resolve).open());
}

class TaggedSyncSettingTab extends PluginSettingTab {
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

		new Setting(containerEl)
			.setName("reMarkable connection")
			.setDesc(connected ? "Connected." : "Not connected.");

		if (connected) {
			new Setting(containerEl).addButton((button) =>
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
					text.setPlaceholder("abcdefgh").onChange((value) => {
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

		this.renderOcrSettings(containerEl);
		this.renderAutoSyncSettings(containerEl);

		if (connected) {
			this.renderTagRouting(containerEl);
		}
		this.renderActions(containerEl, connected);
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
						.setButtonText("Sync now")
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
							mappedTagCount: Object.keys(this.plugin.data.tagFolderMap).length,
							lastSyncAt: this.plugin.data.lastSyncAt,
							lastSyncError: this.plugin.lastSyncError,
						}),
					);
					new Notice("Diagnostics copied to the clipboard.");
				}),
			);
	}

	private renderOcrSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("OCR").setHeading();

		new Setting(containerEl)
			.setName("Backend")
			.setDesc(
				"Apple Vision runs locally and privately on macOS 13 or later — no account, key, or network." +
					(hasAlternativeBackends()
						? " The LLM providers send each page's render over the network to that provider, using your own API key."
						: ""),
			)
			.addDropdown((dropdown) => {
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
					this.plugin.data.ocrBackend = value as OcrBackendId;
					await this.plugin.saveData(this.plugin.data);
					this.display();
				});
			});

		// Flat-text ceiling hint (structure-preserving-ocr spec §3.2): the moment the user picks a
		// backend is where the Apple-Vision structure limit earns its place.
		containerEl.createDiv({
			cls: "tagged-sync-note",
			text:
				"Apple Vision: flat text only, no headings or tables." +
				(hasAlternativeBackends() ? " Choose an LLM backend for structured Markdown." : ""),
		});

		const id = this.plugin.data.ocrBackend;
		ocrBackendEntry(id)?.renderSettings?.(containerEl, {
			settings: (this.plugin.data.llmProviders[id] ??= {}),
			save: () => this.plugin.saveData(this.plugin.data),
		});
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

		// Money-safety consent (spec §"Money-safety gate"): only meaningful for a metered cloud backend.
		if (isMeteredProvider(this.plugin.data.ocrBackend)) {
			new Setting(containerEl)
				.setName("Automatically transcribe during background sync (uses your paid API)")
				.setDesc("Off by default: background sync is suppressed on a metered backend until you allow it here. Manual Sync now is unaffected.")
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
				button.setButtonText("Discover tags").onClick(async () => {
					button.setDisabled(true);
					try {
						const sessionToken = await this.plugin.auth.session();
						const api = remarkableSession(sessionToken);
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
		const mappedTags = Object.keys(mapping).sort();
		// The root always exists, so even a brand-new empty vault has one valid target.
		const folderPaths = [
			"/",
			...this.app.vault
				.getAllLoadedFiles()
				.filter((file): file is TFolder => file instanceof TFolder && !file.isRoot())
				.map((folder) => folder.path)
				.sort(),
		];
		const folderLabel = (path: string) => (path === "/" ? "Vault root" : path);

		const persist = async () => {
			await this.plugin.saveData(this.plugin.data);
			this.display();
		};

		// A mapped tag used to render read-only, so a wrong first choice could only be undone by editing
		// data.json by hand. Harmless before the cap; a trap with it, since the one slot would be stuck.
		if (mappedTags.length > 0) {
			new Setting(containerEl).setName("Mapped tags").setHeading();
			for (const tag of mappedTags) {
				new Setting(containerEl)
					.setName(tag)
					.setDesc(folderLabel(mapping[tag]))
					.addDropdown((dropdown) => {
						for (const path of folderPaths) dropdown.addOption(path, folderLabel(path));
						// The mapped folder may have been renamed or deleted since; keep it selectable either way.
						if (!folderPaths.includes(mapping[tag])) dropdown.addOption(mapping[tag], `${mapping[tag]} (missing)`);
						dropdown.setValue(mapping[tag]);
						dropdown.onChange(async (value) => {
							if (!value) return;
							mapping[tag] = value;
							await persist();
						});
					})
					.addButton((button) =>
						button
							.setButtonText("Remove")
							.setWarning()
							.onClick(async () => {
								delete mapping[tag];
								await persist();
							}),
					);
			}
			containerEl.createDiv({
				cls: "tagged-sync-note",
				text: "Removing a tag stops syncing it. Notes already in your vault stay where they are.",
			});
		}

		const unmappedTags = this.discoveredTags.filter((tag) => !(tag in mapping));
		if (unmappedTags.length === 0) return;

		new Setting(containerEl).setName("Unmapped tags").setHeading();

		// The cap only ever blocks *adding* a mapping. It must never unmap a tag that is already
		// mapped: unmapping feeds diffUnitTags, which orphans the row, and orphaning is index-only by
		// design -- the folder would just silently stop updating. A silent refusal reads as a bug, so
		// the reason is stated in place rather than by disabling the dropdown.
		if (mappedTags.length >= FREE_TAG_LIMIT) {
			containerEl.createDiv({
				cls: "tagged-sync-note",
				text: "The free version syncs one tag. Remove the current mapping to choose a different one.",
			});
			for (const tag of unmappedTags) new Setting(containerEl).setName(tag).setDesc("Not synced.");
			return;
		}

		for (const tag of unmappedTags) {
			new Setting(containerEl)
				.setName(tag)
				.setDesc("Not synced until mapped to a folder.")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "Choose a folder…");
					for (const path of folderPaths) dropdown.addOption(path, folderLabel(path));
					dropdown.onChange(async (value) => {
						if (!value) return;
						mapping[tag] = value;
						await persist();
					});
				});
		}
	}
}
