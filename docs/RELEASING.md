# Releasing

How a release of this plugin is cut. Two GitHub Actions workflows do the work; a human bumps
numbers, writes notes, merges the bump through a pull request, and pushes a tag.

**Nobody uploads a release asset by hand.** `main.js`, `manifest.json` and `styles.css` are built
in CI, in a fresh checkout, and published from there. That is the rule the pipeline exists to
enforce.

## The eight steps

| # | Step | Command / file |
|---|---|---|
| 1 | Branch off `main` | `git switch -c release/1.0.6` |
| 2 | Bump **four** files to the new version | `manifest.json`, `package.json`, `package-lock.json`, `versions.json` |
| 3 | Rename the changelog heading | `## [Unreleased]` → `## [1.0.6] - 2026-08-01` |
| 4 | Commit and push the branch | `git commit -am "Release 1.0.6" && git push -u origin release/1.0.6` |
| 5 | Open the PR, wait for green, squash-merge | `gh pr create --title "Release 1.0.6"`, then `gh pr merge --squash --delete-branch` |
| 6 | Pre-check, then tag the **merged** commit on `main` and push the tag | `git switch main && git pull --ff-only && node scripts/release-checks.mjs tag 1.0.6 && git tag 1.0.6 && git push origin 1.0.6` |
| 7 | Wait for the release workflow | it builds, attests, publishes and uploads |
| 8 | **After** the tag: `npm run freeze-state`, in a PR of its own | rewrites `test-fixtures/legacy-state/` in place |

Details that matter:

- **`main` takes no direct push.** A repository rule requires a pull request and the `verify`
  check, so the release commit goes the same way every other change does. `git push origin main`
  is rejected with `GH013`.
- **The tag belongs on the squashed commit.** Squash-merging rewrites the commit, so tag only
  after step 5 and after pulling `main` — a tag on the pre-merge commit points at something that
  is not on `main`.
- **The pre-check is step 6, not optional.** `release-checks.mjs tag` runs the version, changelog
  and nightly gates on the tree the tag will carry, and refuses two commits no workflow can
  report on: one whose message carries a skip marker (the nightly's verdict commit — GitHub then
  starts *no* workflow for the tag push, silently) and one that is not `origin/main` (for a 1.10.x
  version: `origin/release/1.10.x`, see *Maintenance releases*). If the nightly landed after your
  release commit, merge one ordinary commit and tag that. 1.10.0 spent three tags on these before
  the check existed.

- **Bump `package-lock.json` by running `npm install`** (or `npm i --package-lock-only`) after
  editing `package.json` — never by hand-editing it. Two version fields and the license must all
  move. This file is on the list because it sat stale for five releases and no human checklist
  caught it.
- **`versions.json`** needs a new key `"1.0.6": "<minAppVersion>"`, and the value must equal
  `manifest.json`'s `minAppVersion`.
- **`npm run freeze-state` belongs *after* the tag, not in the release PR** — step 8, and the reason
  is worth knowing before anyone moves it back. It rewrites the reference vault in
  `test-fixtures/legacy-state/` with what the current build leaves behind after a first sync, and
  `src/legacy-upgrade.test.ts` runs today's engine over it — the only way to test an upgrade against
  a vault nobody invented. Only right after the tag is the tree byte-identical to what shipped, which
  is what "produced by a release" has to mean for that test to be worth anything.
  It overwrites in place, so retiring the previous state is not a step: git holds it in history,
  where a frozen artefact belongs. The version gate fails the *next* release if this is skipped, and
  names the version it expected.
- **The script refuses to freeze from an untagged tree**, because nothing downstream could tell:
  `git tag --points-at HEAD` must list `manifest.json`'s version. Reproducing a shipped build from a
  tree the tag no longer points at is the one case for `npm run freeze-state -- --anyway`, which says
  so on the way past.
- **The tag has no `v` prefix.** `1.0.6`, never `v1.0.6`. The store resolves the tag from the
  manifest version, so a `v`-prefixed tag is simply not found.
- **Step 5 is not optional.** The version gate runs in CI too, so a wrong number fails on the PR
  in seconds — before you spend a tag on it.
