#!/usr/bin/env node
//
// The gates that guard a release. One script so every gate can be run and debugged locally,
// instead of living as inline shell inside a workflow file that only runs on GitHub.
//
//   node scripts/release-checks.mjs version [--tag <tag>]
//   node scripts/release-checks.mjs changelog --ci
//   node scripts/release-checks.mjs changelog --release <version>   # also prints the section
//   node scripts/release-checks.mjs lint [--write]
//   node scripts/release-checks.mjs coverage [--write]      # needs a coverage run first
//   node scripts/release-checks.mjs badges                  # same run, writes the shields files
//   node scripts/release-checks.mjs disabled
//   node scripts/release-checks.mjs nightly
//
// `.mjs`, not `.ts`, on purpose: `npm run build` runs `tsc` over `scripts/` too, so a broken
// `.ts` gate script could block a release.
//
// Every check prints what it compared, not just pass/fail -- when a release stops at 3am the
// numbers matter more than the verdict.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { judgeVerdict, STALE_HOURS } from "./nightly-verdict.mjs";
import { computeBaseline, nightFromVerdict } from "./ocr-baseline.mjs";

// npm's own form for a tree that is not under one licence: `src/` is Apache-2.0, `pro/` is PolyForm
// Strict 1.0.0, and paid commercial use is granted separately. PolyForm Strict has no settled SPDX
// identifier, so there is no expression to write here instead. The gate still earns its place --
// what it now catches is the two files drifting apart, which is how `package-lock.json` sat stale
// for five releases.
const LICENSE = "SEE LICENSE IN LICENSE";
const CHANGELOG = "CHANGELOG.md";
const BASELINE = ".eslint-baseline.json";
// The numbers in the baseline are PLATFORM-DEPENDENT, and this gate runs on Linux. A macOS run
// covers more of the platform-branching files -- local-register, local-model-runtime,
// vision-ocr-runtime -- than ubuntu-latest does, so a baseline written with `--write` on a Mac can
// fail CI on files the commit never touched. That first happened on 2026-08-19, when entry.ts
// entered the measurement and brought those files with it. The floor has to be the platform that
// enforces it: when CI reports a file as less covered and a local run does not, raise that entry by
// the delta CI printed.
const COVERAGE_BASELINE = ".coverage-baseline.json";
const COVERAGE_SUMMARY = "coverage/coverage-summary.json";
const NIGHTLY_VERDICT = ".nightly-verdict.json";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const problems = [];
const fail = (msg) => problems.push(msg);
const ok = (msg) => console.log(`  ok    ${msg}`);

function finish(what) {
	if (problems.length === 0) {
		console.log(`\n${what}: PASS`);
		return;
	}
	console.error(`\n${what}: FAIL`);
	for (const p of problems) console.error(`  FAIL  ${p}`);
	process.exit(1);
}

// --- version gate -----------------------------------------------------------------------------
//
// The reason this pipeline exists. The archived private repo shipped five releases with a lock
// file still saying version 0.1.0 and license MIT, because `npm install` was never re-run after
// the bumps. No human checklist caught it. This one gate would have.
//
// Running it in ci.yml as well as release.yml is a deliberate side effect: it forces the version
// bump and the versions.json entry into one commit, or `main` goes red.

