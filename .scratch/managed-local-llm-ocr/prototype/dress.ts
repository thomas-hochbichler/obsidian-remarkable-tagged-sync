/**
 * PROTOTYPE -- ticket 03. The metric's control, and the reason it exists.
 *
 * "Scoring structured Markdown raw punishes the better transcription" is a CLAIM. This turns each
 * ground truth into a PERFECT transcription wearing Markdown -- headings, nested lists, GFM task
 * boxes, a table, bold, rules, an outer fence and a preamble -- WITHOUT changing a single character
 * of text. Scored fairly it must come out at ~0 % CER / 100 % recall; scored flat, whatever it loses
 * is the size of the unfairness, measured instead of asserted.
 *
 *   npx esbuild .scratch/managed-local-llm-ocr/prototype/dress.ts --bundle --platform=node \
 *     --format=cjs --outfile=$SCRATCH/dress.cjs && node $SCRATCH/dress.cjs <corpusDir> <outDir>
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Section headings the writer drew as plain lines. All-caps counts; so does a known section word. */
const SECTION_WORDS = new Set(["Fragen", "Antworten", "Problem", "Lösung", "ToDo", "Req", "Review", "Retro", "Sprint Demo", "Ai Brain Dump"]);
const isSection = (line: string) =>
	SECTION_WORDS.has(line) || (/[A-ZÄÖÜ]{2}/.test(line) && !/[a-zäöüß]/.test(line));

/** The 3-column colour sheet: 3 tool names, then 8 colours per tool. Every cell is a ground-truth line. */
function asTable(lines: string[]): string[] {
	const head = lines.slice(0, 3);
	const body = lines.slice(3);
	const rows = Math.ceil(body.length / 2);
	return [
		`| ${head.join(" | ")} |`,
		`| --- | --- | --- |`,
		...Array.from({ length: rows }, (_, i) => `| ${body[i] ?? ""} | ${body[i + rows] ?? ""} | |`),
	];
}

function dress(name: string, text: string, index: number): string {
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	if (name === "Quick_sheets-b5333acc") return asTable(lines).join("\n");

	// Both ways a model marks a section, alternating by page so each is exercised on real pages.
	const heading = (l: string) => (index % 2 === 0 ? `## ${l}` : `**${l}**`);
	// One page's plain lines become a GFM task list: the writer drew no markers there at all, so it
	// is the honest test of "a marker the truth never had must not cost".
	const asTasks = name === "Obsidian_Sync_Plugin-39a86ea3";

	const out = lines.map((line, i) => {
		if (i === 0) return `# ${line}`;
		if (isSection(line)) return (index % 3 === 0 ? "---\n" : "") + heading(line);
		if (line.startsWith("+ ")) return `  - ${line.slice(2)}`;
		if (line.startsWith("- ")) return line;
		if (asTasks) return `- [ ] ${line}`;
		return line;
	});

	// Envelope leakage every provider produces, so `sanitizeTranscript` is exercised end to end.
	return index % 3 === 1 ? `Here is the transcript:\n\n\`\`\`markdown\n${out.join("\n")}\n\`\`\`` : out.join("\n");
}

const [corpus, outDir] = process.argv.slice(2);
if (!corpus || !outDir) { console.error("Usage: node dress.cjs <corpusDir> <outDir>"); process.exit(1); }
mkdirSync(outDir, { recursive: true });

const names = readdirSync(corpus).filter((f) => f.endsWith(".gt.txt")).sort();
names.forEach((f, i) => {
	const name = f.replace(/\.gt\.txt$/, "");
	writeFileSync(join(outDir, `${name}.txt`), dress(name, readFileSync(join(corpus, f), "utf8"), i));
});
console.log(`dressed ${names.length} page(s) into ${outDir}`);
