// CLI entry for the nightly's perf half: `npm run nightly:perf`.
//
// Times the heavy page on this runner and writes the part file the verdict job merges. The
// minimum over five runs is the estimator -- noise only ever adds time -- after one warm-up run
// so the JIT is not part of the measurement. A crash writes nothing; the merge records the part
// as `unknown` with "job did not report", never a stale number wearing a fresh timestamp.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rasterizePage } from "../../src/page-rasterizer";
import { renderPagesToPdf } from "../../src/pdf-renderer";
import { heavyPage } from "../perf/heavy-page";
import { type PerfBaseline, evaluatePerf } from "./perf";

const OUT_DIR = join(process.cwd(), "nightly-parts");
const RUNS = 5;

function loadBaseline(): PerfBaseline {
	const path = join(process.cwd(), ".perf-baseline.json");
	if (!existsSync(path)) return {};
	return (JSON.parse(readFileSync(path, "utf8")) as { metrics?: PerfBaseline }).metrics ?? {};
}

async function minMs(fn: () => Promise<unknown> | unknown): Promise<number> {
	let best = Infinity;
	for (let i = 0; i < RUNS; i++) {
		const t0 = performance.now();
		await fn();
		best = Math.min(best, performance.now() - t0);
	}
	return best;
}

async function main() {
	const page = heavyPage(2000);
	await renderPagesToPdf([page]);
	rasterizePage(page);

	const metrics = {
		renderPagesToPdfMs: await minMs(() => renderPagesToPdf([page])),
		rasterizePageMs: await minMs(() => rasterizePage(page)),
	};
	const run = evaluatePerf(metrics, loadBaseline());

	mkdirSync(OUT_DIR, { recursive: true });
	const part = {
		status: run.status,
		measuredAt: new Date().toISOString(),
		detail: {
			metrics: { renderPagesToPdfMs: Math.round(metrics.renderPagesToPdfMs), rasterizePageMs: Math.round(metrics.rasterizePageMs) },
			page: "2000 strokes x 50 points",
			node: process.version,
			...(run.reasons.length === 0 ? {} : { reasons: run.reasons }),
		},
	};
	writeFileSync(join(OUT_DIR, "perf.json"), `${JSON.stringify(part, null, "\t")}\n`);
	console.log(`perf ${part.status}: render ${part.detail.metrics.renderPagesToPdfMs} ms, raster ${part.detail.metrics.rasterizePageMs} ms`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
