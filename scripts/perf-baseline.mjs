// The perf baseline and its change discipline (ticket 21), the same shape as the OCR baseline in
// ocr-baseline.mjs: the git history of .nightly-verdict.json is the record, every metric is the
// median of the last 30 recorded nights, a falling number is absorbed silently, a rising one is
// refused unless --accept names it AND something that explains the raise actually changed -- for
// a wall-clock number on a fixed runner class that is the heavy page or the Node version.
//
//   node scripts/release-checks.mjs perf-baseline                  # dry run
//   node scripts/release-checks.mjs perf-baseline --write
//   node scripts/release-checks.mjs perf-baseline --write --accept <metric> --because "<why>"

export const WINDOW_NIGHTS = 30;
export const MIN_NIGHTS = 5;
export const METRICS = ["renderPagesToPdfMs", "rasterizePageMs"];

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)];
};

/** One night's perf numbers from a committed verdict, or null when that night did not measure. */
export function perfNightFromVerdict(verdict) {
	const part = verdict?.parts?.perf;
	if (!part || !["pass", "degraded"].includes(part.status)) return null;
	const detail = part.detail ?? {};
	const metrics = {};
	for (const name of METRICS) {
		if (typeof detail.metrics?.[name] === "number") metrics[name] = detail.metrics[name];
	}
	if (Object.keys(metrics).length === 0) return null;
	return { measuredAt: part.measuredAt, page: detail.page, node: detail.node, metrics };
}

/** Pure: what --write would put into .perf-baseline.json, what it refused, and why. */
export function computePerfBaseline({ nights, existing, accepts = [], because = "", today }) {
	const refused = [];
	const skipped = [];
	const changed = [];
	const entries = { ...existing };

	for (const name of METRICS) {
		const window = nights.slice(0, WINDOW_NIGHTS).filter((night) => night.metrics[name] !== undefined);
		if (window.length < MIN_NIGHTS) {
			skipped.push(`${name}: needs ${MIN_NIGHTS} recorded nights, has ${window.length}`);
			continue;
		}
		const values = window.map((night) => night.metrics[name]);
		const candidate = {
			ms: median(values),
			spread: Math.max(...values) - Math.min(...values),
			setAt: today,
			nights: values.length,
			page: window[0].page,
			node: window[0].node,
		};
		const current = existing[name];

		if (current === undefined) {
			entries[name] = { ...candidate, because: "first baseline" };
			changed.push(`${name}: first baseline ${candidate.ms} ms over ${candidate.nights} nights`);
			continue;
		}
		if (candidate.ms <= current.ms) {
			if (candidate.ms < current.ms) changed.push(`${name}: lowered ${current.ms} ms -> ${candidate.ms} ms`);
			entries[name] = { ...candidate, because: current.because };
			continue;
		}

		if (!accepts.includes(name)) {
			refused.push(`${name}: would rise ${current.ms} ms -> ${candidate.ms} ms -- a raise needs --accept ${name} --because "..."`);
			continue;
		}
		const differs = ["page", "node"].some((field) => candidate[field] !== undefined && candidate[field] !== current[field]);
		if (!differs) {
			refused.push(`${name}: --accept refused -- page and node are both unchanged, so nothing explains the raise. A regression cannot be made to go away by editing the number`);
			continue;
		}
		if (because.trim() === "") {
			refused.push(`${name}: --accept needs --because "<why>"`);
			continue;
		}
		entries[name] = { ...candidate, because };
		changed.push(`${name}: raised ${current.ms} ms -> ${candidate.ms} ms (${because})`);
	}

	return { entries, refused, skipped, changed };
}
