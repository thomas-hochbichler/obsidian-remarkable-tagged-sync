/**
 * The Zotero 10 desktop app as a {@link ZoteroConnection}.
 *
 * It is the add-on connection, not the base one: it needs the app to be running with "Allow other
 * applications on this computer to communicate with Zotero" switched on, and the user has to grant a
 * key in a dialog. What it buys for that is everything the web cannot do -- it works offline, it
 * knows where the PDF sits on disk (so send needs no download), and its `md5` is the *live* hash of
 * the file rather than the one that was synced.
 *
 * Three rules of Zotero's own making shape this file, all of them proven live on 10.0.2
 * ([research/10]):
 *
 * 1. **`Zotero-Allowed-Request: 1` on every request.** Zotero silently *cancels* -- no response at
 *    all -- any request whose `User-Agent` starts with `Mozilla/` or that carries an `Origin`, unless
 *    that header is there. Electron's user agent starts with `Mozilla/`. Without it, a working
 *    Zotero looks exactly like a closed one.
 * 2. **`Zotero-Server-ID` on writes**, read from any earlier response. It follows the *database*, so
 *    it is also the right thing to key a stored key by: one user, two profiles, two keys.
 * 3. **A key granted with "Allow" serves exactly one request** and then answers 401. "Always Allow"
 *    is what a plugin needs, and both buttons are in the same dialog -- so a 401 is not necessarily
 *    a broken key, it is the ordinary outcome of the wrong button. It re-authorizes once and carries
 *    on, which is why a user who clicks "Allow" every time still gets a working sync, one dialog per
 *    write.
 */

import {
	createZoteroConnection,
	libraryPath,
	withZoteroTimeout,
	ZoteroError,
	type ZoteroConnection,
	type ZoteroRequest,
} from "./zotero-client";

/** Zotero's HTTP server. Fixed: the port is a preference nobody changes, and 127.0.0.1 is the only host it binds. */
const LOCAL_API = "http://localhost:23119/api";

/** The personal library. The local API answers `0` for "whoever is signed in here"; a group is `/groups/<id>`, as on the web. */
const USER_PREFIX = "/users/0";

/** What the authorize dialog calls us. The user reads this sentence in Zotero, so it is the plugin's real name. */
const APP_NAME = "Tagged Sync for reMarkable";

/** Localhost answers at once or not at all, so this is short on purpose -- it is a "is Zotero there?" limit. */
export const ZOTERO_LOCAL_TIMEOUT_MS = 5_000;

/**
 * How long the authorize call may block.
 *
 * ⚠️ It blocks on a **modal dialog**: Zotero's prompt is synchronous, so the HTTP request stays open
 * until the user clicks. Anything in the range of an ordinary request timeout would abandon the
 * dialog while the user is still reading it -- and then write-back would report "Zotero did not
 * answer" for a Zotero that is waiting for a click. Two minutes, and Deny is a fast answer anyway.
 */
export const ZOTERO_AUTHORIZE_TIMEOUT_MS = 120_000;

type Fetch = typeof fetch;

/**
 * Where the granted local key is kept between runs, keyed by `Zotero-Server-ID`.
 *
 * Injected rather than reaching into `data.json` from here: the key is a credential belonging to one
 * Zotero database, and which file it lands in is the settings layer's business. It also keeps this
 * file testable without a vault.
 */
export interface LocalKeyStore {
	read(serverId: string): string | null;
	write(serverId: string, key: string): Promise<void>;
}

/** A key store that forgets on restart -- the honest default when nothing durable was supplied. */
export function memoryKeyStore(): LocalKeyStore {
	const keys = new Map<string, string>();
	return {
		read: (serverId) => keys.get(serverId) ?? null,
		write: async (serverId, key) => {
			keys.set(serverId, key);
		},
	};
}