function versionGate(tag) {
	const manifest = readJson("manifest.json");
	const pkg = readJson("package.json");
	const lock = readJson("package-lock.json");
	const versions = readJson("versions.json");
	const v = manifest.version;

	console.log(`version gate: manifest.json says ${v}\n`);

	if (pkg.version === v) ok(`package.json version ${pkg.version}`);
	else fail(`package.json version is ${pkg.version}, manifest.json says ${v}`);

	// Both fields. npm writes the version twice and they can drift independently.
	if (lock.version === v) ok(`package-lock.json .version ${lock.version}`);
	else fail(`package-lock.json .version is ${lock.version}, manifest.json says ${v} -- run \`npm i --package-lock-only\``);

	const lockPkgVersion = lock.packages?.[""]?.version;
	if (lockPkgVersion === v) ok(`package-lock.json .packages[""].version ${lockPkgVersion}`);
	else fail(`package-lock.json .packages[""].version is ${lockPkgVersion}, manifest.json says ${v} -- run \`npm i --package-lock-only\``);

	if (pkg.license === LICENSE) ok(`package.json license ${pkg.license}`);
	else fail(`package.json license is ${pkg.license}, expected ${LICENSE}`);

	const lockLicense = lock.packages?.[""]?.license;
	if (lockLicense === LICENSE) ok(`package-lock.json license ${lockLicense}`);
	else fail(`package-lock.json license is ${lockLicense}, expected ${LICENSE} -- run \`npm i --package-lock-only\``);

	// versions.json maps plugin version -> the minimum Obsidian version it needs. The store reads
	// it to decide what to offer an older app.
	const minApp = versions[v];
	if (minApp === undefined) {
		fail(`versions.json has no key "${v}" -- add "${v}": "${manifest.minAppVersion}"`);
	} else if (minApp !== manifest.minAppVersion) {
		fail(`versions.json["${v}"] is ${minApp}, manifest.json minAppVersion is ${manifest.minAppVersion}`);
	} else {
		ok(`versions.json["${v}"] = ${minApp}, matches manifest minAppVersion`);
	}

	// The frozen legacy state must have been produced by the **previously released** version -- the
	// one before the version being cut here -- because `src/legacy-upgrade.test.ts` runs today's
	// engine over a vault that a shipped release actually wrote.
	//
	// This rule used to demand *this* version, and freezing was step 2b of the release PR. Those two
	// gates cannot both be green: a fresh freeze stamps today's `RENDER_VERSION` into the state, and
	// A8.20 asserts `meta.renderVersion < RENDER_VERSION` -- the staleness that forces `runSync` past
	// its early return. Cutting 1.5.0 hit it head-on: freeze and five tests go red, skip it and this
	// gate goes red. Ticket 13 §4 predicted exactly this ("One caveat").
	//
	// So the freeze moved out of the release PR to the first commit *after* the tag, where the tree is
	// byte-identical to the build that shipped -- which is what "produced by the previous release"
	// was always supposed to mean. See docs/RELEASING.md step 8.
	//
	// It sits here rather than in a job of its own because `ci.yml` and `release.yml` both already run
	// this gate: no new step, no new file to remember, and the failure shows up on the release PR in
	// under a minute -- before a tag is spent.
	const legacyState = readJson("test-fixtures/legacy-state/meta.json");
	// Insertion order is the release order, and `v` is always the last key by the time the gate runs
	// -- the check above fails first if the key for this version is missing altogether.
	const releases = Object.keys(versions);
	const previous = releases[releases.length - 2];
	if (previous === undefined) ok("test-fixtures/legacy-state has no previous release to be produced by");
	else if (legacyState.version === previous) ok(`test-fixtures/legacy-state produced by ${legacyState.version}, the release before ${v}`);
	else
		fail(
			`test-fixtures/legacy-state was produced by ${legacyState.version}, the release before ${v} is ${previous} -- ` +
				"run `npm run freeze-state` on a tree checked out at that tag, or see docs/RELEASING.md step 8",
		);

	// release.yml only. The tag carries no `v` prefix -- the store resolves the tag from the
	// manifest version, so `v1.0.6` would simply not be found.
	if (tag !== undefined) {
		if (tag === v) ok(`git tag ${tag}`);
		else fail(`git tag is ${tag}, manifest.json version is ${v}${tag === `v${v}` ? " -- the tag must have no `v` prefix" : ""}`);
	}

	finish("version gate");
}

// --- changelog gate ---------------------------------------------------------------------------
//
// CHANGELOG.md is the source of truth for release notes; the workflow cuts the matching section
// out and uses it as the release body. Nothing is generated from commit messages.

/** Splits the file into `## [heading]` sections, in file order. */
function parseSections(text) {
	const lines = text.split("\n");
	const sections = [];
	let current = null;
	for (const line of lines) {
		const m = /^##\s+\[([^\]]+)\]/.exec(line);
		if (m) {
			current = { name: m[1], body: [] };
			sections.push(current);
		} else if (current) {
			current.body.push(line);
		}
	}
	return sections.map((s) => ({ name: s.name, body: s.body.join("\n").trim() }));
}

function readChangelog() {
	let text;
	try {
		text = readFileSync(CHANGELOG, "utf8");
	} catch {
		fail(`${CHANGELOG} is missing`);
		finish("changelog gate");
		return null;
	}
	const sections = parseSections(text);
	if (sections.length === 0) fail(`${CHANGELOG} has no "## [...]" sections -- it does not parse as Keep a Changelog`);
	return sections;
}

