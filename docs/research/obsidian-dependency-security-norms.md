# Obsidian ecosystem norms for dependency security

Research for wayfinder map `security-strategy`, ticket 01. Researched 2026-10-25. All URLs were
read on 2026-10-25 unless stated otherwise. Companion note on the scorecard's level formula:
`docs/research/review-level-thresholds.md` (branch `research/review-level-thresholds`).

## Short answer

1. **Scorecard.** The store runs two separate dependency checks. The *advisory* check reads the
   plugin's dependency tree at the **release tag** (lockfile-shaped data, devDependencies
   included, npm/yarn/pnpm/bun lockfiles all seen), compares it against the **GitHub Advisory
   Database** (every finding links a `GHSA-…` page), and reports each hit as a **Warning**
   (`medium`), so it counts toward the Review level exactly like a lint Warning. The second
   check, a "Vulnerable dependencies scan" of the release assets, shows either the pass line "No
   vulnerable dependencies found." or "Vulnerable dependencies scan not available." Scan
   results are frozen at scan time: our 1.9.0 passed, our 1.9.1 with the identical `zod 3.25.76`
   is flagged, and the only thing that changed in between is that `GHSA-mrhx-c7xc-m3w5` landed
   in the Advisory Database (2026-10-23 18:29 UTC, between the two releases). None of this is
   documented; the scanner is closed source.
2. **Policies.** The developer policies, plugin guidelines, submission requirements and the
   `obsidian-releases` README say **nothing** about dependency updates, lockfiles, SECURITY.md or
   vulnerability disclosure. The only dependency sentence in the policies is a prohibition
   ("must not … install or update themselves or their dependencies"). A lockfile requirement
   exists only in the `obsidianmd/obsidian-workflows` action's warning text. The user-facing help
   tells users to look for the author's `security.md` or `readme.md` to report a vulnerability.
3. **Large plugins.** None of Obsidian Git, Dataview, Templater, Excalidraw or the sample plugin
   has a SECURITY.md, a published GitHub Security Advisory, or an audit/OSV/Snyk step in CI. Two
   of five have Private Vulnerability Reporting on (Templater, Excalidraw), two have a
   `dependabot.yml` (Obsidian Git, Excalidraw), one has CodeQL (Excalidraw), four attest build
   provenance in the release workflow (all but Dataview). Nobody has released "for a CVE" with a
   CVE identifier; the only dependency-vulnerability release wording is Excalidraw 2.23.9:
   "Updated vulnerable package dependency `lodash-es` and `nanoid` based on Obsidian code
   scanner findings."
4. **Obsidian's own defaults.** The sample plugin ships exactly two security defaults: a
   committed `package-lock.json` (used by `npm ci`) and `actions/attest@v4` on `main.js` and
   `styles.css` in `release.yml`. No dependabot.yml, no SECURITY.md, PVR off. The newer
   `obsidianmd/obsidian-workflows` action (Aug 2026) is the only obsidianmd repo with a
   `dependabot.yml`, and it warns when no lockfile is committed. `eslint-plugin-obsidianmd` has
   no dependency rules.

Implications are in the last section: (a) no second scanner is needed for the store's sake, but
the store's own check is a reason to keep `npm audit` covering devDependencies too; (b) do not
promise provenance/SBOM beyond what the release workflow already attests; (c) announce a runtime
CVE in the CHANGELOG and release note and, since no plugin has ever published one, treat a
GitHub Security Advisory as optional, reserved for a vulnerability in our own code.

## 1. What the scorecard checks under "vulnerable dependencies"

### 1.1 What is documented (little)

- Developer docs, "Manage your plugin or theme": "After each release, the directory scans your
  `manifest.json`, GitHub release assets, and source code, and verifies that the build matches
  what's committed." and "Results are grouped into sections covering the manifest, the release
  assets, the source code, and build verification, and each result is rated as an error, a
  warning, a recommendation, or a pass." … "Warnings don't block your submission, but we
  recommend addressing them where you can."
  <https://docs.obsidian.md/community-directory/manage-entry> (source:
  `obsidianmd/obsidian-developer-docs`, `en/Community directory/Manage your plugin or theme.md`).
