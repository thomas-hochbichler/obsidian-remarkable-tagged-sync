import type { Metadata, RawRemarkableApi } from "rmapi-js";

/**
 * The cloud sends `null` -- not an absent key -- for four legacy sync fields (`deleted`,
 * `metadatamodified`, `modified`, `synced`) on some older documents. rmapi-js declares them
 * `z.boolean().optional()`, which accepts an absent key but not `null`, so parsing such a document
 * throws. `listItems()` fetches every document in one `Promise.all`, so a single one of them fails
 * the whole listing: no tags discovered, no sync, for the entire account (issue #10). rmapi-js
 * never reads those four fields.
 *
 * rmapi-js documents `getText` + `JSON.parse` as the way past its own validation, so `getMetadata`
 * is replaced here with a version that treats a null optional as absent. Still unfixed upstream as
 * of rmapi-js 12.0.0.
 */
export function tolerateLegacyMetadata(raw: RawRemarkableApi): void {
	raw.getMetadata = async (fileName, hash) => parseMetadataText(await raw.getText(fileName, hash));
}

const DOCUMENT_TYPES = ["DocumentType", "CollectionType", "TemplateType"];

/**
 * Parses a `.metadata` file the way rmapi-js would, minus the null intolerance. The fields rmapi-js
 * requires are still checked -- dropping validation altogether would turn a genuinely broken
 * document into notes named "undefined" rather than into an error.
 */
export function parseMetadataText(text: string): Metadata {
	const loaded: unknown = JSON.parse(text);
	if (loaded === null || typeof loaded !== "object" || Array.isArray(loaded)) {
		throw new Error("reMarkable metadata was not a JSON object");
	}

	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(loaded)) {
		if (value !== null) fields[key] = value;
	}

	for (const key of ["visibleName", "lastModified", "parent"]) {
		if (typeof fields[key] !== "string") throw new Error(`reMarkable metadata field "${key}" was not a string`);
	}
	if (typeof fields.pinned !== "boolean") {
		throw new Error('reMarkable metadata field "pinned" was not a boolean');
	}
	if (typeof fields.type !== "string" || !DOCUMENT_TYPES.includes(fields.type)) {
		throw new Error(`reMarkable metadata field "type" was ${JSON.stringify(fields.type)}`);
	}

	return fields as unknown as Metadata;
}
