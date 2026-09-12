/**
 * What this vault has been told about Zotero, and whether it may use it.
 *
 * Two settings and a gate. The settings are the two connections of spec §2.1 -- an API key for
 * zotero.org, a toggle for the desktop app -- and neither is required: each connection is enough on
 * its own, and with neither of them the plugin has no Zotero client at all and every Zotero feature
 * is simply not there (§2.1).
 *
 * The gate is §5's split: zotero.org, Send over the cloud, matching and the note's Zotero line are
 * free; the desktop-app connection and writing highlights back into Zotero are Pro. The connection
 * half of that lives here, in {@link createZoteroClientFor}: it is the single place that decides
 * which connections this vault has, so "no licence" and "not configured" reach the rest of the
 * plugin as the same thing -- a connection that is not there -- and no caller carries an `if` about
 * either. The write-back half is asked in `zotero-sync.ts`, at the one step that writes.
 */

import type { Entitlement } from "./licence-state";
import { createZoteroClient, type ZoteroClient } from "./zotero-client";
import { createZoteroLocalConnection, type LocalKeyStore } from "./zotero-local";
import { createZoteroWebConnection } from "./zotero-web";
import { DEFAULT_SEND_FOLDER, DEFAULT_SEND_TAG } from "./zotero-send";

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
	/**
	 * The Zotero tag that sends a paper to the tablet at the start of a sync (§2.6). Empty switches
	 * the step off. On by default with a name nobody's library carries by accident: a tag has to be
	 * put on a paper for anything to happen, so "on" costs one request per sync and nothing else.
	 */
	sendTag: string;
	/** Which mapped sync tag a paper sent that way gets, where the vault maps several (§2.6). `null` falls back to `lastTag`. */
	sendSyncTag: string | null;
}

export const DEFAULT_ZOTERO_SETTINGS: ZoteroSettings = {
	apiKey: null,
	useLocal: false,
	localKeys: {},
	folder: DEFAULT_SEND_FOLDER,
	sendOverSsh: false,
	lastTag: null,
	sendTag: DEFAULT_SEND_TAG,
	sendSyncTag: null,
};

/**
 * The gate: the Pro half of Zotero (spec §5) -- talking to the desktop app, and writing highlights
 * back into the library. Everything else Zotero is free and never asks this.
 *
 * A function rather than an `if` at the call site, and phrased as "may this vault use the Pro half"
 * rather than "is this user free", so `proCapabilities` drives the real gate instead of a copy of
 * it -- the same shape `frontmatterAllowed` and `allowedTransports` have.
 */
export function zoteroProAllowed(entitlement: Entitlement): boolean {
	return entitlement.tier !== "free";
}

/**
 * Why a Zotero command has nothing to do, in the two ways {@link createZoteroClientFor} answers `null`:
 * nothing is set up, or only the desktop app is and this vault may not use it.
 *
 * The second sentence says what still works rather than what was bought: a free vault and a lapsed
 * one arrive here the same way, and both keep Zotero through zotero.org. "Nothing in your library
 * has been changed" is for the lapsed one -- an add-only feature switching off must not read as
 * something having been undone.
 */
export function zoteroUnavailable(settings: ZoteroSettings): string {
	return zoteroConfigured(settings)
		? "The Zotero desktop app connection is part of Tagged Sync Pro, so it is switched off. Nothing in your library has been changed. Add a zotero.org API key under Settings → Zotero to use Zotero without it."
		: "Connect Zotero first — Settings → Zotero.";
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
 * The desktop-app connection is built only for a vault that may have it (§5); a free vault with
 * nothing but that toggle on gets `null`, the same value an unconfigured vault gets. That is
 * "refused in place" for the connection half: every caller downstream -- matching, write-back, the
 * send command -- is written against a client that may be absent rather than against a licence it
 * would have to re-read.
 */
export function createZoteroClientFor(store: ZoteroSettingsStore, entitlement: Entitlement): ZoteroClient | null {
	const settings = store.settings();
	const keyStore: LocalKeyStore = {
		read: (serverId) => settings.localKeys[serverId] ?? null,
		write: (serverId, key) => store.saveLocalKey(serverId, key),
	};
	return createZoteroClient({
		local: settings.useLocal && zoteroProAllowed(entitlement) ? createZoteroLocalConnection(keyStore) : undefined,
		web: settings.apiKey === null ? undefined : createZoteroWebConnection(settings.apiKey),
	});
}
