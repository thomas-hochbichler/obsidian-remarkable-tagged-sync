import type { Entitlement } from "./licence-state";

/**
 * Frontmatter properties (Pro): the plugin-managed keys a synced note carries so vault views
 * (Dataview, Bases) can query it -- see `.scratch/pro-frontmatter/spec.md`.
 *
 * The management policy is surgical and line-level on purpose. The plugin owns exactly the
 * `remarkable-*` keys plus the tags it added to the shared `tags` list; every other line of the
 * user's frontmatter is preserved byte-for-byte -- no YAML re-serialization, no
 * `processFrontMatter`. That is the same contract the note body already has: the managed block is
 * the plugin's, the free area is the user's, and here the block is a set of lines instead of a
 * region.
 */
export interface NoteFrontmatter {
	/** Already namespaced (`remarkable/<tag>`, no `#`) -- see {@link namespacedTags}. */
	tags: string[];
	/** Device `lastModified` as a local ISO minute, or null when the device value was unreadable. */
	modified: string | null;
	/** When this note's content was last written, as a local ISO minute. */
	synced: string;
	/** Device folder path (`Work/Projekt X`), or null for a document at the root -- no key is written. */
	folder: string | null;
	type: "notebook" | "pdf" | "epub";
	pinned: boolean;
	/** The document's id, for stable identity and debugging. */
	uuid: string;
}

/**
 * The gate: frontmatter properties are part of Tagged Sync Pro. Asked by `main.ts` before a sync
 * writes any keys and by the settings tab to disable the toggle -- the same predicate in both
 * places, so the census in `pro-capabilities.ts` can drive it.
 */
export function frontmatterAllowed(entitlement: Entitlement): boolean {
	return entitlement.tier !== "free";
}

/** The scalar keys the plugin owns outright, in the order a fresh block lists them. */
const MANAGED_KEYS = [
	"remarkable-modified",
	"remarkable-synced",
	"remarkable-folder",
	"remarkable-type",
	"remarkable-pinned",
	"remarkable-uuid",
] as const;

// Same shape note-builder matches: a leading `---` block closed by `---` on its own line.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Local ISO 8601 to the minute (`2026-08-26T14:30`) -- Dataview-native, and same-day syncs still
 * sort correctly. Local rather than UTC because the value is read by the person sitting in front of
 * the vault, and seconds say nothing a sort needs.
 */
