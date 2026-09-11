import { describe, expect, it, vi } from "vitest";
import { entitlementOf, type Entitlement, NO_LICENCE, startTrial } from "./licence-state";
import {
	createZoteroClientFor,
	DEFAULT_ZOTERO_SETTINGS,
	zoteroAllowed,
	zoteroConfigured,
	type ZoteroSettings,
	zoteroSettingsStore,
} from "./zotero-settings";

// The connections reach for `window.setTimeout`, which is Obsidian's rule for popout windows and
// does not exist under vitest.
vi.stubGlobal("window", {
	setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
	clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

const NOW = new Date("2026-09-11T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const FREE = entitlementOf(NO_LICENCE, NOW);
const BOUGHT = entitlementOf({ ...NO_LICENCE, key: "TS-1", activationId: "act-1", validatedAt: new Date(NOW.getTime() - DAY_MS).toISOString() }, NOW);
const TRIAL = entitlementOf(startTrial(NO_LICENCE, new Date(NOW.getTime() - 2 * DAY_MS)), NOW);

const clientFor = (settings: ZoteroSettings, entitlement: Entitlement) =>
	createZoteroClientFor({ settings: () => settings, saveLocalKey: async () => {} }, entitlement);

const WEB_ONLY: ZoteroSettings = { ...DEFAULT_ZOTERO_SETTINGS, apiKey: "P9c46b0lkV2XzAoUTqPmPuGZ" };
const DESKTOP_ONLY: ZoteroSettings = { ...DEFAULT_ZOTERO_SETTINGS, useLocal: true };

describe("who may use Zotero", () => {
	it("is Pro, and a trial counts", () => {
		expect(zoteroAllowed(BOUGHT)).toBe(true);
		expect(zoteroAllowed(TRIAL)).toBe(true);
		expect(zoteroAllowed(FREE)).toBe(false);
	});

	// The whole of "refused in place": no client, so there is nothing to match with, nothing to write
	// back, and no Send command to register. A free vault syncs exactly as it did before.
	it("hands a free vault no client, however well it is configured", () => {
		expect(clientFor({ ...DEFAULT_ZOTERO_SETTINGS, apiKey: "key", useLocal: true }, FREE)).toBeNull();
	});

	// The lapsed-licence case (§5): the settings the buyer filled in are still in `data.json`, and are
	// picked up again the moment the licence is renewed. Nothing is deleted on the way out.
	it("comes back the moment a licence does, from the settings that were left alone", () => {
		expect(clientFor(WEB_ONLY, FREE)).toBeNull();
		expect(clientFor(WEB_ONLY, BOUGHT)).not.toBeNull();
	});
});

describe("the key Zotero's dialog granted", () => {
	const holder = (settings: ZoteroSettings) => ({ zotero: settings });

	it("is kept beside the keys of any other Zotero database, never instead of them", async () => {
		// A user with two Zotero profiles has two server ids and two keys. Overwriting the map -- the
		// obvious one-liner -- loses the other one every time they switch, and the symptom is a
		// permission dialog that comes back for good.
		const data = holder({ ...DEFAULT_ZOTERO_SETTINGS, localKeys: { OTHERDATABASE: "old-key" } });
		let saves = 0;
		await zoteroSettingsStore(data, async () => void saves++).saveLocalKey("1PUT74VpHXuE", "granted-key");

		expect(data.zotero.localKeys).toEqual({ OTHERDATABASE: "old-key", "1PUT74VpHXuE": "granted-key" });
		expect(saves).toBe(1);
	});

	it("is read back for the database that granted it, and for no other", () => {
		const data = holder({ ...DEFAULT_ZOTERO_SETTINGS, useLocal: true, localKeys: { "1PUT74VpHXuE": "granted-key" } });
		const store = zoteroSettingsStore(data, async () => {});

		expect(store.settings().localKeys["1PUT74VpHXuE"]).toBe("granted-key");
		expect(store.settings().localKeys.SOMEOTHERID).toBeUndefined();
	});

	it("hands the client the settings as they are now, not as they were when it was built", async () => {
		// The settings tab writes a pasted key into the same object; a store that had copied the block
		// would keep handing out the key from before the paste until Obsidian restarted.
		const data = holder(DEFAULT_ZOTERO_SETTINGS);
		const store = zoteroSettingsStore(data, async () => {});
		data.zotero = { ...data.zotero, apiKey: "pasted-just-now" };

		expect(store.settings().apiKey).toBe("pasted-just-now");
	});
});

describe("what counts as set up", () => {
	it("takes either connection alone, and neither as nothing", () => {
		expect(zoteroConfigured(DEFAULT_ZOTERO_SETTINGS)).toBe(false);
		expect(zoteroConfigured(WEB_ONLY)).toBe(true);
		expect(zoteroConfigured(DESKTOP_ONLY)).toBe(true);
	});

	it("builds a client for either one alone", () => {
		expect(clientFor(WEB_ONLY, BOUGHT)).not.toBeNull();
		expect(clientFor(DESKTOP_ONLY, BOUGHT)).not.toBeNull();
	});

	it("builds none at all when neither is set up", () => {
		expect(clientFor(DEFAULT_ZOTERO_SETTINGS, BOUGHT)).toBeNull();
	});

	// A vault that has never been near Zotero must be indistinguishable from the plugin as it shipped
	// before this feature -- which is what "the free plugin is unchanged" (§5) means in practice.
	it("starts switched off entirely", () => {
		expect(DEFAULT_ZOTERO_SETTINGS).toEqual({ apiKey: null, useLocal: false, localKeys: {}, folder: "Zotero", sendOverSsh: false, lastTag: null });
	});
});

// The wire, driven end to end: settings -> client -> a real request shape -> back into the settings.
// Everything either side of it is covered elsewhere; what is only true here is that the key the
// dialog granted is written where the next run reads it.
describe("from the settings block to Zotero and back", () => {
	/** A stand-in Zotero desktop: the server-id handshake, the permission dialog, and one write. */
	function fakeZotero(storedKey: string | null) {
		const localKeys: Record<string, string> = storedKey === null ? {} : { SERVERID1234: storedKey };
		const data = { zotero: { ...DEFAULT_ZOTERO_SETTINGS, useLocal: true, localKeys } };
		const asked: string[] = [];
		const writtenWith: (string | null)[] = [];
		const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			asked.push(url);
			if (url === "http://localhost:23119/api/") return new Response(null, { headers: { "Zotero-Server-ID": "SERVERID1234" } });
			if (url.endsWith("/local/authorize")) return new Response(JSON.stringify({ key: "freshly-granted", remember: true }), { status: 200 });
			writtenWith.push(new Headers(init?.headers).get("Zotero-API-Key"));
			return new Response(JSON.stringify({ success: { "0": "NEW1" } }), { status: 200 });
		});
		vi.stubGlobal("fetch", impl);
		return { data, asked, writtenWith };
	}

	const write = async (data: { zotero: ZoteroSettings }, saved: { count: number }) => {
		const client = createZoteroClientFor(zoteroSettingsStore(data, async () => void saved.count++), BOUGHT);
		await client?.createAnnotations([{ type: "note", parentKey: "ATT1", comment: "x" }]);
	};

	it("writes with the key this Zotero database granted earlier, without asking again", async () => {
		const { data, asked, writtenWith } = fakeZotero("already-granted");
		const saved = { count: 0 };
		await write(data, saved);

		expect(asked.some((url) => url.endsWith("/local/authorize"))).toBe(false);
		expect(writtenWith).toEqual(["already-granted"]);
		expect(saved.count).toBe(0);
	});

	it("stores a newly granted key where the next run will find it", async () => {
		const { data } = fakeZotero(null);
		const saved = { count: 0 };
		await write(data, saved);

		expect(data.zotero.localKeys).toEqual({ SERVERID1234: "freshly-granted" });
		expect(saved.count).toBe(1);
	});
});
