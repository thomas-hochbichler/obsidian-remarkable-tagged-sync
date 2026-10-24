# Research: how the store scanner detects a license, and is the LICENSE split clean?

Ticket: `.scratch/store-scorecard-caution/issues/04-license-detection.md` (map `store-scorecard-caution`).
Researched 2026-10-24 against `origin/main` (`cdfdf97`). This is not legal advice. It records
facts from primary sources and how comparable projects lay out their files.

## Sources

| Short name | What | Version / location |
| --- | --- | --- |
| **FAQ** | Obsidian developer docs, "Frequently asked questions" (Community directory) | https://docs.obsidian.md/Community+directory/Frequently+asked+questions, source `obsidianmd/obsidian-developer-docs` `en/Community directory/Frequently asked questions.md`, last commit `29188ec` (2026-08-07) |
| **Manage** | Obsidian developer docs, "Manage your plugin or theme" | same repo, `en/Community directory/Manage your plugin or theme.md` |
| **Policies** | Obsidian developer policies | https://docs.obsidian.md/Community+directory/Developer+policies |
| **GH-docs** | GitHub Docs, "Licensing a repository" | https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository |
| **licensee** | `licensee/licensee` source and docs (the library behind GitHub's license detection, per GH-docs) | https://github.com/licensee/licensee, `main` at `9a9c98b` (2026-10-19), release v10.1.0; files `lib/licensee/projects/project.rb`, `projects/git_project.rb`, `project_files/license_file.rb`, `content_helper/normalization_methods.rb`, `content_helper/constants.rb`, `matchers/dice.rb`, `lib/licensee.rb`, `docs/what-we-look-at.md` |
| **API** | `gh api repos/<owner>/<repo>/license` (GitHub Licenses API), run 2026-10-24 | live |
| **Apache** | Apache License 2.0 text | https://www.apache.org/licenses/LICENSE-2.0.txt |
| **ASF-apply** | ASF, "Applying the Apache License, Version 2.0" | https://www.apache.org/legal/apply-license.html |
| **ASF-howto** | ASF, "Assembling LICENSE and NOTICE files" | https://infra.apache.org/licensing-howto.html |
| **npm** | npm docs, `package.json` → `license` | https://docs.npmjs.com/cli/v11/configuring-npm/package-json#license |
| **vnpl** | `validate-npm-package-license` (npm's license validator) | https://github.com/kemitchell/validate-npm-package-license.js/blob/HEAD/index.js |
| **SPDX** | SPDX license list data | https://github.com/spdx/license-list-data, release v3.29.0, `json/licenses.json` |

## Current state (measured)

- `gh api repos/thomas-hochbichler/obsidian-remarkable-tagged-sync/license` →
  `path: LICENSE`, `license.key: other`, `spdx_id: NOASSERTION`. The store's "License: OTHER" is
  this `key` upper-cased.
- `LICENSE` = a 20-line preamble (three numbered points: Apache for all but `pro/`, `pro/` under
  PolyForm Strict + commercial licence, redistribution permission for the official build) +
  separator + the Apache 2.0 text. Diffed against **Apache**, the Apache part is verbatim except
  the appendix line, which reads `Copyright 2026 Thomas Hochbichler` instead of
  `Copyright [yyyy] [name of copyright owner]`.
- `pro/LICENSE` already exists (PolyForm Strict 1.0.0). `LICENSE-COMMERCIAL.md` and `NOTICE` sit
  in the root. `package.json` is `"private": true`, `"license": "SEE LICENSE IN LICENSE"`, and
  `scripts/release-checks.mjs` (line 34) hard-codes that string for `package.json` *and*
  `package-lock.json`.

## 1. What does the scanner use to recognize a license?

**GitHub's license detection, nothing else that is documented.** The **FAQ** answers the exact
warning text:

> ### Why do I get a "The repository does not have a recognized license" warning, despite having a valid license?
> The scanner fetches the license type from GitHub. This warning appears if GitHub reports
> **Custom license** for your repository, or if your license is formatted differently and couldn't
> be matched against the list of accepted license types.

(**Manage** links to this FAQ entry from its "Fix a failed review" section.) `package.json` and
`manifest.json` are not mentioned; **Policies** only requires "a LICENSE file" that "clearly
indicate[s] the license".

GitHub's detection is **licensee** (**GH-docs**: licensee "compares the repository's LICENSE file
to a short list of known licenses" and "provides the Licenses API"; if the license does not show
"it may indicate multiple licenses or other complexity … simplify your LICENSE file and note the
complexity somewhere else, such as your repository's README file").

What the file must look like, per **licensee** source:

- **Location:** only blobs in the repository root, plus a top-level `LICENSES/` directory
  (`git_project.rb#files`). `pro/LICENSE` is never looked at.
- **Name scoring** (`license_file.rb`, `FILENAME_REGEXES`): `LICENSE` = 1.00, `LICENSE.md` = 0.95,
  … `LICENSE-<something>[.ext]` = 0.70, `COPYRIGHT` = 0.35. The regex is `/(un)?licen[sc]e/i`, so
  **`LICENSING.md` scores 0** (no `licen[sc]e` substring) and is not a candidate. `NOTICE` scores 0.
- **Content match:** exact hash first, then the Dice matcher with a **98 % similarity threshold**
  (`Licensee::CONFIDENCE_THRESHOLD = 98`, `matchers/dice.rb`) plus a bigram check at half that.
  Before comparing, licensee strips title, version, copyright lines, Markdown/HTML markup, and
  **everything after `END OF TERMS AND CONDITIONS`** (`strip_end_of_terms`,
  `END_OF_TERMS_REGEX`). A file that matches nothing becomes `License.find('other')`.
- Our preamble adds about 160 words of non-Apache text in front of the terms, which pushes the
  similarity below 98 % → `other`. That is the whole cause of the finding.

## 2. Would the planned restructure report Apache-2.0?

**Yes, by licensee's rules and by GitHub's observed behaviour — with one caveat on extra root files.**

- A `LICENSE` that is the verbatim Apache text matches exactly or near-exactly. Our filled-in
  appendix line does not matter: it sits after `END OF TERMS AND CONDITIONS`, which licensee
  removes before matching.
- `LICENSING.md` (the explanation file) scores 0 and is ignored.
- **Caveat — `LICENSE-COMMERCIAL.md` stays a candidate (score 0.70).** By the *library* logic in
  `project.rb#license`, any further candidate that matches no known license is `other`, and two
  distinct results (`apache-2.0` + `other`) make the project `other` (`docs/what-we-look-at.md`:
  "If the project has multiple license matches … Licensee won't return a license"). **GitHub does
  not behave that way in practice.** Every repo found with a clean root `LICENSE` plus a root
  `LICENSE-COMMERCIAL.md` is reported with the root file's SPDX id (**API**, 2026-10-24):

  | Repo | Root license files | GitHub reports |
  | --- | --- | --- |
  | `markus-global/markus` | `LICENSE` (Apache 2.0, verbatim body), `LICENSE-COMMERCIAL.md` | `Apache-2.0` |
  | `LuxAlgo/PineTS` | `LICENSE`, `LICENSE-COMMERCIAL.md` | `AGPL-3.0` |
  | `TypeWhisper/typewhisper-mac` | `LICENSE`, `LICENSE-COMMERCIAL.md` | `GPL-3.0` |
  | `redbco/redb-open` | `LICENSE`, `LICENSE-COMMERCIAL.md` | `AGPL-3.0` |
  | `soundondigital/ravennakit` | `LICENSE`, `LICENSE-COMMERCIAL.md` | `AGPL-3.0` |

  So keeping `LICENSE-COMMERCIAL.md` in the root is very likely fine on GitHub. A local
  `licensee detect` run would still say `other`, though, and GitHub could change. Moving it (e.g.
  into `pro/` or renaming it so the name has no `licen[sc]e`) removes the dependency on this
  undocumented behaviour. Not tested here: a repo with this exact layout before vs after.
- **Do not add a `LICENSES/` directory** (REUSE layout): licensee scores every file there 1.0, so
  `LICENSES/Apache-2.0.txt` + a PolyForm file would be two candidates again.
- **Verifying:** `gh api repos/thomas-hochbichler/obsidian-remarkable-tagged-sync/license` after
  the change lands on `main`. The repo license comes from the default branch, so a **Review
  branch** preview scan (**Manage**) of a feature branch probably still shows the old result — this
  is an inference, not documented.
- **Side effect to weigh:** the store's Details panel would then show **License: Apache-2.0** for a
  plugin whose `main.js` also contains PolyForm-Strict code. The store field cannot express the
  split. The README, `LICENSING.md` and the listing's long description would have to carry it.

## 3. Is the split sound for open-core repos, and must `pro/` carry its own LICENSE?

Facts, not advice:

- **What Apache 2.0 itself covers.** **Apache** §1: `"Work" shall mean the work of authorship …
  made available under the License, as indicated by a copyright notice that is included in or
  attached to the work`. The licence covers what the licensor says it covers; the root `LICENSE`
  file alone does not define the scope. The appendix recommends a per-file boilerplate notice.
- **ASF practice:** "copying the contents of LICENSE-2.0.txt into a file called LICENSE in the top
  directory" (**ASF-apply**); the LICENSE file "always contains the text of the Apache License, and
  sometimes more information", and other components get "a pointer to the dependency's license
  within the distribution and a short note summarizing its licensing" (**ASF-howto**). ASF also
  says LICENSE and NOTICE "must exactly represent the contents of the distribution they reside
  in". This is the ASF's own release policy, written for bundled third-party code, not for
  open-core splits.
- **How comparable projects lay it out** (**API**, 2026-10-24):

  | Project | Layout | GitHub reports |
  | --- | --- | --- |
  | `documenso/documenso` | root `LICENSE` = pure AGPL-3.0; `packages/ee/LICENSE` = "The Documenso Commercial License"; `packages/ee/package.json` `"license": "COMMERCIAL"` | `AGPL-3.0` |
  | `gitlabhq/gitlabhq` | root `LICENSE` = preamble ("All content that resides under the "ee/" directory … is licensed under the license defined in "ee/LICENSE"") + MIT | `other` |
  | `PostHog/posthog` | same pattern as GitLab (preamble → `ee/LICENSE`, then MIT) | `other` |
  | `n8n-io/n8n`, `mattermost/mattermost`, `metabase/metabase` | custom/combined root licence plus `LICENSE_EE.md` / `LICENSE.enterprise` / `LICENSE-*.txt` | `other` |

  The big open-core projects mostly accept `other` and keep the preamble in `LICENSE` (today's
  layout). Documenso is the one found with exactly the planned layout: pure root licence, the
  separate licence inside the excluded directory, the scope stated next to it. No dual-licensed
  Obsidian plugin with a `pro/`-style split was found (GitHub code search for PolyForm in plugin
  repos turned up only this repo).
- **Does `pro/` need its own LICENSE?** The repo already has `pro/LICENSE` (PolyForm Strict), which
  is what GitLab, PostHog and Documenso all do (`ee/LICENSE`). Once the preamble leaves the root
  `LICENSE`, the root file no longer says that `pro/` is excluded, so the exclusion has to be stated
  elsewhere: `LICENSING.md`, the README licence section (already does), and optionally a per-file
  header in `pro/*.ts` (today they have none; the SPDX convention is
  `// SPDX-License-Identifier: LicenseRef-PolyForm-Strict-1.0.0`, as no SPDX id exists for
  PolyForm Strict — see Q4).
- **Point 3 of the preamble is a grant, not an explanation.** It gives everyone permission to
  redistribute the unmodified official build (which contains `pro/` code). PolyForm Strict alone
  forbids distribution. Wherever the preamble moves, that permission must stay in a document that
  reads as a grant from the copyright holder (e.g. `LICENSING.md` stated as such, or
  `LICENSE-COMMERCIAL.md`/`pro/`), and `pro/LICENSE` or its neighbour should point to it.

## 4. What should `package.json` `license` say afterwards?

- PolyForm Strict has **no SPDX id** (**SPDX** v3.29.0 lists only `PolyForm-Noncommercial-1.0.0`
  and `PolyForm-Small-Business-1.0.0`), so a full expression needs a `LicenseRef-`, e.g.
  `(Apache-2.0 AND LicenseRef-PolyForm-Strict-1.0.0)`.
- npm's validator flags any expression containing `LicenseRef` as invalid (**vnpl**: "a valid SPDX
  license expression (without "LicenseRef"), "UNLICENSED", or "SEE LICENSE IN <filename>"").
  **npm** documents `SEE LICENSE IN <filename>` for exactly this case, with the file at the top level.
- The Obsidian scanner does not read `package.json` (FAQ: it takes the licence from GitHub), and
  the package is `"private": true`, so this field only affects tooling and readers.
- So: **`"SEE LICENSE IN LICENSING.md"`** (whatever the explanation file is called). Leaving
  `SEE LICENSE IN LICENSE` would point at a file that then says plain Apache, which is wrong for
  `pro/`. `scripts/release-checks.mjs` line 34 (`const LICENSE = "SEE LICENSE IN LICENSE"`) and
  `package-lock.json` (`npm i --package-lock-only`) must change in the same commit, or the version
  gate fails.

## Open points for the spec

- Keep `LICENSE-COMMERCIAL.md` in the root (works on GitHub today per five repos) or move/rename it
  (independent of undocumented GitHub behaviour)?
- Accept that the store will show "Apache-2.0" for a plugin with a PolyForm part, and say so in the
  listing description?
- Where the redistribution grant (preamble point 3) lives after the move.