// ci.yml: the file parses and an `## [Unreleased]` heading exists. NOTHING MORE.
//
// The trap: do not also demand a section for the current version here. Entries live under
// `## [Unreleased]` until tag time, so on `main` no `## [1.0.6]` section exists yet -- a naive
// copy of the release-side check makes `main` permanently red.
function changelogCi() {
	const sections = readChangelog();
	if (!sections) return;
	if (sections.some((s) => s.name === "Unreleased")) ok(`${CHANGELOG} parses, ${sections.length} sections, "## [Unreleased]" present`);
	else fail(`${CHANGELOG} has no "## [Unreleased]" section -- new entries have nowhere to go`);
	finish("changelog gate (ci)");
}

// release.yml: a section matching the tag exists AND `## [Unreleased]` is empty -- an unmoved
// entry means something shipped that the notes do not mention.
function changelogRelease(version) {
	const sections = readChangelog();
	if (!sections) return;

	const unreleased = sections.find((s) => s.name === "Unreleased");
	if (!unreleased) fail(`${CHANGELOG} has no "## [Unreleased]" section`);
	else if (unreleased.body !== "") fail(`"## [Unreleased]" is not empty -- rename it to "## [${version}] - <date>" before tagging:\n${unreleased.body.split("\n").map((l) => `          ${l}`).join("\n")}`);
	else ok(`"## [Unreleased]" is empty`);

	const section = sections.find((s) => s.name === version);
	if (!section) fail(`${CHANGELOG} has no "## [${version}]" section`);
	else if (section.body === "") fail(`"## [${version}]" is empty -- the release body would be blank`);
	else ok(`"## [${version}]" found, ${section.body.split("\n").length} lines`);

	finish("changelog gate (release)");

	// Only reached on pass. The workflow redirects this to a file and hands it to `gh release
	// create --notes-file`.
	if (process.env.CHANGELOG_OUT) writeFileSync(process.env.CHANGELOG_OUT, `${section.body}\n`);
}

// --- lint ratchet -----------------------------------------------------------------------------
//
// Fails when the problem count is HIGHER than the committed baseline. It does not fail on errors.
//
// Why not fail on errors: there are 86 today, so a fail-on-error gate would block the next
// release until the separate src/ cleanup finishes -- while the store reviewer is waiting. And
// "fail on errors only" is not a dial that can be turned down: eslint exits non-zero whenever any
// error exists, and --max-warnings governs warnings only. So the count is read from JSON output
// and eslint's own exit code is deliberately ignored.
//
// Report-only was rejected: a warning nobody reads is not a gate.

