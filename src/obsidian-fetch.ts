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
export async function obsidianFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		headers[key] = value;
	});

	const response = await requestUrl({
		url: input.toString(),
		method: init?.method ?? "GET",
		headers,
		body: toRequestBody(init?.body),
		throw: false,
	});

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
		return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
	}
	throw new TypeError(`obsidianFetch cannot forward a ${body.constructor.name} body to requestUrl`);
}
