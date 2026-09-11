/**
 * What this vault has been told about Zotero, and whether it may use it.
 *
 * Two settings and a gate. The settings are the two connections of spec §2.1 -- an API key for
 * zotero.org, a toggle for the desktop app -- and neither is required: each connection is enough on
 * its own, and with neither of them the plugin has no Zotero client at all and every Zotero feature
 * is simply not there (§2.1, §5 "refused-in-place").
 *
 * {@link createZoteroClientFor} is where all of that meets. It is the single place that decides
 * whether Zotero exists for this vault, so "no licence" and "nothing configured" reach the rest of
 * the plugin as the same thing -- `null` -- and no caller carries an `if` about either.
 */

import type { Entitlement } from "./licence-state";
import { createZoteroClient, type ZoteroClient } from "./zotero-client";
import { createZoteroLocalConnection, type LocalKeyStore } from "./zotero-local";
import { createZoteroWebConnection } from "./zotero-web";
import { DEFAULT_SEND_FOLDER } from "./zotero-send";

export interface ZoteroSettings {
	/** A zotero.org API key, or `null`. Read and write, personal library -- nothing else is asked for. */
	apiKey: string | null;
	/** Talk to the Zotero 10 desktop app on this machine. */
	useLocal: boolean;
	/**
	 * The keys Zotero's permission dialog has granted, by `Zotero-Server-ID`.
	 *
	 * Keyed by server id because that id follows the *database*: one person with two Zotero profiles
	 * has two of them, and a key granted by one is rejected by the other. It also makes this field
	 * harmless in a synced `data.json` -- another machine's Zotero has another id, so its key is never
	 * reached for. Beside `deviceToken` and the licence, which is where this vault's other credentials
	 * already live.
	 */
	localKeys: Record<string, string>;
	/** The tablet folder Send puts documents in: looked up by name, created when missing, never renamed (§2.4). */
	folder: string;
	/**
	 * May Send write straight onto the tablet over SSH?
	 *
	 * Off by default and asked for in words, because this is the one thing the plugin does that
	 * interrupts the person holding the device: there is no way to make xochitl notice a new file
	 * without restarting it (see `ssh-send.ts`), so a send closes whatever they have open. The cloud
	 * needs no such permission and is therefore tried first.
	 */
	sendOverSsh: boolean;
	/** The sync tag the last send used, offered first the next time there is a choice (§2.4). */
	lastTag: string | null;
}

export const DEFAULT_ZOTERO_SETTINGS: ZoteroSettings = {
	apiKey: null,
	useLocal: false,
	localKeys: {},
	folder: DEFAULT_SEND_FOLDER,
	sendOverSsh: false,
	lastTag: null,
};

/**
 * The gate: everything Zotero is Tagged Sync Pro (spec §5).
 *
 * A function rather than an `if` at the call site, and phrased as "may this vault use Zotero" rather
 * than "is this user free", so `proCapabilities` drives the real gate instead of a copy of it -- the
 * same shape `frontmatterAllowed` and `allowedTransports` have.
 */
export function zoteroAllowed(entitlement: Entitlement): boolean {
	return entitlement.tier !== "free";
}

/** Has the user set up either connection? Says nothing about whether it answers. */
export function zoteroConfigured(settings: ZoteroSettings): boolean {
	return settings.apiKey !== null || settings.useLocal;
}

/** Reads and writes the granted local keys wherever the plugin keeps its settings. */
export interface ZoteroSettingsStore {
	settings(): ZoteroSettings;
	/** Called once per granted key, so the next run opens no dialog. */
	saveLocalKey(serverId: string, key: string): Promise<void>;
}

/**
 * The store over the plugin's own settings block.
 *
 * Here rather than inline in `main.ts` because of the one line that is not plumbing: a granted key is
 * added to `localKeys` **beside** the keys already there. Overwriting the map instead -- the obvious
 * one-liner -- would lose the other Zotero database's key every time a user switched profiles, and
 * the symptom is a permission dialog that comes back for good.
 */
export function zoteroSettingsStore(holder: { zotero: ZoteroSettings }, save: () => Promise<void>): ZoteroSettingsStore {
	return {
		settings: () => holder.zotero,
		saveLocalKey: async (serverId, key) => {
			holder.zotero = { ...holder.zotero, localKeys: { ...holder.zotero.localKeys, [serverId]: key } };
			await save();
		},
	};
}

/**
 * This vault's Zotero client, or `null` when there is not one to have.
 *
 * `null` is the whole of "refused in place": a lapsed licence and an unconfigured vault arrive at
 * the same value, and every caller downstream -- matching, write-back, the send command -- is written
 * against a client that may be absent rather than against a licence it would have to re-read.
 */
export function createZoteroClientFor(store: ZoteroSettingsStore, entitlement: Entitlement): ZoteroClient | null {
	if (!zoteroAllowed(entitlement)) return null;
	const settings = store.settings();
	const keyStore: LocalKeyStore = {
		read: (serverId) => settings.localKeys[serverId] ?? null,
		write: (serverId, key) => store.saveLocalKey(serverId, key),
	};
	return createZoteroClient({
		local: settings.useLocal ? createZoteroLocalConnection(keyStore) : undefined,
		web: settings.apiKey === null ? undefined : createZoteroWebConnection(settings.apiKey),
	});
}
