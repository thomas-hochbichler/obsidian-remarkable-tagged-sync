# npm dependency-security toolbox, state of the art 2026

Research note for `.scratch/security-strategy/issues/02-npm-toolbox-state-of-the-art.md`.
Written 2026-10-25. Every URL below was read on 2026-10-25 unless a different date is given.
Where a claim could not be confirmed in a primary source it is marked **NOT CONFIRMED**.

Repo facts this note is written against (measured in a clean worktree at `74adbad`, npm 11.20.0,
Node 26.12 locally, `.nvmrc` = 22):

- `package-lock.json` lockfileVersion 3; 457 packages in the tree, of which 29 are reachable from
  the 4 runtime deps (`kaitai-struct`, `pdf-lib`, `rmapi-js`, `ssh2`) and 426 only via
  devDependencies (`npm audit --json` → `metadata.dependencies`).
- `npm audit` today: 0 vulnerabilities at every level. `npm audit signatures`: 408 packages with
  verified registry signatures, 81 with verified attestations, 0 invalid, 0 missing; 5.7 s wall time.
- 5 packages carry install-time lifecycle scripts (`hasInstallScript` in the lockfile): `esbuild`
  (postinstall), `ssh2` (install), `cpu-features` (install, optional dep of ssh2), `core-js`
  (postinstall, dep of rmapi-js), `fsevents` (install, optional dep of vite).
- GitHub settings (read via `gh api`, GET only): Dependabot security updates enabled, Dependabot
  alerts enabled (30 alerts in history, 0 open), secret scanning + push protection enabled,
  private vulnerability reporting **disabled**, `allow_auto_merge: false`, squash-merge only,
  code scanning not configured. One active ruleset `protect-main` on the default branch: no
  deletion, no force-push, pull request required with `required_approving_review_count: 0`,
  required status check `verify`. No `SECURITY.md`, no `dependabot.yml`.
- All four workflows install with `npm ci`; none uses `pull_request_target`/`workflow_run` or
  interpolates issue/PR text into scripts; actions are SHA-pinned with a `# vX.Y.Z` comment.
  Release assets are `main.js`, `manifest.json`, `styles.css`, unsigned.

---

## 1. Dependabot vs Renovate

### 1.1 The relevant `dependabot.yml` keys (version 2)

All from the options reference,
<https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference>:

| Key | What the docs say |
|---|---|
| `package-ecosystem` | required; `npm` (npm v7–v11, also used for pnpm/yarn) and `github-actions` are valid values. |
| `directory` | required; for `github-actions` "use the value `/`. Dependabot will search the /.github/workflows directory". |
| `schedule.interval` | `daily`, `weekly`, `monthly`, `quarterly`, `semiannually`, `yearly`, `cron`. "Use `monthly` to run on the first day of each month." `schedule.day` is weekly-only; `time` defaults to a random time, `timezone` defaults to UTC. |
| `cooldown` | "allowing updates to be delayed for a configurable number of days"; sub-keys `default-days`, `semver-major-days`, `semver-minor-days`, `semver-patch-days`, `include`, `exclude`. "only available for version updates, not security updates." Since 2026-07-14 a default 3-day cooldown applies even when not configured: <https://github.blog/changelog/2026-07-14-dependabot-version-updates-introduce-default-package-cooldown/> ("Security updates still open immediately"). |
| `allow` | sub-keys `dependency-name`, `dependency-type` (`direct`, `indirect`, `all`, `production`, `development`), and `update-types` (`version-update:semver-patch` etc.). "When `update-types` is omitted from an `allow` rule, all update types are allowed for that rule." "`update-types` only affects *version* updates, not *security updates*." |
| `ignore` | sub-keys `dependency-name`, `versions`, `update-types` (`version-update:semver-major` / `-minor` / `-patch`). "a dependency that is matched by both an allow and an ignore will be ignored." |
| `groups` | `applies-to` (`version-updates` default, or `security-updates`), `dependency-type` (`development`/`production`), `patterns`, `exclude-patterns`, `update-types` (`patch`, `minor`, `major`). "If a dependency matches more than one rule, it's included in the first group that it matches." Dependencies matching no group get individual PRs. |
| `open-pull-requests-limit` | default 5 for version updates; "Security update pull requests are subject to a separate, fixed limit of 10 open pull requests". `0` disables version updates for that ecosystem. |
| `versioning-strategy` | npm: `auto` (default; app → `increase`, library → `widen`), `increase`, `increase-if-necessary`, `lockfile-only`, `widen`. Which one `auto` picks for a `"private": true` package with a bundled `main.js` is **NOT CONFIRMED** in the reference; set it explicitly. |
| `commit-message` | `prefix`, `prefix-development`, `include: scope` (adds `deps` / `deps-dev`). |
| `labels` | replaces the default labels; "will also affect pull requests for security updates to the manifest files of this package manager". |

