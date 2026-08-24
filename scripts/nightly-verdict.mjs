//
// The rules for reading `.nightly-verdict.json` -- separated from the gate that calls them so they
// can be tested, which for this gate matters more than for the others: every rule here is about
// what happens when the measurement did NOT arrive, and those are exactly the paths that never run
// on a good day.
//
// The verdict is a committed file rather than a GitHub run conclusion, because the release gate has
// to read it without touching the three foreign APIs, a maintainer has to be able to run the gate
// locally at 3am, and a run conclusion is a boolean where the numbers are what make a failure
// diagnosable. Being a file, it is also a diff somebody sees, and its git history is the drift
// curve for free.
//
//   {
//     "schema": 1,
//     "commit": "…", "runId": "…", "runUrl": "https://github.com/…/actions/runs/…",
//     "parts": {
//       "contract": { "status": "pass", "measuredAt": "2026-08-19T03:07:11Z", "detail": {} },
//       "ocr":      { "status": "pass", "measuredAt": "2026-08-19T03:09:44Z", "detail": {} }
//     }
//   }
//
// Transcript text never goes in this file. Not "unless the page is public" -- absolutely, because
// "these pages are public so it is fine" is the reasoning that has to fail closed in this repo. The
// transcripts of a failing page belong in the run's artifact, where whoever is debugging a CER jump
// is already looking.

export const STALE_HOURS = 72;

export const PARTS = ["contract", "ocr", "perf"];
const TOP_KEYS = ["schema", "commit", "runId", "runUrl", "parts"];
const PART_KEYS = ["status", "measuredAt", "lastMeasuredAt", "detail"];
const STATUSES = ["pass", "degraded", "unknown", "catastrophe"];

const hoursBetween = (later, earlier) => (later.getTime() - earlier.getTime()) / 3_600_000;

function parseTime(value) {
	if (typeof value !== "string") return null;
	const t = new Date(value);
	return Number.isNaN(t.getTime()) ? null : t;
}

// Returns { problems, notes }. Empty problems means the release may proceed.
//
// The default is FAIL, and nothing in these rules can be satisfied by an absent file: "pass" has to
// have been written by a run that actually measured something.
export function judgeVerdict(verdict, now) {
	const problems = [];
	const notes = [];

	if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) {
		problems.push(".nightly-verdict.json is missing or is not an object -- run the nightly, or `gh workflow run nightly.yml`");
		return { problems, notes };
	}

	if (verdict.schema !== 1) {
		problems.push(`schema is ${JSON.stringify(verdict.schema)}, expected 1 -- this gate does not know how to read that file`);
		return { problems, notes };
	}

	// Strict about unknown keys, because the failure that actually happens here is a half-edited or
	// badly merged file, and a lenient parser would read one of those as a pass.
	for (const key of Object.keys(verdict)) {
		if (!TOP_KEYS.includes(key)) problems.push(`unknown key \`${key}\` -- a hand-edited or badly merged verdict is not a verdict`);
	}

	const parts = verdict.parts;
	if (parts === null || typeof parts !== "object" || Array.isArray(parts)) {
		problems.push("`parts` is missing");
		return { problems, notes };
	}
	for (const name of Object.keys(parts)) {
		if (!PARTS.includes(name)) problems.push(`unknown part \`${name}\``);
	}

	for (const name of PARTS) {
		const part = parts[name];
		if (part === null || typeof part !== "object" || Array.isArray(part)) {
			problems.push(`part \`${name}\` is missing -- a verdict that measured only half of the night is not a verdict`);
			continue;
		}
		for (const key of Object.keys(part)) {
			if (!PART_KEYS.includes(key)) problems.push(`unknown key \`${key}\` in part \`${name}\``);
		}

		if (!STATUSES.includes(part.status)) {
			problems.push(`part \`${name}\` has status ${JSON.stringify(part.status)}, expected one of ${STATUSES.join(", ")}`);
			continue;
		}

		const measuredAt = parseTime(part.measuredAt);
		if (measuredAt === null) {
			problems.push(`part \`${name}\` has no readable \`measuredAt\` -- without it there is no way to tell a fresh verdict from a stale one`);
			continue;
		}

		const age = hoursBetween(now, measuredAt);
		if (age > STALE_HOURS) {
			problems.push(
				`part \`${name}\` was measured ${age.toFixed(0)} h ago, older than ${STALE_HOURS} h -- one missed night is an incident, three is a broken schedule. Re-run: gh workflow run nightly.yml`,
			);
			continue;
		}

		if (part.status === "catastrophe") {
			problems.push(`part \`${name}\` is a catastrophe -- the shipped code is already broken against what it was measured against`);
			continue;
		}

		// `unknown` is a quota, a 429, a 503 or an expired key -- not evidence that the plugin is
		// broken, so it does not block on the night it happens. It blocks only through the second
		// clock: three nights with no real measurement is indistinguishable from having no gate.
		if (part.status === "unknown") {
			const lastMeasuredAt = parseTime(part.lastMeasuredAt);
			if (lastMeasuredAt === null) {
				problems.push(`part \`${name}\` is unknown and has never produced a real measurement`);
				continue;
			}
			const lastAge = hoursBetween(now, lastMeasuredAt);
			if (lastAge > STALE_HOURS) {
				problems.push(
					`part \`${name}\` has been unknown since ${part.lastMeasuredAt} (${lastAge.toFixed(0)} h) -- that is now indistinguishable from having no gate`,
				);
				continue;
			}
			notes.push(`${name}: unknown, but really measured ${lastAge.toFixed(0)} h ago`);
			continue;
		}

		notes.push(`${name}: ${part.status}, measured ${age.toFixed(0)} h ago`);
	}

	return { problems, notes };
}
