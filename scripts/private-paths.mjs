//
// The private block of .gitignore, as one list.
//
// Kept in code rather than parsed from that file on purpose: the checks built on it must survive
// someone editing the ignore rules, which is the one route the ignore-only design never covered.
//
// One copy, shared by the CI gate (private-gate.mjs) and the local hooks (private-hook.mjs). A
// second copy would drift, and a partial list is worse than none -- it reads as coverage.
//
// All nine entries, matched case-insensitively: git's ignore rules are, on a macOS checkout, and the
// file on disk is `CLAUDE.md` where the rule says `Claude.md`. A case-sensitive test would let that
// one through while reporting ok.
export const PRIVATE = [
	/^\.scratch\//i,
	/^\.scratch-inspect\//i,
	/^\.claude\//i,
	/^docs\/agents\//i,
	/^Claude\.md$/i,
	/^PRD\.md$/i,
	/^skills-lock\.json$/i,
	/^tools\//i,
];

export const isPrivate = (path) => PRIVATE.some((re) => re.test(path));