- Help, "Community directory": "Review reflects the result of the latest automated scan of a
  release." The passed checks it names include "no known vulnerable dependencies, no obfuscated
  code, verified GitHub artifact attestations".
  <https://obsidian.md/help/community-directory> (source: `obsidianmd/obsidian-help`,
  `en/Extending Obsidian/Community directory.md`).
- Help, "Plugin security": "Obsidian automatically scans every plugin version for security
  vulnerabilities, code quality issues, and malware."
  <https://help.obsidian.md/plugin-security> (source: `obsidianmd/obsidian-help`,
  `en/Extending Obsidian/Plugin security.md`, line 37).
- The scorecard's "Learn more" link (in the box "Scorecards are new and may contain errors. If
  you notice anything inaccurate, please let us know.") goes to the blog post
  <https://obsidian.md/blog/future-of-plugins/>, which says: "Every version is now
  automatically checked for code quality and security vulnerabilities." and "Scorecards are new
  and can contain errors. You may find false positives and false negatives." It names no
  database and no inputs.
- **Not documented anywhere:** which file(s) the dependency check reads, which vulnerability
  database it uses, the Review-level formula. `obsidianmd/obsidian-developer-docs` has no page
  named Scorecard, Build attestations or Reproducible builds (tree grep). The words
  "Satisfactory" and "Caution" do not occur in the developer docs, help docs or blog.
