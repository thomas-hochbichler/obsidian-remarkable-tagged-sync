// The drift curve, read straight out of git (ticket 14 §6): the history of .nightly-verdict.json
// IS the time series, so this needs no database and no service -- `npm run ocr:curve` answers the
// question a curve actually gets asked: *when did this start?*
//
// Prints one table per backend: per page, tonight's CER and the deltas against 7, 30 and 90 days
// ago (the newest recorded night at or before that horizon). Local, offline, no dependency.

import { execFileSync } from "node:child_process";
import { nightFromVerdict } from "./ocr-baseline.mjs";

const VERDICT = ".nightly-verdict.json";
const HORIZONS = [7, 30, 90];

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

/** Recorded nights, newest first, each with its commit time. */
function nights() {
	const rows = git("log", "--format=%H %cI", "--", VERDICT)
		.split("\n")
		.filter((line) => line !== "");
	const out = [];
	for (const row of rows) {
		const [sha, committedAt] = row.split(" ");
		try {
			const night = nightFromVerdict(JSON.parse(git("show", `${sha}:${VERDICT}`)));
			if (night !== null) out.push({ committedAt: new Date(committedAt), night });
		} catch {
			// Not a recorded night.
		}
	}
	return out;
}

const pct = (cer) => `${(cer * 100).toFixed(1)}%`;
const delta = (now, then) => (then === undefined ? "     —" : `${now - then >= 0 ? "+" : "−"}${Math.abs((now - then) * 100).toFixed(1)}pp`.padStart(6));

function main() {
	const recorded = nights();
	if (recorded.length === 0) {
		console.log(`no recorded nights in the history of ${VERDICT}`);
		return;
	}
	const [newest, ...history] = recorded;
	console.log(`ocr drift curve -- ${recorded.length} recorded night(s), newest ${newest.committedAt.toISOString().slice(0, 10)}\n`);

	for (const [backendKey, backend] of Object.entries(newest.night.backends)) {
		console.log(backendKey);
		console.log(`  page   tonight   ${HORIZONS.map((d) => `Δ${d}d`.padStart(6)).join("   ")}`);
		for (const [page, cer] of Object.entries(backend.pages).sort(([a], [b]) => a.localeCompare(b))) {
			const at = HORIZONS.map((days) => {
				const cutoff = new Date(newest.committedAt.getTime() - days * 86_400_000);
				const then = history.find((entry) => entry.committedAt <= cutoff);
				return then?.night.backends[backendKey]?.pages[page];
			});
			console.log(`  ${page}     ${pct(cer).padStart(6)}   ${at.map((then) => delta(cer, then)).join("   ")}`);
		}
		console.log("");
	}
}

main();
