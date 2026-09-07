// The published series (ticket 02 of .scratch/ocr-accuracy-page): every night the nightly has
// measured, as one flat CSV, so the accuracy page can cite data instead of a screenshot.
//
// The source is the git history of `.nightly-verdict.json`, not a second file that accumulates.
// `scripts/nightly-verdict.mjs` already notes that being a committed file makes its history the
// drift curve for free; this reads that curve. So the output is a projection and is always
// regenerated whole -- there is nothing here to append to, and nothing that can drift from the
// commits it is derived from.
//
// What is NOT in it: transcript text, in any form. Same rule as the verdict file, same reason.
// Error rates and structure verdicts are measurements; the words on the page are not ours to
// republish, and "the reference pages are public anyway" is exactly the reasoning that has to
// fail closed here.
//
// Usage: node scripts/ocr-series.mjs > ocr-series.csv

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

export const COLUMNS = [
	"measured_at",
	"run_id",
	"backend",
	"page",
	"trait",
	"cer",
	"problem",
	"structure",
	"backend_status",
	"prompt_sha",
	"render_version",
];

/**
 * Page id to trait name, from the reference set's filenames: `13-corrections-de.md` is the
 * corrections page. Taken from the filenames rather than a table here, because a table here is a
 * second place to forget when a page is added.
 */
export function traitsFromFilenames(filenames) {
	const traits = {};
	for (const name of filenames) {
		const match = /^(\d+)-(.+?)(?:-(?:de|en))?\.md$/.exec(name);
		if (match) traits[match[1]] = match[2];
	}
	return traits;
}

/**
 * `verdicts` is [{ verdict, ... }] newest first or oldest first, it does not matter: rows come
 * back sorted by measurement time, and a run measured twice contributes its pages once.
 *
 * A night whose OCR part never produced backends -- `unknown`, the shape commit 7319d9e left --
 * contributes no rows at all. It is not a night of zeros; it is a night with no measurement,
 * and writing zeros for it would be inventing data.
 */
export function toRows(verdicts, traits) {
	const seen = new Set();
	const rows = [];
	for (const verdict of verdicts) {
		const part = verdict?.parts?.ocr;
		const backends = part?.detail?.backends;
		if (!part?.measuredAt || !backends) continue;
		for (const [backend, result] of Object.entries(backends)) {
			for (const [page, measurement] of Object.entries(result.pages ?? {})) {
				const key = `${part.measuredAt}|${backend}|${page}`;
				if (seen.has(key)) continue;
				seen.add(key);
				rows.push({
					measured_at: part.measuredAt,
					run_id: verdict.runId ?? "",
					backend,
					page,
					trait: traits[page] ?? "",
					// The fraction as measured, not a rounded percentage: rounding is the reader's
					// choice, and a page that reads 0.0011 is not a page that reads 0.1 %.
					cer: typeof measurement.cer === "number" ? measurement.cer.toFixed(6) : "",
					problem: measurement.problem ?? "",
					// `kind:state`, joined by ";" so no field ever needs quoting.
					structure: Object.entries(measurement.structure ?? {})
						.map(([kind, state]) => `${kind}:${state}`)
						.join(";"),
					backend_status: result.status ?? "",
					// Both of these change what was measured. A CER jump that lines up with a
					// render version bump is not a model regression, and without these columns
					// nobody reading the series can tell the two apart.
					prompt_sha: part.detail?.promptSha ?? "",
					render_version: part.detail?.renderVersion ?? "",
				});
			}
		}
	}
	rows.sort(
		(a, b) =>
			a.measured_at.localeCompare(b.measured_at) ||
			a.backend.localeCompare(b.backend) ||
			a.page.localeCompare(b.page),
	);
	return rows;
}

export const toCsv = (rows) =>
	[COLUMNS.join(","), ...rows.map((row) => COLUMNS.map((column) => row[column]).join(","))].join("\n");

const invokedDirectly = process.argv[1]?.endsWith("ocr-series.mjs") ?? false;
if (invokedDirectly) {
	const file = ".nightly-verdict.json";
	const shas = execFileSync("git", ["log", "--format=%H", "--", file], { encoding: "utf8" }).split("\n").filter(Boolean);
	const verdicts = [];
	for (const sha of shas) {
		try {
			verdicts.push(JSON.parse(execFileSync("git", ["show", `${sha}:${file}`], { encoding: "utf8" })));
		} catch {
			// A commit that removed the file, or left it unparseable. Not a measurement either way.
		}
	}
	const traits = traitsFromFilenames(readdirSync("test-fixtures/ocr-reference/pages"));
	console.log(toCsv(toRows(verdicts, traits)));
}