### 1.2 The exact file for the ticket's spec

One group for all devDependencies, minor + patch only, monthly, plus github-actions:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "monthly"          # first day of each month
      timezone: "Europe/Vienna"
    versioning-strategy: "increase" # bump the ^ranges in package.json, not lockfile-only
    allow:
      - dependency-type: "development"
        update-types:
          - "version-update:semver-minor"
          - "version-update:semver-patch"
    groups:
      dev-dependencies:
        dependency-type: "development"
        update-types: ["minor", "patch"]
    commit-message:
      prefix: "chore"
      include: "scope"               # -> "chore(deps-dev): ..."

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "monthly"
      timezone: "Europe/Vienna"
    commit-message:
      prefix: "chore"
      include: "scope"
```

How this config treats each class of update, per the docs cited in 1.1:

- **devDependencies**: one grouped PR per month with every minor/patch bump. Major bumps are not
  *allowed* (via `allow.update-types`), so they produce no version-update PR at all. If majors
  should instead arrive as individual PRs, drop `update-types` from the `allow` rule: the docs
  say "All major updates will continue to be raised as individual pull requests"
  (<https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/optimizing-pr-creation-version-updates>).
- **Runtime (production) deps** `kaitai-struct`, `pdf-lib`, `rmapi-js`, `ssh2`: with
  `allow: dependency-type: development` they receive **no version-update PRs**. Without the
  `allow` block the default applies ("All dependencies explicitly defined in a manifest are kept
  up to date by version updates") and each runtime dep not matched by the group gets its own
  individual PR, including majors. A second group `runtime-dependencies` with
  `dependency-type: production` is the middle ground if runtime bumps should be reviewed monthly
  as one PR.
- **Security updates still arrive separately and immediately.** They are triggered by alerts,
  not by `schedule`: "when a Dependabot alert is raised … Dependabot automatically tries to fix
  it" and "Dependabot will not group security updates with version updates"
  (<https://docs.github.com/en/code-security/dependabot/dependabot-security-updates/about-dependabot-security-updates>).
  `allow.update-types` explicitly does not restrict them (1.1), and `allow` is documented with
  "All dependencies defined in lock files with vulnerable dependencies are updated by security
  updates." The 2026-07-14 changelog repeats "Security updates still open immediately."
- **Does a blanket `ignore … version-update:semver-major` suppress a security fix that exists
  only in a major?** The controlling-dependencies page says `ignore` applies "when it opens pull
  requests for version updates and security updates"
  (<https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/controlling-dependencies-updated>),
  while the "only affects version updates" sentence sits under `update-types (allow)`, not under
  `ignore`. The specific case is **NOT CONFIRMED** either way, which is why the file above uses
  `allow.update-types` and no `ignore` block. (Security PRs target "the minimum version that
  includes the patch", so a major is proposed only when nothing lower fixes it.)
- **SHA-pinned actions**: "Dependabot only supports updates to GitHub Actions using the GitHub
  repository syntax, such as `actions/checkout@<commit>`" and "Dependabot updates the version
  documentation of GitHub Actions when the comment is on the same line"
  (<https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions>;
  changelog <https://github.blog/changelog/2022-10-31-dependabot-now-updates-comments-in-github-actions-workflows-referencing-action-versions/>).
  The repo's `@<sha> # v7.0.1` convention is exactly what Dependabot maintains. Caveat from the
  same guide: Dependabot does not raise *alerts* for SHA-pinned actions.

### 1.3 Can Dependabot auto-merge?

