#!/usr/bin/env node
//
// Refuses to publish anything from the private block of .gitignore. This is the layer that holds
// when the others do not: `.gitignore` yields to `git add -f`, and a local hook yields to
// `--no-verify`, but `verify` is a required status check and `main` requires a PR, so nothing
// reaches the public branch without passing here.
//
//   node scripts/private-gate.mjs          # range from BASE / BEFORE, as gate 1 does
//
// It exists because the ignore rule alone did not hold: 196 files under `.scratch/` were tracked
// on a branch on 2026-08-08, force-added past the rule, some of them transcripts of real
// handwritten notes. Nothing reached `origin`, and that was luck rather than a control.
//
// Three questions, cheapest first:
//
// 1. PATHS AT HEAD -- does any TRACKED file sit in the private block? Catches whatever is present
//    now, however it got there, including a force-add made months ago.
//
// 2. PATHS IN THE RANGE -- does any commit being merged TOUCH the block? Catches add-then-remove
//    inside one PR, which question 1 cannot see.
//
// 3. CONTENT -- do the tracked files match a private pattern? Paths only catch what someone
//    thought to list; a transcript pasted into a CHANGELOG entry passes both path checks.
//
//    The patterns are the very strings being protected -- an employer name, a ticket prefix, a
//    colleague's name -- so committing them here would publish exactly what they guard. They live
//    in the `PRIVATE_CONTENT_PATTERNS` repository secret (newline-separated regexes) and, for
//    local runs, in an untracked `.private-patterns`. With neither present this check is SKIPPED,
//    and says so loudly: the path gates still run, so it degrades, it does not fail open in
//    silence.
//
//    A match prints the file and line NUMBER and never the matched text. CI logs of a public repo
//    are public; a gate that quoted the secret it just found would leak it to catch it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Mirrors the private block of .gitignore. Kept here rather than parsed from that file on purpose:
// the gate must survive someone editing the ignore rules, which is the one route the ignore-only
// design never covered.
// All nine entries, verified untracked on origin/main at the time this was written -- a partial
// mirror would be worse than none, because it reads as coverage.
const PRIVATE = [
	/^pro\//,
	/^\.scratch\//,
	/^\.scratch-inspect\//,
	/^\.claude\//,
	/^docs\/agents\//,
	/^Claude\.md$/,
	/^PRD\.md$/,
	/^skills-lock\.json$/,
	/^tools\//,
];

// A range this long is a first push or a rewritten branch, where grepping every revision costs
// minutes. The path checks still cover it; only the content sweep narrows to HEAD, and says so.
const MAX_REVS = 200;

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const lines = (out) => out.split("\n").filter(Boolean);
const isPrivate = (path) => PRIVATE.some((re) => re.test(path));

let failed = false;

function fail(message) {
	console.log(`::error::${message}`);
	failed = true;
}

// --- the range ---------------------------------------------------------------------------------
//
// Same shape as ci.yml's git-identity gate: a PR knows its base, a push knows what it replaced,
// and the first push of a branch knows neither -- there the tip is all that can be checked.
function resolveRange() {
	const base = process.env.BASE?.trim();
	const before = process.env.BEFORE?.trim();
	const zero = "0000000000000000000000000000000000000000";
	if (base) return `${base}..HEAD`;
	if (before && before !== zero) {
		try {
			git("cat-file", "-e", `${before}^{commit}`);
			return `${before}..HEAD`;
		} catch {
			// Old tip is gone (force-push). Fall through to the tip-only case.
		}
	}
	return null;
}

// --- 1. tracked paths at HEAD ------------------------------------------------------------------

const tracked = lines(git("ls-files")).filter(isPrivate);
if (tracked.length) {
	fail(`${tracked.length} tracked file(s) sit in the private block of .gitignore`);
	for (const path of tracked.slice(0, 20)) console.log(`  tracked  ${path}`);
	if (tracked.length > 20) console.log(`  ... and ${tracked.length - 20} more`);
} else {
	console.log("paths at HEAD          ok  (no tracked file in the private block)");
}

// --- 2. paths touched anywhere in the range -----------------------------------------------------

const range = resolveRange();
if (range) {
	const touched = [...new Set(lines(git("log", "--format=", "--name-only", range)))].filter(isPrivate);
	if (touched.length) {
		fail(`${touched.length} private path(s) are touched by commits in ${range}`);
		for (const path of touched.slice(0, 20)) console.log(`  touched  ${path}`);
	} else {
		console.log(`paths in ${range}  ok  (no commit touches the private block)`);
	}
} else {
	console.log("paths in range         skipped  (first push or rewritten branch -- HEAD checked above)");
}

// --- 3. content ---------------------------------------------------------------------------------

const patterns = (process.env.PRIVATE_CONTENT_PATTERNS ?? (existsSync(".private-patterns") ? readFileSync(".private-patterns", "utf8") : ""))
	.split("\n")
	.map((line) => line.trim())
	.filter((line) => line && !line.startsWith("#"));

if (!patterns.length) {
	console.log("content                SKIPPED  (no PRIVATE_CONTENT_PATTERNS secret, no .private-patterns)");
} else {
	// `git grep -l` over the revisions in the range: a blob that appeared and vanished inside one
	// PR still gets read. -l, never -n with context: the file is the finding, the text is the leak.
	let revs = range ? lines(git("rev-list", range)) : [];
	if (revs.length > MAX_REVS) {
		console.log(`content                narrowed to HEAD  (${revs.length} revisions in range, over the ${MAX_REVS} cap)`);
		revs = [];
	}
	const scope = revs.length ? revs : ["HEAD"];
	const hits = new Set();
	for (const pattern of patterns) {
		try {
			for (const hit of lines(git("grep", "-l", "-I", "-E", pattern, ...scope, "--", "."))) hits.add(hit);
		} catch (error) {
			// git grep exits 1 with no output when nothing matches. Anything else is a real failure.
			if (error.status !== 1) throw error;
		}
	}
	if (hits.size) {
		fail(`${hits.size} file(s) match a private content pattern -- the match itself is not printed`);
		for (const hit of [...hits].slice(0, 20)) console.log(`  match    ${hit}`);
	} else {
		console.log(`content                ok  (${patterns.length} pattern(s), ${scope.length} revision(s))`);
	}
}

if (failed) {
	console.log("");
	console.log("Nothing here is fixed by deleting the file in a new commit: the blob stays in the");
	console.log("pushed history. Move the material out of the working tree, then rewrite the branch.");
	process.exit(1);
}