export function formatLocalMinute(date: Date): string {
	const pad = (part: number): string => String(part).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The device's `lastModified` as a local ISO minute, or null when it cannot be read. The cloud
 * stores it as an epoch-milliseconds string; tolerating an ISO string as well costs one branch and
 * survives a format change without writing `Invalid Date` into anyone's vault.
 */
export function deviceModified(lastModified: string): string | null {
	const ms = /^\d+$/.test(lastModified) ? Number(lastModified) : Date.parse(lastModified);
	return Number.isFinite(ms) ? formatLocalMinute(new Date(ms)) : null;
}

/**
 * Device tag names as Obsidian property tags: namespaced `remarkable/<tag>`, written without `#`
 * (the property convention), characters Obsidian's tag parser rejects replaced so the entry still
 * registers as a real tag. The namespace is what guarantees every synced note answers
 * `FROM #remarkable`.
 */
export function namespacedTags(names: string[]): string[] {
	const cleaned = names
		.map((name) =>
			name
				.replace(/^#/, "")
				.replace(/\s+/g, "-")
				.replace(/[^\p{L}\p{N}/_-]/gu, ""),
		)
		.filter((name) => name.replace(/[/-]/g, "") !== "");
	return [...new Set(cleaned)].map((name) => `remarkable/${name}`);
}

/** A scalar as a YAML value: plain where unambiguous, JSON-quoted where YAML would misread it. */
function yamlValue(value: string): string {
	const plain = /^[\p{L}\p{N}_][^:#\n]*$/u.test(value) && !/\s$/.test(value);
	return plain ? value : JSON.stringify(value);
}

/** Each managed key's value line content, or null for "this key must not exist". */
function scalarValues(frontmatter: NoteFrontmatter): Record<(typeof MANAGED_KEYS)[number], string | null> {
	return {
		"remarkable-modified": frontmatter.modified,
		"remarkable-synced": frontmatter.synced,
		"remarkable-folder": frontmatter.folder === null ? null : yamlValue(frontmatter.folder),
		"remarkable-type": frontmatter.type,
		"remarkable-pinned": String(frontmatter.pinned),
		"remarkable-uuid": frontmatter.uuid,
	};
}

/** Strips one layer of matching quotes, so `'#tag'` and `tag` compare as the same list entry. */
function unquote(raw: string): string {
	const trimmed = raw.trim();
	const quoted =
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")));
	return quoted ? trimmed.slice(1, -1) : trimmed;
}

/**
 * Merges the plugin's tags into the shared `tags` key, touching only its own entries: entries in
 * `previousOwnTags` that are no longer in `ownTags` go, missing `ownTags` are appended, and every
 * user entry keeps its exact bytes. Handles the three forms a stored `tags` key takes -- block
 * list, inline `[a, b]`, and a bare scalar (converted to a block list, the one place a user line
 * is reformatted, because a scalar cannot hold a second entry).
 *
 * With `ownTags` empty this *is* the cleanup: it removes the previously-added entries and drops
 * the key when nothing is left in it.
 */
function mergeTags(lines: string[], ownTags: string[], previousOwnTags: string[]): string[] {
	const stale = new Set(previousOwnTags.filter((tag) => !ownTags.includes(tag)));
	const index = lines.findIndex((line) => /^tags\s*:/.test(line));

	if (index === -1) {
		if (ownTags.length === 0) return lines;
		return [...lines, "tags:", ...ownTags.map((tag) => `  - ${tag}`)];
	}

	const rest = lines[index].slice(lines[index].indexOf(":") + 1).trim();

	if (rest.startsWith("[") && rest.endsWith("]")) {
		const entries = rest
			.slice(1, -1)
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry !== "" && !stale.has(unquote(entry)));
		const present = new Set(entries.map(unquote));
		entries.push(...ownTags.filter((tag) => !present.has(tag)));
		if (entries.length === 0) return [...lines.slice(0, index), ...lines.slice(index + 1)];
		return [...lines.slice(0, index), `tags: [${entries.join(", ")}]`, ...lines.slice(index + 1)];
	}

	// Block list (or a bare scalar, folded into one): collect the item lines that follow the key.
	let end = index + 1;
	const items: string[] = rest === "" ? [] : [`  - ${rest}`];
	while (end < lines.length && /^\s*-\s/.test(lines[end])) {
		items.push(lines[end]);
		end++;
	}

	const kept = items.filter((item) => !stale.has(unquote(item.replace(/^\s*-\s*/, ""))));
	const present = new Set(kept.map((item) => unquote(item.replace(/^\s*-\s*/, ""))));
	const indent = kept[0]?.match(/^\s*/)?.[0] ?? "  ";
	kept.push(...ownTags.filter((tag) => !present.has(tag)).map((tag) => `${indent}- ${tag}`));

	if (kept.length === 0) return [...lines.slice(0, index), ...lines.slice(end)];
	return [...lines.slice(0, index), "tags:", ...kept, ...lines.slice(end)];
}

/** Replaces, inserts, or removes the plugin's scalar lines; a line starting `<key>:` is the plugin's. */
function mergeScalars(lines: string[], frontmatter: NoteFrontmatter): string[] {
	const merged = [...lines];
	const values = scalarValues(frontmatter);
	for (const key of MANAGED_KEYS) {
		const value = values[key];
		const index = merged.findIndex((line) => line.startsWith(`${key}:`));
		if (value === null) {
			if (index !== -1) merged.splice(index, 1);
		} else if (index !== -1) {
			merged[index] = `${key}: ${value}`;
		} else {
			merged.push(`${key}: ${value}`);
		}
	}
	return merged;
}

/**
 * Writes the plugin's keys into `content`'s leading frontmatter block, creating the block when the
 * note has none. Returns the new content and the tags the plugin now owns in this note --
 * the caller stores them on the index row, so the next write (or the cleanup pass) knows which
 * entries of the shared `tags` list are the plugin's to remove.
 */
export function applyFrontmatter(
	content: string,
	frontmatter: NoteFrontmatter,
	previousOwnTags: string[],
): { content: string; ownTags: string[] } {
	const match = content.match(FRONTMATTER_RE);
	if (!match) {
		const lines = mergeScalars(mergeTags([], frontmatter.tags, previousOwnTags), frontmatter);
		return { content: `---\n${lines.join("\n")}\n---\n${content}`, ownTags: frontmatter.tags };
	}

	const lines = mergeScalars(mergeTags(match[1].split("\n"), frontmatter.tags, previousOwnTags), frontmatter);
	return {
		content: `---\n${lines.join("\n")}\n---\n${content.slice(match[0].length)}`,
		ownTags: frontmatter.tags,
	};
}

/**
 * The toggle-off cleanup for one note: removes the plugin's keys and its tracked tags, keeps every
 * user line, and drops the `---` block entirely when nothing of the user's is left in it. Returns
 * null when the note carries nothing of the plugin's -- the caller skips the write.
 */
export function removeFrontmatter(content: string, ownTags: string[]): string | null {
	const match = content.match(FRONTMATTER_RE);
	if (!match) return null;

	let lines = mergeTags(match[1].split("\n"), [], ownTags);
	lines = lines.filter((line) => !MANAGED_KEYS.some((key) => line.startsWith(`${key}:`)));

	const cleaned = lines.every((line) => line.trim() === "")
		? content.slice(match[0].length)
		: `---\n${lines.join("\n")}\n---\n${content.slice(match[0].length)}`;
	return cleaned === content ? null : cleaned;
}