- **Scanner source is not public.** `obsidianmd/obsidian-releases` holds only the JSON lists,
  a README, a `plugin-review.md` stub, a PR template and two workflows (`plugin-stat.yml`,
  `mirror-community-json.yml`) that download and validate JSON from
  `community.obsidian.md/assets/…`; no audit/advisory/attestation logic. The nearest public code
  is the GitHub Action `obsidianmd/obsidian-workflows` ("Matches the community directory's
  validation and scanner expectations so your submissions pass on the first try",
  <https://github.com/obsidianmd/obsidian-workflows>, README line 8); its `src/` contains no
  vulnerability scan (grep for vuln/audit/osv/GHSA: zero hits), and its `summary.ts` marks
  obfuscation/network/behaviour checks as "advisory, authoritative scan runs at release".

### 1.2 What the store pages show (primary data)

The store is a Next.js app; each finding sits in the server-rendered payload under a key
`<severity>:<index>:<message>`. We fetched 22 listing pages on 2026-10-25 (ours, the five
plugins of question 3, plus 16 others) and extracted every finding whose text mentions
"vulnerab", "advisory" or "dependenc".

| Plugin (id) | Review | Issues | Dependency findings |
| --- | --- | --- | --- |
| reMarkable Tagged Sync (`remarkable-tagged-sync`, 1.9.1) | Satisfactory | 9 | `info` "Vulnerable dependencies scan not available." + **`medium` "Dependency has a potential vulnerability advisory"** → "Upgrade to a version outside the vulnerable range (<4.6.6)." → `zod` → <https://github.com/advisories/GHSA-mrhx-c7xc-m3w5> |
| Obsidian Git (`obsidian-git`) | Caution | 76 | `pass` "No vulnerable dependencies found." |
| Dataview (`dataview`) | Risks | 386 | `info` scan not available + `medium` advisory → `svelte` (<3.49.0, GHSA-wv8q-r932-8hc7) + `medium` "'@lezer/common' should be listed in the project's dependencies" |
| Templater (`templater-obsidian`) | Satisfactory | 8 | `pass` "No vulnerable dependencies found." |
| Excalidraw (`obsidian-excalidraw-plugin`) | Passed | 2 | `pass` "No vulnerable dependencies found." |
| Advanced URI (`obsidian-advanced-uri`) | Satisfactory | 15 | `info` scan not available + `medium` advisory → `moment` (GHSA-4p3w-j4w9-5jqw) |
| Linter (`obsidian-linter`) | Satisfactory | 7 | `info` scan not available + `medium` advisory → `katex` (>=0.11.0 <0.18.2, GHSA-238p-pmpm-9mq7) |
| Terminal (`terminal`) | Satisfactory | 44 | `info` scan not available + `medium` advisory → `braces`, `katex`, `sprintf-js` |
| Periodic Notes (`periodic-notes`) | Caution | 75 | `info` scan not available + **~60 `medium`** "Potentially vulnerable dependency X (via Y). Verify that this vulnerability does not affect your plugin." → "Upgrade to version N or later", e.g. `ws (via @jest/core)`, `tough-cookie (via @jest/core)`, `rollup`, `@babel/helpers (via @jest/core)`, `lodash`, `svelte` |
| Tasks (`obsidian-tasks-plugin`) | Caution | 56 | `pass` "No known vulnerable dependencies." |
| Commander (`cmdr`), Local REST API, Outliner, Omnisearch, QuickAdd, Advanced Tables | various | — | `pass` "No vulnerable dependencies found." |
| Calendar, Icon Folder, Kanban, Shell commands, Style Settings | various | — | `info` "Vulnerable dependencies scan not available.", no advisory finding |

Observations that answer the three sub-questions:

**(a) Input: the dependency tree at the release tag, devDependencies included, from the
lockfile.**

- Periodic Notes' scanned release is `1.0.0-beta.3` (2022-04-14, the latest release). Its
  `package.json` at that tag lists `jest`, `ts-jest`, `@types/jest`, `moment` under
  `devDependencies` and the repo has only a `yarn.lock`. The store flags `ws (via @jest/core)`,
  `tough-cookie (via @jest/core)`, `@babel/helpers (via @jest/core)`: transitive
  **devDependencies** that are not in `main.js`. Today's `package.json` on `master` no longer
  has jest, so the scan reflects the **tag**, not HEAD.
  <https://github.com/liamcain/obsidian-periodic-notes> (`package.json?ref=1.0.0-beta.3`).
- Advanced URI 2.2.1 has `pnpm-lock.yaml` and no `moment` in its own `package.json`
  (dependencies: `obsidian-community-lib`, `uuid`); the flagged `moment` is transitive. So the
  scanner resolves the tree, which needs a lockfile or an equivalent resolution; it handles
  pnpm, yarn and (Terminal: `bun.lock`) bun lockfiles, not only `package-lock.json`.
  <https://github.com/Vinzent03/obsidian-advanced-uri> (`package.json?ref=2.2.1`).
- Our own case is consistent: `package-lock.json` at tag `1.9.1` has `zod 3.25.76` (a
  transitive dependency of `rmapi-js`), and the finding names `zod` with the GHSA range
  `< 4.6.6`. `zod` is also bundled in the 1.9.1 `main.js` (`zod/v3`, `ZodError` strings
  present), so this case alone cannot separate lockfile from bundle; the Periodic Notes case can,
  and says lockfile.
- Whether the check also parses `main.js` cannot be confirmed. The separate pass line "No
  vulnerable dependencies found." (sometimes "No known vulnerable dependencies.") never
  co-occurs with an advisory finding in the sample, and every page with an advisory finding also
  shows "Vulnerable dependencies scan not available." The relation between the two lines is
  undocumented; we read it as one check with three outcomes (pass / findings / not run), but
  that is an inference.

**(b) Database: the GitHub Advisory Database.** Every advisory finding links to
`https://github.com/advisories/GHSA-…`; the "Upgrade to …" text matches the advisory's
`vulnerableVersionRange` / `firstPatchedVersion` fields. Whether the scanner queries GitHub
directly, via OSV (which mirrors GHSA) or via `npm audit` (which also serves GHSA data) is not
confirmable; the output is GHSA-shaped in all cases. Timeline evidence for our plugin:

| Event | Time (UTC) | Source |
| --- | --- | --- |
| 1.9.0 published, lockfile `zod 3.25.76` | 2026-10-23 12:46 | `gh api …/releases/tags/1.9.0`; `git show 1.9.0:package-lock.json` |
| 1.9.0 scorecard read: dependency check **passed** | 2026-10-24 | `.scratch/store-scorecard-caution/map.md`, inventory |
| `GHSA-mrhx-c7xc-m3w5` published to the Advisory Database (commit "Publish GHSA-mrhx-c7xc-m3w5") | 2026-10-23 18:29 | `gh api repos/github/advisory-database/commits?path=advisories/github-reviewed/2026/10/GHSA-mrhx-c7xc-m3w5/…` (the GraphQL `publishedAt` of 2026-10-01 is the upstream repository advisory; the reviewed-database entry is from 10-23) |
| 1.9.1 published, lockfile still `zod 3.25.76` | 2026-10-24 18:51 | `gh api …/releases/tags/1.9.1`; `git show 1.9.1:package-lock.json` |
| 1.9.1 scorecard read: **Warning** for `zod` | 2026-10-25 | store page |
| `main` after PR #232: `zod 4.6.7` | 2026-10-25 06:28 | `git show HEAD:package-lock.json` |

Same dependency, two results, with the advisory's publication between them. Also: the 1.9.0
result, read on 10-24, was still "pass" although the advisory was already in the database, and
the 1.9.1 page still shows the Warning although `main` is fixed. So **a scorecard is computed
once per release and not re-evaluated** (inference from two data points; Obsidian does not say).

**(c) Effect on the Review level: it is a Warning, so yes.** The finding carries severity key
`medium`, the same bucket as the lint Warnings. The companion research
(`review-level-thresholds.md`) established that only `high` (Risks) and `medium` (Warnings)
count: 1–30 Warnings and no Risks = Satisfactory, ≥31 Warnings or 1 Risk = Caution. A single
advisory therefore never forces Caution by itself (Linter is Satisfactory with 7 issues
including one), but it is one Warning in the budget of 30, rules out Passed, and one advisory
can carry several findings (Periodic Notes: ~60). Obsidian's own wording stays at "Warnings
don't block your submission".

## 2. What the policies and guidelines say

Read 2026-10-25, each from the live page and the markdown source in
`obsidianmd/obsidian-developer-docs` / `obsidianmd/obsidian-help`.

| Topic | Developer policies | Plugin guidelines | Submission requirements | `obsidian-releases` README / PR template |
| --- | --- | --- | --- | --- |
| Dependency updates | Only as a prohibition: plugins "must not … Install or update themselves or their dependencies." | silent | silent | silent |
| Lockfiles | silent | silent | silent | silent |
| SECURITY.md | silent | silent | silent | silent |
| Vulnerability disclosure | silent (the "Disclosures" section is about README disclosures of payment, accounts, network use, files outside the vault, ads, telemetry, closed source) | "Security" section only on `innerHTML`/`outerHTML`/`insertAdjacentHTML` | silent | silent |

Sources: <https://docs.obsidian.md/community-directory/developer-policies>,
<https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines>,
<https://docs.obsidian.md/community-directory/submission-requirements-for-plugins>,
<https://github.com/obsidianmd/obsidian-releases> (README.md, plugin-review.md,
.github/pull_request_template.md).