- **The eight steps end at this repository.** The website dates itself to a version and answers
  questions about it, so a release leaves work over there too — see *After the release* below.

## What the pipeline does for you

Both workflows run the same gates, cheapest first. Publishing is last, so nothing can publish
after a failure.

| # | Gate | CI | Release |
|---|---|---|---|
| 1 | checkout, Node from `.nvmrc`, `npm ci --ignore-scripts` | ✅ | ✅ |
| 1b | dependency audit — see *Dependencies and security* in `docs/DEVELOPING.md` | ✅ runtime deps, high+ | ✅ **whole tree, moderate+** |
| 2 | git author email | ✅ | — |
| 3 | version consistency across the four files, and the frozen state | ✅ | ✅ **plus tag == version** |
| 4 | changelog | ✅ weaker — see below | ✅ hard |
| 4b | nightly verdict (`.nightly-verdict.json`, 72 h window) | ✅ release commit only | ✅ |
| 5 | lint ratchet | ✅ | ✅ |
| 6 | `tsc -noEmit` + 1805 tests | ✅ | ✅ |
| 7 | build | ✅ | ✅ |
| 8 | bundle scan | ✅ | ✅ |
| 9 | attest `main.js`, `manifest.json`, `styles.css` | — | ✅ |
| 10 | `gh release create` + upload | — | ✅ |

You can run any gate locally:

```bash
npm audit --audit-level=moderate                 # the release gate; must be clean before you tag
node scripts/release-checks.mjs version          # add --tag 1.0.6 to also check the tag
node scripts/release-checks.mjs changelog --ci   # or --release 1.0.6
node scripts/release-checks.mjs lint
node scripts/release-checks.mjs nightly          # the verdict gate; `tag 1.0.6` runs it with the rest
node scripts/check-bundle.mjs                    # after npm run build
```

### The local-model transcription gate

**Not in CI, and deliberately manual: it downloads 5.5 GB and takes half an hour.** Run it when the
pinned model or `llama.cpp` revision in `src/local-model-artefacts.ts` changes — that is the only
thing that can move the numbers.

```bash
npx esbuild scripts/release-gate.ts --bundle --platform=node --format=cjs \
  --external:iconv-lite --alias:obsidian=./tests/stubs/obsidian.ts --outfile=/tmp/gate.cjs
node /tmp/gate.cjs /tmp/gate-out
npx esbuild .scratch/managed-local-llm-ocr/prototype/mdbench.ts --bundle --platform=node \
  --format=cjs --external:iconv-lite --outfile=/tmp/mdbench.cjs
node /tmp/mdbench.cjs .scratch/vision-ocr-quality/corpus --backend=dir --from=/tmp/gate-out
```

It fetches the model through the shipped downloader and transcribes the ten ground-truth pages
through `createLocalOcrBackend`, so the shipped raster, prompt, flags and post-processing are all
inside what is measured. **Expect 7.6 % CER and 78.9 % word recall on the eight linear pages**; the
corpus has a ±0.8 noise band, and anything outside it is a defect in the shipped path rather than a
new measurement. Background and the last result: `.scratch/managed-local-llm-ocr/spec.md` §15.

### The bundle scan

Runs against the built `main.js`, not the source. It looks for two things the Obsidian store
rejects — dynamically created `<script>` elements and `new Function` — and for strings that must
never appear in a public build. Release 1.0.5 was rejected for exactly the first kind, and the
offending code was inside a bundled dependency where no lint of our own source could have seen it.

If it ever fails on an obfuscation pattern, a dependency has reintroduced a polyfill. Look at the
`alias` block in `esbuild.config.mjs` first.

### The lint ratchet

`npm run lint` reproduces the checker the Obsidian store runs. The gate fails when the problem
count rises **above** the number in `.eslint-baseline.json` — it does not fail on errors, because
there are 86 known ones and fixing them is a separate piece of work.

So: you may not add new problems. When you fix some, lower the baseline in the same commit:

```bash
node scripts/release-checks.mjs lint --write
```

The same applies after regenerating `src/kaitai/rmv6-generated.js`, which is linted, not ignored.