export function createZoteroLocalConnection(store: LocalKeyStore, fetchImpl: Fetch = fetch): ZoteroConnection {
	/** Cached per process. It identifies the database Zotero has open, and that does not change under us. */
	let serverId: string | null = null;

	const send = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
		try {
			return await withZoteroTimeout(fetchImpl(url, init), timeoutMs, "the Zotero desktop app");
		} catch (error) {
			if (error instanceof ZoteroError) throw error;
			// Connection refused is the ordinary state of this connection -- Zotero is simply not
			// running -- so it is worded as a fact rather than as a fault.
			throw new ZoteroError("unreachable", "The Zotero desktop app is not running.");
		}
	};

	/**
	 * The server id, from the headers of the no-op `GET /api/`.
	 *
	 * Also this connection's reachability check, and deliberately the same call: if Zotero is closed
	 * this throws `unreachable`, and if the local API is switched off it answers 403 with a sentence
	 * saying so -- the two states a user has to tell apart to fix anything.
	 */
	const knownServerId = async (): Promise<string> => {
		if (serverId !== null) return serverId;
		const response = await send(`${LOCAL_API}/`, { headers: { "Zotero-Allowed-Request": "1" } }, ZOTERO_LOCAL_TIMEOUT_MS);
		if (response.status === 403) {
			throw new ZoteroError("not-enabled", 'Zotero is running with "Allow other applications on this computer to communicate with Zotero" switched off.');
		}
		const id = response.headers.get("Zotero-Server-ID");
		if (id === null) throw new ZoteroError("server", "Zotero answered without saying which database it has open.");
		serverId = id;
		return id;
	};

	/**
	 * Asks Zotero for a key, which shows the user a dialog.
	 *
	 * Deny is Zotero's default button and answers `403 {denied:true}`; that is a decision, not a
	 * failure, and it is worded so the status line can simply repeat it. More than five dialogs a
	 * minute answers 429 -- which only happens to a plugin that is asking in a loop, so it reports
	 * rather than waiting.
	 */
	const authorize = async (id: string): Promise<string> => {
		const response = await send(
			`${LOCAL_API}/local/authorize`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", "Zotero-Allowed-Request": "1", "Zotero-Server-ID": id },
				body: JSON.stringify({ appName: APP_NAME }),
			},
			ZOTERO_AUTHORIZE_TIMEOUT_MS,
		);
		if (response.status === 403) throw new ZoteroError("denied", "Zotero was asked for permission to write, and the answer was Deny.");
		if (response.status === 429) throw new ZoteroError("rate-limited", "Zotero is refusing further permission dialogs for a moment.");
		if (!response.ok) throw new ZoteroError("server", `Zotero answered ${response.status} when asked for permission to write.`);
		const body = (await response.json()) as { key?: unknown };
		if (typeof body.key !== "string" || body.key === "") throw new ZoteroError("server", "Zotero granted permission without a key.");
		await store.write(id, body.key);
		return body.key;
	};

	const writeKey = async (id: string, fresh: boolean): Promise<string> => {
		if (fresh) return await authorize(id);
		return store.read(id) ?? (await authorize(id));
	};

	const requester = async ({ method = "GET", library, path, body, headers }: ZoteroRequest): Promise<Response> => {
		const id = await knownServerId();
		const url = `${LOCAL_API}${libraryPath(library, USER_PREFIX)}${path}`;
		const call = async (key: string | null): Promise<Response> =>
			await send(
				url,
				{
					method,
					headers: {
						"Zotero-Allowed-Request": "1",
						"Zotero-Server-ID": id,
						...(key === null ? {} : { "Zotero-API-Key": key }),
						...(method === "GET" ? {} : { "Content-Type": "application/json" }),
						...headers,
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				},
				ZOTERO_LOCAL_TIMEOUT_MS,
			);

		// Reads need no key at all, so a read never opens a dialog. That is what makes matching and the
		// send picker work on a Zotero the user has never granted anything to.
		if (method === "GET") return await call(null);

		const first = await call(await writeKey(id, false));
		// The single-use "Allow" key: spent, and the next request is the one that finds out. One fresh
		// key, one retry -- a second 401 is a real refusal and is reported as one.
		if (first.status !== 401) return first;
		return await call(await writeKey(id, true));
	};

	/**
	 * The library id, out of any item's own `library.id`.
	 *
	 * The local API answers `/users/0/…` for every path, so the prefix cannot say whose library this
	 * is -- but every item it returns carries the real numeric id, which is what the note's web link
	 * needs. An empty library answers nothing, and then the note simply has no web link (spec §4).
	 */
	const libraryId = async (): Promise<number | null> => {
		const response = await requester({ library: "user", path: "/items/top?limit=1" });
		if (!response.ok) return null;
		const rows = (await response.json()) as { library?: { id?: unknown } }[];
		const id = Array.isArray(rows) ? rows[0]?.library?.id : undefined;
		return typeof id === "number" ? id : null;
	};

	return createZoteroConnection("local", "your Zotero desktop app", requester, {
		/**
		 * The file's own path, which is the reason this connection exists for send: no download, and it
		 * works for a linked file that was never in Zotero's storage at all.
		 *
		 * `/file/view/url` answers a percent-encoded `file://` URL as plain text; 400 is Zotero's answer
		 * for an item that is not a file attachment, and `null` lets the caller fall through.
		 */
		async path(key, library) {
			const response = await requester({ library, path: `/items/${key}/file/view/url` });
			if (!response.ok) return null;
			const url = (await response.text()).trim();
			if (!url.startsWith("file://")) return null;
			return decodeURIComponent(url.slice("file://".length));
		},
		// The desktop hands out a path; reading it is the caller's, which keeps every filesystem call
		// in one place instead of two (spec §2.4).
		bytes: async () => null,
	}, libraryId);
}
