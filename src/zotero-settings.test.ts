import { describe, expect, it, vi } from "vitest";
import { entitlementOf, type Entitlement, NO_LICENCE, startTrial } from "./licence-state";
import {
	zoteroUnavailable,
	createZoteroClientFor,
	DEFAULT_ZOTERO_SETTINGS,
	zoteroProAllowed,
	webConfigured, zoteroConfigured,
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

const WEB_ONLY: ZoteroSettings = { ...DEFAULT_ZOTERO_SETTINGS, useWeb: true, apiKey: "P9c46b0lkV2XzAoUTqPmPuGZ" };
/** A key pasted, the switch left off: kept, and not a connection. */
const WEB_OFF: ZoteroSettings = { ...WEB_ONLY, useWeb: false };
const DESKTOP_ONLY: ZoteroSettings = { ...DEFAULT_ZOTERO_SETTINGS, useLocal: true };

describe("who may use the Pro half of Zotero", () => {
	it("is Pro, and a trial counts", () => {
		expect(zoteroProAllowed(BOUGHT)).toBe(true);
		expect(zoteroProAllowed(TRIAL)).toBe(true);
		expect(zoteroProAllowed(FREE)).toBe(false);
	});

	// The free half (§5): zotero.org is enough to send, match and name the paper. A free vault with a
	// key gets a client like anyone else.
	it("hands a free vault a client over zotero.org", () => {
		expect(clientFor(WEB_ONLY, FREE)).not.toBeNull();
	});

	// "Refused in place" for the connection half: the desktop toggle on its own buys a free vault
	// nothing, and the value it gets is the one an unconfigured vault gets -- no `if` in any caller.
	it("hands a free vault no client for the desktop app alone", () => {
		expect(clientFor(DESKTOP_ONLY, FREE)).toBeNull();
	});

	// The lapsed-licence case (§5): the settings the buyer filled in are still in `data.json`, and are
	// picked up again the moment the licence is renewed. Nothing is deleted on the way out.
	it("gives the desktop app back the moment a licence does, from the settings that were left alone", () => {
		expect(clientFor(DESKTOP_ONLY, FREE)).toBeNull();
		expect(clientFor(DESKTOP_ONLY, BOUGHT)).not.toBeNull();
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

	// The switch is what says whether anything goes to zotero.org (desk test 2026-09-13): a key with
	// the switch off is kept for later and reaches nothing -- not a connection, not a client, and no
	// zotero.org link in a note.
	it("counts a key with zotero.org switched off as nothing", () => {
		expect(webConfigured(WEB_OFF)).toBe(false);
		expect(webConfigured(WEB_ONLY)).toBe(true);
		expect(zoteroConfigured(WEB_OFF)).toBe(false);
		expect(clientFor(WEB_OFF, BOUGHT)).toBeNull();
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
		expect(DEFAULT_ZOTERO_SETTINGS).toEqual({ useWeb: false, apiKey: null, useLocal: false, localKeys: {}, folder: "Zotero", sendOverSsh: false, sendTag: "", groups: [] });
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
		await client?.createAnnotations([{ type: "note", parentKey: "ATT1", comment: "x" }], "user");
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

describe("why a Zotero command has nothing to do", () => {
	// The two ways the factory answers `null`: nothing set up, or only the desktop app and this vault
	// may not use it. The second names what still works -- a zotero.org key -- before anything else.
	it("sends an unconfigured vault to the settings", () => {
		expect(zoteroUnavailable(DEFAULT_ZOTERO_SETTINGS)).toContain("Settings");
	});

	it("tells a vault with only the desktop app that nothing in their library has been touched, and what still works", () => {
		const sentence = zoteroUnavailable(DESKTOP_ONLY);
		expect(sentence).toContain("Nothing in your library has been changed.");
		expect(sentence).toContain("zotero.org API key");
	});
});

describe("group libraries (ticket 26)", () => {
	const WITH_GROUP: ZoteroSettings = { ...WEB_ONLY, groups: [{ id: 4711, name: "Lab reading group" }] };

	// The Pro half, refused in place like the desktop app: the free vault's client simply has no
	// group in it, and the setting is left where it is for the day a licence arrives.
	it("reach a Pro vault's client and not a free vault's", () => {
		expect(clientFor(WITH_GROUP, BOUGHT)?.libraries).toEqual(["user", { group: 4711 }]);
		expect(clientFor(WITH_GROUP, FREE)?.libraries).toEqual(["user"]);
	});
});
