/**
 * Running a bounded number of things at once.
 *
 * It lived in `vision-ocr-backend` because that is where it was first needed, and stayed there
 * while the sync engine and the LLM transcript picked it up. Reading the tablet made that address
 * indefensible: `device-api` overlaps SFTP round trips and has nothing whatever to do with OCR, and
 * an import of a vision backend from the SSH path reads as a mistake every time somebody meets it.
 * It is one function about scheduling, so it lives under a name that says only that.
 */

/** Maps `items` through `fn` with at most `limit` in flight at once, preserving input order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}
