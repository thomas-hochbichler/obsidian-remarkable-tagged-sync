# How the Community directory computes the scorecard "Review" level

Research for wayfinder map `store-scorecard-caution`, ticket 01. Researched 2026-10-24.

## Short answer

Obsidian does not publish the formula. Measured over 694 store pages (see Method), one rule
explains every page we sampled:

| Review level   | Bar  | Condition (first match wins)                              |
| -------------- | ---- | --------------------------------------------------------- |
| **Risks**      | 1/4  | ≥ 2 findings in **Risks**, or **Warnings** ≥ ~600 (somewhere in 525–665) |
| **Caution**    | 2/4  | exactly 1 finding in **Risks**, or **Warnings** ≥ 31       |
| **Satisfactory** | 3/4 | **Warnings** 1–30, no Risks                                |
| **Passed**     | 4/4  | 0 Warnings, 0 Risks                                        |

**Other** and **Disclosures** never count toward the level. `fs` and `child_process` are always
reported as **Warnings**, one finding each. They do not force Caution, but they do rule out
Passed.

**For this plugin (1.9.0):** Warnings 49 and Risks 0 give **Caution**. Getting Warnings down to
**≤ 30** (the 2 `fs`/`child_process` findings included) would give **Satisfactory**. That means
fixing at least 19 of the 47 lint-type Warnings. The 21 "Other" findings, including the 18
`display` deprecations, have no effect on the level. **Passed is not reachable** while
`fs`/`child_process` are in use.

## 1. Which levels exist, and what moves a plugin between them

### What Obsidian documents

- The **help page** for listings describes the Scorecard. Health is rated "such as Excellent".
  The review section "shows the result of the latest automated scan, such as Passed, grouped into
  passed checks …, disclosures …, and other notes". It also has a traffic-light callout: "🟢 Few
  or no disclosures means low risk / 🟡 A handful of disclosures, worth checking … / 🔴 Several
  disclosures or warnings means you should carefully review". The page names no levels besides
  *Passed* and gives no thresholds.
  Source: <https://obsidian.md/help/community-directory> (markdown source:
  <https://github.com/obsidianmd/obsidian-help/blob/master/en/Extending%20Obsidian/Community%20directory.md>).
  - The traffic light talks about *disclosures*. That **does not match observed behaviour**: the
    level is driven by Warnings and Risks, and Disclosures have no effect (Passed pages carry up
    to 7 disclosures). Treat the callout as user guidance, not as the formula.
- The **developer docs** say: "each result is rated as an error, a warning, a recommendation, or
  a pass"; "Warnings don't block your submission, but we recommend addressing them where you
  can."
  Sources: <https://docs.obsidian.md/community-directory/manage-entry> ("Fix a failed review")
  and <https://docs.obsidian.md/community-directory/faq> ("What does the automated review
  check?"). Markdown sources:
  <https://github.com/obsidianmd/obsidian-developer-docs/tree/main/en/Community%20directory>.
