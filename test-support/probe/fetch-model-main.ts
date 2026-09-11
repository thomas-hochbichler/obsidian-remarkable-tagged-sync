// Fetch one pinned model generation's two GGUFs to a directory, verifying each against the SHA-256
// in `src/local-model-artefacts.ts` -- the same table the shipped downloader reads, imported rather
// than copied so the probe can never measure a model the plugin does not pin.
//
// Not `startLocalModelDownload` itself: that wants a vault, a card and a lock. What it shares with
// this is the thing the probe depends on -- the URL, the byte count and the hash.
//
// Measurement scaffolding for managed-llm-windows-x64 ticket 07. Nothing in `src/` calls it.

import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { MODEL_GENERATIONS } from "../../src/local-model-artefacts";
import { MMPROJ_FILE, MODEL_FILE } from "../../src/local-model-store";

const dir = process.argv[2];
const wanted = process.argv[3] ?? "qwen2.5-vl-7b-instruct-q4_k_m";
if (!dir) {
	console.error("usage: node fetch-model.cjs <directory> [generation dir]");
	process.exit(64);
}

const generation = MODEL_GENERATIONS.find((g) => g.dir === wanted);
if (!generation) {
	console.error(`no pinned generation ${wanted}; known: ${MODEL_GENERATIONS.map((g) => g.dir).join(", ")}`);
	process.exit(64);
}

async function fetchArtefact(url: string, file: string, bytes: number, sha256: string) {
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
	const hash = createHash("sha256");
	await pipeline(
		// Hash on the way past rather than re-reading 4.7 GB afterwards.
		async function* () {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				hash.update(chunk);
				yield chunk;
			}
		},
		createWriteStream(file),
	);
	const size = statSync(file).size;
	if (size !== bytes) throw new Error(`${file}: ${size} B, pinned ${bytes}`);
	const digest = hash.digest("hex");
	if (digest !== sha256) throw new Error(`${file}: sha256 ${digest}, pinned ${sha256}`);
	console.log(`ok  ${file}  ${size.toLocaleString("en-US")} B  ${digest}`);
}

async function main() {
	mkdirSync(dir, { recursive: true });
	console.log(`${generation!.label} (${generation!.dir})`);
	for (const artefact of generation!.artefacts) {
		await fetchArtefact(artefact.url, join(dir, artefact.fileName), artefact.bytes, artefact.sha256);
	}
	console.log(`\n-> ${join(dir, MODEL_FILE)}\n-> ${join(dir, MMPROJ_FILE)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
