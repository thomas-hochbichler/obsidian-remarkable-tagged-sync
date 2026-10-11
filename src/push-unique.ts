/**
 * Appends each of `items` that `list` does not already hold, while `list` is shorter than `limit`.
 *
 * Every warning channel collects "each distinct sentence once": a document's every margin note hits
 * the same dead server, and a notebook synced under two tags raises the same Zotero sentence twice.
 * The rule was written out six times, and only one copy had a limit.
 */
export function pushUnique<T>(list: T[], items: Iterable<T>, limit = Infinity): void {
	for (const item of items) {
		if (list.length >= limit) return;
		if (!list.includes(item)) list.push(item);
	}
}
