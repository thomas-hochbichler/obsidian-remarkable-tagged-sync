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
| 6 | Tag the **merged** commit on `main` and push the tag | `git switch main && git pull --ff-only && git tag 1.0.6 && git push origin 1.0.6` |
| 7 | Wait for the release workflow | it builds, attests, publishes and uploads |
| 8 | **After** the tag: `npm run freeze-state`, in a PR of its own | rewrites `test-fixtures/legacy-state/` in place |

Details that matter:

- **`main` takes no direct push.** A repository rule requires a pull request and the `verify`
  check, so the release commit goes the same way every other change does. `git push origin main`
  is rejected with `GH013`.
- **The tag belongs on the squashed commit.** Squash-merging rewrites the commit, so tag only
  after step 5 and after pulling `main` — a tag on the pre-merge commit points at something that
  is not on `main`.

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
| 1 | checkout, Node from `.nvmrc`, `npm ci` | ✅ | ✅ |
| 2 | git author email | ✅ | — |
| 3 | version consistency across the four files, and the frozen state | ✅ | ✅ **plus tag == version** |
| 4 | changelog | ✅ weaker — see below | ✅ hard |
| 5 | lint ratchet | ✅ | ✅ |
| 6 | `tsc -noEmit` + 1805 tests | ✅ | ✅ |
| 7 | build | ✅ | ✅ |
| 8 | bundle scan | ✅ | ✅ |
| 9 | attest `main.js`, `manifest.json`, `styles.css` | — | ✅ |
| 10 | `gh release create` + upload | — | ✅ |

You can run any gate locally:

```bash
node scripts/release-checks.mjs version          # add --tag 1.0.6 to also check the tag
node scripts/release-checks.mjs changelog --ci   # or --release 1.0.6
node scripts/release-checks.mjs lint
node scripts/check-bundle.mjs                    # after npm run build
```

### The local-model transcription gate

**Not in CI, and deliberately manual: it downloads 5.5 GB and takes half an hour.** Run it when the
pinned model or `llama.cpp` revision in `src/local-model-artefacts.ts` changes — that is the only
thing that can move the numbers.

```bash
npx esbuild scripts/release-gate.ts --bundle --platform=node --format=cjs \
  --external:iconv-lite --alias:obsidian=./test-stubs/obsidian.ts --outfile=/tmp/gate.cjs
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