function lintRatchet(write) {
	let raw;
	try {
		raw = execFileSync("npx", ["eslint", ".", "-f", "json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	} catch (e) {
		// Expected whenever any error exists. The JSON still arrives on stdout.
		raw = e.stdout;
		if (!raw) {
			console.error("eslint produced no output:\n", e.stderr || e.message);
			process.exit(1);
		}
	}

	const results = JSON.parse(raw);
	let errors = 0;
	let warnings = 0;
	for (const f of results) {
		errors += f.errorCount;
		warnings += f.warningCount;
	}
	const total = errors + warnings;

	if (write) {
		const baseline = readJson(BASELINE);
		baseline.problems = total;
		baseline.measured = new Date().toISOString().slice(0, 10);
		writeFileSync(BASELINE, `${JSON.stringify(baseline, null, "\t")}\n`);
		console.log(`lint ratchet: baseline rewritten to ${total} (${errors} errors, ${warnings} warnings)`);
		return;
	}

	const { problems: baseline } = readJson(BASELINE);
	console.log(`lint ratchet: ${total} problems (${errors} errors, ${warnings} warnings), baseline ${baseline}\n`);

	if (total > baseline) {
		const worst = results
			.filter((f) => f.errorCount + f.warningCount > 0)
			.sort((a, b) => b.errorCount + b.warningCount - (a.errorCount + a.warningCount));
		fail(`${total - baseline} new lint problem(s). Fix them, or re-baseline in the same commit with \`node scripts/release-checks.mjs lint --write\`.`);
		for (const f of worst.slice(0, 10)) {
			console.error(`        ${String(f.errorCount + f.warningCount).padStart(4)}  ${f.filePath.replace(`${process.cwd()}/`, "")}`);
		}
	} else if (total < baseline) {
		ok(`${baseline - total} fewer than the baseline -- lower it in this commit with \`node scripts/release-checks.mjs lint --write\``);
	} else {
		ok("equal to the baseline");
	}

	finish("lint ratchet");
}

// --- coverage ratchet -------------------------------------------------------------------------
//
// Fails when a file's count of UNCOVERED lines or branches is HIGHER than the committed baseline.
// Absolute counts, per file, deliberately -- not percentages, and not one repo-wide number.
//
// Absolute, because a percentage moves when nothing about the tests changed: deleting untested
// code raises it, adding tested code lowers a file's ratio against itself. Counting uncovered
// lines makes all three of the cheap-and-good moves free -- adding tested code, deleting code,
// moving tested code -- and charges only for adding code nothing runs.
//
// Per file, because a repo-wide number lets one file rot while another improves, and the file that
// rots is always the one nobody wanted to test.
//
// No percentage threshold anywhere. A round number invites tests written to reach it, and this
// repo has the measurement that makes that concrete: at 71.2 % line coverage, roughly 41 of 70
// deliberate mutations of production code survived all 996 tests -- including both Pro gates. A
// number that can be true while the product is broken may report; it may not block.
//
// A file missing from the baseline counts as 0 uncovered, so a new file arrives with its tests or
// it arrives red. That is the same rule as "a new feature without its tests is unfinished", said
// mechanically. Re-baselining in the same commit is the escape hatch, and it is visible in review.

function coverageFacts() {
	let summary;
	try {
		summary = readJson(COVERAGE_SUMMARY);
	} catch {
		console.error(`${COVERAGE_SUMMARY} is missing -- run \`npm run test:coverage\` first.`);
		process.exit(1);
	}
	const files = {};
	for (const [abs, m] of Object.entries(summary)) {
		if (abs === "total") continue;
		files[abs.replace(`${process.cwd()}/`, "")] = {
			lines: m.lines.total - m.lines.covered,
			branches: m.branches.total - m.branches.covered,
		};
	}
	return { total: summary.total, files };
}

function coverageRatchet(write) {
	const { total, files } = coverageFacts();
	const pct = (m) => `${m.pct.toFixed(1)} % (${m.total - m.covered} of ${m.total} uncovered)`;

	if (write) {
		const baseline = readJson(COVERAGE_BASELINE);
		baseline.measured = new Date().toISOString().slice(0, 10);
		baseline.files = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
		writeFileSync(COVERAGE_BASELINE, `${JSON.stringify(baseline, null, "\t")}\n`);
		console.log(`coverage ratchet: baseline rewritten over ${Object.keys(files).length} files`);
		console.log(`  lines    ${pct(total.lines)}`);
		console.log(`  branches ${pct(total.branches)}`);
		return;
	}

	const baseline = readJson(COVERAGE_BASELINE);
	console.log(`coverage ratchet: lines ${pct(total.lines)}, branches ${pct(total.branches)}\n`);

	const worse = [];
	let better = 0;
	for (const [file, now] of Object.entries(files)) {
		const was = baseline.files[file] ?? { lines: 0, branches: 0 };
		const dl = now.lines - was.lines;
		const db = now.branches - was.branches;
		if (dl > 0 || db > 0) worse.push({ file, dl, db, now, was, isNew: !(file in baseline.files) });
		else if (dl < 0 || db < 0) better += 1;
	}

	const gone = Object.keys(baseline.files).filter((f) => !(f in files));

	if (worse.length > 0) {
		fail(
			`${worse.length} file(s) got less covered. Test the new code, or re-baseline in the same ` +
				"commit with `npm run test:coverage && node scripts/release-checks.mjs coverage --write`.",
		);
		for (const w of worse) {
			const what = [w.dl > 0 ? `+${w.dl} uncovered lines` : null, w.db > 0 ? `+${w.db} uncovered branches` : null]
				.filter(Boolean)
				.join(", ");
			console.error(`        ${w.file}${w.isNew ? " (new file)" : ""}: ${what}`);
		}
	} else {
		ok(`no file got less covered${better > 0 ? `; ${better} improved` : ""}`);
	}

	if (better > 0 && worse.length === 0) {
		ok(`${better} file(s) improved -- lower the baseline in this commit with \`node scripts/release-checks.mjs coverage --write\``);
	}
	if (gone.length > 0) {
		ok(`${gone.length} baseline file(s) no longer exist; --write drops them`);
	}

	finish("coverage ratchet");
}

// --- coverage badges --------------------------------------------------------------------------
//
// Writes the two shields.io endpoint files from the SAME coverage run the ratchet just read. Two
// badges, not one: this codebase is full of `fetchFn ?? fetch` defaults that add a branch to an
// already-covered line, so lines alone would be the flattering half of the truth.
//
// The colours are cosmetic and are deliberately NOT the numbers of any gate, because no gate has a
// number -- see the ratchet above. The badge reports; it never blocks. Nothing in this repo may
// read it back.

const BADGE_COLOURS = [
	[90, "brightgreen"],
	[80, "green"],
	[70, "yellowgreen"],
	[60, "yellow"],
	[50, "orange"],
];

function coverageBadges() {
	const { total } = coverageFacts();
	let changed = false;

	for (const metric of ["lines", "branches"]) {
		const pct = total[metric].pct;
		const badge = {
			schemaVersion: 1,
			label: metric,
			message: `${pct.toFixed(1)}%`,
			color: BADGE_COLOURS.find(([min]) => pct >= min)?.[1] ?? "red",
		};
		const path = `.coverage-badge-${metric}.json`;
		const next = `${JSON.stringify(badge, null, "\t")}\n`;
		let prev = "";
		try {
			prev = readFileSync(path, "utf8");
		} catch {
			// First run. Falls through to a write, which is what should happen.
		}
		if (prev !== next) {
			writeFileSync(path, next);
			changed = true;
		}
		console.log(`  ${path}: ${badge.message} ${badge.color}${prev === next ? " (unchanged)" : ""}`);
	}

	// Read by the workflow, which commits only when this says something moved -- otherwise every
	// push to `main` would produce a badge commit saying the same number.
	console.log(`badges-changed=${changed}`);
	if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`, { flag: "a" });
}

// --- disabled tests ---------------------------------------------------------------------------
//
// `skip`, `only` and `todo` are banned outright. There is no baseline and no allow-list, because
// there are none today and this is the one gate that can start strict.
//
// A skipped test is a deleted test wearing a disguise: the file still lists it, the count still
// includes the file, and nothing runs. `only` is worse -- it silently deletes every OTHER test in
// the file, so a suite can go green having run four assertions out of 996.
//
// The way out of a failing test is to fix it, delete it, or write it down as a `gap:` row in the
// matrix, where the backlog is tracked in the open.

const DISABLED = [
	/\b(?:describe|it|test|bench|suite)\s*\.\s*(?:skip|only|todo)\b/,
	/\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(/,
];

function disabledTests() {
	// `git ls-files src pro test-stubs` and filter here, rather than passing a glob to git: a
	// pathspec that matches nothing is not an error, so a mistyped glob makes this gate print
	// "no skip, only or todo" over zero files. It did, on the first run.
	const files = execFileSync("git", ["ls-files", "src", "pro", "test-stubs"], { encoding: "utf8" })
		.split("\n")
		.filter((f) => f.endsWith(".test.ts"));

	let found = 0;
	for (const file of files) {
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, i) => {
			if (DISABLED.some((re) => re.test(line))) {
				found += 1;
				console.error(`        ${file}:${i + 1}  ${line.trim()}`);
			}
		});
	}

	console.log(`disabled tests: scanned ${files.length} files\n`);
	if (found > 0) fail(`${found} disabled test(s). Fix it, delete it, or record it as a \`gap:\` row in the matrix.`);
	else ok("no skip, only or todo");

	finish("disabled tests");
}

// --- the nightly verdict ------------------------------------------------------------------------
//
// Reads .nightly-verdict.json and refuses a release that no recent night measured. The rules live
// in nightly-verdict.mjs so they can be unit-tested: every one of them is about what happens when
// the measurement did NOT arrive, and those paths never run on a good day.
//
// NOT wired into release.yml yet, deliberately. No nightly has ever run, so the file does not
// exist, and a gate that blocks every release from the day it lands is the failure this rollout
// is ordered to avoid. It gets wired in the commit where the first real verdict is committed.
//
// It also never runs in ci.yml -- a stale verdict would turn `main` red for a reason no commit
// caused -- and never on a beta, because a beta is very often the fix for whatever made the
// nightly red.

function nightlyGate() {
	let verdict = null;
	try {
		verdict = readJson(NIGHTLY_VERDICT);
	} catch (e) {
		if (e.code !== "ENOENT") {
			console.error(`${NIGHTLY_VERDICT} will not parse: ${e.message}`);
			process.exit(1);
		}
	}

	const { problems: found, notes } = judgeVerdict(verdict, new Date());
	console.log(`nightly verdict: ${NIGHTLY_VERDICT}, ${STALE_HOURS} h window\n`);
	for (const n of notes) ok(n);
	for (const f of found) fail(f);
	finish("nightly verdict");
}

// --- the OCR baseline ---------------------------------------------------------------------------
//
// The rules live in ocr-baseline.mjs (tested there); this reads the recorded nights out of the git
// history of the verdict file -- the history IS the record, no database -- and writes
// .ocr-baseline.json. See that file's header for the change discipline.

const OCR_BASELINE = ".ocr-baseline.json";

/** The verdict file at every commit that touched it on this branch, newest first. */
function recordedNights() {
	const shas = execFileSync("git", ["log", "--format=%H", "--", NIGHTLY_VERDICT], { encoding: "utf8" })
		.split("\n")
		.filter((sha) => sha !== "");
	const nights = [];
	for (const sha of shas) {
		try {
			const night = nightFromVerdict(JSON.parse(execFileSync("git", ["show", `${sha}:${NIGHTLY_VERDICT}`], { encoding: "utf8" })));
			if (night !== null) nights.push(night);
		} catch {
			// An unparseable historical revision is simply not a recorded night.
		}
	}
	return nights;
}

function ocrBaseline(write, accepts, because) {
	let existing = {};
	try {
		existing = readJson(OCR_BASELINE).entries ?? {};
	} catch (e) {
		if (e.code !== "ENOENT") {
			console.error(`${OCR_BASELINE} will not parse: ${e.message}`);
			process.exit(1);
		}
	}

	const nights = recordedNights();
	const { entries, refused, skipped, changed } = computeBaseline({
		nights,
		existing,
		accepts,
		because,
		today: new Date().toISOString().slice(0, 10),
	});

	console.log(`ocr baseline: ${nights.length} recorded night(s) in the history of ${NIGHTLY_VERDICT}\n`);
	for (const line of skipped) console.log(`  wait  ${line}`);
	for (const line of changed) ok(line);
	for (const line of refused) fail(line);
	if (changed.length === 0 && refused.length === 0) console.log("  ok    nothing to change");

	if (write && problems.length === 0 && changed.length > 0) {
		writeFileSync(
			OCR_BASELINE,
			`${JSON.stringify(
				{
					comment:
						"One entry per <backend>/<model>/<page>: the median CER of the last 30 recorded nights. Never edit by hand. Recompute with `node scripts/release-checks.mjs ocr-baseline --write`; a key that falls is absorbed silently, a key that rises is refused unless --accept names it AND the model, the prompt or the render version actually changed -- the only three honest reasons a transcription baseline can get worse.",
					entries,
				},
				null,
				"\t",
			)}\n`,
		);
		console.log(`\nwrote ${OCR_BASELINE}`);
	} else if (!write && changed.length > 0) {
		console.log("\ndry run -- pass --write to apply");
	}
	finish("ocr baseline");
}

// --- dispatch ---------------------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
	const i = rest.indexOf(name);
	return i === -1 ? undefined : (rest[i + 1] ?? "");
};

switch (command) {
	case "version":
		versionGate(flag("--tag"));
		break;
	case "changelog":
		if (rest.includes("--ci")) changelogCi();
		else if (flag("--release")) changelogRelease(flag("--release"));
		else {
			console.error("changelog: pass --ci or --release <version>");
			process.exit(2);
		}
		break;
	case "lint":
		lintRatchet(rest.includes("--write"));
		break;
	case "coverage":
		coverageRatchet(rest.includes("--write"));
		break;
	case "badges":
		coverageBadges();
		break;
	case "disabled":
		disabledTests();
		break;
	case "nightly":
		nightlyGate();
		break;
	case "ocr-baseline":
		ocrBaseline(rest.includes("--write"), flag("--accept") === undefined ? [] : [flag("--accept")], flag("--because") ?? "");
		break;
	default:
		console.error("usage: release-checks.mjs <version|changelog|lint|coverage|badges|disabled|nightly|ocr-baseline> [...]");
		process.exit(2);
}
