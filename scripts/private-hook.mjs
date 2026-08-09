#!/usr/bin/env node
//
// Layers 2 and 3 of `.scratch/leak-protection/plan.md`: refuse to commit, and refuse to push,
// anything from the private block of .gitignore.
//
//   node scripts/private-hook.mjs pre-commit    # what is staged right now
//   node scripts/private-hook.mjs pre-push      # every path in the history being pushed (refs on stdin)
//
// Both run off the shared list in private-paths.mjs, independent of .gitignore -- so they also cover
// the route the ignore rule never did: someone editing the ignore file, and `git add -f`.
//
// pre-commit alone is not enough, and that is why pre-push exists. The near-miss of 2026-08-08 was
// *history*: 196 private files sat on a branch across 22 commits, every one of which a commit-time
// check would have waved through at push time, because by then nothing new was being staged.
//
// Both yield to `--no-verify`. That is accepted rather than worked around: it turns a silent
// accident into a deliberate act. The copy that cannot be bypassed is scripts/private-gate.mjs,
// which runs in CI on a machine the flag cannot reach.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isPrivate } from "./private-paths.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const lines = (out) => out.split("\n").filter(Boolean);

const mode = process.argv[2];

function refuse(paths) {
	process.stderr.write(`${mode}: private path in the ${mode === "pre-commit" ? "staged changes" : "pushed history"}, refusing:\n`);
	for (const path of paths.slice(0, 20)) process.stderr.write(`  ${path}\n`);
	if (paths.length > 20) process.stderr.write(`  ... and ${paths.length - 20} more\n`);
	if (mode === "pre-push") {
		process.stderr.write("\nDeleting the file in a new commit does not fix this: the blob stays in the\n");
		process.stderr.write("history being pushed. Move the material out of the tree, then rewrite the branch.\n");
	}
	process.exit(1);
}

if (mode === "pre-commit") {
	const staged = lines(git("diff", "--cached", "--name-only", "--diff-filter=ACMR")).filter(isPrivate);
	if (staged.length) refuse(staged);
} else if (mode === "pre-push") {
	// stdin gives one line per ref being pushed: `<local ref> <local sha> <remote ref> <remote sha>`.
	const ZERO = /^0+$/;
	const hits = new Set();
	for (const line of lines(readFileSync(0, "utf8"))) {
		const [, localSha, , remoteSha] = line.split(" ");
		if (ZERO.test(localSha)) continue; // a deletion pushes nothing
		// A branch the remote has never seen reports an all-zero remote sha, and there is no range to
		// take. `--not --remotes=origin` is the honest substitute: everything about to become public,
		// and nothing that already is -- which matters here, because main's own history does contain
		// private paths, from the commits that untracked them.
		const range = ZERO.test(remoteSha) ? [localSha, "--not", "--remotes=origin"] : [`${remoteSha}..${localSha}`];
		for (const path of lines(git("log", "--format=", "--name-only", ...range))) if (isPrivate(path)) hits.add(path);
	}
	if (hits.size) refuse([...hits]);
} else {
	process.stderr.write("usage: private-hook.mjs pre-commit|pre-push\n");
	process.exit(2);
}
