/**
 * The one retry a server asks for with `Retry-After`, shared by the clients that honour it once
 * (zotero.org, readwise.io). The OCR providers retry a 429 on rules of their own (`fetchWithRetry`).
 */

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * The longest wait a `Retry-After` may buy. Beyond it the call reports instead, because past half a
 * minute the honest answer to the user is "the server is busy, the next sync will do it" -- which is
 * what both Zotero write-back and the Readwise push do with whatever did not land.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/** Seconds out of a `Backoff` or `Retry-After` header, as milliseconds, or 0 when there is nothing to wait for. */
export function waitMs(response: Response, header: string): number {
	const seconds = Number(response.headers.get(header) ?? "");
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/**
 * One request, with the one retry the server itself asks for.
 *
 * A `429`/`503` with `Retry-After` is the server saying *when* to come back, and honouring it once
 * is the difference between a run that finishes a little later and a run that hammers a rate limit
 * until it is banned. Once, not in a loop: the second refusal is returned, and the caller resumes on
 * the next sync with nothing lost.
 */
export async function retryOnceAfter(send: () => Promise<Response>, sleep: Sleep): Promise<Response> {
	const first = await send();
	if (first.status !== 429 && first.status !== 503) return first;
	const retryAfter = waitMs(first, "Retry-After");
	if (retryAfter === 0 || retryAfter > MAX_RETRY_AFTER_MS) return first;
	await sleep(retryAfter);
	return await send();
}