Not by itself: the options reference has no auto-merge key. GitHub's documented route is a
workflow that calls GitHub's native auto-merge
(<https://docs.github.com/en/code-security/dependabot/working-with-dependabot/automating-dependabot-with-github-actions>):

- trigger `on: pull_request`, guard
  `if: github.event.pull_request.user.login == 'dependabot[bot]' && github.repository == 'owner/repo'`;
- `permissions: contents: write` and `pull-requests: write` (the default token for
  Dependabot-triggered runs is read-only:
  <https://docs.github.com/en/code-security/dependabot/troubleshooting-dependabot/troubleshooting-dependabot-on-github-actions>);
- `dependabot/fetch-metadata` to read `update-type` (`version-update:semver-patch` …) and gate on it;
- `gh pr merge --auto --squash "$PR_URL"` with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`
  (`--auto` = "Automatically merge only after necessary requirements are met",
  <https://cli.github.com/manual/gh_pr_merge>).

What GitHub requires around it:

- The repository setting **Allow auto-merge** must be on: "Before you use auto-merge, it must be
  enabled for the repository"
  (<https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request>).
  This repo currently has `allow_auto_merge: false`.
- Branch protection or a ruleset with required status checks: "you should enable Require status
  checks to pass before merging for the target branch"; auto-merge is only offered on PRs that
  cannot merge immediately. The existing `protect-main` ruleset with required check `verify` is
  enough. Whether the `gh` CLI itself errors when the repo setting is off is **NOT CONFIRMED**
  from the `gh` manual (the requirement is documented on the GitHub side).
- Workflows triggered by Dependabot run as if from a fork: GitHub Actions secrets are not
  available, only Dependabot secrets (troubleshooting page above). `GITHUB_TOKEN` is enough for
  `gh pr merge --auto`; a merge queue would need a PAT/App token.

### 1.4 Renovate, for comparison

From docs.renovatebot.com (read 2026-10-25):

- Hosted GitHub App at <https://github.com/apps/renovate>; Community Cloud is "A generous free tier,
  available for all across an unlimited number of public and private repositories"
  (<https://docs.renovatebot.com/mend-hosted/overview/>). Onboarding PR adds `renovate.json`.
- Equivalent config: `config:recommended` + `schedule:monthly` (`"* 0-3 1 * *"`) +
  `packageRules: [{ matchDepTypes: ["devDependencies"], matchUpdateTypes: ["minor","patch"], groupName: "dev dependencies" }]`
  + `:disableMajorUpdates` (<https://docs.renovatebot.com/presets-default/>,
  <https://docs.renovatebot.com/configuration-options/>).
- Things Dependabot lacks: `lockFileMaintenance` (regenerates the lockfile to refresh
  transitives), the Dependency Dashboard issue, `automerge: true` with `platformAutomerge`
  (which also "requires the 'Allow auto-merge' checkbox in the repository settings",
  <https://docs.renovatebot.com/key-concepts/automerge/>), `helpers:pinGitHubActionDigests`,
  `security:minimumReleaseAgeNpm`, `osvVulnerabilityAlerts`.
- Renovate's own comparison table: <https://docs.renovatebot.com/bot-comparison/> (rows: dashboard,
  grouping, scheduling, platforms, built-in, licence). Both support grouping and monthly schedules;
  Dependabot is built in and needs no third-party app installation.

Verdict for a solo repo with ~20 deps: Dependabot's grouping, cooldown and SHA-comment handling
now cover the whole requirement; Renovate's extra features (lockfile maintenance, dashboard,
native automerge) do not justify a third-party app with write access.

---

## 2. Scanners: what `npm audit` covers and what others add

### 2.1 `npm audit`

- "submits a description of the dependencies configured in your project to your default
  registry and asks for a report of known vulnerabilities"; "By default npm requires a
  package-lock or shrinkwrap in order to run the audit"
  (<https://docs.npmjs.com/cli/v11/commands/npm-audit>). It therefore works without
  `node_modules` (verified locally: the first `npm audit --json` above ran before any install).
- Data source: "every version of the npm CLI that supports security audits is now talking
  directly to the GitHub Advisory Database"
  (<https://github.blog/2021-10-07-github-advisory-database-now-powers-npm-audit/>, 2021-10-07).
- Scope: "checks direct dependencies, devDependencies, bundledDependencies, and
  optionalDependencies, but does not check peerDependencies"
  (<https://docs.npmjs.com/auditing-package-dependencies-for-security-vulnerabilities>).
- What it does **not** cover (none of these appear anywhere in the audit docs): typosquats,
  install scripts, obfuscated code, maintainer-account takeover / new publishers, unmaintained
  packages, licences. **Malware advisories**: the GitHub Advisory Database has a `malware` type
  ("We publish them automatically into the GitHub Advisory Database from the npm security team
  and the OpenSSF",
  <https://docs.github.com/en/code-security/security-advisories/working-with-global-security-advisories-from-the-github-advisory-database/about-the-github-advisory-database>),
  but whether the audit endpoint returns them to `npm audit` is **NOT CONFIRMED** in any npm or
  GitHub page read. On the GitHub side malware alerts are an opt-in toggle for Dependabot
  (<https://github.blog/changelog/2026-03-17-dependabot-now-detects-malware-in-npm-dependencies/>,
  <https://docs.github.com/en/code-security/concepts/supply-chain-security/malware-alerts>), and
  the OpenSSF malicious-packages feed is ingested since 2026-07-28
  (<https://github.blog/changelog/2026-07-28-dependabot-alerts-on-malicious-packages-across-more-ecosystems/>).

### 2.2 What the alternatives add

| Tool | Free for a public repo | Account needed | GitHub Action | Adds over `npm audit` + Dependabot |
|---|---|---|---|---|
| **OSV-Scanner** (Google, Apache-2.0) | yes; OSV API "Currently there are no limits on the API" (<https://google.github.io/osv.dev/api/>) | no | `google/osv-scanner-action` reusable workflows `osv-scanner-reusable.yml` / `osv-scanner-reusable-pr.yml` (<https://google.github.io/osv-scanner/github-action/>) | OSV aggregates the GitHub Advisory Database **and** OpenSSF Malicious Packages `MAL-` records (<https://google.github.io/osv.dev/data/>); licence allowlist (`--licenses`); PR base-vs-head diff; exit 1 on findings, 128 when no packages found (<https://google.github.io/osv-scanner/output/>); ignores via `osv-scanner.toml`. Supports `package-lock.json` (<https://google.github.io/osv-scanner/supported-languages-and-lockfiles/>). No JS call analysis. |
| **Socket** GitHub App | "$0 … unlimited public and private repositories", "always be free to use for open-source" (<https://socket.dev/pricing>) | a Socket org/account is implied by the dashboard; **NOT CONFIRMED** explicitly on the install page | official action is `SocketDev/action` (Firewall Free mode needs no token, <https://github.com/SocketDev/action>); CLI needs an API token (<https://docs.socket.dev/docs/socket-cli>) | behavioural signals the others lack: install scripts, typosquat, obfuscated code, network/shell/filesystem/env access, protestware, "New author", "Unstable ownership", licence, deprecated/unmaintained (<https://docs.socket.dev/docs/alert-types>). Comments on PRs that change manifests (<https://docs.socket.dev/docs/socket-for-github>). |
| **Socket Firewall Free** (`sfw`) | yes, "no API key and no configuration required" | no | via `SocketDev/action` | blocks "only confirmed malware" at install time, wrapper mode only, telemetry always on (<https://docs.socket.dev/docs/socket-firewall-free>) |
| **Snyk** | free plan, 200 Open Source tests; "We do not count contributions to public (open source) repos" (<https://snyk.io/plans/>) | yes, `SNYK_TOKEN` (<https://docs.snyk.io/snyk-cli/authenticate-to-use-the-cli>) | `snyk/actions/node` (<https://github.com/snyk/actions>) | Snyk-curated DB incl. malicious packages as CWE-506; note `snyk test` skips devDependencies by default (`--dev`, <https://docs.snyk.io/snyk-cli/commands/test>) |
| **dependency-review-action** (GitHub) | yes, "Public repositories" (<https://github.com/actions/dependency-review-action>) | no | `actions/dependency-review-action` | PR gate on *introduced* vulnerable deps and licences; `allow-licenses`, `deny-packages`, `fail-on-scopes` (default `runtime`), OpenSSF Scorecard column (`show-openssf-scorecard`, default true). Malware coverage **NOT CONFIRMED**. |

For this repo the honest overlap picture is: vulnerability data (npm audit, Dependabot alerts,
OSV-Scanner, dependency-review) all trace back to the GitHub Advisory Database; the only genuinely
different signal sets are Socket's behavioural analysis and, for malware, the OpenSSF `MAL-` feed,
which Dependabot now also serves once the malware toggle is on.

---

## 3. `npm audit` in CI

Sources: <https://docs.npmjs.com/cli/v11/commands/npm-audit>,
<https://docs.npmjs.com/cli/v11/using-npm/config>, and the npm CLI source at tag `v11.21.1`
(<https://github.com/npm/cli/tree/v11.21.1>) where the prose docs are silent.

- **`--omit=dev`**: config docs define `omit` as "Dependency types to omit from the installation
  tree on disk" (default `dev` only when `NODE_ENV=production`); `--production` and
  `--only=prod` are deprecated aliases. The audit docs do not spell out the effect on findings;
  the source does: `workspaces/arborist/lib/audit-report.js` skips nodes for which
  `node.shouldOmit(omit)` is true before building the registry payload, and `calc-dep-flags.js`
  clears the `dev` flag on any node reachable from a prod path. So `npm audit --omit=dev` reports
  only packages reachable without going through a devDependency. Locally: 29 of 457 packages.
- **`--audit-level`**: "The minimum level of vulnerability for `npm audit` to exit with a
  non-zero exit code"; values `info`, `low`, `moderate`, `high`, `critical`, `none`. "This option
  does not filter the report output, it simply changes the command's failure threshold."
  `none` never fails.
- **Exit codes**: "exit with a 0 exit code if no vulnerabilities were found. If vulnerabilities
  were found the exit code will depend on the audit-level config." `--json` does not change the
  exit code (`npm-audit-report/lib/index.js` computes it independently of the reporter). A
  registry/audit-endpoint error is logged as `npm warn audit …` and the command exits 1 as a
  generic error (`lib/utils/audit-error.js`, `lib/cli/exit-handler.js`) — in CI that is
  indistinguishable by exit code from "vulnerabilities found".
- **Endpoint**: docs say the Bulk Advisory endpoint is used and "If the `Bulk Advisory` endpoint
  returns an error … npm will attempt to load advisory data from the `Quick Audit` endpoint". The
  `v11.21.1` source only calls `/-/npm/v1/security/advisories/bulk` and returns `null` on error;
  the quick-audit fallback is not in the code. Docs and code disagree here.
- **`--package-lock-only`**: "the current operation will only use the `package-lock.json`,
  ignoring `node_modules`" — listed as an audit option, so an audit step can run before or
  without `npm ci`.
- **`npm audit fix`**: `--dry-run`, `--force` ("install modules outside your stated dependency
  range (including SemVer-major changes)"; "it is strongly recommended that you do not use this
  option!"). Since 11.18.0, when `min-release-age` blocks a fix npm "warns that the fix was
  blocked, and exits with a non-zero code".
- **False-positive behaviour**: the detail reporter prints `No fix available` for advisories
  without a remediation; there is no built-in allowlist ("ignoring" appears nowhere in the audit
  docs). The two npm RFCs that proposed one never merged:
  <https://github.com/npm/rfcs/pull/18> (author 2024-01-25: "This RFC is unlikely to move
  forward") and <https://github.com/npm/rfcs/pull/422>. Dan Abramov's "npm audit: Broken by
  Design" (<https://overreacted.io/npm-audit-broken-by-design/>, 2021-07-07, opinion piece)
  documents the typical noise: moderate/high ReDoS findings reachable only through build tooling.
  Userland filters: `audit-ci` (IBM, allowlist by GHSA id/module/path,
  <https://github.com/IBM/audit-ci>) and `better-npm-audit` (`.nsprc` with expiry,
  <https://github.com/jeemok/better-npm-audit>). With 426 of 457 packages dev-only in this repo,
  `--omit=dev` is the main noise filter; the dev tree is still covered by Dependabot alerts.
- **`npm audit signatures`**: "verify the registry signatures of downloaded packages" and "also
  verify the provenance attestations of downloaded packages"; keys from
  `registry-host.tld/-/npm/v1/keys`; signature is over `name@version:integrity`
  (<https://docs.npmjs.com/cli/v11/commands/npm-audit#audit-signatures>,
  <https://docs.npmjs.com/about-registry-signatures>). Semantics not in the prose docs, from
  `lib/utils/verify-signatures.js` at `v11.21.1`: requires an installed tree (`loadActual`; errors
  "found no installed dependencies to audit"), skips git/non-registry specs and omitted types,
  counts a package as **missing** only when it has no signature *and* the registry publishes
  keys, and sets exit code 1 when `invalid` **or** `missing` is non-empty. Attestations are
  verified only where present; a package without provenance passes on its registry signature.
  Cost: one manifest fetch per installed registry package, concurrency 20 — measured 5.7 s for
  408 packages here. What it proves: the tarball you installed is the one the registry signed. What
  it does not prove: that the version was published by the legitimate maintainer — a package
  published with stolen credentials is signed by the registry like any other, and the provenance
  docs say so: provenance "does not guarantee the package has no malicious code"
  (<https://docs.npmjs.com/generating-provenance-statements>).

---

## 4. Lockfile, pinning and `--ignore-scripts`

- **Lockfile**: "This file is intended to be committed into source repositories"; for libraries
  "package-lock.json cannot be published, and it will be ignored if found in any place other than
  the root project" (<https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json>).
- **`npm ci`**: "The project must have an existing package-lock.json"; "If dependencies in the
  package lock do not match those in package.json, npm ci will exit with an error"; "installs are
  essentially frozen" (<https://docs.npmjs.com/cli/v11/commands/npm-ci>).
- **OpenSSF npm guide** (<https://github.com/ossf/package-manager-best-practices/blob/main/published/npm.md>):
  "Developers should declare and commit a lockfile for ***all*** their projects"; "Use a lockfile
  because it implements hash pinning using cryptographic hashes"; in CI "only run npm commands that
  treat the lockfile as read-only" (`npm ci`, `npm install-ci-test`). For libraries the guide says
  the lockfile "***should*** be ignored for tests running in CI" so the range is exercised; for
  applications: commit and freeze. Range advice: "`^m.n.o` to pin to a major range". The guide
  does not mention `--ignore-scripts`.
- **Is caret + lockfile + `npm ci` still the norm for an application-like bundle?** Yes by every
  primary source read: npm's lockfile docs, `npm ci` docs and the OpenSSF guide all assume exactly
  that; `save-exact` (default `false`, `save-prefix` default `^`,
  <https://docs.npmjs.com/cli/v11/using-npm/config>) adds nothing once the lockfile is frozen,
  because the lockfile already fixes the exact version and integrity hash. OpenSSF Scorecard's
  Pinned-Dependencies check never parses `package.json` ranges; it treats `npm ci` as pinned and
  flags `npm install`/`npm i`/`npm update` in workflows
  (<https://github.com/ossf/scorecard/blob/main/checks/raw/shell_download_validate.go>). This plugin
  is application-like (bundled `main.js`, `"private": true`), so the current setup is the
  recommended one.
- **Cooldown at the npm level**: npm 11.10.0 added `min-release-age` ("only versions that were
  available more than the given number of days ago will be installed", complement to `before`),
  11.17.0 `min-release-age-exclude` (<https://docs.npmjs.com/cli/v11/using-npm/config>,
  <https://github.com/npm/cli/blob/v11.21.1/CHANGELOG.md>). Default `null`. pnpm's equivalent
  `minimumReleaseAge` defaults to 1440 minutes since pnpm 11
  (<https://pnpm.io/settings/dependency-resolution>). With Dependabot's own 3-day cooldown already
  in force, an `.npmrc` `min-release-age` is an optional second layer that would also delay manual
  `npm install` of a brand-new release.
- **`--ignore-scripts`**: "If true, npm does not run scripts specified in package.json files",
  including the root project's `pre`/`post` scripts
  (<https://docs.npmjs.com/cli/v11/using-npm/config#ignore-scripts>); `npm ci` runs
  `preinstall, install, postinstall, prepublish, preprepare, prepare, postprepare`
  (<https://docs.npmjs.com/cli/v11/using-npm/scripts>). So `npm ci --ignore-scripts` also skips
  this repo's `prepare` (`git config core.hooksPath .githooks || true`), which only matters on a
  developer machine, not in CI.
- **Does it break esbuild?** No. esbuild's docs: with `--ignore-scripts` "esbuild's install script
  doesn't run", the binary "should still be automatically selected and installed from esbuild's
  optional dependencies by npm", the command "remains pointed to the JavaScript shim file", and
  only `--ignore-scripts` **plus** `--no-optional` breaks it
  (<https://esbuild.github.io/getting-started/#install-esbuild>; CHANGELOG 0.13.0 at
  <https://github.com/evanw/esbuild/blob/main/CHANGELOG-2021.md>: the post-install step is an
  optimisation that replaces the shim with the binary). **Verified locally**: `npm ci
  --ignore-scripts` → `npx esbuild --version` = 0.28.1, `npm run build` (typecheck + production
  bundle, 3.3 MB `main.js`) exit 0, `vitest run` 136 files / 2965 tests passed.
- **The other install scripts**: `ssh2`'s `install.js` builds an optional native crypto binding
  and exits 0 on failure ("Failed to build optional crypto binding",
  <https://github.com/mscdex/ssh2/blob/master/install.js>); `cpu-features` is an
  optionalDependency of ssh2 (its node-gyp build is tolerated failing); `core-js`'s postinstall is
  the funding banner wrapped in `try/catch`; `fsevents` is an optional dep of vite on macOS only.
  None is required for the bundle: `main.js` is built by esbuild from JS sources, and the plugin
  runs inside Obsidian's Electron where no native binding from `node_modules` is shipped.
- **npm's new install-script policy**: `npm install-scripts` (`ls`, `approve`, `deny`, `prune`)
  manages an `allowScripts` field in `package.json`
  (<https://docs.npmjs.com/cli/v11/commands/npm-install-scripts>); config keys `allow-scripts`,
  `strict-allow-scripts`, `dangerously-allow-all-scripts`. The docs page says "Dependency install
  scripts are blocked by default", but **locally with npm 11.20.0 a plain `npm ci` still ran all
  five scripts** (the esbuild binary was swapped in; output: `npm warn install-scripts 5 packages
  have install scripts not yet covered by allowScripts: core-js, cpu-features, esbuild, fsevents,
  ssh2 … Run npm install-scripts ls to review, or npm install-scripts approve <pkg> to allow.`).
  The npm 12.0.0 changelog is where blocking becomes the default ("Dependency lifecycle scripts
  are now blocked by default unless allowed by the root package's `allowScripts` policy",
  <https://github.com/npm/cli/blob/latest/CHANGELOG.md>). Node 22 ships an npm 10.x (not re-verified
  here against nodejs.org), so CI on `.nvmrc` = 22 is on neither behaviour unless npm is upgraded
  in the workflow. Docs and code
  disagree for 11.x; the local test is the authority for this machine.

---

## 5. GitHub repository settings

### 5.1 Private Vulnerability Reporting

- UI: repository **Settings** → sidebar section **Security and quality** → **Advanced Security** →
  "to the right of 'Private vulnerability reporting', click **Enable**"
  (<https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository>).
  Public repositories only; owner/admin required.
- REST: `GET|PUT|DELETE /repos/{owner}/{repo}/private-vulnerability-reporting`; PUT/DELETE return
  204 and need admin access
  (<https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28>, sections "Check if private
  vulnerability reporting is enabled" / "Enable private vulnerability reporting"). With the
  `gh` CLI (`-X` sets the method, `{owner}/{repo}` placeholders resolve from the current repo,
  <https://cli.github.com/manual/gh_api>):

  ```sh
  gh api repos/{owner}/{repo}/private-vulnerability-reporting            # {"enabled":false} today
  gh api -X PUT repos/{owner}/{repo}/private-vulnerability-reporting     # enable, 204
  ```
- Reporter side: **Security** tab → **Report a vulnerability**; the security policy, if any, is
  shown above the form
  (<https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability>).
  Maintainer side: the report appears under Security → Advisories with status `Triage`; options
  "Accept and open as draft", "Start a temporary private fork", or close
  (<https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/fix-reported-vulnerabilities/managing-privately-reported-security-vulnerabilities>).

### 5.2 Minimal SECURITY.md

- Accepted locations in precedence order: `.github/`, repository root, `docs/`
  (<https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file>).
  UI: Security tab → **Security policy** → **Start setup**
  (<https://docs.github.com/en/code-security/getting-started/adding-a-security-policy-to-your-repository>).
- GitHub's docs describe but do not reproduce the template. Its text (`## Supported Versions`
  table with `:white_check_mark:` / `:x:`, `## Reporting a Vulnerability` with "Tell them where to
  go, how often they can expect to get an update …") is reproduced only in a community discussion
  (<https://github.com/orgs/community/discussions/195654>, secondary source) and in many
  unedited repos; **NOT CONFIRMED** from a GitHub-authored page.
- A minimal policy that also scores 10/10 on Scorecard's Security-Policy check (needs a link or
  e-mail, free text, and words like "vulnerability", "disclosure" and a number of days — see 5.3):

  ```markdown
  # Security Policy

  ## Supported Versions

  Only the latest release on the Obsidian community plugin store receives security fixes.

  ## Reporting a Vulnerability

  Please report vulnerabilities privately via GitHub's "Report a vulnerability" button on
  https://github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync/security/advisories/new
  Do not open a public issue. You will get a first response within 7 days; coordinated
  disclosure is the default, with a fix targeted within 90 days.
  ```

### 5.3 OpenSSF Scorecard on this repo

Checks from <https://github.com/ossf/scorecard/blob/main/docs/checks.md>, detection details from
`checks/raw/*.go` in the same repo; weights per README (Critical 10, High 7.5, Medium 5, Low 2.5).
Expected result for this repo as it is today:

| Check (risk) | Expected | Why |
|---|---|---|
| Binary-Artifacts (High) | 10 | flags `exe so dll jar class pyc wasm …` by magic/extension; PNG/JPG/GIF/PDF/`.rm` fixtures are not on the list. |
| Branch-Protection (High) | ~3 | tiers: Tier 1 (no force-push/deletion) → 3; Tier 2 needs ≥1 required reviewer, which a solo repo cannot sensibly require, so the required `verify` check (Tier 3) earns nothing. Rulesets are readable with the default token. |
| Code-Review (High) | 0 | "Requiring reviews for all changes is infeasible for some projects, such as those with only one active participant" — self-merged squash PRs count as unreviewed. |
| Dependency-Update-Tool (High) | 0 → 10 | looks for `.github/dependabot.yml` / `renovate.json`; fallback is commits *committed by* `dependabot[bot]`, which squash-merge defeats. Security updates alone do not count. A `dependabot.yml` fixes it. |
| Security-Policy (Medium) | 0 → 10 | `SECURITY.md` in root/`.github`/`docs`; link or e-mail 6, text 3, disclosure/vuln/days words 1. |
| Pinned-Dependencies (Medium) | high | actions SHA-pinned, workflows use `npm ci` (treated as pinned). |
| Token-Permissions (High) | 10 (warning) | top-level `contents: read` + job-level `contents: write` is the documented best shape; the badge job's write is a warning only. |
| Dangerous-Workflow (Critical) | 10 | no `pull_request_target`/`workflow_run` checkout, no untrusted-context interpolation. |
| SAST (Medium) | 0 | no CodeQL; code scanning default setup is `not-configured`. |
| Signed-Releases (High) | 0 | release assets have no `.sig/.sigstore/.intoto.jsonl`; "The check does not verify the signatures." |
| Packaging (Medium) | n/a | only npm/PyPI-style publishing workflows count; Obsidian store releases are GitHub release assets. |
| Fuzzing (Medium), CII-Best-Practices (Low), SBOM (Medium) | 0 | not in place; Fuzzing for JS looks for fast-check. |
| Maintained (High), CI-Tests (Low), License (Low) | 10 | weekly commits, Actions checks on PRs, GitHub detects Apache-2.0. |
| Vulnerabilities (High) | 10 | OSV against the lockfile; currently clean. |
| Webhooks | not run | EXPERIMENTAL, needs a PAT. |

Running it: `ossf/scorecard-action` is "free for all public repositories"; needs
`security-events: write` (SARIF upload to code scanning, free on public repos) and
`id-token: write` for `publish_results: true` (badge + scorecard.dev viewer); the default
`GITHUB_TOKEN` suffices with rulesets; no account
(<https://github.com/ossf/scorecard-action/blob/main/README.md>; reference workflow
<https://github.com/ossf/scorecard/blob/main/.github/workflows/scorecard-analysis.yml>). The
weekly public scan covers "more than 1.3 million repositories" from `ossf/scorecard-infra`'s list;
whether this repo is included is **NOT CONFIRMED**. Whether GitHub shows Scorecard scores in the
dependency graph or npm registry: **NOT CONFIRMED** (dependency review mentions no score; the
`dependency-review-action` does show a Scorecard column for *introduced* deps).

Assessment: on a solo-maintained repo the three High-weight checks Code-Review, Branch-Protection
and Signed-Releases are structurally capped, so the aggregate will sit around 6–7/10 no matter
what. The actionable items it would surface are exactly `dependabot.yml`, `SECURITY.md`, and
optionally CodeQL — all known from this note already.

---

## Implications for this repo

### Recommended `.github/dependabot.yml`

The file in 1.2, unchanged. Runtime deps get security updates only; devDependencies one grouped
minor/patch PR per month; actions one monthly PR that keeps the `# vX.Y.Z` comments. Dependabot's
default 3-day cooldown applies without configuration. If a runtime major or minor should be
reviewed on a schedule, add a second `allow` rule with `dependency-type: "production"` and a
`runtime-dependencies` group rather than removing the `allow` block.

### Recommended CI audit step

Add to `verify` in `.github/workflows/ci.yml`, directly after `- run: npm ci`:

```yaml
      # Gate on the shipped tree only: of 457 packages, 29 are reachable from the four runtime
      # deps; the other 426 are build/test tooling, which Dependabot alerts already watch and
      # which must not turn a release red over a ReDoS in a dev-only transitive.
      # `--audit-level=high` fails on high/critical; everything lower is printed, not fatal.
      - run: npm audit --omit=dev --audit-level=high
```

Trade-offs made explicit: an audit-endpoint outage exits 1 like a finding (3.), so a red run must
be read, not retried blindly; there is no allowlist, so an unfixable high in the runtime tree
blocks CI until it is overridden via `overrides` in `package.json` or the dependency is swapped.

### Yes/no

- **Second scanner: no.** Every vulnerability source on offer (OSV-Scanner, dependency-review,
  Dependabot) is fed by the same GitHub Advisory Database as `npm audit`; the one new signal set,
  Socket's behavioural analysis, costs a third-party GitHub App on a repo with four runtime deps
  that can be reviewed by hand. Turn on GitHub's malware-alert toggle instead (free, same `MAL-`
  feed OSV-Scanner uses).
- **`npm audit signatures` in CI: no.** It costs 5–6 s and 400 registry requests per run to
  verify something `npm ci` already verifies with the lockfile's `integrity` hashes, and it
  cannot catch the threat that matters (a maintainer-account takeover publishes a validly
  registry-signed package). Run it manually before a release if wanted.
- **Auto-merge: no for now.** It needs the `Allow auto-merge` repo setting, a workflow with
  `contents: write` + `pull-requests: write`, and `gh pr merge --auto`; with one grouped PR per
  month the saving is one click, while the cost is that a dev-tooling bump lands without a human
  reading the changelog. Revisit if the monthly PR becomes a chore.
- **OpenSSF Scorecard: no as a recurring workflow, yes once by CLI.** A solo repo is capped on
  Code-Review, Branch-Protection and Signed-Releases, so the score cannot become a meaningful
  badge; everything actionable it would flag (`dependabot.yml`, `SECURITY.md`, CodeQL) is
  already listed here. One `scorecard --repo=github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync`
  run with a `GITHUB_AUTH_TOKEN` after the two files land is enough to confirm the fixes.

Not asked but cheap and recommended: enable Private Vulnerability Reporting
(`gh api -X PUT repos/{owner}/{repo}/private-vulnerability-reporting`) and commit the
`SECURITY.md` from 5.2 so the reporting form shows it.
