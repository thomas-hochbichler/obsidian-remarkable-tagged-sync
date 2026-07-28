import { requestUrl } from "obsidian";

async function obsidianFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		headers[key] = value;
	});

	const body = typeof init?.body === "string" || init?.body instanceof ArrayBuffer ? init.body : undefined;

	const response = await requestUrl({
		url: input.toString(),
		method: init?.method ?? "GET",
		headers,
		body,
		throw: false,
	});

	return new Response(response.arrayBuffer, {
		status: response.status,
		headers: response.headers,
	});
}

/**
 * reMarkable's cloud API sends no CORS headers, so the renderer's native
 * fetch() is blocked before the request is even sent (rmapi-js sets an
 * Authorization header, which forces a CORS preflight). rmapi-js always
 * calls the global fetch with no injection point, so route it through
 * Obsidian's requestUrl, which isn't subject to CORS, instead.
 *
 * @returns a function that restores the original global fetch.
 */
export function installObsidianFetch(): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = obsidianFetch as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}
