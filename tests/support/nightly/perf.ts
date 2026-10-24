// Half two of the perf gate (ticket 21): the wall-clock judgement. The nightly times the heavy
// page on the fixed runner class and this scores it against `.perf-baseline.json` -- the same
// shape of discipline as the OCR baseline: an absent baseline observes and passes (the first
// nights exist to CREATE the reference), and a committed baseline may only be raised with
// `--accept` and a named cause. The thresholds carry both a factor and an absolute floor, because
// the measured spread on one machine was 9-17 % -- 1.5x is real headroom over that -- and a
// floor keeps a 3 ms metric from flapping on scheduler noise.

export interface PerfMetrics {
	renderPagesToPdfMs: number;
	rasterizePageMs: number;
}

export interface PerfBaseline {
	renderPagesToPdfMs?: number;
	rasterizePageMs?: number;
}

export const DEGRADE_FACTOR = 1.5;
export const DEGRADE_FLOOR_MS = 50;

export interface PerfRun {
	status: "pass" | "degraded";
	reasons: string[];
}

export function evaluatePerf(metrics: PerfMetrics, baseline: PerfBaseline): PerfRun {
	const reasons: string[] = [];
	for (const name of ["renderPagesToPdfMs", "rasterizePageMs"] as const) {
		const measured = metrics[name];
		const reference = baseline[name];
		// No baseline yet: the night observes. Recording without judging is what the first five
		// nights are for, exactly like an OCR page whose key has no baseline entry.
		if (reference === undefined) continue;
		if (measured > reference * DEGRADE_FACTOR && measured - reference > DEGRADE_FLOOR_MS) {
			reasons.push(`${name}: ${Math.round(measured)} ms against baseline ${Math.round(reference)} ms`);
		}
		// Faster than baseline is silent here: lowering the reference is the baseline script's job,
		// with the same review a raise gets -- a gate must never tighten itself overnight.
	}
	return { status: reasons.length === 0 ? "pass" : "degraded", reasons };
}