What does exist, outside the four documents:

- **Lockfile requirement, stated only by a tool.** `obsidianmd/obsidian-workflows`,
  `src/deps.ts` lines 104–108: "No lockfile found (pnpm-lock.yaml, yarn.lock, bun.lockb,
  bun.lock, npm-shrinkwrap.json, or package-lock.json). … The community directory requires a
  committed lockfile to verify that your release can be reproduced from source." Its
  `src/dep-checks.ts` emits "uses unpinned version specifier … without a lockfile" (warning) and
  "uses broad version range … without a lockfile" (recommendation) only when no lockfile is
  found. Caret ranges **with** a lockfile draw no finding, which matches our scorecard.
- **SECURITY.md as the expected reporting channel, stated to users, not developers.** Help,
  "Plugin security", line 41: "If you discover a security vulnerability in a community plugin,
  refer to the plugin author's `security.md` or `readme.md` for how to report it. For critical
  flaws, also report the issue to Obsidian support."
  <https://help.obsidian.md/plugin-security>. And <https://obsidian.md/help/resources>
  "Report a security issue": "If you've discovered a security issue in Obsidian, or if you
  suspect that a plugin is malicious, please email the Obsidian team."
- **Escalation path in the policies:** "If the developer doesn't respond after 7 days, contact
  the Obsidian team … For serious violations, you can contact our team immediately."
  <https://docs.obsidian.md/community-directory/developer-policies>.
- The FAQ's "How can I run the review checks locally?" answers with the ESLint plugin only; no
  local parity for the dependency check is offered.
  <https://docs.obsidian.md/community-directory/faq>.

## 3. How the large plugins handle it

All via `gh api` on 2026-10-25. `code-scanning/default-setup` and `vulnerability-alerts`
return 403/404 for non-admins on every repo, so whether Dependabot *alerts* are switched on
cannot be determined from outside; the table shows what is visible.

