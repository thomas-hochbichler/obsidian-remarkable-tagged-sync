import {
	normalizePath,
	Notice,
	Plugin,
	ProgressBarComponent,
	setIcon,
	setTooltip,
	type TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import { normalizeAttachmentsFolder } from "./attachment-writer";
import { autoSpendBlocked, backgroundConsentGiven, backgroundRunBlocked } from "./auto-sync-gates";
import { confirmDialog } from "./confirm-modal";
import { isIntervalSyncDue } from "./auto-sync";
import { checkLicence, type LicenceApi, type LicenceContext } from "./licence-check";
import { createPolarLicenceApi } from "./licence-client";
import { type Entitlement, entitlementOf } from "./licence-state";
import type { OcrBackend as OcrBackendId } from "./note-builder";
import { remapRows } from "./note-rename";
import type { OcrBackend as OcrBackendAdapter } from "./ocr-backend";
import { isRegisteredOcrBackend, ocrBackendEntries, ocrBackendEntry } from "./ocr-registry";
import { reTranscribeConfirmation, reTranscribeIsUseful } from "./re-transcribe-prompt";
import { registerRegionProcessor } from "./region-view";
import { type AuthStore, RemarkableAuth } from "./remarkable-auth";
import { CloudTransport } from "./cloud-transport";
import { type Transport, type TransportSession, explainTransportError } from "./transport";
import { reTranscribeAll, runSync, type SyncProgress } from "./sync-engine";
import { type Scheduler, windowScheduler } from "./scheduler";
import { TaggedSyncSettingTab } from "./settings-tab";
import { outcomeStatus, progressStatus, type StatusRequest, statusView, type SyncStatusState } from "./status-model";
import {
	LONG_NOTICE_MS,
	outcomeNotice,
	partialOutcomeNotices,
	type PartialOutcome,
	platformGapNotice,
} from "./sync-notices";
import { NOTHING_SYNCED_NOTICE, type Preflight, preflightRun, reTranscribableUnits, type RunConditions } from "./sync-guards";
import {
	defaultOcrBackend,
	hasAlternativeBackends,
	isGated,
	type OcrFallback,
	planGatedFallback,
	planUnconfiguredFallback,
} from "./ocr-resolution";
import { TagRouter } from "./tag-router";
import { DEFAULT_DATA, migrateSettings, type TaggedSyncData } from "./settings-store";
import { createAttachmentStore, createNoteStore, resolveFolderCasing, resolveTagMapCasing } from "./vault-stores";
import { UnavailableOcrBackend } from "./vision-ocr-backend";
import { visionBackend } from "./vision-register";
import { visionPlatformSupported } from "./vision-ocr-runtime";

/** How long after `onload` to fire the on-launch auto-sync — a few seconds so auth/network are ready and startup isn't janked (auto-sync spec §Triggers). */
const AUTO_SYNC_LAUNCH_DELAY_MS = 4_000;

export default class TaggedSyncPlugin extends Plugin {
	data: TaggedSyncData = DEFAULT_DATA;
	auth!: RemarkableAuth;
	private cloudTransport!: Transport;
	readonly licenceApi: LicenceApi = createPolarLicenceApi();
	/** What the launch delay and the interval backstop run on. Replaced in tests; see `./scheduler`. */
	scheduler: Scheduler = windowScheduler;

	/**
	 * Now, as a sync writes it. The same clock the interval is measured on, deliberately: `lastSyncAt`
	 * is the value `isIntervalSyncDue` counts from, so two clocks here would let the backstop answer a
	 * question about a moment that never existed.
	 */
	private nowIso(): string {
		return new Date(this.scheduler.now()).toISOString();
	}
	private statusBar!: HTMLElement;
	/**
	 * The status bar's parts are held, not rebuilt per update: recreating the icon on every
	 * progress tick would restart the busy spin from zero, so it would jerk instead of turn.
	 */
	private statusIcon!: HTMLElement;
	/** The sentence, never cut short. */
	private statusText!: HTMLElement;
	/** A document's name, capped in width -- the tooltip carries it in full. */
	private statusName!: HTMLElement;
	private statusBarWrapper!: HTMLElement;
	private statusProgress!: ProgressBarComponent;
	/** The last fraction shown, so a pending stop can freeze the bar where it stands. */
	private lastBar: number | null = null;
	private statusState: SyncStatusState | null = null;
	private syncing = false;
	/**
	 * Set by `requestStop()`, polled by the engine at unit boundaries. Reset at the start of every run
	 * as well as in its `finally`: a stop confirmed just as the run ends must not carry over and kill
	 * the next one before it has done anything.
	 */
	private stopRequested = false;
	/**
	 * Raw text of the last failure, for "Copy diagnostics". Held in memory rather than persisted: it
	 * is wanted right after something went wrong, and a reverse-engineered API's raw error is often
	 * the whole diagnosis -- but it is not state the plugin should carry around in `data.json`.
	 */
	lastSyncError: string | null = null;
	private autoSyncLaunchTimer: number | null = null;
	private autoSyncIntervalTimer: number | null = null;

	/**
	 * What Pro is unlocked for right now. Read from the stored fields only -- asking this never
	 * causes a network call, which is what keeps the promise that a free user never talks to Polar.
	 */
	entitlement(): Entitlement {
		return entitlementOf(this.data.licence, new Date());
	}

	/**
	 * Re-reads the licence from Polar if one is due, and returns what the answer entitles the user to.
	 *
	 * Called on the path of a gated feature and nowhere else. `checkLicence` itself decides whether a
	 * call is needed, so this is cheap to ask and silent for a free user.
	 */
	async refreshLicence(silent = false): Promise<Entitlement> {
		const result = await checkLicence(this.data.licence, this.licenceApi, this.licenceContext());
		let state = result.state;
		// A background run must never interrupt with a popup (auto-sync spec §Failure), and the
		// ended-licence notice is shown once ever -- so spending it on a run nobody is watching would
		// mean nobody ever sees it. Holding the flag back keeps the lock immediate and the sentence
		// for the next time the user is actually there.
		if (silent && result.notice !== null) state = { ...state, endedNoticeShown: false };
		if (result.changed) {
			this.data.licence = state;
			await this.saveData(this.data);
		}
		if (!silent && result.notice !== null) new Notice(result.notice);
		return result.entitlement;
	}

	/**
	 * Re-checks the licence before a run, but only when the selected backend is one that needs it.
	 * A user on Apple Vision or a local server causes no call, whatever they own.
	 */
	private async refreshLicenceIfGated(silent: boolean): Promise<void> {
		if (this.backendRequiresLicence()) await this.refreshLicence(silent);
	}

	private backendRequiresLicence(): boolean {
		return ocrBackendEntry(this.data.ocrBackend)?.requiresLicence === true;
	}

	/** Where this vault reads its notes from right now. */
	transport(): Transport {
		return this.cloudTransport;
	}

	/** What {@link preflightRun} judges, read off the plugin at the moment it is asked. */
	private runConditions(): RunConditions {
		return {
			connected: this.transport().status().connected,
			running: this.syncing,
			backendRequiresLicence: this.backendRequiresLicence(),
		};
	}

	/** The vault's name labels the activation, so the buyer recognises the row in Polar's own list. */
	licenceContext(): LicenceContext {
		// `off` is the platform default wherever Apple Vision cannot run, and it is not something to
		// name as a fallback -- there, honestly, nothing transcribes.
		const fallback = defaultOcrBackend(visionPlatformSupported());
		return {
			label: this.app.vault.getName(),
			now: new Date(),
			fallbackBackend: fallback === "off" ? null : (ocrBackendEntry(fallback)?.label ?? null),
		};
	}

	async onload() {
		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("tagged-sync-status");
		this.statusIcon = this.statusBar.createSpan({ cls: "tagged-sync-status-icon" });
		// Obsidian's own component rather than a bare `<progress>`: that one paints in the *operating
		// system's* accent colour, which is the one colour on screen no theme can reach.
		this.statusBarWrapper = this.statusBar.createSpan({ cls: "tagged-sync-status-bar" });
		this.statusProgress = new ProgressBarComponent(this.statusBarWrapper);
		this.statusText = this.statusBar.createSpan();
		this.statusName = this.statusBar.createSpan({ cls: "tagged-sync-status-name" });
		// The whole item, not just the icon: a status bar item is already a small target, and the text
		// beside the spinner is the part that says a run is happening. Whether it does anything is
		// decided at click time -- `mod-clickable` and the tooltip come and go with the busy state.
		this.registerDomEvent(this.statusBar, "click", () => void this.confirmStop());
		this.statusBar.hide();
		this.data = migrateSettings(await this.loadData(), {
			isKnownBackend: isRegisteredOcrBackend,
			defaultBackend: defaultOcrBackend(visionPlatformSupported()),
		});

		const store: AuthStore = {
			getDeviceToken: () => this.data.deviceToken,
			setDeviceToken: async (token) => {
				this.data.deviceToken = token;
				await this.saveData(this.data);
			},
		};
		this.auth = new RemarkableAuth(store);
		this.cloudTransport = new CloudTransport(this.auth);

		this.addSettingTab(new TaggedSyncSettingTab(this.app, this));
		// Registered whatever the setting says: it governs whether a sync *writes* margin notes, while a
		// note that already carries one has to keep working after the setting is switched off again.
		registerRegionProcessor(this);
		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => this.syncNow(),
		});
		this.addCommand({
			id: "stop-sync",
			name: "Stop sync",
			// Hidden unless something is running, like `re-transcribe-all` below. No confirmation: a
			// command the user went looking for and named "Stop sync" *is* the intent. The status-bar
			// click asks first because a click there could be a slip.
			checkCallback: (checking) => {
				if (!this.isSyncing()) return false;
				if (!checking) this.requestStop();
				return true;
			},
		});
		this.addCommand({
			id: "re-transcribe-all",
			name: "Re-transcribe all synced notes",
			// Pointless without a backend that produces text (Off, or Vision on Windows/Linux):
			// hidden from the palette rather than failing at run time.
			checkCallback: (checking) => {
				// Silent: this runs on every keystroke in the palette, and a backend that falls back
				// announces the fallback.
				const backend = this.resolveOcrBackend(true);
				if (!reTranscribeIsUseful(backend, ocrBackendEntry(backend.id))) return false;
				if (!checking) void this.reTranscribeAll();
				return true;
			},
		});

		// Keep data.json note paths accurate across user renames/moves (invisible-sync-state 01).
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath)));

		// On-launch auto-sync (spec §Triggers): wait for the workspace to finish loading, then a few
		// seconds more so auth/network are ready.
		this.app.workspace.onLayoutReady(() => {
			this.autoSyncLaunchTimer = this.scheduler.setTimeout(() => {
				void this.triggerAutoSync();
			}, AUTO_SYNC_LAUNCH_DELAY_MS);
		});
		this.rearmAutoSyncInterval();
	}

	onunload() {
		if (this.autoSyncLaunchTimer !== null) this.scheduler.clearTimeout(this.autoSyncLaunchTimer);
		if (this.autoSyncIntervalTimer !== null) this.scheduler.clearInterval(this.autoSyncIntervalTimer);
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
		const kind = file instanceof TFolder ? "folder" : file instanceof TFile ? "file" : null;
		if (kind === null) return;
		const rows = remapRows(this.data.syncIndex.rows, { kind, from: oldPath, to: file.path });
		if (rows === null) return;
		this.data.syncIndex.rows = rows;
		await this.saveData(this.data);
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
		// Present in the bundle but not permitted. It falls back like an unconfigured backend rather
		// than disappearing from the dropdown: a backend that vanishes teaches nobody that Pro exists,
		// and a silent stop reads as a broken plugin instead of an ended licence.
		if (isGated(entry, this.entitlement().tier)) {
			const label = entry.label;
			return this.applyOcrFallback(planGatedFallback({ label, visionAvailable: visionPlatformSupported(), silent }), id);
		}
		// `??=` rather than `??`: a backend that writes through its blob during a run -- the local
		// model records each page's duration there -- needs the live object, not a throwaway copy, or
		// the measurement is lost the moment the sync ends.
		const adapter = entry.create((this.data.llmProviders[id] ??= {}), { silent });
		if (adapter) return adapter;
		const label = entry.label;
		return this.applyOcrFallback(planUnconfiguredFallback({ label, visionAvailable: visionPlatformSupported(), silent }), id);
	}

	/** Wiring only: raise what the plan says to say, build what it says to use. */
	private applyOcrFallback(plan: OcrFallback, id: OcrBackendId): OcrBackendAdapter {
		if (plan.notice !== null) new Notice(plan.notice);
		return plan.use === "vision" ? visionBackend() : new UnavailableOcrBackend(id);
	}

	/** Wiring only: `status-model.ts` decides what the item says, this puts it on screen. */
	private setStatus(state: SyncStatusState, text: string, options: Omit<StatusRequest, "state" | "text"> = {}): void {
		this.applyStatus({ state, text, ...options });
	}

	private applyStatus(request: StatusRequest): void {
		const view = statusView(request, this.stopRequested);
		// Only the text moves while a state lasts -- the icon is left alone so `is-busy` keeps spinning
		// it across progress ticks, including the long silent ones (OCR, re-transcribe).
		if (view.state !== this.statusState) {
			this.statusIcon.empty();
			setIcon(this.statusIcon, view.icon);
			this.statusBar.toggleClass("is-busy", view.spinning);
			this.statusState = view.state;
		}
		// Outside that guard on purpose: this follows `stopRequested` too, which flips without a state
		// change. Cheap enough to redo every tick -- a class and an attribute, not a rebuilt icon.
		this.statusBar.toggleClass("mod-clickable", view.stoppable);
		setTooltip(this.statusBar, view.tooltip);

		this.lastBar = view.bar;
		if (view.bar === null) this.statusBarWrapper.hide();
		else {
			this.statusProgress.setValue(view.bar);
			this.statusBarWrapper.show();
		}
		// Both parts are hidden when empty: the item is a flex row with a gap, so an empty span would
		// still push its neighbours apart.
		this.statusText.setText(view.text);
		this.statusText.toggle(view.text !== "");
		this.statusName.setText(view.document);
		this.statusName.toggle(view.document !== "");
		this.statusBar.show();
	}

	private showProgress(progress: SyncProgress): void {
		this.applyStatus(progressStatus(progress, this.stopRequested, this.lastBar));
	}

	/**
	 * The status-bar click. Silent when there is nothing to stop: the item stays visible after a run
	 * ends, showing its outcome, and clicking that should do nothing rather than explain itself. Also
	 * silent on a second click, since the first stop is already pending.
	 */
	private async confirmStop(): Promise<void> {
		if (!this.isSyncing() || this.stopRequested) return;
		const confirmed = await confirmDialog(
			this.app,
			"Stop sync",
			// The delay is stated because it is the one thing that would otherwise read as a broken
			// button: the user clicks Stop and the spinner keeps turning, possibly for minutes on a
			// large notebook with the local model.
			"Stop the run that is in progress? The note being transcribed right now is finished first, so this can take a moment. Everything already written is kept, and the next sync carries on from there.",
			"Stop",
		);
		// The run may well have ended while the dialog sat open; requestStop() ignores that.
		if (confirmed) this.requestStop();
	}

	async syncNow(): Promise<void> {
		const claim = this.claimRun();
		if (!claim.start) {
			new Notice(claim.notice);
			return;
		}
		try {
			if (claim.refreshLicence) await this.refreshLicence(false);
			await this.runSyncNow(this.resolveOcrBackend(), false);
		} finally {
			this.syncing = false;
		}
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
	/**
	 * Asks the run in flight to stop at its next unit boundary. A no-op when nothing is running, which
	 * is the other half of the guard on `stopRequested`: the stop dialog can be confirmed after the run
	 * it was opened for has already finished.
	 *
	 * The stop is not immediate — the unit currently being rendered and transcribed always finishes, so
	 * on a slow backend the status bar can keep turning for a while after this returns.
	 */
	requestStop(): void {
		if (!this.syncing) return;
		this.stopRequested = true;
		// Said now rather than at the next progress tick, which can be a whole unit away: a click that
		// changes nothing visible reads as a click that did not register.
		this.setStatus("busy", "Tagged Sync: stopping…");
	}

	/** Whether a long-running job is in flight, and so whether there is anything to stop. */
	isSyncing(): boolean {
		return this.syncing;
	}

	/**
	 * Asks {@link preflightRun} whether a long job may start and, if it may, takes the
	 * one-run-at-a-time lock -- in one synchronous step, which is the whole of it. `syncing` used to
	 * be *read* in the pre-flight and *set* several awaits later, inside `runSyncNow`; two presses of
	 * Sync now in the same tick both got through the read before either did the write, and then both
	 * wrote the one sync index.
	 *
	 * Whoever claims it releases it. `runSyncNow` does neither -- it is called with the lock held.
	 */
	private claimRun(): Preflight {
		const preflight = preflightRun(this.runConditions());
		if (preflight.start) this.syncing = true;
		return preflight;
	}

	/** Runs a sync. The caller holds the run lock and releases it; see {@link claimRun}. */
	private async runSyncNow(backend: OcrBackendAdapter, auto: boolean): Promise<void> {
		this.stopRequested = false;
		if (!auto) new Notice("Syncing…");
		this.setStatus("busy", "Tagged Sync: starting…");
		const transport = this.transport();
		let session: TransportSession | null = null;
		try {
			session = await transport.open();
			const result = await runSync(
				{
					api: session.api,
					// Both configured folder sets resolve to the vault's real casing here, before any
					// path is derived from them -- see resolveFolderCasing for why (issue #73).
					tagRouter: new TagRouter(await resolveTagMapCasing(this.app.vault, this.data.tagFolderMap)),
					noteStore: createNoteStore(this.app),
					attachmentStore: createAttachmentStore(this.app.vault),
					attachmentsFolder: await resolveFolderCasing(
						this.app.vault,
						normalizePath(normalizeAttachmentsFolder(this.data.attachmentsFolder)),
					),
					ocrBackend: backend,
					marginNotes: this.data.marginNotes,
					now: () => this.nowIso(),
					onProgress: (progress) => this.showProgress(progress),
					shouldStop: () => this.stopRequested,
					// Checkpoint after each document, so an interrupted sync can't strand written notes
					// without index rows and duplicate them on the next run.
					saveIndex: async (index) => {
						this.data.syncIndex = index;
						await this.saveData(this.data);
					},
				},
				this.data.syncIndex,
			);

			// A background run the user stopped by hand is not a background run any more: they are at the
			// keyboard, watching, and owed the same reporting a manual sync gets.
			const speak = !auto || result.stopped;

			this.data.syncIndex = result.index;
			// Deliberately not stamped on a stopped run. `isIntervalSyncDue` counts from the last
			// *completed* sync, so stamping here would push the next auto-sync out by a full interval as
			// if the work had been done -- and leave "last synced" claiming a run that never finished.
			if (!result.stopped) this.data.lastSyncAt = this.nowIso();
			if (speak) this.maybeShowUnavailableNotice(result.unavailableOcrUnits);
			// Saved either way: this is also the only call that persists what a backend wrote into its own
			// settings blob during the run (the local model records each page's duration there).
			await this.saveData(this.data);

			// A run that skipped units "succeeded" overall, but its errors are exactly what "Copy
			// diagnostics" is for -- they used to be console.warn only, leaving "Last error: none"
			// there. A clean run clears any stale error, so diagnostics reflects the latest sync. A stop
			// is not itself an error and contributes nothing here; only what the partial run hit does.
			this.lastSyncError = result.skipErrors.length > 0 ? result.skipErrors.join("\n") : null;

			this.applyStatus(outcomeStatus(result));
			const outcome = outcomeNotice({ stopped: result.stopped, notesWritten: result.notesWritten, background: auto });
			if (outcome !== null) new Notice(outcome);
			// Both of these used to be console-only while the notice still reported plain success. A
			// stopped run's skips and failures are just as real as a completed one's.
			if (speak) this.reportPartialOutcomes(result);
		} catch (error) {
			this.lastSyncError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			this.setStatus("failed", "Tagged Sync: sync failed");
			if (!auto) new Notice(explainTransportError(transport, error, "sync"));
		} finally {
			await session?.close();
			this.stopRequested = false;
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
			this.scheduler.clearInterval(this.autoSyncIntervalTimer);
			this.autoSyncIntervalTimer = null;
		}
		const { enabled, intervalHours } = this.data.autoSync;
		if (!enabled || intervalHours === null) return;
		// Deliberately not registerInterval(): that would pile up a leaked interval on every re-arm,
		// since registered intervals are only cleared on unload. This one id is cleared above and in
		// onunload.
		this.autoSyncIntervalTimer = this.scheduler.setInterval(() => {
			if (isIntervalSyncDue(this.data.lastSyncAt, intervalHours, this.scheduler.now())) void this.triggerAutoSync();
		}, intervalHours * 3_600_000);
	}

	/**
	 * A single gated background sync (auto-sync spec §"Money-safety gate"/§Failure). Every pre-flight
	 * check that fails just returns silently — no notice, no error: disabled, an in-flight sync, no
	 * connection, or a metered backend the user hasn't consented to auto-run. Only a clean gate reaches
	 * the actual run.
	 */
	private async triggerAutoSync(): Promise<void> {
		const entry = ocrBackendEntry(this.data.ocrBackend);
		if (
			backgroundRunBlocked({
				enabled: this.data.autoSync.enabled,
				running: this.syncing,
				connected: this.auth.isConnected(),
				backgroundConsent: backgroundConsentGiven(entry, this.data.llmProviders[this.data.ocrBackend] ?? {}),
			}) !== null
		) {
			return;
		}
		// Resolved only now, because resolving is not free: it constructs adapters and can raise a
		// fallback notice. Everything decidable without one has been decided above.
		await this.refreshLicenceIfGated(true);
		const backend = this.resolveOcrBackend(true);
		if (autoSpendBlocked(backend.metered, this.data.autoSync.autoTranscribeMetered) !== null) return;
		// Claimed here rather than at the top: the gates above can decide not to run at all, and a tick
		// that holds the lock while deciding makes `isSyncing()` -- and the Stop sync command with it --
		// lie about a run that never starts. The read above is only fast feedback; this is the gate.
		if (!this.claimRun().start) return;
		try {
			await this.runSyncNow(backend, true);
		} finally {
			this.syncing = false;
		}
	}

	/** Wiring only: `sync-notices.ts` decides which of the five are said, in what words and in what order. */
	private reportPartialOutcomes(result: PartialOutcome): void {
		for (const notice of partialOutcomeNotices(result)) new Notice(notice.message, notice.timeout);
	}

	/** Once, on the first sync that produces an `unavailable` unit; then never again. Caller persists `this.data`. */
	private maybeShowUnavailableNotice(unavailableOcrUnits: number): void {
		const notice = platformGapNotice({
			unavailableUnits: unavailableOcrUnits,
			alreadyShown: this.data.ocrUnavailableNoticeShown,
			alternativesExist: hasAlternativeBackends(ocrBackendEntries()),
		});
		if (notice === null) return;
		this.data.ocrUnavailableNoticeShown = true;
		new Notice(notice, LONG_NOTICE_MS);
	}

	/**
	 * Re-runs OCR over every already-synced note and rewrites just its transcript (spec §8.4). Opt-in
	 * and confirmed first, because for LLM-vision it re-fetches every `.rm` and spends money -- a
	 * destructive-by-cost operation must never be automatic.
	 */
	async reTranscribeAll(): Promise<void> {
		// Not a claim: this only spares the user a dialog they would be refused after. The lock is
		// taken below, once they have actually said yes.
		const preflight = preflightRun(this.runConditions());
		if (!preflight.start) {
			new Notice(preflight.notice);
			return;
		}

		if (preflight.refreshLicence) await this.refreshLicence(false);
		const backend = this.resolveOcrBackend();
		const unitCount = reTranscribableUnits(this.data.syncIndex.rows);
		if (unitCount === 0) {
			new Notice(NOTHING_SYNCED_NOTICE);
			return;
		}
		const entry = ocrBackendEntry(this.data.ocrBackend);
		const confirmed = await confirmDialog(
			this.app,
			"Re-transcribe synced notes",
			reTranscribeConfirmation({
				unitCount,
				backendId: backend.id,
				// Off the resolved adapter, not the chosen id: a paid backend that fell back to a free
				// one spends nothing, and would otherwise be warned about anyway.
				metered: backend.metered,
				timeCaveat: entry?.reTranscribeCaveat?.(this.data.llmProviders[entry.id] ?? {}, unitCount) ?? "",
			}),
			"Re-transcribe",
		);
		if (!confirmed) return;

		// The dialog may have sat open for minutes, so nothing the pre-flight established is still
		// known -- the connection can have gone too. Said out loud rather than returning quietly: the
		// user has just pressed the button.
		const claim = this.claimRun();
		if (!claim.start) {
			new Notice(claim.notice);
			return;
		}
		this.stopRequested = false;
		this.setStatus("busy", "Tagged Sync: re-transcribing…");
		const transport = this.transport();
		let session: TransportSession | null = null;
		try {
			session = await transport.open();
			const { updated, index, stopped } = await reTranscribeAll(
				{
					api: session.api,
					noteStore: createNoteStore(this.app),
					ocrBackend: backend,
					onProgress: (progress) => this.showProgress(progress),
					shouldStop: () => this.stopRequested,
					// Checkpoint after each note, so an interrupted re-transcribe can't leave notes whose
					// stored blockHash no longer describes them -- the next sync would read those as hand
					// edits and never touch them again.
					saveIndex: async (index) => {
						this.data.syncIndex = index;
						await this.saveData(this.data);
					},
				},
				this.data.syncIndex,
			);
			// Carries the refreshed block hashes -- without saving, the next sync would read this
			// re-transcribe as a hand edit and refuse to update every note it touched.
			this.data.syncIndex = index;
			await this.saveData(this.data);
			if (stopped) {
				// The notes it did reach keep their fresh transcripts; the rest keep the old ones, and
				// running the command again picks them up.
				this.setStatus("stopped", `Tagged Sync: stopped · re-transcribed ${updated} note(s)`);
				new Notice(`Re-transcribe stopped. ${updated} note(s) refreshed; the rest are unchanged.`);
			} else {
				this.setStatus("ok", `Tagged Sync: re-transcribed ${updated} note(s)`);
				new Notice(`Re-transcribed ${updated} note(s).`);
			}
		} catch (error) {
			this.lastSyncError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			this.setStatus("failed", "Tagged Sync: re-transcribe failed");
			new Notice(explainTransportError(transport, error, "sync"));
		} finally {
			await session?.close();
			this.syncing = false;
			this.stopRequested = false;
		}
	}
}
