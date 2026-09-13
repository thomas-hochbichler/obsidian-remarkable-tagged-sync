import type { Content, RawRemarkableApi } from "rmapi-js";

/**
 * rmapi-js validates every `.content` against a schema that requires six fields the cloud does not
 * always send: a document seen in issue #156 carried only `coverPageNumber`, `cPages`, `fileType`,
 * `formatVersion`, `orientation` and `pageCount`. `listItems()` fetches every document in one
 * `Promise.all`, so that one document fails the whole listing -- no tags discovered, no sync, for
 * the entire account. Same shape as issue #10, on `.content` instead of `.metadata`.
 *
 * The plugin reads five things from a `.content`: `fileType`, `tags`, `pageTags`, `cPages` and
 * `pages`. Only those are checked here; everything else passes through untouched. Still unfixed
 * upstream as of rmapi-js 14.2.0, whose schema requires the same six fields.
 */
export function tolerateSlimContent(raw: RawRemarkableApi): void {
	raw.getContent = async (fileName, hash) => parseContentText(await raw.getText(fileName, hash));
}

/** Parses a `.content` file, checking the shape of the fields this plugin reads and nothing more. */
export function parseContentText(text: string): Content {
	const loaded: unknown = JSON.parse(text);
	if (loaded === null || typeof loaded !== "object" || Array.isArray(loaded)) {
		throw new Error("reMarkable content was not a JSON object");
	}
	const fields = loaded as Record<string, unknown>;

	if (fields.fileType !== undefined && typeof fields.fileType !== "string") {
		throw new Error('reMarkable content field "fileType" was not a string');
	}
	for (const key of ["tags", "pageTags", "pages"]) {
		if (fields[key] !== undefined && fields[key] !== null && !Array.isArray(fields[key])) {
			throw new Error(`reMarkable content field "${key}" was not an array`);
		}
	}
	const cPages = fields.cPages;
	if (cPages !== undefined && (cPages === null || typeof cPages !== "object" || !Array.isArray((cPages as { pages?: unknown }).pages))) {
		throw new Error('reMarkable content field "cPages.pages" was not an array');
	}

	return fields;
}