| Check | Obsidian Git | Dataview | Templater | Excalidraw | sample-plugin |
| --- | --- | --- | --- | --- | --- |
| `dependabot.yml` | yes (npm + github-actions, weekly, limit 10; added 2026-07-26, PR #1129) | no | no | yes (npm weekly, `target-branch: master`; added 2025-06-12) | no |
| Renovate config | no | no | no | no | no |
| `SECURITY.md` | no | no | no | no | no |
| Private Vulnerability Reporting | off | off | **on** | **on** | off |
| CodeQL workflow | no | no | no | yes (`codeql-analysis.yml`, since 2022, weekly cron, last success 2026-10-23) | no |
| audit / OSV / Snyk / Socket step in CI | no | no | no | no | no |
| Lockfile / package manager | `pnpm-lock.yaml` | `package-lock.json` | `pnpm-lock.yaml` | `package-lock.json` | `package-lock.json` (`npm ci`) |
| Build-provenance attestation in release workflow | `actions/attest@v4` | no | `actions/attest@v4` | `actions/attest-build-provenance@v2` | `actions/attest@v4` |
| Published GitHub Security Advisories | none | none | none | none | none |
| Dependabot PRs merged / closed unmerged / open | 14 / 27 / 1 | 12 / 1 / 2 | 3 / 6 / 2 | 2 / 15 / 17 | 0 |
| runtime deps / devDeps | 17 / 23 | 11 / 22 | 7 / 33 | 18 / 40 | 0 / 10 |
| Bundler | esbuild | rollup | esbuild | rollup | esbuild |

Repos: <https://github.com/Vinzent03/obsidian-git>,
<https://github.com/blacksmithgu/obsidian-dataview>,
<https://github.com/SilentVoid13/Templater>,
<https://github.com/zsviczian/obsidian-excalidraw-plugin>,
<https://github.com/obsidianmd/obsidian-sample-plugin>.

Releases for a dependency CVE, and how they were announced:

- **No repo has a release note containing a CVE identifier for a dependency, and none has ever
  published a GitHub Security Advisory** (`gh api repos/<o>/<r>/security-advisories` → `[]`
  for all five).
- **Excalidraw** is the only one with dependency-vulnerability release wording, and it was driven
  by the store scanner, not by a CVE feed: release 2.23.9 (2026-06-06): "Updated vulnerable
  package dependency `lodash-es` and `nanoid` based on Obsidian code scanner findings."
  Follow-ups 2.23.11/2.23.12 "Addressed further Obsidian code scanner findings"; 2.24.1 calls
  the scanner "difficult to work with due to inconsistent results, limited transparency, and
  the lack of a clear review or appeal process."
  <https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/2.23.9>. Excalidraw
  otherwise leaves most Dependabot PRs open (17 open, e.g. `dompurify 3.3.3→3.4.0` since
  2026-04-16).
- **Dataview**'s one CVE (CVE-2021-42057, issue #615, still open) was in its own code
  (DataviewJS `eval`), handled in the issue thread and in general release-note prose (0.4.13:
  "actively looking into improving DataviewJS sandboxing and general security posture"), with
  no advisory. Issue #2288 "Vulnerability" (2024, svelte CVE-2022-25875 via
  `obsidian-calendar-ui`, an `npm audit` finding) has no maintainer response; a community
  member called it "a false-positive non-issue … since the effected ssr svelte component is not
  even used." <https://github.com/blacksmithgu/obsidian-dataview/issues/2288>.
- **Templater**: CHANGELOG entries "Security issue with using innerHTML" and "adding toggles
  for security relevant Templater features" are own-code hardening. Its `package.json` lists
  `"child_process": "^1.0.2"`, the npm placeholder package, not Node's builtin (line 68), an odd
  supply-chain exposure worth knowing about but not our concern.
- **Obsidian Git**: 154 releases, none mentioning CVE/vulnerability/security; Dependabot
  configured since 2026-07 and merged in batches (14 merged, 27 superseded).

Cross-cutting: all five bundle dependencies into `main.js` with `obsidian` and CodeMirror
external, so a dependency CVE ships frozen in the artifact until a rebuild, exactly our
situation.

## 4. Dependency-security defaults in Obsidian's own tooling

