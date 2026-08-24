// Half one of the perf gate (ticket 21): the complexity ratio. Absolute time is a property of the
// machine, but the ratio between the same code at 500 and at 2000 strokes is a property of the
// code -- linear work costs ~4x. The limit of 6 is measured, not guessed: ten clean rounds spread
// 3.5-4.2, and the subtlest injected O(n^2) (a per-stroke walk over all strokes) measured 6.6 --
// a limit of 10 would have let it ship. Runs on every PR on any runner because no reference
// number is needed; the uniform slowdown this test is blind to belongs to the nightly perf part.
//
// Noise can only inflate a timing, so the minimum over a few runs is the estimator, and a noisy
// attempt (a descheduled small run inflates the ratio) gets retried: a real O(n^2) cannot produce
// a clean attempt, so pass-on-any-attempt is sound.

import { describe, expect, it } from "vitest";
import { rasterizePage } from "../../src/page-rasterizer";
import { renderPagesToPdf } from "../../src/pdf-renderer";
import { heavyPage } from "./heavy-page";

const SMALL = heavyPage(500);
const LARGE = heavyPage(2000);
const RATIO_LIMIT = 6;
const ATTEMPTS = 3;
const RUNS = 2;

async function minMs(fn: () => Promise<unknown> | unknown): Promise<number> {
	let best = Infinity;
	for (let i = 0; i < RUNS; i++) {
		const t0 = performance.now();
		await fn();
		best = Math.min(best, performance.now() - t0);
	}
	return best;
}

async function assertLinear(fn: (page: typeof SMALL) => Promise<unknown> | unknown) {
	await fn(SMALL); // warm-up, so the first measured run is not paying for the JIT
	const ratios: number[] = [];
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const small = await minMs(() => fn(SMALL));
		const large = await minMs(() => fn(LARGE));
		const ratio = large / small;
		if (ratio < RATIO_LIMIT) return;
		ratios.push(ratio);
	}
	expect.fail(`4x the strokes cost ${ratios.map((r) => `${r.toFixed(1)}x`).join(", ")} across ${ATTEMPTS} attempts -- linear code costs ~4x, the limit is ${RATIO_LIMIT}x`);
}

describe("complexity ratio", () => {
	it("renderPagesToPdf stays linear: 4x the strokes may not cost more than 6x the time", { timeout: 30_000 }, async () => {
		await assertLinear((page) => renderPagesToPdf([page]));
	});

	it("rasterizePage stays linear: 4x the strokes may not cost more than 6x the time", { timeout: 30_000 }, async () => {
		await assertLinear((page) => rasterizePage(page));
	});
});