- The **"Learn more"** link next to the Review score on the store page goes to the blog post
  <https://obsidian.md/blog/future-of-plugins/>. The post describes scorecards only in general
  terms ("will continue to improve as we incorporate disclosures, privacy labels, artifact
  attestation, manual review results, and adoption of app capabilities") and gives no levels.
- No obsidianmd GitHub repo contains the level names or the scoring code. A GitHub code search of
  the `obsidianmd` org for "Satisfactory" finds nothing. The scanner and portal are
  closed-source; see predecessor research in
  `.scratch/store-scorecard-fixes/issues/01-scanner-lint-behavior.md`.

### What the store page actually renders (primary data)

The store is a Next.js app. Its server-rendered payload carries each finding with a React key
`<severity>:<index>:<message>` under an `h3` section heading with a count. For our page,
<https://community.obsidian.md/plugins/remarkable-tagged-sync>:

| Section heading (store) | Severity key | Count | Counts toward "N issues"? | Counts toward level? |
| ----------------------- | ------------ | ----- | ------------------------- | -------------------- |
| Passed                  | `pass`       | 6     | no                        | no                   |
| Disclosures             | `info`       | 6     | no                        | no                   |
| **Risks** (not present here) | `high`  | 0     | yes                       | **yes**              |
| **Warnings**            | `medium`     | 49    | yes                       | **yes**              |
| Other                   | `info`       | 21    | yes                       | no                   |

"70 issues" = Warnings 49 + Other 21. Level names seen: **Passed** (green, 4/4 bar segments),
**Satisfactory** (green, 3/4), **Caution** (orange, 2/4), **Risks** (red, 1/4). The mapping of
store sections to the dashboard's "error / warning / recommendation" wording is inferred, not
documented: Risks ≈ error, Warnings ≈ warning, Other ≈ recommendation.

### Measured thresholds

Method: we fetched 694 listing pages on 2026-10-24, out of 9,410 IDs in
<https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugins.json>. The sample
was the first 40 IDs, 610 random IDs and a set of named shell, terminal and pandoc plugins. For
each page we parsed the Review label and the per-section counts. Result: 176 Passed,
333 Satisfactory, 160 Caution, 25 Risks. **The rule in the table above predicts all 694 pages
correctly (0 mispredictions).**

- Satisfactory has Warnings 1–30 (max 30) and never a Risk. Caution without a Risk has Warnings
  31–524 (min 31). So the Satisfactory/Caution cut is exactly between **30 and 31**.
- Caution with exactly 1 Risk has Warnings 0–220. Examples: `obsidian-shellcommands` with 1 issue
  (the Risk "fundingUrl must not point to the Obsidian website") is Caution, and `sqlseal` with 1
  issue is Caution. A single Risk is enough for Caution, whatever the Warnings count.
- Every page with ≥ 2 Risks is Risks, e.g. `latex-math` with 2 Risks and 2 Warnings. Risks without
  any Risk finding occur only at Warnings ≥ 665. The highest Caution has 524 Warnings
  (`ozsync`). The upper cut lies in 525–665 and cannot be narrowed from this sample.
- "Other" is irrelevant. `terminal` (polyipseity) has 44 issues (Warnings 13 + Other 31) and is
  **Satisfactory**. Passed pages carry up to 12 Other findings. So the headline "N issues"
  number is **not** what decides the level.
- Typical Risk (`high`) findings seen: unsafe `innerHTML`/`insertAdjacentHTML` assignment,
  `Function` constructor, unlimited or undescribed `eslint-disable`, and manifest errors
  (`fundingUrl`/`authorUrl` pointing at obsidian.md, "Obsidian" in the plugin name, email in the
  author field), a missing release tag for the manifest version, and an unparsable
  `tsconfig.json`. This plugin has none.

## 2. Do `fs` / `child_process` force Caution?

**No.** Across all 694 pages, "**Direct Filesystem Access**" (92 pages) and "**Shell
Execution**" (64 pages) are always rendered under Warnings with severity `medium`, never under
Risks. Each counts as one Warning. Levels of pages that have both: Satisfactory 38, Caution 12,
Risks 4. Those 38 Satisfactory pages have 2–29 Warnings. Examples: `ssh-terminal` with
24 Warnings, `ante` with 24, `copsilot` with 29, `terminal-commands` with 2.

They do rule out **Passed**. Passed requires 0 Warnings, and no page in the sample that has
`fs` or `child_process` is Passed.

## 3. Can a permission be justified so the level or the display changes?

**No documented mechanism exists.**

- The Developer policies require a README disclosure for "Network use. Clearly explain which
  remote services are used and why they're needed." and for "Accessing files outside of Obsidian
  vaults. Clearly explain why this is needed." This is a listing *requirement*. Nothing says it
  affects the scorecard. Source: <https://docs.obsidian.md/community-directory/developer-policies>.
  Plugins whose READMEs explain shell use still show the Warning (all 64 `child_process` pages
  do).
- The manifest has no permission or justification field. The submission requirements only
  demand `isDesktopOnly: true` when Node.js or Electron APIs are used.
  Source: <https://docs.obsidian.md/community-directory/submission-requirements-for-plugins>
  (section "Node.js and Electron APIs are only allowed on desktop").
- The blog announces future declarations: "Plugins will declare what they access: network, file
  system, clipboard, and other capabilities. Users will be able to see these disclosures before
  installing plugins." It gives no format and no date. For wrong scorecard results it says to
  "contact us in the #plugin-dev channel on the Obsidian Discord server".
  Source: <https://obsidian.md/blog/future-of-plugins/>.
- The dashboard's **Request review** only re-runs the scan; it is not an appeal.
  Source: <https://docs.obsidian.md/community-directory/manage-entry>.

## 4. Comparison: well-known desktop plugins using `child_process`

As of 2026-10-24 (store pages `https://community.obsidian.md/plugins/<id>`):

| Plugin (id)                 | Review       | Risks | Warnings | Other | fs | child_process |
| --------------------------- | ------------ | ----- | -------- | ----- | -- | ------------- |
| Obsidian Git (`obsidian-git`) | **Caution** | 0 | 63 | 13 | yes | yes |
| Shell commands (`obsidian-shellcommands`) | **Caution** | 1 (`fundingUrl`) | 0 | 0 | — | — |
| Templater (`templater-obsidian`) | Satisfactory | 0 | 2 | 6 | — | yes |
| Terminal (`terminal`)       | Satisfactory | 0 | 13 | 31 | yes | — |
| Local REST API (`obsidian-local-rest-api`) | Satisfactory | 0 | 13 | 3 | yes | — |
| SSH Terminal (`ssh-terminal`) | Satisfactory | 0 | 24 | 3 | yes | yes |
| Pandoc (`obsidian-pandoc`)  | Caution      | 1 | 3 | 0 | — | — |
| Enhancing Export (`obsidian-enhancing-export`) | Risks | 5 | 435 | 5 | yes | yes |
| Execute Code (`execute-code`) | Risks       | 30 | 329 | 2 | — | — |
| **reMarkable Tagged Sync**  | **Caution**  | 0 | 49 | 21 | yes | yes |

Obsidian Git is Caution because of its Warning count (63), not because of `child_process`.
Shell commands is Caution because of one manifest error and has no other issues. Its scan
surfaces no `child_process` finding at all, probably because the scanner does not trace its
spawn path (inference). Templater uses `child_process` and is Satisfactory.

## Consequences for the map

- **Destination level:** Satisfactory is reachable. It needs Warnings ≤ 30, i.e. at least
  19 fewer than today's 49, with `fs` and `child_process` counted. Passed is not reachable.
- **Prioritisation:** only the Warnings bucket matters for the level. The pre-decided small
  fixes (timers 7, casts 4, assertions 2, `this` alias 1, union 1, whitespace 1) remove
  16 Warnings, which gives 33. Three more are needed, e.g. a few of the 20 console calls, the
  9 `fetch` calls, the license finding or `getSettingDefinitions()`. The 18 `display`
  deprecations ("Other") are irrelevant **for the level** but still count in the "N issues"
  headline.
- **Guardrail:** any single Risk finding (e.g. an undescribed `eslint-disable`, a manifest URL
  pointing at obsidian.md) drops the level to Caution regardless of Warnings. A second one drops
  it to Risks.
- **Caveat:** this is an empirical model of a closed system on 2026-10-24. Obsidian says
  scorecards "will continue to improve" and can change without notice.
