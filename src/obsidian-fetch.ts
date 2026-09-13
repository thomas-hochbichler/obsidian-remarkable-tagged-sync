import { requestUrl } from "obsidian";

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
 * rmapi-js lists an account by fetching every document's file list, metadata and content in one
 * `Promise.all`, so a first sync on an account of N documents used to put 3 x N requests out at the
 * same moment -- and a notebook's pages are rendered the same way, one request per page. Electron's
 * net stack refuses past some limit with `net::ERR_INSUFFICIENT_RESOURCES`, which the user then read
 * as "reMarkable changed their service" (issue #160). The bound lives here and not at the call
 * sites because rmapi-js's own fan-outs cannot be reached from outside, and this is the one door
 * every request goes through.
 *
 * Eight: Chromium opens at most six connections to one host, so anything above that only queues
 * one layer down; a little over it keeps the queue fed while an answer is being read.
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

export async function obsidianFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		headers[key] = value;
	});

	await takeSlot();
	let response;
	try {
		response = await requestUrl({
			url: requestUrlOf(input),
			method: init?.method ?? "GET",
			headers,
			body: toRequestBody(init?.body),
			throw: false,
		});
	} finally {
		giveSlot();
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
