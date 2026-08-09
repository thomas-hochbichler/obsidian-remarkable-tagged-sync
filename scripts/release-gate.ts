// The release gate (managed-local-llm-ocr spec §15, last paragraph): the ten-page corpus through the
// *shipped* path, scored against §12's 7.6 % CER / 78.9 % word recall on the eight linear pages.
//
// Every earlier number in §12 came from `prototype/run-cli.sh`, which drives `llama-mtmd-cli` directly
// with `-hf` and the prompt pasted into a shell variable. Nothing in it is the code that ships. This
// harness replaces all of it with the plugin's own modules and touches the model only through them:
//
//   * the model arrives through `startLocalModelDownload` -- the pinned URLs, the SHA-256 pass, `tar`;
//   * the paths come from `resolveLocalModelPaths`, so it lands where the plugin will look for it;
//   * a page is transcribed by `createLocalOcrBackend(...).recognize([page])`, which means the shipped
//     raster, the shipped prompt, the shipped flags, `sanitizeTranscript` and `typedText`.
//
// What is left over is scoring, and that stays `prototype/mdbench.ts` deliberately: a gate that
// reproduces a number has to use the instrument that produced it.
//
// Build + run (from the repo root; CJS because the node layer uses a dynamic require by design):
//   SP=<scratchpad>
//   npx esbuild scripts/release-gate.ts --bundle --platform=node \
//     --format=cjs --external:iconv-lite --alias:obsidian=./test-stubs/obsidian.ts --outfile=$SP/gate.cjs
//   node $SP/gate.cjs <outDir>
//
// Resumable in both halves: a finished artefact is skipped by the downloader, and a page whose
// `<name>.txt` already exists is skipped here -- a 7B pass over ten pages must not be lost to a crash
// on page nine.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Platform } from "obsidian";
import { type DownloadHandle, startLocalModelDownload } from "../src/local-model-fetch";
import { localModelPlatform, readLocalModelState, resolveLocalModelPaths } from "../src/local-model-runtime";
import { createLocalOcrBackend } from "../src/local-ocr-runtime";
import { parseRmV6 } from "../src/rm-parser";

// The stub keeps the desktop guard shut so no unit test spawns a subprocess; this script needs it open.
(Platform as { isDesktop: boolean }).isDesktop = true;
// The lock heartbeat uses `window.setInterval`, which the plugin's lint rule requires for popout-window
// compatibility and which always exists in Obsidian's renderer. Plain node has none, so it stands one in.
(globalThis as { window?: unknown }).window ??= globalThis;

/** The plugin's real id, so the model lands where the plugin itself will look for it. */
const PLUGIN_ID = "remarkable-tagged-sync";
const CORPUS = ".scratch/vision-ocr-quality/corpus";

const outDir = process.argv[2];
if (!outDir) {
	console.error("Usage: node gate.cjs <outDir>");
	process.exit(1);
}

function gib(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Fetches whatever is missing, through the shipped downloader, printing the card's own progress. */
async function ensureModel(): Promise<void> {
	const platform = localModelPlatform();
	const paths = resolveLocalModelPaths(PLUGIN_ID);
	if (!platform || !paths) throw new Error("this machine is not one the backend is offered on");

	const before = readLocalModelState(paths, Date.now());
	console.log(`  state before: ${before}`);
	console.log(`  root:         ${paths.root}`);
	if (before === "ready") return;

	let lastLine = "";
	// `startLocalModelDownload` publishes its first phase *synchronously*, before it has returned, so
	// the callback cannot close over a `const` binding that does not exist yet.
	let handle: DownloadHandle | undefined;
	handle = startLocalModelDownload(paths, platform, () => {
		const progress = handle?.progress();
		if (!progress) return;
		const line =
			progress.phase === "downloading"
				? `  ${gib(progress.receivedBytes)} of ${gib(progress.totalBytes)}  (${Math.floor((progress.receivedBytes / progress.totalBytes) * 100)}%)`
				: `  ${progress.phase}`;
		if (line === lastLine) return;
		lastLine = line;
		console.log(line);
	});

	const outcome = await handle.finished;
	if (outcome.phase !== "done") throw new Error(`download failed: ${JSON.stringify(outcome)}`);
	const after = readLocalModelState(paths, Date.now());
	console.log(`  state after:  ${after}`);
	if (after !== "ready") throw new Error(`the download finished but the state is ${after}`);
}

/** Every corpus page that has a hand-corrected ground truth beside it, in the order §12 reports them. */
function corpusPages(): string[] {
	return readdirSync(CORPUS)
		.filter((f) => f.endsWith(".rm"))
		.map((f) => f.replace(/\.rm$/, ""))
		.filter((name) => existsSync(join(CORPUS, `${name}.gt.txt`)))
		.sort();
}

async function transcribe(): Promise<void> {
	mkdirSync(outDir, { recursive: true });
	// One live blob, as the plugin has: `recordPageDuration` writes the rolling mean through it, and
	// carrying it across pages is what §7.3's estimate is built on.
	const settings: Record<string, unknown> = {};

	// Rebuilt per page, exactly as a sync does -- `create()` runs once per sync and the adapter is not
	// kept, so a gate that built one adapter for all ten pages would be testing something else.
	const timings: string[] = [];
	for (const name of corpusPages()) {
		const target = join(outDir, `${name}.txt`);
		if (existsSync(target)) {
			console.log(`  skip  ${name}`);
			continue;
		}
		const backend = createLocalOcrBackend(PLUGIN_ID, settings);
		if (!backend) throw new Error("the backend refused to build: the model is not ready, or busy");

		const page = parseRmV6(new Uint8Array(readFileSync(join(CORPUS, `${name}.rm`))));
		const startedAt = Date.now();
		const result = await backend.recognize([page]);
		const seconds = (Date.now() - startedAt) / 1000;

		if (result.status !== "ok") throw new Error(`${name}: status ${result.status} ${JSON.stringify(result.warnings ?? [])}`);
		writeFileSync(target, result.text);
		timings.push(`${name} ${seconds.toFixed(1)}`);
		console.log(`  done  ${name}  ${seconds.toFixed(1)}s  ${result.text.length} chars`);
	}
	if (timings.length > 0) writeFileSync(join(outDir, "timings.txt"), `${timings.join("\n")}\n`);
	console.log(`\n  transcripts in ${outDir}`);
	console.log(`  page durations recorded in the blob: ${JSON.stringify(settings)}`);
}

async function main(): Promise<void> {
	console.log("\nThe model, through the shipped downloader:\n");
	await ensureModel();
	console.log("\nThe ten corpus pages, through the shipped backend:\n");
	await transcribe();
	console.log("\nScore with:\n  node <scratch>/mdbench.cjs .scratch/vision-ocr-quality/corpus --backend=dir --from=" + outDir + "\n");
}

void main().catch((error: Error) => {
	console.error(error);
	process.exit(1);
});
