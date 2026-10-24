import { requestUrl } from "obsidian";

/**
 * The shape of a fetch, for the parameters that take one so a test can answer in its place. A type
 * only: the value the plugin passes is always `obsidianFetch`, never the free global.
 */
export type Fetch = typeof fetch;

/**
 * reMarkable's cloud API sends no CORS headers, so the renderer's native fetch() is blocked before
 * the request is even sent (rmapi-js sets an Authorization header, which forces a CORS preflight).
 * rmapi-js always calls the global fetch with no injection point, so its calls are routed through
 * Obsidian's requestUrl, which isn't subject to CORS, instead.
 *
 * The routing happens at build time: esbuild's `inject` (see esbuild.config.mjs) rewrites every
 * free-identifier `fetch` reference inside the bundle to this function. The global fetch is never
 * touched, so other plugins and Obsidian core are unaffected.
 */
/**
 * The URL a fetch-style `input` refers to.
 *
 * A plain `input.toString()` looks right and is wrong for one of the three cases: `RequestInfo`
 * includes `Request`, which has no meaningful `toString()` and stringifies to `"[object Object]"`.
 * rmapi-js only ever passes a string today, so this has never fired -- but it would fail as a
 * malformed URL rather than as anything diagnosable.
 */
function requestUrlOf(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

/**
 * How many requests may be open at once, across everything in the plugin that talks to a server.
 *
 * rmapi-js lists an account with one `Promise.all` over every document -- each document's file
 * list first, then its metadata and content -- so a first sync on an account of N documents used to
 * put N requests out at the same moment and up to 2 x N a moment later. A notebook's pages are
 * rendered the same way, one request per page. Electron's net stack refuses past some limit with
 * `net::ERR_INSUFFICIENT_RESOURCES`, which the user then read as "reMarkable changed their service"
 * (issue #160). The bound lives here and not at the call sites because rmapi-js's own fan-outs
 * cannot be reached from outside, and this is the one door every request goes through.
 *
 * Eight: Chromium opens at most six connections to one host, so anything above that only queues
 * one layer down; a little over it keeps the queue fed while an answer is being read. The bound is
 * one for the whole plugin, not one per host -- the runtime's limit is per process, and the cloud,
 * an OCR provider and the licence server rarely have a request open at the same time.
 */
export const MAX_REQUESTS_IN_FLIGHT = 8;

let inFlight = 0;
const waiting: (() => void)[] = [];

async function takeSlot(): Promise<void> {
	if (inFlight < MAX_REQUESTS_IN_FLIGHT) {
		inFlight++;
		return;
	}
	// The slot is handed over by `giveSlot`, which is why `inFlight` is not touched here.
	await new Promise<void>((resolve) => waiting.push(resolve));
}

function giveSlot(): void {
	const next = waiting.shift();
	if (next) next();
	else inFlight--;
}

/**
 * The waits before asking reMarkable's cloud again after a 502, 503 or 504: one per retry.
 *
 * The cloud answered "503 Server Error ... Service error -27" for a few minutes on 2026-10-14, and the
 * whole sync failed on the first request that met it. A blip of seconds is ridden out here; an outage
 * of minutes is not, and then the sync fails as before and says the cloud is unavailable.
 */
export const OUTAGE_RETRY_DELAYS_MS = [2_000, 8_000];
const OUTAGE_STATUSES = new Set([502, 503, 504]);
/**
 * Only reads from reMarkable's own hosts are asked again: a GET changes nothing over there. A send to
 * the tablet is not repeated, Zotero honours `Retry-After` itself, and the OCR providers retry a 429
 * only (`fetchWithRetry`), each for reasons of its own.
 */
const REMARKABLE_URL = /^https:\/\/([^/]+\.)?remarkable\.(com|engineering)(:\d+)?(\/|$)/i;

export async function obsidianFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		headers[key] = value;
	});
	const url = requestUrlOf(input);
	const method = init?.method ?? "GET";
	const requestBody = toRequestBody(init?.body);

	const request = async () => {
		await takeSlot();
		try {
			return await requestUrl({ url, method, headers, body: requestBody, throw: false });
		} finally {
			giveSlot();
		}
	};

	let response = await request();
	// No slot is held while waiting: the rest of the plugin's requests go on meanwhile.
	for (const delay of method === "GET" && REMARKABLE_URL.test(url) ? OUTAGE_RETRY_DELAYS_MS : []) {
		if (!OUTAGE_STATUSES.has(response.status)) break;
		await new Promise((resolve) => window.setTimeout(resolve, delay));
		response = await request();
	}

	// The Response constructor throws on a non-null body for these statuses.
	const body = [101, 103, 204, 205, 304].includes(response.status) ? null : response.arrayBuffer;
	return new Response(body, {
		status: response.status,
		headers: response.headers,
	});
}

/**
 * requestUrl only accepts `string | ArrayBuffer` bodies. rmapi-js sends strings and Uint8Arrays;
 * anything else is a caller this shim wasn't written for, so fail loudly rather than send an empty
 * body.
 */
function toRequestBody(body: BodyInit | null | undefined): string | ArrayBuffer | undefined {
	if (body === null || body === undefined) return undefined;
	if (typeof body === "string" || body instanceof ArrayBuffer) return body;
	if (ArrayBuffer.isView(body)) {
		return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	}
	throw new TypeError(`obsidianFetch cannot forward a ${body.constructor.name} body to requestUrl`);
}
