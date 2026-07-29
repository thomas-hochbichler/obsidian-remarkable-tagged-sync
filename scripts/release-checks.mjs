#!/usr/bin/env node
//
// The gates that guard a release. One script so every gate can be run and debugged locally,
// instead of living as inline shell inside a workflow file that only runs on GitHub.
//
//   node scripts/release-checks.mjs version [--tag <tag>]
//   node scripts/release-checks.mjs changelog --ci
//   node scripts/release-checks.mjs changelog --release <version>   # also prints the section
//   node scripts/release-checks.mjs lint [--write]
//
// `.mjs`, not `.ts`, on purpose: `npm run build` runs `tsc` over `scripts/` too, so a broken
// `.ts` gate script could block a release.
//
// Every check prints what it compared, not just pass/fail -- when a release stops at 3am the
// numbers matter more than the verdict.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const LICENSE = "Apache-2.0";
const CHANGELOG = "CHANGELOG.md";
const BASELINE = ".eslint-baseline.json";

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
	default:
		console.error("usage: release-checks.mjs <version|changelog|lint> [...]");
		process.exit(2);
}
