// The OCR baseline and its change discipline (ticket 14 §5) -- the mechanism the whole quality
// gate stands on, because a threshold relative to a number the author can edit is not a threshold.
//
//   node scripts/release-checks.mjs ocr-baseline                  # dry run: what --write would do
//   node scripts/release-checks.mjs ocr-baseline --write
//   node scripts/release-checks.mjs ocr-baseline --write --accept <key> --because "<why>"
//
// Every key is recomputed as the median of the last 30 recorded nights (the git history of
// .nightly-verdict.json is the record). A key that falls is written silently -- improvement is
// absorbed, same direction as the lint and coverage ratchets. A key that rises is refused unless
// the run names it with --accept AND at least one of `model`, `promptSha`, `renderVersion` changed
// against the entry being replaced: the only three honest reasons a transcription baseline can get
// worse are the model changed, the prompt changed, or the image we send changed. A provider
// silently swapping the model behind an alias changes none of them, and stays refused -- pinning a
// dated id (which changes `model`) is the honest way out, and it shows up in a diff.

/** The last-30-nights window, and the first-baseline requirement of five real measurements. */
export const WINDOW_NIGHTS = 30;
export const MIN_NIGHTS = 5;

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)];
};

/**
 * One night's OCR measurements, extracted from a committed verdict -- or null when that night
 * produced no numbers at all.
 *
 * **The numbers decide, not the part's status.** That status is the worst of every backend
 * (`mergeBackendStatuses`), which was a sound gate while three backends ran and became a trap at
 * eight: one rate-limited page on one model turns the whole part `unknown`, and rejecting the part
 * threw away the seven backends that had measured cleanly. Both nights after the set grew to eight
 * were discarded that way, and the five new backends sat at zero recorded nights while their
 * figures were already in the file.
 *
 * Nothing is softened by reading them. Every backend without a numeric CER is dropped below, the
 * baseline is keyed per backend *and* per page, and a 429 on page 10 therefore means exactly what
 * it is -- one sample fewer for page 10, on that one model.
 */
export function nightFromVerdict(verdict) {
	const part = verdict?.parts?.ocr;
	if (!part) return null;
	const detail = part.detail ?? {};
	const backends = {};
	for (const [key, backend] of Object.entries(detail.backends ?? {})) {
		const pages = {};
		for (const [page, m] of Object.entries(backend.pages ?? {})) {
			if (typeof m.cer === "number") pages[page] = m.cer;
		}
		if (Object.keys(pages).length > 0) backends[key] = { model: backend.model, pages };
	}
	if (Object.keys(backends).length === 0) return null;
	return { measuredAt: part.measuredAt, promptSha: detail.promptSha, renderVersion: detail.renderVersion, backends };
}

/**
 * Recomputes every `<backendKey>/<page>` entry from the recorded nights (newest first) against the
 * existing baseline. Pure: returns what would be written, what was refused, and why.
 */
export function computeBaseline({ nights, existing, accepts = [], because = "", today }) {
	const refused = [];
	const skipped = [];
	const changed = [];
	const entries = { ...existing };

	// Series per full key, newest night first, capped at the window.
	const series = new Map();
	const provenance = new Map();
	for (const night of nights.slice(0, WINDOW_NIGHTS)) {
		for (const [backendKey, backend] of Object.entries(night.backends)) {
			for (const [page, cer] of Object.entries(backend.pages)) {
				const key = `${backendKey}/${page}`;
				if (!series.has(key)) series.set(key, []);
				series.get(key).push(cer);
				// The newest night that names the three discipline fields wins.
				if (!provenance.has(key) && night.promptSha !== undefined) {
					provenance.set(key, { model: backend.model, promptSha: night.promptSha, renderVersion: night.renderVersion });
				}
			}
		}
	}

	for (const [key, values] of [...series.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		if (values.length < MIN_NIGHTS) {
			skipped.push(`${key}: needs ${MIN_NIGHTS} recorded nights, has ${values.length}`);
			continue;
		}
		const candidate = {
			cer: median(values),
			spread: Math.max(...values) - Math.min(...values),
			setAt: today,
			nights: values.length,
			...provenance.get(key),
		};
		const current = existing[key];

		if (current === undefined) {
			entries[key] = { ...candidate, because: "first baseline" };
			changed.push(`${key}: first baseline ${(candidate.cer * 100).toFixed(1)} % over ${candidate.nights} nights`);
			continue;
		}
		if (candidate.cer <= current.cer) {
			if (candidate.cer < current.cer) changed.push(`${key}: lowered ${(current.cer * 100).toFixed(1)} % -> ${(candidate.cer * 100).toFixed(1)} %`);
			entries[key] = { ...candidate, because: current.because };
			continue;
		}

		// The raise path. Refused by default; --accept opens it only when something that explains
		// the raise actually changed.
		if (!accepts.includes(key)) {
			refused.push(`${key}: would rise ${(current.cer * 100).toFixed(1)} % -> ${(candidate.cer * 100).toFixed(1)} % -- a raise needs --accept ${key} --because "..."`);
			continue;
		}
		const fields = ["model", "promptSha", "renderVersion"];
		const differs = fields.some((field) => candidate[field] !== undefined && candidate[field] !== current[field]);
		if (!differs) {
			refused.push(
				`${key}: --accept refused -- model, promptSha and renderVersion are all unchanged, so nothing explains the raise. A regression cannot be made to go away by editing the number`,
			);
			continue;
		}
		if (because.trim() === "") {
			refused.push(`${key}: --accept needs --because "<why>"`);
			continue;
		}
		entries[key] = { ...candidate, because };
		changed.push(`${key}: raised ${(current.cer * 100).toFixed(1)} % -> ${(candidate.cer * 100).toFixed(1)} % (${because})`);
	}

	return { entries, refused, skipped, changed };
}