| Repo | Lockfile | `dependabot.yml` | `SECURITY.md` | PVR | audit step | Provenance | SBOM |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `obsidianmd/obsidian-sample-plugin` | `package-lock.json` | no | no | off | no (`lint.yml`: `npm ci`, build, lint on Node 20/22/24) | **yes**: `release.yml` `permissions: id-token: write, attestations: write`, step "Attest build provenance" `actions/attest@v4` with `subject-path: main.js` (+ `styles.css` if present), then `gh release create … --draft` | no |
| `obsidianmd/eslint-plugin` (npm `eslint-plugin-obsidianmd`) | yes | no | no | **on** (only obsidianmd repo with PVR) | no | not checked | no |
| `obsidianmd/obsidian-releases` | yes (prettier only) | no | no | off | no | no | no |
| `obsidianmd/obsidian-api` | none | no | no | off | no | no `.github` | no |
| `obsidianmd/obsidian-workflows` | yes | **yes**: github-actions weekly grouped minor+patch; npm weekly, group `npm-development` (minor+patch), group `npm-production` (patch only) | no | off | no | yes (`@actions/attest`, `buildSLSAProvenancePredicate()` in `src/release.ts`) | no |
| org-level `obsidianmd/.github` | `gh api repos/obsidianmd/.github` → 404, so no org SECURITY.md | | | | | | |

