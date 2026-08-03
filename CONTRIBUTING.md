# Contributing

Thanks for your interest in improving Tagged Sync for reMarkable.

## Setup

```bash
npm install
npm run build        # bundles src/entry.ts to main.js via esbuild
npm test             # vitest suite
npm run lint         # eslint (mirrors the Obsidian store scanner's ruleset)
```

Node version: see `.nvmrc`.

## Before you open a PR

- **Branch workflow**: `main` only takes changes via PR (squash-merged, CI must be green) —
  see `docs/DEVELOPING.md`. Branch names follow `feature/<slug>` / `fix/<slug>`.
- **Tests**: `npm test` must pass. New behavior needs a test next to the module
  (`src/<module>.test.ts`).
- **Lint ratchet**: `node scripts/release-checks.mjs lint` must not report more problems
  than the committed baseline (`.eslint-baseline.json`). If your change legitimately lowers
  the count, re-baseline in the same commit with `--write`.
- **Changelog**: add a line under `## [Unreleased]` in `CHANGELOG.md` in the same commit as
  the change.

## The rmv6 parser is clean-room — please keep it that way

`src/kaitai/` parses the reMarkable v6 format from MIT-licensed specs and references only
(see `src/kaitai/PROVENANCE.md`). **Do not read or reference GPL-licensed reMarkable
parser implementations** when working on it. Edit `rmv6.ksy`, regenerate with
`npm run generate:kaitai` (never edit `rmv6-generated.js` by hand), and update the
hand-written `rmv6-generated.d.ts` to match.

## Releases

Maintainer-driven; see `docs/RELEASING.md`. Release assets are built and attested in CI —
never uploaded by hand.
