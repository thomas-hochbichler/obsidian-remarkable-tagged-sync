/**
 * `data.json`, as this plugin reads it.
 *
 * There is no schema version here and that is a decision, not an omission. Three facts make a version
 * stamp worse than the shape-driven migration below:
 *
 * 1. **`onload` never writes.** Every one of the plugin's `saveData` calls sits behind a user action.
 *    Loading migrates in memory and saves nothing, so a stamp would only reach the disk on the first
 *    action that happens to persist -- a user who upgrades and syncs nothing keeps a versionless file
 *    indefinitely. A version that is absent for an unbounded time cannot be required, cannot be
 *    trusted, and cannot be the thing a migration branches on.
 * 2. **This `data.json` is an explicitly synced file.** The licence lives in it precisely so that one
 *    vault is one activation wherever it is opened -- which means two installs on *different plugin
 *    versions* sharing one file through Obsidian Sync is supported, not hypothetical. A shape-driven
 *    read survives that in both directions; a version number invites the older install to refuse.
 * 3. Every field already has a defined answer for "absent". The migration is therefore **total** and
 *    **idempotent**, and those two properties are what its tests assert instead of a version.
 */

import { DEFAULT_ATTACHMENTS_FOLDER } from "./attachment-writer";
import { type LicenceState, NO_LICENCE } from "./licence-state";
import type { OcrBackend as OcrBackendId } from "./note-builder";
import type { BackendSettings } from "./ocr-registry";
import { EMPTY_SYNC_INDEX, type SyncIndex } from "./sync-engine";
import type { TagFolderMap } from "./tag-router";

/** Opt-in background sync (auto-sync spec §"Settings & data model"). */
export interface AutoSyncSettings {
	/** Master toggle; default off. */
	enabled: boolean;
	/** Interval backstop in hours; `null` means on-launch only (interval disabled). */
	intervalHours: number | null;
	/** Durable one-time consent to auto-run a metered cloud backend; default off. */
	autoTranscribeMetered: boolean;
}

export const DEFAULT_AUTO_SYNC: AutoSyncSettings = {
	enabled: false,
	intervalHours: 6,
	autoTranscribeMetered: false,
};

export interface TaggedSyncData {
	deviceToken: string | null;
	tagFolderMap: TagFolderMap;
	syncIndex: SyncIndex;
	ocrBackend: OcrBackendId;
	/**
	 * Each backend's own settings blob, keyed by backend id and remembered across backend switches
	 * (multi-provider spec §4). Opaque here -- only the backend that owns a blob reads inside it.
	 */
	llmProviders: Record<string, BackendSettings>;
	/** Set once the platform "no transcription here" notice has been shown, so it never nags again (spec §6.2). */
	ocrUnavailableNoticeShown: boolean;
	autoSync: AutoSyncSettings;
	/** ISO timestamp of the last *completed* sync (manual or auto); drives the interval backstop. */
	lastSyncAt: string | null;
	/** Vault folder for rendered PDFs (spec §8: configurable, default `tagged-sync/attachments`). Stored raw; normalized at use. */
	attachmentsFolder: string;
	/**
	 * F20. Handwritten margin notes on annotated PDFs, off by default: transcribing them spawns an OCR
	 * process per note, and a transcription of someone's own handwriting is not something to write into
	 * their vault unasked.
	 */
	marginNotes: boolean;
	/**
	 * The Pro licence, beside `deviceToken` because that is where this vault's other credential
	 * already lives. In a synced vault these fields travel to the other machine, which is correct:
	 * one vault is one activation, wherever it is opened.
	 */
	licence: LicenceState;
}

export const DEFAULT_DATA: TaggedSyncData = {
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
	marginNotes: false,
	licence: NO_LICENCE,
};

/**
 * The two things the migration is not allowed to work out for itself. Both are module state at the
 * call site, and both would make this unit untestable in the way that matters:
 *
 * - the registry is populated by **side-effect imports** (`vision-register`, `llm-register`, …), so a
 *   test importing this file alone would see an empty registry and watch every stored backend get
 *   coerced -- a green test proving nothing.
 * - the platform default is a `Platform`/`os` read, which a unit test cannot move. Injected, both of
 *   its branches are one argument.
 */
export interface SettingsEnv {
	/** Is this an OCR backend this build still knows? */
	isKnownBackend: (id: unknown) => boolean;
	/** What an unknown or absent backend becomes -- platform-derived (multi-provider spec §7). */
	defaultBackend: OcrBackendId;
}

/** What `loadData()` may hand back: anything, plus the one key that was renamed. */
type SavedData = (Partial<TaggedSyncData> & { ocrBackendChoice?: unknown }) | null | undefined;

/**
 * Reads a stored `data.json` into the shape the plugin runs on. **Total** -- every input, including
 * `null`, a string and an array, produces a complete object -- and **idempotent**, so a file this
 * has already migrated migrates to itself.
 */
export function migrateSettings(saved: unknown, env: SettingsEnv): TaggedSyncData {
	// Optional chaining is what makes this total: every non-object input answers `undefined` to every
	// field, so junk and absence take the same path rather than needing a guard of their own.
	const stored = saved as SavedData;
	// Old installs stored the choice under `ocrBackendChoice`, so "vision" survives; the retired
	// "llm-vision"/"tesseract" reset (multi-provider spec §7). The old single `llmVisionApiKey` is
	// dropped by not carrying it forward -- users re-enter their key once under the per-provider model.
	const savedBackend = stored?.ocrBackend ?? stored?.ocrBackendChoice;
	return {
		deviceToken: stored?.deviceToken ?? DEFAULT_DATA.deviceToken,
		tagFolderMap: stored?.tagFolderMap ?? {},
		syncIndex: stored?.syncIndex ?? EMPTY_SYNC_INDEX,
		ocrBackend: env.isKnownBackend(savedBackend) ? (savedBackend as OcrBackendId) : env.defaultBackend,
		llmProviders: stored?.llmProviders ?? {},
		ocrUnavailableNoticeShown: stored?.ocrUnavailableNoticeShown ?? false,
		autoSync: { ...DEFAULT_AUTO_SYNC, ...stored?.autoSync },
		lastSyncAt: stored?.lastSyncAt ?? null,
		attachmentsFolder: stored?.attachmentsFolder ?? DEFAULT_DATA.attachmentsFolder,
		// A saved `true` is honoured. It can only have been written by someone who switched the setting
		// on themselves, in a 1.1.0 beta; the feature they said yes to now draws the handwriting out of
		// the embedded PDF instead of storing a picture of it, and the setting they used to say it with
		// is on screen again to say no with.
		marginNotes: stored?.marginNotes ?? DEFAULT_DATA.marginNotes,
		// Spread over the default so a `data.json` written by an older version, or one a user has
		// edited by hand, is missing fields rather than being rejected.
		licence: { ...NO_LICENCE, ...stored?.licence },
	};
}