Other sample-plugin facts: `.npmrc` holds only `tag-version-prefix=""`; `package.json` pins
`esbuild` exactly (`0.25.5`), carets elsewhere, `"obsidian": "latest"`; `.gitignore` excludes
`main.js` ("They should be uploaded to GitHub releases instead."). Its `AGENTS.md` has a
"Security, privacy, and compliance" section (no network by default, no hidden telemetry,
"Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal
releases") and on dependencies only "Keep the plugin small. Avoid large dependencies. Prefer
browser-compatible packages." The README mentions dependencies only as "`npm i` to install
dependencies."

`eslint-plugin-obsidianmd`'s rule table has no dependency or vulnerability rules; the
security-adjacent rules are `no-forbidden-elements`, `no-nodejs-modules`, `no-global-this`,
`hardcoded-config-path`, `no-sample-code`, `validate-manifest`, `validate-license`.
<https://github.com/obsidianmd/eslint-plugin>.

The `obsidian-releases` bot workflows (`plugin-stat.yml`, `mirror-community-json.yml`) only
fetch and validate JSON; they ship no dependency-security logic.

So the ecosystem's de-facto defaults, transmitted by the template, are: **commit the lockfile,
build with `npm ci`, attest `main.js` provenance**. Dependabot version updates, SECURITY.md,
PVR and audit gates are not part of the template and not asked for anywhere.

## Implications for this repo

**(a) A second scanner is not needed for the store; `npm audit` must cover what the store
covers.** The store's advisory check is GHSA-based and lockfile-based, the same data `npm audit`
reads (npm's audit endpoint serves GitHub Advisory Database data). A second scanner (OSV, Snyk,
Socket) would add reachability analysis or malware heuristics, which the store does not score;
whether that is worth a CI step is ticket 02's question, not a store requirement. Two
consequences follow from the store reading the **whole** lockfile at the release tag:
(1) the planned gate `npm audit --omit=dev --audit-level=high` matches our runtime risk model,
but a devDependency advisory still costs a store Warning (Periodic Notes carries ~60 of them),
so the informational full `npm audit` before a release is what protects the scorecard, and a
pre-release `npm audit` (all deps, any level) deserves a line in `docs/RELEASING.md`; (2) a
scorecard is computed once per release and never re-evaluated, so an advisory published after
a release stays invisible on the store until the next release, and an advisory published
*before* a release that we did not patch stays visible for the whole release's lifetime. The
1.9.1 page will show the `zod` Warning until 1.9.2.

**(b) Do not promise provenance or SBOM beyond the attestation.** The ecosystem norm, set by
the sample plugin and followed by four of the five large plugins, is `actions/attest` on
`main.js`; the store verifies it and shows it as two Passed lines plus "Build reproduced the
release main.js byte-for-byte". Nobody in the sample publishes an SBOM, and no Obsidian document
asks for one. The policy text should state what already holds: lockfile committed, build
reproducible from the tag, release assets attested, verifiable with `gh attestation verify
main.js --repo thomas-hochbichler/obsidian-remarkable-tagged-sync`. Anything more is a promise
with no reader and a maintenance cost.

**(c) Announce a runtime CVE in the CHANGELOG and release note; a GitHub Security Advisory is
optional and best reserved for our own code.** No surveyed plugin has ever published a GitHub
Security Advisory, and none names CVEs in release notes; the one precedent (Excalidraw 2.23.9)
is a plain release-note sentence naming the packages. A Security Advisory on our repo would
additionally create a GHSA about *our* package, which is only appropriate when the vulnerability
is in our code, not when we re-bundle a fixed upstream library. The announcement our users can
act on is the release itself (Obsidian updates plugins from the release), so: CHANGELOG line
naming the package, the GHSA/CVE id and the fixed version, the same sentence in the GitHub
release body, and the patch-release rule from ticket 00 (≤ 7 days when high/critical and
reachable). Enabling Private Vulnerability Reporting and adding a SECURITY.md would put us ahead
of every surveyed plugin and matches the only user-facing instruction Obsidian gives ("refer to
the plugin author's `security.md` or `readme.md`"); since `help.obsidian.md` points users at
`security.md` specifically, the file name `SECURITY.md` is the right one.

## Method and sources

- Store pages fetched 2026-10-25 with `curl` from
  `https://community.obsidian.md/plugins/<id>` for: remarkable-tagged-sync, obsidian-git,
  dataview, templater-obsidian, obsidian-excalidraw-plugin, obsidian-local-rest-api, terminal,
  obsidian-shellcommands, calendar, obsidian-kanban, obsidian-tasks-plugin,
  obsidian-style-settings, table-editor-obsidian, obsidian-advanced-uri, periodic-notes,
  obsidian-outliner, cmdr, obsidian-linter, omnisearch, obsidian-icon-folder, quickadd. Findings
  were extracted from the server-rendered payload keys `pass:|info:|medium:|high:`.
- Advisory: `gh api graphql` `securityAdvisory(ghsaId:"GHSA-mrhx-c7xc-m3w5")` and
  `gh api repos/github/advisory-database/commits?path=advisories/github-reviewed/2026/10/GHSA-mrhx-c7xc-m3w5/GHSA-mrhx-c7xc-m3w5.json`.
- Our own history: `git show 1.9.0:package-lock.json`, `git show 1.9.1:package-lock.json`,
  `git show HEAD:package-lock.json`; release asset `main.js` of 1.9.1 via `gh release download`.
- Docs: <https://docs.obsidian.md/community-directory/manage-entry>,
  <https://docs.obsidian.md/community-directory/faq>,
  <https://docs.obsidian.md/community-directory/developer-policies>,
  <https://docs.obsidian.md/community-directory/submission-requirements-for-plugins>,
  <https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines>,
  <https://obsidian.md/help/community-directory>, <https://help.obsidian.md/plugin-security>,
  <https://obsidian.md/help/resources>, <https://obsidian.md/blog/future-of-plugins/>, with
  markdown sources in `obsidianmd/obsidian-developer-docs` and `obsidianmd/obsidian-help`.
- obsidianmd repos via `gh api`: obsidian-releases (tree, README, plugin-review.md, PR template,
  workflows), obsidian-workflows (README, action.yml, src/deps.ts, src/dep-checks.ts,
  src/artifact-checks.ts, src/summary.ts, src/release.ts, .github/dependabot.yml),
  obsidian-sample-plugin (package.json, .npmrc, .gitignore, AGENTS.md, workflows), eslint-plugin
  (README rule table), obsidian-api; `private-vulnerability-reporting`, `contents/SECURITY.md`,
  `contents/.github/dependabot.yml` for each; `repos/obsidianmd/.github` (404).
- Plugin repos via `gh api`: trees, package.json, workflows, `security-advisories`,
  `private-vulnerability-reporting`, `code-scanning/default-setup` (403 for all),
  `vulnerability-alerts` (404 for all), `pulls?state=all` filtered on dependabot/renovate
  authors, releases filtered on CVE/vulnerab/security/advisory/audit, `gh search issues` for
  "CVE" and "vulnerability".
- Two background research agents did the docs/obsidianmd pass and the five-repo pass; the
  quotes used above for `obsidian-workflows` (`deps.ts`, `dependabot.yml`, README), the help
  page `Plugin security.md`, the sample plugin's `release.yml`, the Excalidraw 2.23.9 note and
  all PVR states were re-read directly before being cited.
