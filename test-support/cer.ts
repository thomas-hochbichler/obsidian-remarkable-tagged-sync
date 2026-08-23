// The nightly's measuring instrument: the ticket-14 §2 normaliser and the character error rate.
//
// Both sides of every comparison -- the ground-truth body and the backend's transcript -- go
// through `normalizeForCer` first, so a difference that survives normalisation is a reading error
// and nothing else. The rules were settled by measuring them against the real reference pages
// (ticket 14 §2), and the two easiest mistakes are named here so they are not re-made:
//
// - **NFC and only NFC.** NFKC rewrites `a²` to `a2` and `…` to `...` -- it destroys exactly the
//   characters pages 06, 11 and 12 exist to measure.
// - **Levenshtein needs no table-aware or list-aware scoring.** It is an optimal alignment, not a
//   positional diff: a shifted table pipe costs 0 after whitespace collapsing, measured. What a
//   table does need is `structureObservation`, because a table returned as prose measures 41 % CER
//   -- indistinguishable from "read half the words wrong" unless recorded separately.

/** Zero-width characters a transport may inject; none can be handwritten. */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
/** Every Unicode space separator except U+0020 becomes a plain space and falls to the space rules. */
const EXOTIC_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
/** Markdown emphasis markers hugging a word; the device has one pen, so emphasis is never written. */
const EMPHASIS_OPEN = /([*_]{1,2})(?=\S)/g;
const EMPHASIS_CLOSE = /(?<=\S)([*_]{1,2})/g;

type LineKind = "blank" | "heading" | "bullet" | "numbered" | "table" | "tableDelimiter" | "blockquote" | "plain";

interface Line {
	kind: LineKind;
	/** Nesting depth from leading whitespace: floor(spaces / 2), a tab is one level. */
	level: number;
	/** The content with markers stripped (heading/bullet/number markers, table pipes kept). */
	content: string;
}

function classify(raw: string): Line {
	if (/^\s*$/.test(raw)) return { kind: "blank", level: 0, content: "" };

	const indent = /^[\t ]*/.exec(raw)![0];
	const level = Math.floor(indent.replace(/\t/g, "  ").length / 2);
	const line = raw.trim();

	// A delimiter row is formatting, not content: every cell is dashes with optional alignment colons.
	if (/\|/.test(line)) {
		const cells = line.replace(/^\|/, "").replace(/\|$/, "").split("|");
		if (cells.length >= 2 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell))) {
			return { kind: "tableDelimiter", level, content: "" };
		}
		if (line.split("|").length - 1 >= 2) return { kind: "table", level, content: line };
	}

	const heading = /^#{1,6}\s+(.*)$/.exec(line);
	if (heading) return { kind: "heading", level, content: heading[1] };

	if (/^>/.test(line)) return { kind: "blockquote", level, content: line.replace(/^>\s?/, "") };

	// CommonMark bullet markers, plus the typographic ones a model may emit. Deliberately NOT
	// letters: page 04's `a.` / `b.` sub-items are ordinary text and must stay measurable verbatim.
	const bullet = /^[-*+•–]\s+(.*)$/.exec(line);
	if (bullet) return { kind: "bullet", level, content: bullet[1] };

	const numbered = /^\d{1,3}[.)]\s+(.*)$/.exec(line);
	if (numbered) return { kind: "numbered", level, content: numbered[1] };

	return { kind: "plain", level, content: line };
}

/** Collapses runs of spaces and trims; the per-line half of ticket 14 §2 rule (2). */
function collapseSpaces(text: string): string {
	return text.replace(/ {2,}/g, " ").trim();
}

/** `| a | b | c |` with trimmed cells, leading/trailing pipes tolerated on the way in. */
function canonicalTableRow(line: string): string {
	const cells = line
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => collapseSpaces(cell));
	return `| ${cells.join(" | ")} |`;
}

/**
 * The ticket-14 §2 normaliser. Both sides of a comparison go through this; what survives is a
 * reading error. See the file header for the two measured rules that shape it.
 */
