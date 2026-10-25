# Developing

How a change — feature or bug fix — travels from an idea to `main`. Releasing is a separate
document: `docs/RELEASING.md`.

**`main` only takes changes via pull request.** An active ruleset (`protect-main`) requires the
CI `verify` check, allows squash merges only, and blocks direct pushes, force pushes and branch
deletion. There are no bypass actors; in an emergency, temporarily disable the ruleset under
Settings → Rules.

## The loop

| # | Step | Command |
|---|---|---|
| 1 | Branch off `main` | `git switch -c feature/<slug>` (or `fix/<slug>`) |
| 2 | Develop; push early and often | CI runs the full gate list on every push, on any branch |
| 3 | Test manually in the test vault | `npm run dev`, then reload the plugin (see below) |
| 4 | Optionally, cut a beta for BRAT testing | `git tag 1.0.9-beta.1 && git push origin 1.0.9-beta.1` |
| 5 | Open a PR, wait for green | `gh pr create` |
| 6 | Squash-merge | the merged branch is auto-deleted |
| 7 | Release when ready | `docs/RELEASING.md` |

Details that matter:

- **No version bump on a branch.** The version gate checks consistency across the four files,
  not that a bump happened — bumping stays part of the release steps, on `main`.
- **Changelog lines ride with the change**, under `## [Unreleased]`, in the same commit — exactly
  as on `main`.
- **A branch with an open PR runs CI twice per push**: the push run checks the branch tip, the PR
  run checks the merge result against `main`. Both are meaningful; the duplication is accepted.
- **No e2e checklist template.** What to test is written in the PR description when it isn't
  obvious — a standing template earned its upkeep nowhere yet.

## Watching CI from the terminal

GitHub emails on a failed run and marks the commit/PR. To see it without leaving the shell:

```bash
gh run list --branch "$(git branch --show-current)" --limit 3   # recent runs of this branch
gh run watch                                                    # follow a run live (interactive picker)
gh pr checks --watch                                            # the PR's checks, once one exists
```

## The test vault

The repo contains a dedicated vault at `test/` (gitignored, registered in Obsidian). The plugin
files inside it are **symlinks to the repo root**, so whatever branch is checked out is what the
vault runs:

```
test/.obsidian/plugins/remarkable-tagged-sync/main.js       -> ../../../../main.js
test/.obsidian/plugins/remarkable-tagged-sync/manifest.json -> ../../../../manifest.json
test/.obsidian/plugins/remarkable-tagged-sync/styles.css    -> ../../../../styles.css
```

The e2e flow per branch: `git switch feature/<slug>` → `npm run dev` (watch build) → reload the
plugin in the `test/` vault (toggle it off/on, or reload Obsidian) → test by hand. The vault runs
the free build only; `pro/` testing stays ad hoc.

Should `test/` ever be lost, recreate the links:

```bash
mkdir -p test/.obsidian/plugins/remarkable-tagged-sync
cd test/.obsidian/plugins/remarkable-tagged-sync
ln -s ../../../../main.js ../../../../manifest.json ../../../../styles.css .
```

## Beta releases for BRAT

