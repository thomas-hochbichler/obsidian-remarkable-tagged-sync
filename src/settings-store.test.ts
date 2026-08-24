import { describe, expect, it } from "vitest";
import { NO_LICENCE } from "./licence-state";
import { DEFAULT_AUTO_SYNC, DEFAULT_DATA, migrateSettings, type SettingsEnv } from "./settings-store";

// Gap G20 -- settings migration and the state after an upgrade. Every field of `data.json` is read
// raw and there is no schema version; the two properties that stand in for one are asserted here:
// the read is **total** (every input yields a complete object) and **idempotent** (a file it has
// already read reads to itself).
//
// This file imports neither `obsidian` nor `rmapi-js` nor the plugin. That is what `SettingsEnv` buys:
// the registry is filled by side-effect imports and the platform default is an `os` read, so left
// un-injected a test here would watch every stored backend get coerced and call it a pass.
//
// What the *shipped* plugin does with the real registry and the real platform is
// `settings-on-load.test.ts`.

/** A build that knows two backends. Neither is "vision", so a coercion here cannot pass by accident. */
const ENV: SettingsEnv = {
	isKnownBackend: (id) => id === "off" || id === "anthropic",
	defaultBackend: "off",
};

const MAC: SettingsEnv = { ...ENV, defaultBackend: "vision" };