export function normalizeForCer(text: string): string {
	const repaired = text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.replace(ZERO_WIDTH, "")
		.replace(EXOTIC_SPACES, " ")
		.normalize("NFC");

	const lines = repaired.split("\n").map(classify);

	const out: string[] = [];
	// Ordinals are renumbered canonically by position within their own consecutive run, per level,
	// so `1. / 1. / 1.` and `1. / 2. / 3.` -- which render identically -- collapse together, while a
	// dropped item still moves the item text and shows up as edits.
	let counters = new Map<number, number>();

	for (const line of lines) {
		if (line.kind !== "numbered") counters = new Map();

		if (line.kind === "blank") {
			if (out.length > 0 && out[out.length - 1] !== "") out.push("");
			continue;
		}
		if (line.kind === "tableDelimiter") continue;

		const content = collapseSpaces(line.content.replace(EMPHASIS_OPEN, "").replace(EMPHASIS_CLOSE, ""));
		const indent = "  ".repeat(line.level);

		switch (line.kind) {
			case "table":
				out.push(canonicalTableRow(content));
				break;
			case "bullet":
				out.push(`${indent}- ${content.replace(/^\[X\]/, "[x]")}`);
				break;
			case "numbered": {
				for (const depth of [...counters.keys()]) if (depth > line.level) counters.delete(depth);
				const n = (counters.get(line.level) ?? 0) + 1;
				counters.set(line.level, n);
				out.push(`${indent}${n}. ${content}`);
				break;
			}
			case "blockquote":
				out.push(`> ${content}`);
				break;
			case "heading":
				out.push(content);
				// A heading is its own block: the next plain line must not be joined onto it.
				out.push("");
				break;
			case "plain": {
				// A single line break inside running text is the device wrapping at page width --
				// layout, not content -- so consecutive plain lines join with a space. Never across
				// any other kind of line, and never across a blank one.
				const last = out.length - 1;
				if (last >= 0 && out[last] !== "" && isJoinablePlain(out[last])) {
					out[last] = `${out[last]} ${content}`;
				} else {
					out.push(`${indent}${content}`);
				}
				break;
			}
		}
	}

	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out.join("\n");
}

// Joining needs to know the previous OUTPUT line was plain text. Everything else this normaliser
// emits starts with a marker it wrote itself (`- `, `1. `, `| `, `> `), so plain is the remainder.
function isJoinablePlain(emitted: string): boolean {
	const t = emitted.trimStart();
	return !/^(- |\d{1,3}\. |\| |> )/.test(t);
}

/** Edit distance over Unicode code points; after NFC these pages hold no combining sequences. */
export function levenshtein(a: string, b: string): number {
	const s = [...a];
	const t = [...b];
	if (s.length === 0) return t.length;
	if (t.length === 0) return s.length;
	let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
	for (let i = 1; i <= s.length; i++) {
		const row = [i];
		for (let j = 1; j <= t.length; j++) {
			row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)));
		}
		prev = row;
	}
	return prev[t.length];
}

/**
 * Character error rate of a transcript against a reference: `levenshtein / length(reference)` over
 * the two normalised strings, in code points. **Never capped** -- a prompt variant once measured
 * 836.8 % on a single page, and a cap would have hidden exactly that.
 *
 * `alternates` are alternate reference renderings (ticket 14 §2 rule 10; page 06 declares its LaTeX
 * form). The CER is the minimum over the body and the alternates, each scored against its own
 * length. The list is authored once, before the first measurement; growing it later is governed by
 * the same discipline as raising a baseline.
 */
export function characterErrorRate(reference: string, transcript: string, alternates: string[] = []): number {
	const hyp = normalizeForCer(transcript);
	let best = Number.POSITIVE_INFINITY;
	for (const candidate of [reference, ...alternates]) {
		const ref = normalizeForCer(candidate);
		const length = [...ref].length;
		if (length === 0) throw new Error("empty reference body -- the loader must reject this page");
		best = Math.min(best, levenshtein(ref, hyp) / length);
	}
	return best;
}

/**
 * The structure observation of ticket 14 §2 rule (9), recorded beside CER and never folded into
 * it: "tables got worse" and "tables stopped being tables" are different bugs. Only structures the
 * reference actually has are observed.
 */
export function structureObservation(reference: string, transcript: string): { table?: "ok" | "lost"; list?: "ok" | "lost" } {
	const kinds = (text: string) => normalizeForCer(text).split("\n").map(classify);
	const refKinds = kinds(reference);
	const hypKinds = kinds(transcript);
	const count = (lines: Line[], match: (kind: LineKind) => boolean) => lines.filter((line) => match(line.kind)).length;

	const observation: { table?: "ok" | "lost"; list?: "ok" | "lost" } = {};
	if (count(refKinds, (k) => k === "table") >= 2) {
		observation.table = count(hypKinds, (k) => k === "table") >= 2 ? "ok" : "lost";
	}
	if (count(refKinds, (k) => k === "bullet" || k === "numbered") >= 2) {
		observation.list = count(hypKinds, (k) => k === "bullet" || k === "numbered") >= 2 ? "ok" : "lost";
	}
	return observation;
}
