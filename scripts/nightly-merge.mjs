// Merges the nightly's part files into `.nightly-verdict.json` (ticket 14 §1.2, §3).
//
// Each job writes its own part into `nightly-parts/<name>.json`; this runs in the `verdict` job
// with `if: always()`, so a crashed job still yields a part -- recorded as `unknown` with the
// reason "job did not report", never as last night's value wearing a fresh timestamp. The one
// thing that IS carried forward is `lastMeasuredAt`, the second clock the release gate's rule 4
// reads: three nights without a real measurement is indistinguishable from having no gate.
//
// Usage: node scripts/nightly-merge.mjs   (in the repo root; reads env for the run coordinates)
// Prints the commit subject for the verdict commit on stdout's last line.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PARTS } from "./nightly-verdict.mjs";

/** A part measured only when it produced a verdict about the world, not about its own night. */
const MEASURED_STATUSES = ["pass", "degraded", "catastrophe"];

export function mergeParts({ parts, previous, now, run }) {
	const merged = {};
	for (const name of PARTS) {
		const part = parts[name];
		const carried = previous?.parts?.[name]?.lastMeasuredAt ?? null;
		if (part === undefined) {
			merged[name] = {
				status: "unknown",
				measuredAt: now,
				...(carried === null ? {} : { lastMeasuredAt: carried }),
				detail: { reason: "job did not report" },
			};
			continue;
		}
		const measured = MEASURED_STATUSES.includes(part.status);
		const lastMeasuredAt = measured ? part.measuredAt : carried;
		merged[name] = {
			status: part.status,
			measuredAt: part.measuredAt,
			...(lastMeasuredAt === null || lastMeasuredAt === undefined ? {} : { lastMeasuredAt }),
			detail: part.detail ?? {},
		};
	}
	return { schema: 1, commit: run.commit, runId: run.runId, runUrl: run.runUrl, parts: merged };
}

/** `chore(nightly): ocr pass (median CER 3.9 %) · perf pass (render 210 ms) [skip ci]` */
export function commitSubject(verdict) {
	const pieces = PARTS.map((name) => {
		const part = verdict.parts[name];
		const backends = part.detail?.backends ?? {};
		const medians = Object.values(backends)
			.map((backend) => backend.medianCer)
			.filter((cer) => typeof cer === "number")
			.sort((a, b) => a - b);
		const median = medians.length === 0 ? null : medians[Math.floor((medians.length - 1) / 2)];
		let number = "";
		if (name === "ocr" && median !== null) number = ` (median CER ${(median * 100).toFixed(1)} %)`;
		const renderMs = part.detail?.metrics?.renderPagesToPdfMs;
		if (name === "perf" && typeof renderMs === "number") number = ` (render ${Math.round(renderMs)} ms)`;
		return `${name} ${part.status}${number}`;
	});
	return `chore(nightly): ${pieces.join(" · ")} [skip ci]`;
}

function main() {
	const parts = {};
	for (const name of PARTS) {
		const path = `nightly-parts/${name}.json`;
		if (existsSync(path)) parts[name] = JSON.parse(readFileSync(path, "utf8"));
	}
	const previous = existsSync(".nightly-verdict.json") ? JSON.parse(readFileSync(".nightly-verdict.json", "utf8")) : null;
	const verdict = mergeParts({
		parts,
		previous,
		now: new Date().toISOString(),
		run: {
			commit: process.env.GITHUB_SHA ?? "local",
			runId: process.env.GITHUB_RUN_ID ?? "local",
			runUrl:
				process.env.GITHUB_RUN_ID === undefined
					? "local"
					: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
		},
	});
	writeFileSync(".nightly-verdict.json", `${JSON.stringify(verdict, null, "\t")}\n`);
	console.log(commitSubject(verdict));
}

const invokedDirectly = process.argv[1]?.endsWith("nightly-merge.mjs") ?? false;
if (invokedDirectly) main();
