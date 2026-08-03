# Releasing

How a release of this plugin is cut. Two GitHub Actions workflows do the work; a human bumps
numbers, writes notes, and pushes a tag.

**Nobody uploads a release asset by hand.** `main.js`, `manifest.json` and `styles.css` are built
in CI, in a fresh checkout, and published from there. That is the rule the pipeline exists to
enforce.

## The six steps

| # | Step | Command / file |
|---|---|---|
| 1 | Bump **four** files to the new version | `manifest.json`, `package.json`, `package-lock.json`, `versions.json` |
| 2 | Rename the changelog heading | `## [Unreleased]` → `## [1.0.6] - 2026-08-01` |
| 3 | Commit | `git commit -am "Release 1.0.6"` |
| 4 | Push, and wait for CI to go green | `git push` |
| 5 | Tag and push the tag | `git tag 1.0.6 && git push origin 1.0.6` |
| 6 | Wait for the release workflow | it builds, attests, publishes and uploads |

Details that matter:

- **Bump `package-lock.json` by running `npm install`** (or `npm i --package-lock-only`) after
  editing `package.json` — never by hand-editing it. Two version fields and the license must all
  move. This file is on the list because it sat stale for five releases and no human checklist
  caught it.
- **`versions.json`** needs a new key `"1.0.6": "<minAppVersion>"`, and the value must equal
  `manifest.json`'s `minAppVersion`.
- **The tag has no `v` prefix.** `1.0.6`, never `v1.0.6`. The store resolves the tag from the
  manifest version, so a `v`-prefixed tag is simply not found.
- **Step 4 is not optional.** The version gate runs in CI too, so a wrong number fails on `main`
  in seconds — before you spend a tag on it.

## What the pipeline does for you

Both workflows run the same gates, cheapest first. Publishing is last, so nothing can publish
after a failure.

| # | Gate | CI | Release |
|---|---|---|---|
| 1 | checkout, Node from `.nvmrc`, `npm ci` | ✅ | ✅ |
| 2 | git author email | ✅ | — |
| 3 | version consistency across the four files | ✅ | ✅ **plus tag == version** |
| 4 | changelog | ✅ weaker — see below | ✅ hard |
| 5 | lint ratchet | ✅ | ✅ |
| 6 | `tsc -noEmit` + 211 tests | ✅ | ✅ |
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

## Local development

```bash
npm install
npm run dev     # watch build
npm run build   # production build + typecheck
npm test        # 211 tests
```

Then reload Obsidian to pick up the rebuilt plugin. The branch workflow, the test vault, and
beta pre-releases for BRAT are documented in `docs/DEVELOPING.md`.
