// Renders the night's OCR part as a Markdown table for the workflow run summary (ticket 14 §6.2):
// backend × page with tonight's CER, the baseline and the delta, plus the structure observations.
// This is where a notification lands somebody, so it is where the detail belongs.
//
// Usage: node scripts/nightly-summary.mjs [>> "$GITHUB_STEP_SUMMARY"]

import { existsSync, readFileSync } from "node:fs";

const pct = (cer) => (typeof cer === "number" ? `${(cer * 100).toFixed(1)} %` : "—");

export function renderSummary(part, baselineEntries) {
	const lines = [`## OCR — ${part.status}`, ""];
	for (const [backendKey, backend] of Object.entries(part.detail?.backends ?? {})) {
		lines.push(`### ${backendKey} — ${backend.status}${backend.reason ? ` (${backend.reason})` : ""}`, "");
		const pages = Object.entries(backend.pages ?? {});
		if (pages.length === 0) continue;
		lines.push("| page | CER | baseline | Δ | structure |", "|---|---|---|---|---|");
		for (const [page, m] of pages.sort(([a], [b]) => a.localeCompare(b))) {
			const baseline = baselineEntries[`${backendKey}/${page}`]?.cer;
			const delta =
				typeof m.cer === "number" && typeof baseline === "number"
					? `${m.cer - baseline >= 0 ? "+" : "−"}${Math.abs((m.cer - baseline) * 100).toFixed(1)} pp`
					: "—";
			const structure = Object.entries(m.structure ?? {})
				.map(([kind, state]) => `${kind}: ${state}`)
				.join(", ");
			lines.push(`| ${page} | ${m.problem ?? pct(m.cer)} | ${pct(baseline)} | ${delta} | ${structure || "—"} |`);
		}
		lines.push(`| **median** | **${pct(backend.medianCer)}** | | | |`, "");
	}
	return lines.join("\n");
}

const invokedDirectly = process.argv[1]?.endsWith("nightly-summary.mjs") ?? false;
if (invokedDirectly) {
	const part = JSON.parse(readFileSync("nightly-parts/ocr.json", "utf8"));
	const baseline = existsSync(".ocr-baseline.json") ? (JSON.parse(readFileSync(".ocr-baseline.json", "utf8")).entries ?? {}) : {};
	console.log(renderSummary(part, baseline));
}
