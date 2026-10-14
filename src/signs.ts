/**
 * The user's notation: the signs a line can start with and what each means (ticket 43).
 *
 * One table, two readers. The transcript copies the signs (`transcriptionPrompt`), and insight notes
 * read them from the transcript (`signRules`) -- never from the ink, so a rule is only as good as the
 * copy. It is the writer's, not a page type's: it lives under Transcription and runs before any Profile
 * is chosen, in the free build too.
 */

export type SignMeaning = "task-open" | "task-done" | "task-elsewhere" | "event" | "note" | "custom";

export interface SignDef {
	/** The character the transcript writes for it. */
	glyph: string;
	/** How it looks on paper, for a mark no character resembles well ("a small triangle"). */
	drawn?: string;
	meaning: SignMeaning;
	/** `custom` only: what it means, in the user's words. */
	text?: string;
}

/** Common marks offered when adding a sign, so nobody hunts for Unicode. */
export const SIGN_PALETTE = ["•", "○", "◦", "—", "–", "X", "✓", ">", "<", "!", "★", "□", "■", "△", "?"];

export const MEANING_LABELS: Record<SignMeaning, string> = {
	"task-open": "Open task",
	"task-done": "Done task",
	"task-elsewhere": "Task moved elsewhere",
	event: "Event",
	note: "Note",
	custom: "In my own words…",
};

/** Ryder Carroll's key, as measured in research 31 and 35; the looks are ticket 43's table. */
export const BULLET_JOURNAL: readonly SignDef[] = [
	{ glyph: "•", drawn: "a dot", meaning: "task-open" },
	{ glyph: "X", drawn: "a cross over the dot", meaning: "task-done" },
	{ glyph: ">", drawn: "an arrow to the right", meaning: "task-elsewhere" },
	{ glyph: "<", drawn: "an arrow to the left", meaning: "task-elsewhere" },
	{ glyph: "○", drawn: "a small circle", meaning: "event" },
	{ glyph: "—", drawn: "a dash", meaning: "note" },
];

/**
 * The stored table, total. Rows are carried as stored: `data.json` is shared between devices, and a
 * meaning a newer build added must survive this one's next save. The prompts skip what they cannot read.
 */
export function readSigns(saved: unknown): SignDef[] {
	return Array.isArray(saved) ? saved.filter((row: unknown): row is SignDef => typeof (row as Partial<SignDef> | null)?.glyph === "string") : [];
}

/** Said where the signs are set and where insight notes are switched on, when the reader keeps none (ticket 43). */
export const dropsSignsSentence = (reader: string) => `${reader} keeps no signs. Your signs reach insight notes only with a language model that does.`;

/** The rows a prompt can use: a sign with no character yet says nothing. */
const usable = (signs: readonly SignDef[]) => signs.filter((sign) => sign.glyph.trim() !== "");
/** "△ (a small triangle)", or the character alone. */
const named = (sign: SignDef) => (sign.drawn?.trim() ? `${sign.glyph.trim()} (${sign.drawn.trim()})` : sign.glyph.trim());

/**
 * The signs the transcript is told to copy, "• for a dot, ★", and the first for its example; null without any.
 * The look follows "for", not in brackets as for extraction: the transcript writes out what it is told
 * to copy, and a look beside the sign must not read as part of it.
 */
export function transcriptSigns(signs: readonly SignDef[]): { list: string; first: string } | null {
	const rows = usable(signs);
	if (rows.length === 0) return null;
	const list = rows.map((sign) => (sign.drawn?.trim() ? `${sign.glyph.trim()} for ${sign.drawn.trim()}` : sign.glyph.trim()));
	return { list: list.join(", "), first: rows[0].glyph.trim() };
}

const RULE: Record<SignMeaning, string> = {
	"task-open": "marks an open task.",
	"task-done": "marks a task that is done: set done to true.",
	"task-elsewhere": "marks a task that is not open here: leave it out.",
	event: "marks an event: not a task.",
	note: "marks a note: not a task.",
	custom: "",
};

/** What a sign means to the extraction, one sentence a row, worded after research 31's Bullet Journal sentences. */
export function signRules(signs: readonly SignDef[]): string[] {
	const rows = usable(signs);
	if (rows.length === 0) return [];
	const sentences = rows
		.filter((sign) => (sign.meaning === "custom" ? sign.text?.trim() : RULE[sign.meaning]))
		.map((sign) => `The sign ${named(sign)} before a line ${sign.meaning === "custom" ? `means: ${sign.text!.trim()}` : RULE[sign.meaning]}`);
	// Ticket 42: the transcript's own list marker read as the writer's dash. Unsaid where "-" is a sign.
	const dash = rows.some((sign) => sign.glyph.trim() === "-") ? [] : ["A - at the start of a line is the list format, not a sign."];
	return [...sentences, ...dash];
}
