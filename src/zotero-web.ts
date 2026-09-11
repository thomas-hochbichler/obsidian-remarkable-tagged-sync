/**
 * zotero.org as a {@link ZoteroConnection}.
 *
 * This is the connection a web-only user has -- the human this feature was specified with uses
 * Zotero in the browser and nothing else -- and it is the only one that works with the desktop app
 * closed. What it cannot do is know where a file sits on disk, so `filePath` answers `null` and the
 * send command falls through to downloading the bytes (spec §2.4).
 *
 * Requests go through the global `fetch`, which esbuild rewrites to Obsidian's `requestUrl`
 * (`obsidian-fetch.ts`), so there is no CORS problem and no new dependency -- the same route
 * `licence-client.ts` takes.
 */

import {
	createZoteroConnection,
	withZoteroTimeout,
	ZoteroError,
	type ZoteroConnection,
	type ZoteroRequest,
} from "./zotero-client";

const ZOTERO_API = "https://api.zotero.org";

/** API version 3 is the only one the local API speaks, so both connections are pinned to it. */
const API_VERSION = "3";

/**
 * How long one zotero.org call may take before the sync stops waiting.
 *
 * The same reasoning as `LICENCE_TIMEOUT_MS`, and for the same reason: write-back is awaited on the
 * sync path, so a server that accepts the connection and never answers must not be a sync that never
 * ends. File downloads are deliberately outside this -- a PDF is not a JSON call.
 */
export const ZOTERO_WEB_TIMEOUT_MS = 15_000;

/**
 * The longest wait a `Retry-After` may buy. Beyond it the call reports instead, because past half a
 * minute the honest answer to the user is "Zotero is busy, the next sync will do it" -- which is
 * exactly what write-back does with a skipped document (spec §3.4).
 */
const MAX_BACKOFF_MS = 30_000;

type Fetch = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Seconds out of a `Backoff` or `Retry-After` header, as milliseconds, or 0 when there is nothing to wait for. */
function waitMs(response: Response, header: string): number {
	const seconds = Number(response.headers.get(header) ?? "");
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

export function createZoteroWebConnection(apiKey: string, fetchImpl: Fetch = fetch, sleep: Sleep = realSleep): ZoteroConnection {
	/**
	 * The numeric user id, asked for once and then remembered.
	 *
	 * Every library-scoped path needs it, and the key itself is the only thing that knows it -- a
	 * Zotero API key is issued to an account, and `/keys/current` is where the account comes back.
	 * Cached as the promise rather than the value, so twenty parallel calls make one request.
	 */
	let userId: Promise<number | null> | null = null;

	/** When zotero.org last asked us to slow down. A `Backoff` applies to the *next* request, not this one. */
	let quietUntil = 0;

	const send = async (url: string, init: RequestInit, timeoutMs: number | null): Promise<Response> => {
		const wait = quietUntil - Date.now();
		if (wait > 0) await sleep(Math.min(wait, MAX_BACKOFF_MS));
		let response: Response;
		try {
			const work = fetchImpl(url, init);
			response = timeoutMs === null ? await work : await withZoteroTimeout(work, timeoutMs, "zotero.org");
		} catch (error) {
			// A rejected fetch is the network, not an answer: nothing reached zotero.org, so this is the
			// one case the client may retry on the other connection.
			if (error instanceof ZoteroError) throw error;
			throw new ZoteroError("unreachable", "Could not reach zotero.org.");
		}
		const backoff = waitMs(response, "Backoff");
		if (backoff > 0) quietUntil = Date.now() + backoff;
		return response;
	};

	/**
	 * One request, with the one retry zotero.org itself asks for.
	 *
	 * A `429`/`503` with `Retry-After` is the server saying *when* to come back, and honouring it once
	 * is the difference between a run that finishes a little later and a run that hammers a rate limit
	 * until it is banned. Once, not in a loop: the second refusal is reported, and write-back resumes
	 * on the next sync with nothing lost.
	 */
	const request = async (url: string, init: RequestInit, timeoutMs: number | null): Promise<Response> => {
		const first = await send(url, init, timeoutMs);
		if (first.status !== 429 && first.status !== 503) return first;
		const retryAfter = waitMs(first, "Retry-After");
		if (retryAfter === 0 || retryAfter > MAX_BACKOFF_MS) return first;
		await sleep(retryAfter);
		return await send(url, init, timeoutMs);
	};

	const headers = (write: boolean): Record<string, string> => ({
		"Zotero-API-Key": apiKey,
		"Zotero-API-Version": API_VERSION,
		...(write ? { "Content-Type": "application/json" } : {}),
	});

	const loadUserId = async (): Promise<number | null> => {
		const response = await request(`${ZOTERO_API}/keys/current`, { headers: headers(false) }, ZOTERO_WEB_TIMEOUT_MS);
		if (response.status === 401 || response.status === 403) throw new ZoteroError("unauthorized", "Zotero rejected the API key.");
		if (!response.ok) throw new ZoteroError("server", `zotero.org answered ${response.status} when asked whose key this is.`);
		const body = (await response.json()) as { userID?: unknown };
		return typeof body.userID === "number" ? body.userID : null;
	};

	const libraryId = async (): Promise<number | null> => {
		// Re-asked after a failure rather than caching the rejection: a user who pastes a working key
		// into the settings must not have to restart Obsidian for it to be tried.
		userId ??= loadUserId().catch((error: unknown) => {
			userId = null;
			throw error;
		});
		return await userId;
	};

	const prefix = async (): Promise<string> => {
		const id = await libraryId();
		if (id === null) throw new ZoteroError("unauthorized", "This Zotero API key is not tied to a personal library.");
		return `${ZOTERO_API}/users/${id}`;
	};

	const requester = async ({ method = "GET", path, body, headers: extra }: ZoteroRequest): Promise<Response> =>
		await request(
			`${await prefix()}${path}`,
			{ method, headers: { ...headers(method !== "GET"), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
			ZOTERO_WEB_TIMEOUT_MS,
		);

	return createZoteroConnection("web", "zotero.org", requester, {
		// Only Zotero's own storage has the bytes, and only the desktop knows a path. Saying so here is
		// what lets the send command ask the user for the file instead of failing (spec §2.4).
		path: async () => null,
		async bytes(key) {
			// No timeout: this is a file, and a slow download is not a hung server. `requestUrl` follows
			// the 302 into S3 on its own.
			const response = await request(`${await prefix()}/items/${key}/file`, { headers: headers(false) }, null);
			// 404 is the answer for a linked file and for one that has not synced up -- "Zotero has no
			// copy of this PDF online", which the caller turns into the file dialog.
			if (response.status === 404) return null;
			if (!response.ok) throw new ZoteroError("server", `zotero.org answered ${response.status} for that PDF.`);
			return new Uint8Array(await response.arrayBuffer());
		},
	}, libraryId);
}