To test a branch build on a real device setup — or another machine — publish a **pre-release**
that [BRAT](https://github.com/TfTHacker/obsidian42-brat) can install:

```bash
git tag 1.0.9-beta.1        # on the branch commit you want to ship
git push origin 1.0.9-beta.1
```

`beta-release.yml` builds in a fresh checkout, stamps the tag into `manifest.json` **in the
runner only**, runs the release gates (minus version/changelog/attestation — rationale in the
workflow header), and publishes with `--prerelease`. Install it via BRAT's "Add beta plugin with
frozen version" using this repo and the tag.

Rules that keep betas harmless:

- **Never commit a pre-release version** to `manifest.json` or `versions.json`. The community
  store reads `main`'s manifest and resolves exactly that tag — as long as `main` only ever names
  stable versions, betas are invisible to it.
- **Betas are disposable.** If a run fails or a build is bad, delete the tag or just bump `n`.
  Nobody depends on a beta staying available.
- The beta tag namespace `x.y.z-beta.n` never collides with release tags: `release.yml`'s tag
  pattern cannot match it.

Background and sources: `.scratch/feature-branch-workflow/` (map, tickets, BRAT research).

## Dependencies and security

The plugin ships four runtime dependencies, bundled into `main.js`: `kaitai-struct`, `pdf-lib`,
`rmapi-js`, `ssh2`. Everything else in `package.json` is build and test tooling that never reaches
a user. That split decides how an update is handled.

**Two classes, two urgencies.**

- **Runtime dependencies** can trigger a release. A vulnerability in one of them reaches the
  user's machine with the next `main.js`, so the fix has to ship.
- **Dev dependencies** never trigger a release. A vulnerability in Vitest or ESLint is fixed on
  `main` and waits for whatever release comes next.

**When a runtime vulnerability ships a release.** Severity *high* or *critical* **and** reachable
from the plugin → a patch release within seven days. *Moderate* or *low*, or not reachable (an
advisory in an `ssh2` server code path the plugin never calls) → the next regular release.
Reachability is a judgement, written in two sentences in the PR description; there is no tool for
it. Either way the CHANGELOG gets one line under *Dependencies* naming the package, the advisory
(GHSA or CVE id) and the fixed version, and that line is the release body. A GitHub Security
Advisory on this repo is reserved for a vulnerability in our own code.

**How updates arrive.** Dependabot does both halves; `.github/dependabot.yml` has the details.

- *Security updates* open the moment an advisory lands, one PR per fix, for runtime and dev
  dependencies alike. Not configurable, not grouped, not scheduled.
- *Version updates* arrive once a month as **one grouped PR** for all dev dependencies, minor and
  patch only, plus one PR for the SHA-pinned GitHub Actions. Merge after green CI, no release.
  Runtime dependencies get no version-update PRs: bumping `rmapi-js` or `ssh2` touches every
  device and cloud read and is done by hand, with a real sync, when there is a reason.
- *Major bumps* of dev tooling (TypeScript, ESLint, Vitest, `@types/node`) are deliberate work:
  one PR each, when no feature branch is open. Dependabot is configured not to raise them.
- No auto-merge, by choice: one PR a month is read, not waved through.

**Two audit gates.** Both read the GitHub Advisory Database, the same source as Dependabot and the
community store's scorecard.

| Where | Command | Fails on |
|---|---|---|
| `ci.yml`, every branch | `npm audit --omit=dev --audit-level=high` | a *high*+ advisory reachable from the four runtime deps (29 of ~460 packages) |
| `release.yml`, `beta-release.yml` | `npm audit --audit-level=moderate` | **any** *moderate*+ advisory in the whole lockfile |

The release gate is stricter because the store scans `package-lock.json` **at the tag**, dev
dependencies included, and computes the scorecard once per release without ever re-evaluating it.
A dev-only advisory that is harmless to users still costs a scorecard Warning for the lifetime of
that release (1.9.1 carries one for `zod`, which entered the database two days after the tag). The
branch gate is looser so that the same dev-only advisory does not block a feature branch; the
report step above it prints the full picture without failing. `npm audit` has no allowlist: an
unfixable runtime finding is answered with an `overrides` entry in `package.json` or by swapping
the dependency. A red audit step is read, not retried: an advisory-endpoint outage exits with the
same code as a finding.

Locally, the same two commands run on demand. There is no pre-push hook for them on purpose.

**What is deliberately not done.**

- *No second scanner* (OSV-Scanner, Snyk, Socket): all of them are fed by the same advisory
  database; the one different signal, Socket's behavioural analysis, costs a third-party app for
  four runtime dependencies that can be read by hand. GitHub's own malware alerts are on instead.
- *No `npm audit signatures` step*: it verifies what `npm ci` already verifies through the
  lockfile's integrity hashes, and cannot catch a package published from a stolen maintainer
  account, which the registry signs like any other.
- *No SBOM* beyond the SLSA provenance that `release.yml` attests for `main.js`, `manifest.json`
  and `styles.css`.
- *Caret ranges in `package.json`* with an exact `package-lock.json` and `npm ci` stay. Pinning
  the ranges too would add nothing the lockfile does not already give and would make every
  Dependabot PR louder.

**Hardening that is on.** `npm ci --ignore-scripts` in every workflow: five packages carry install
scripts (`esbuild`, `ssh2`, `cpu-features`, `core-js`, `fsevents`), none is needed for the build
or the tests, and an install script is the usual way a compromised package runs code on the
machine installing it. If a future `esbuild` release starts fetching its binary through its install
script, this is the line to revisit. Secret scanning with push protection, Dependabot security
updates and Private Vulnerability Reporting are on in the repository settings; `SECURITY.md` tells
reporters where to go.

**Beta first?** Only when the fix forces a **major** bump of a library, or touches `rmapi-js` or
`ssh2` (every device and cloud read goes through them). Then a BRAT beta and one real sync before
the tag. A patch bump of `pdf-lib` goes straight to a release, after the usual real sync.

Background: `.scratch/security-strategy/` (map, tickets, two research notes on the research
branches `research/obsidian-dependency-security-norms` and `research/npm-dependency-security-toolbox`).