⚠️ A green local lint does **not** guarantee a green store review. The store's scanner ignores
this repo's ESLint config and its rule set is not published.

## Maintenance releases (1.10.x)

**Why the line exists.** 1.11.0 raises `minAppVersion` to 1.13.4. An Obsidian below that silently
stays on the newest 1.10.x: the store tells it nothing, so a bug there can only be fixed from a
1.10.x release. The line lives on the branch `release/1.10.x`, cut from tag `1.10.0`, and stays for
six months after 1.11.0 ships; then it is decided again. It starts at 1.10.1: 1.10.0 itself is
`main`'s release, and "1.10.x" below always means a version after it.

**Which fixes qualify.** On demand, per bug: reported by a user below 1.13.4, or severe (data loss,
security, wrong rendering). Not every fix.

**Cutting the branch, once.** A tree at tag `1.10.0` has none of these gates, and the tag's tree is
what `release.yml` runs, so the pipeline comes first:
`git switch -c release/1.10.x 1.10.0`, then cherry-pick `82698ed` (#263, the tag pre-check) and the
pull request that added this section, in that order, and push.

**How the store finds it.** Obsidian (read in 1.15.0's `app.js`) reads `manifest.json` from the
default branch and offers that version whenever its `minAppVersion` fits the app. Only when it does
not fit does it read `versions.json`, where it takes the highest key that fits; key order does not
matter. So **a release on the branch is invisible until `main` says so**, and what `main` has to say
depends on whether 1.11.0 is there yet:

| `main`'s manifest | What the store offers | `main` needs |
|---|---|---|
| still 1.10.x (before 1.11.0) | every Obsidian the manifest's version; `versions.json` is never read | all four version files at 1.10.N |
| 1.11.0 or later | an Obsidian below 1.13.4 the highest fitting `versions.json` key | only the key `"1.10.N": "1.5.7"` |

The steps:

| # | Step | Command / file |
|---|---|---|
| 1 | The fix lands on `main` first, changelog line under `## [Unreleased]`. Directly on the branch only when the code no longer exists on `main` | the usual pull request |
| 2 | Cherry-pick it onto the branch | `git switch release/1.10.x && git pull --ff-only && git cherry-pick <sha>` |
| 3 | Bump the four files to 1.10.N (`"1.10.N": "1.5.7"`, the floor stays), rename the changelog heading, commit | as in the eight steps; no pull request, the branch has no ruleset |
| 4 | Push and wait for the branch's CI to go green | `git push && gh run watch` |
| 5 | Audit, pre-check, tag, push the tag | `npm audit --audit-level=moderate && node scripts/release-checks.mjs tag 1.10.N && git tag 1.10.N && git push origin 1.10.N` |
| 6 | Wait for the release workflow | the same `release.yml` |
| 7 | **After** the release exists: a pull request on `main` | the table above, plus `CHANGELOG.md` |

Details that matter:

- **Step 7 comes last.** The store downloads from `releases/download/<version>/`, so `main` naming a
  version with no release yet breaks installing and updating for everyone it is offered to.
- **Skip `npm run freeze-state`.** `main`'s fixture is frozen from `main`'s releases, and the version
  gate leaves 1.10.x keys out of the last two it accepts; a state frozen at 1.10.N would be refused.
  The branch keeps the state its tag carried.
- **The branch needs the pipeline.** `release.yml` and `release-checks.mjs` run from the tag's tree,
  so a change to them on `main` has to be cherry-picked too before it can apply to a 1.10.x tag. The
  same goes for a dependency fix: the audit reads the tag's lockfile, and an advisory published after
  the branch's last pick fails the tag even when `main` is clean.
- **The nightly verdict is `main`'s.** The nightly commits to `main` only and its secrets are limited
  to `main`, so the file on the branch is always stale; a 1.10.x version reads `origin/main`'s, by the
  same rules, and still fails by default. It says the outside world is fine. It says nothing about
  the branch's own speed or Vision result, which is one more reason for main first: the fix has been
  through a night there if it has waited for one. A catastrophe on `main` blocks the branch too, even
  one only `main`'s newer code caused: repair `main`, re-run the nightly, then tag.
- **`CHANGELOG.md` on `main` records every 1.10.N.** The section on the branch is the release body,
  and `main`'s file is the one people read. In the pull request of step 7, move the line from
  `## [Unreleased]` into a `## [1.10.N] - <date>` section in version order (below 1.11.0's); left
  where it is, it would also be published as part of the next release from `main`.
- **GitHub's Latest moves only upward.** `release.yml` asks `release-checks.mjs latest`: 1.10.N
  published after 1.11.0 is `--latest=false`, so the repository page stays on 1.11.x. The store does
  not read the flag.

## Writing the changelog

`CHANGELOG.md` is the source of truth for release notes. The release workflow cuts out the
section matching the tag and publishes it as the release body verbatim. Nothing is generated from
commit messages, and commit style is not constrained in any way.

- Put every user-visible change under `## [Unreleased]`, **in the same commit as the change** —
  not at release time.
- Use `### Added` / `### Changed` / `### Fixed` / `### Removed`.
- Write for a user: what they get, not what the diff did.
- At release time, rename `## [Unreleased]` to `## [1.0.6] - <date>` and leave a fresh empty
  `## [Unreleased]` above it.

CI checks only that the file parses and that `## [Unreleased]` exists. The release workflow is
strict: it needs a section matching the tag, and `## [Unreleased]` must be empty.

If the published notes turn out wrong, fix the **release page** with `gh release edit` and the
**file** in the next ordinary commit. The file at the frozen tag stays stale; nobody reads a
changelog at an old tag.

## Verifying an attestation

Every published asset is signed with SLSA build provenance, so anyone can check it was built by
this repo's CI and not uploaded by hand:

```bash
gh attestation verify main.js --repo thomas-hochbichler/obsidian-remarkable-tagged-sync
```

## When a release run fails

| Situation | What to do |
|---|---|
| The run failed and **no release exists** | delete the tag, fix it, re-tag the **same** version |
| It failed on the **nightly verdict** | `node scripts/release-checks.mjs nightly` names the part; a backend's reason sits in `.nightly-verdict.json` at `parts.ocr.detail.backends.<key>.reason` (a large file — query it, do not print it). Fix the backend list in `tests/support/nightly/ocr.ts` if a provider is the cause, `gh workflow run nightly.yml --ref main`, then tag the commit *after* the verdict commit (step 6's pre-check says which) |
| A release **exists** | never touch it — bump to the next version |

```bash
git tag -d 1.0.6 && git push origin :refs/tags/1.0.6
```

Releases are immutable once published: the tag and the assets cannot be changed. The release
body can still be edited.

## Submitting to the community store

- Submission is **a web form, not a pull request** — `obsidianmd/obsidian-releases` has pull
  requests switched off.
- The automated checker **re-reads the repository** each time, so every round of reviewer fixes
  needs a **new release**. Version numbers get spent fast; that is normal.

## After the release — the FAQ on the website

The website lives in its own repository, but `https://taggedsync.com/faq` answers questions about
*this* plugin at *one* version, so a release can make it wrong. Nothing bumps it for you. Read the
changelog you just wrote and check two things:

- **The version and the month** — `describes` in `src/site.ts`, one line. The stamp under the FAQ
  heading and `softwareVersion` in the schema on the home page both read it. The month says when
  the answers were last checked against this README; it is not a build date and never moves on its
  own.
- **The README deep links.** Every answer in `src/data/faq.ts` may carry one `readme.anchor`, and
  each has to match a heading in this README. Renaming a heading here breaks a link there and
  nothing says so — ten anchors today, and this line is the only check they get.

Then ask whether any answer is now wrong. A changed limit is the usual case: the answers describe
what the plugin does, not what it is called.

## Local development

```bash
npm install
npm run dev     # watch build
npm run build   # production build + typecheck
npm test        # 1805 tests
```

Then reload Obsidian to pick up the rebuilt plugin. The branch workflow, the test vault, and
beta pre-releases for BRAT are documented in `docs/DEVELOPING.md`.
