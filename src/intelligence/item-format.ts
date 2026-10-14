/**
 * An Item format says how one List/Checklist item is written as a Markdown line, e.g.
 * `- [ ] {{text}} 📅 {{due}}`. The same format reads the line back, because the merge compares what
 * the engine wrote with what the user left in the note.
 *
 * Grouping rule: a format is split into words; each field placeholder owns the placeholder-free words
 * right before it (`📅 {{due}}`, `[due:: {{due}}]`). An empty field drops its whole group -- a stray
 * `📅` would make a Tasks query read a due date that is not there. `{{text}}` is mandatory.
 */

export interface FormatItem {
	text: string;
	fields: Record<string, string | null | undefined>;
	/** The character inside `[ ]`; ignored when the format has no checkbox. Default space. */
	checkbox?: string;
	/** Trailing fields of the line being replaced (Tasks' `✅`, `🔁`, priority), kept verbatim. */
	trailing?: string;
}

export interface ParsedLine {
	text: string;
	fields: Record<string, string>;
	checkbox: string | null;
	trailing: string;
}

export interface ItemFormat {
	readonly fieldNames: string[];
	render(item: FormatItem): string;
	parse(line: string): ParsedLine | null;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
// `[ ]` holds a space, so it is swapped for one token before the format is split into words.
const CHECKBOX = "\u0000checkbox";

// What the Tasks plugin appends to a line on its own: done/cancel/created/start/scheduled/due dates,
// recurrence, priority, id and depends-on. Read as one opaque tail so the merge never mistakes them
// for part of the item's text.
const TASKS_TRAILING = String.raw`(?:[✅❌➕⏳🛫📅]️?\s*\d{4}-\d{2}-\d{2}|🔁️?[^✅❌➕⏳🛫📅⏫🔼🔽⏬🔺🆔⛔]*[^\s✅❌➕⏳🛫📅⏫🔼🔽⏬🔺🆔⛔]|[⏫🔼🔽⏬🔺]️?|🆔\s*\S+|⛔️?\s*\S+)`;

interface Group {
	words: string[];
	/** Field name owning this group, "text" for the mandatory one, null for the literal tail. */
	field: string | null;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileItemFormat(format: string): ItemFormat {
	const words = format.trim().split("[ ]").join(CHECKBOX).split(/\s+/);
	const groups: Group[] = [];
	let pending: string[] = [];
	for (const word of words) {
		pending.push(word);
		const names = [...word.matchAll(PLACEHOLDER)].map((m) => m[1]);
		if (names.length === 0) continue;
		groups.push({ words: pending, field: names.includes("text") ? "text" : names[0] });
		pending = [];
	}
	if (pending.length > 0) groups.push({ words: pending, field: null });
	if (!groups.some((g) => g.field === "text")) throw new Error(`Item format "${format}" has no {{text}} placeholder`);

	const fieldNames = [...format.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((name) => name !== "text");
	const hasCheckbox = words.includes(CHECKBOX);
	const captureOrder: string[] = [];

	const wordPattern = (word: string): string => {
		if (word === CHECKBOX) {
			captureOrder.push(CHECKBOX);
			return String.raw`\[(.)\]`;
		}
		let out = "";
		let last = 0;
		for (const m of word.matchAll(PLACEHOLDER)) {
			out += escapeRegex(word.slice(last, m.index));
			captureOrder.push(m[1]);
			out += "(.+?)";
			last = m.index + m[0].length;
		}
		return out + escapeRegex(word.slice(last));
	};

	let pattern = "";
	for (const [index, group] of groups.entries()) {
		const body = group.words.map(wordPattern).join(String.raw`\s+`);
		const sep = index === 0 ? "" : String.raw`\s+`;
		pattern += group.field === "text" || group.field === null ? sep + body : `(?:${sep}${body})?`;
	}
	const regex = new RegExp(String.raw`^\s*${pattern}((?:\s+${TASKS_TRAILING})*)\s*$`, "u");

	return {
		fieldNames,
		render(item) {
			const parts: string[] = [];
			for (const group of groups) {
				const value = group.field === null || group.field === "text" ? null : item.fields[group.field];
				if (group.field !== null && group.field !== "text" && (value === null || value === undefined || value === "")) continue;
				parts.push(
					group.words
						.map((word) => (word === CHECKBOX ? `[${item.checkbox ?? " "}]` : word.replace(PLACEHOLDER, (_, name: string) => (name === "text" ? item.text : (item.fields[name] ?? "")))))
						.join(" "),
				);
			}
			if (item.trailing) parts.push(item.trailing);
			return parts.join(" ");
		},
		parse(line) {
			const match = regex.exec(line);
			if (!match) return null;
			const parsed: ParsedLine = { text: "", fields: {}, checkbox: hasCheckbox ? " " : null, trailing: match[captureOrder.length + 1].trim() };
			captureOrder.forEach((name, i) => {
				const value = match[i + 1];
				if (value === undefined) return;
				if (name === CHECKBOX) parsed.checkbox = value;
				else if (name === "text") parsed.text = value.trim();
				else parsed.fields[name] = value.trim();
			});
			return parsed.text === "" ? null : parsed;
		},
	};
}