describe("migrateSettings", () => {
	it("gives a first install every default", () => {
		expect(migrateSettings(null, MAC)).toEqual({ ...DEFAULT_DATA, ocrBackend: "vision" });
	});

	it("is total: nothing a data.json could hold makes it throw or return a hole", () => {
		// `loadData()` reads a file a user can edit, and a sync conflict can leave anything in it.
		for (const junk of [null, undefined, "", "a string", 0, 1, true, false, [], [1, 2], NaN]) {
			const data = migrateSettings(junk, ENV);
			expect(Object.keys(data).sort()).toEqual(Object.keys(DEFAULT_DATA).sort());
			expect(data.licence).toEqual(NO_LICENCE);
			expect(data.autoSync).toEqual(DEFAULT_AUTO_SYNC);
		}
	});

	it("is idempotent: reading its own output changes nothing", () => {
		const once = migrateSettings({ ocrBackendChoice: "anthropic", autoSync: { enabled: true } }, ENV);
		expect(migrateSettings(once, ENV)).toEqual(once);
	});

	it("takes the current key name over the one it replaced", () => {
		// Both can be present: `ocrBackendChoice` is never deleted from the file, only stopped being
		// written. The newer key is the one the user last chose with.
		expect(migrateSettings({ ocrBackend: "anthropic", ocrBackendChoice: "off" }, ENV).ocrBackend).toBe("anthropic");
	});

	it("still reads the pre-1.1 key name when it is the only one there", () => {
		expect(migrateSettings({ ocrBackendChoice: "anthropic" }, ENV).ocrBackend).toBe("anthropic");
	});

	it.each([
		["a retired backend", "tesseract"],
		["the other retired backend", "llm-vision"],
		["a real id this particular build does not ship", "anthropic"],
		["an empty string", ""],
		["something that is not a string at all", 7],
	])("resets %s to the platform default", (_what, stored) => {
		// A build without the paid half is the interesting case: `anthropic` is a real id that this
		// particular build cannot construct, and leaving it would fail at transcription time instead.
		const buildWithoutPaidBackends: SettingsEnv = { isKnownBackend: (id) => id === "off", defaultBackend: "off" };
		expect(migrateSettings({ ocrBackend: stored }, buildWithoutPaidBackends).ocrBackend).toBe("off");
	});

	it("keeps a backend this build does know", () => {
		expect(migrateSettings({ ocrBackend: "anthropic" }, ENV).ocrBackend).toBe("anthropic");
	});

	it("asks the environment rather than deciding the platform itself", () => {
		expect(migrateSettings(null, { ...ENV, defaultBackend: "vision" }).ocrBackend).toBe("vision");
		expect(migrateSettings(null, { ...ENV, defaultBackend: "off" }).ocrBackend).toBe("off");
	});

	it("drops the single API key the pre-multi-provider version stored", () => {
		// Users re-enter their key once, under the per-provider model. Carrying it forward would mean
		// guessing which provider a key from a version that only had one belongs to.
		const data = migrateSettings({ llmVisionApiKey: "sk-old-secret" }, ENV);
		expect(data.llmProviders).toEqual({});
		expect(JSON.stringify(data)).not.toContain("sk-old-secret");
	});

	it("keeps each backend's own settings blob untouched", () => {
		const providers = { anthropic: { apiKey: "sk-1" }, openai: { apiKey: "sk-2", model: "gpt-x" } };
		expect(migrateSettings({ llmProviders: providers }, ENV).llmProviders).toEqual(providers);
	});

	it.each([
		["the master toggle alone", { enabled: true }, { enabled: true, intervalHours: 6, autoTranscribeMetered: false }],
		["launch-only", { intervalHours: null }, { enabled: false, intervalHours: null, autoTranscribeMetered: false }],
		["the metered consent alone", { autoTranscribeMetered: true }, { enabled: false, intervalHours: 6, autoTranscribeMetered: true }],
		["an empty block", {}, DEFAULT_AUTO_SYNC],
	])("fills an autoSync block holding %s from the defaults", (_what, stored, expected) => {
		expect(migrateSettings({ autoSync: stored }, ENV).autoSync).toEqual(expected);
	});

	it("fills a half-written licence block the same way", () => {
		// `data.json` travels between machines through Obsidian Sync, so it can arrive written by a
		// version that did not have all of these fields. Missing beats rejected.
		expect(migrateSettings({ licence: { key: "abc" } }, ENV).licence).toEqual({ ...NO_LICENCE, key: "abc" });
	});

	it("keeps a whole working install exactly as it found it", () => {
		const stored = {
			deviceToken: "device-token",
			primaryTransport: "ssh",
			fallbackTransport: "cloud",
			ssh: { host: "192.168.1.9", port: 22, privateKey: "PEM", hostKeyFingerprint: "SHA256:abc" },
			sshHashes: { "doc.content|12|1000": "a".repeat(64) },
			tagFolderMap: { "#work": "Work" },
			syncIndex: { version: 4, rows: { "doc/1": { note: "Work/One.md" } } },
			ocrBackend: "anthropic",
			llmProviders: { anthropic: { apiKey: "sk-1" } },
			ocrUnavailableNoticeShown: true,
			autoSync: { enabled: true, intervalHours: null, autoTranscribeMetered: true },
			lastSyncAt: "2026-08-01T00:00:00.000Z",
			attachmentsFolder: "Attachments",
			marginNotes: true,
			licence: { ...NO_LICENCE, key: "k", activationId: "a", validatedAt: "2026-08-01T00:00:00.000Z" },
		};
		expect(migrateSettings(structuredClone(stored), ENV)).toEqual(stored);
	});

	it("honours a marginNotes: true written by a 1.1.0 beta", () => {
		expect(migrateSettings({ marginNotes: true }, ENV).marginNotes).toBe(true);
		expect(migrateSettings({}, ENV).marginNotes).toBe(false);
	});

	it("keeps an attachments folder the user chose, and defaults the rest", () => {
		expect(migrateSettings({ attachmentsFolder: "Attachments" }, ENV).attachmentsFolder).toBe("Attachments");
		expect(migrateSettings({}, ENV).attachmentsFolder).toBe("tagged-sync/attachments");
	});

	it("does not hand two installs the same syncIndex object", () => {
		// `onVaultRename` writes into `data.syncIndex.rows` in place. Handing a fresh install the
		// module-level EMPTY_SYNC_INDEX itself means one install's rename can be seen by the next --
		// in production a small blast radius, in a test run a shared-state hazard across whole files.
		const first = migrateSettings(null, ENV);
		const second = migrateSettings(null, ENV);

		first.syncIndex.rows["doc/1"] = { note: "x" } as never;

		expect(second.syncIndex.rows).toEqual({});
	});

	it("does not alias the defaults it spread from either", () => {
		const data = migrateSettings(null, ENV);
		data.autoSync.enabled = true;
		data.licence.key = "leaked";

		expect(DEFAULT_AUTO_SYNC.enabled).toBe(false);
		expect(NO_LICENCE.key).toBeNull();
	});
});
