# Research: stay at `minAppVersion` 1.5.7 or raise to 1.13?

Ticket: `.scratch/settings-redesign/issues/01-min-app-version.md` (map `settings-redesign`).
Researched 2026-11-03 against `feature/settings-redesign` (`7eeb958`), `manifest.json` `minAppVersion`
1.5.7, plugin version 1.10.0. Extends `docs/research/settings-api-compat.md` on branch
`research/settings-api-compat` (2026-10-24); what that note settled is not repeated: Path B works at 1.5.7,
lint does not force the raise, the 18 `display()` calls are gone through `redraw()`.

This note gathers facts. It does not pick a path; that is ticket 07.

## Sources

| Short name | What | Version / location |
| --- | --- | --- |
| **d.ts** | `obsidian.d.ts` | npm `obsidian` 1.14.4: the version `package-lock.json` resolves `^1.13.1` to on `feature/settings-redesign` |
| **Migrate** | Developer docs, "Migrate to declarative settings" | `obsidianmd/obsidian-developer-docs` `en/Plugins/Guides/Migrate to declarative settings.md`, last commit `c56c7e7` (2026-08-10) |
| **Settings** | Developer docs, "Settings" | same repo, `en/Plugins/User interface/Settings.md`, last commit `c56c7e7` (2026-08-10) |
| **Versions** | Developer docs, "Versions" (`versions.json`) | same repo, `en/Reference/Versions.md`, last commit `a21f5dc` (2025-12-29); https://docs.obsidian.md/Reference/Versions |
| **Submission** | Developer docs, "Submission requirements for plugins" | same repo, `en/Community directory/Submission requirements for plugins.md` |
| **releases** | `obsidianmd/obsidian-releases` README, "How community plugins are pulled" | https://github.com/obsidianmd/obsidian-releases (read 2026-11-03) |
| **desktop** | `obsidianmd/obsidian-releases` `desktop-releases.json` and its commit history | read 2026-11-03; current `latestVersion` 1.15.0, `minimumVersion` 1.1.9 |
| **stats** | `obsidianmd/obsidian-releases` `community-plugin-stats.json` | read 2026-11-03 |
| **Update help** | Obsidian Help, "Update Obsidian" | `obsidianmd/obsidian-help` `en/Getting started/Update Obsidian.md`; https://obsidian.md/help/updates |
| **CL 1.13** | Obsidian changelog, "Obsidian 1.13 Desktop (Public)", 2026-07-30 | https://obsidian.md/changelog/2026-07-30-desktop-v1.13.4/ |
| **lint** | `eslint-plugin-obsidianmd` | 0.4.2 (lockfile), `dist/lib/rules/settingsTab/*.js` |
| **forum** | Obsidian forum threads, answered by moderator WhiteNoise | https://forum.obsidian.md/t/plugin-update-problem/43812 (2022-09-22); https://forum.obsidian.md/t/community-plugin-wrong-version-when-installing-and-updating/28339 (2021-12) |
| **code** | This repo, `feature/settings-redesign` `7eeb958` | `src/settings-tab.ts`, `src/local-register.ts`, `src/localhost-register.ts`, `src/local-model-card.ts`, `src/ocr-registry.ts`, `src/main.ts`, `pro/llm-register.ts`, `tests/stubs/fake-obsidian.ts`, `versions.json` |
| **issues** | This repo's GitHub issues by people other than the maintainer | 46 issues, read 2026-11-03 |

## Answer in one paragraph

Nobody publishes how many Obsidian installs run which version. Obsidian has no public numbers, and
obsidianstats.com has none either; the only per-version signal for this plugin is the Obsidian version
users paste into issues, and 5 of the 6 reporters who gave one were on 1.13.7 or newer. Desktop Obsidian updates itself
on restart unless the user turned automatic updates off. 1.13 has been the public build since
2026-07-30, 1.11.4 since 2026-01-12, and the current public build is 1.15.0. The one structural group
that cannot reach 1.13 by auto-update is installers older than 1.1.9 (December 2022): the update feed
stopped serving them at 1.12.7 on the same day 1.13.4 went public. Raising `minAppVersion` takes no
plugin away from anyone: Obsidian reads `versions.json` and offers users below the floor the newest
release that still fits, which for this repo would be the last 1.5.7 release. The updates they miss are
missed silently. Obsidian's docs say "Prefer Path A whenever you can" and to keep Path B only for "an
existing user base on Obsidian < 1.13.0 that you can't drop". In this repo, Path B means 60 `Setting`
rows across 4 files, drawn once by `display()` and again by `getSettingDefinitions()`, plus a
`renderSettings` contract that writes straight into a container. A 1.13 floor would also remove the
three 1.11.4 Keychain guards and the three `mod-warning` workarounds, and it would make the redraw
helper a plain `update()`.

## 1. Which Obsidian versions do users run?

**No reliable adoption number exists.** Searched for one in the places below and found none. No
number below is an estimate.

- Obsidian publishes no app-version distribution. Its public data feeds are `community-plugins.json`
  and `community-plugin-stats.json`, which count plugin downloads per *plugin* version, and
  `desktop-releases.json`, which holds the update feed (**releases**, **stats**, **desktop**). None of
  them says which *app* version is running.
- obsidianstats.com shows plugin and theme counts and plugin updates. It has no app-version or
  `minAppVersion` data (front page, read 2026-11-03).
- moritzjung.dev/obsidian-stats counts GitHub release-asset downloads per Obsidian release. That is a
  count of installer downloads, not of running app versions, and it comes from a community member,
  not from Obsidian. It cannot answer the question.
- **This plugin's own signal** (**issues**): the "Copy diagnostics" block prints `apiVersion`
  (`src/settings-tab.ts:992`). Of 46 issues by other people, 7 carry an Obsidian version, from 6
  reporters: 1.12.7 (#10, 2026-08-08), 1.13.7 (#69 and #73 by one reporter, #101, #156, #160;
  2026-08-22 to 2026-09-13), 1.14.4 (#211, 2026-10-18). That makes 5 of 6 reporters on 1.13 or newer,
  and none below 1.11.4. The sample is tiny and self-selected (people who file issues).
- Plugin size, for scale (**stats**): `remarkable-tagged-sync` has 2,370 downloads in total. The
  per-version counts (for example 1.10.0: 43, 1.9.2: 82) count installs plus updates, not users, and
  say nothing about app versions.

**How the desktop app updates** (**Update help**):

- "Obsidian on desktop devices regularly checks for new updates. If automatic updates are enabled,
  the application will update on restart." The user can turn this off under *Settings → General →
  Automatic updates*. How many users do that is not published.
- There are two versions. The *app* version (the downloaded `asar`) updates itself. The *installer*
  version "is the version of Electron … and it cannot be updated by the automatic update process"; the
  user has to download and run a new installer. `apiVersion`, `requireApiVersion()` and the store's
  `minAppVersion` check all go by the **app** version (d.ts: `requireApiVersion` "Returns `true` if
  the API version is equal to or higher than the requested version"). So an old installer does not
  block a 1.13 floor as long as the app version reaches 1.13.
- **Exception, and the one hard group (desktop):** on 2026-07-30 the commit "Update public to
  v1.13.4. Bump minimum installer to 1.1.9." raised `minimumVersion` in `desktop-releases.json` from
  0.14.5 to 1.1.9. Read from the field name and that commit message (Obsidian documents neither):
  an installer older than 1.1.9 (public 2022-12-23) no longer gets app updates and stays on 1.12.7.
  These users cannot pass a 1.13 floor without reinstalling. They do pass the 1.11.4 Readwise gate.
- **CL 1.13**: "The installer has been updated to use Electron v43.1.1. To upgrade, … visit the
  Obsidian download page and reinstall Obsidian." That reinstall is optional, since 1.13.4 reached
  installers ≥ 1.1.9 through the feed. The same release fixed "the app silently crashing on any
  installer older than Obsidian 1.6".

**Release timeline** (public channel, from the commit history of **desktop**):

| Version | Public since | Note |
| --- | --- | --- |
| 1.5.7 | never public | early access only (2024-02-20); first public 1.5.x after it is 1.5.8 (2024-02-22) |
| 1.11.4 | 2026-01-12 | Keychain (`SecretStorage`, `SecretComponent`); the Readwise gate |
| 1.12.7 | 2026-03-23 | last public build before 1.13; final build for installers < 1.1.9 |
| 1.13.0 to 1.13.3 | never public | early access 2026-05-28 to 2026-07-21 |
| 1.13.4 | 2026-07-30 | first public 1.13; `minimumVersion` installer raised to 1.1.9 |
| 1.13.7 | 2026-08-12 | |
| 1.14.4 | 2026-10-05 | |
| 1.15.0 | 2026-11-02 | current public |

So when 1.11.0 ships (before 2026-11-24, ground rule 7), 1.13 will have been the public build for
about four months. Every public 1.13 build is 1.13.4 or later, so a floor of `1.13.0`, `1.13.2` or
`1.13.4` reaches exactly the same public users.

## 2. What happens to a user below a raised `minAppVersion`?

- **The store keeps serving the last compatible version.** **releases**: "If your `manifest.json`
  requires a version of Obsidian that's higher than the running app, your `versions.json` will be
  consulted to find the latest version of your plugin that is compatible." **Versions** says the same
  and shows the fallback with an example ("the most recent plugin version for 1.1.0 is 0.12.0").
- **This repo is ready for that.** `versions.json` lists all 38 releases (1.0.0 to 1.10.0, values
  1.5.0 / 1.5.7), and `scripts/release-checks.mjs:104-112` fails a release whose `versions.json` entry
  does not match `manifest.minAppVersion`. If 1.11.0 moves to 1.13, every user below 1.13 is offered
  1.10.0 (or the last release still marked 1.5.7) to install and to update to.
- **Can they still install?** Yes, the fallback version (**releases**, **Versions**).
- **Is it silent?** As far as public sources go, yes. No developer doc describes a notice to the user.
  In 2022, forum moderator WhiteNoise answered a user who saw "nothing happens" on update with "You
  have the latest version of plugins your Obsidian version supports" (**forum**, 43812). That answer
  is about Obsidian's behaviour in 2022, and it comes from a moderator, not from the docs. Not checked
  in a 1.12 app.
- Consequence for this plugin: users below 1.13 keep a working 1.10.x but stop getting fixes. With
  1.11.0, that means Readwise and any later fix (for example a reMarkable format change). The README
  or changelog line is the only place they could learn why.
- **Submission** asks only that `minAppVersion` "should be set to the minimum required version …
  If you don't know …, use the latest stable build number." It neither rewards a low floor nor
  penalises a high one.

## 3. What Obsidian's docs recommend, and what Path B costs here

**Recommendation (Migrate, "Choosing a path"):**

- `>= 1.13.0` → Path A: "implement `getSettingDefinitions()` only. Delete `display()`."
- `< 1.13.0` and adopting → Path B: "keep `display()` and add `getSettingDefinitions()` alongside it."
- `< 1.13.0` and no need for the new features → "Leave the plugin as-is. The new API is opt-in."
- "Prefer Path A whenever you can; it's simpler and avoids maintaining two implementations. Choose
  Path B only if you have an existing user base on Obsidian < 1.13.0 that you can't drop."
- Path B end state: "Once your user base on < 1.13.0 is small enough, delete the `display()` method and
  bump `minAppVersion` to `1.13.0`."
- Warning: "Every time you add or change a setting, update both … Drift between the two means users on
  different Obsidian versions see different settings. If the maintenance overhead isn't worth it,
  prefer Path A."
- **Settings** adds: "The imperative API remains supported indefinitely as a fallback on 1.13+". So
  staying on `display()` alone at 1.5.7 (the third row) remains allowed. It would just give up the
  global settings search and the declarative rendering.

**What would exist twice in this codebase** (**code**, `feature/settings-redesign` `7eeb958`):

| Where | `new Setting(` rows | How it draws |
| --- | --- | --- |
| `src/settings-tab.ts` (1258 lines) | 52 | 14 `render*` methods called from `redraw()` (lines 109-137) |
| `src/local-register.ts` | 2 (+ card from `src/local-model-card.ts`) | `renderSettings(containerEl, ctx)` of the registry entry, line 428; own `redrawCard` |
| `src/localhost-register.ts` | 3 | `renderSettings`, line 312 |
| `pro/llm-register.ts` | 3 | `renderSettings`, line 242 |
| **total** | **60** | |

- The contract `OcrBackendEntry.renderSettings?(containerEl: HTMLElement, ctx)` (`src/ocr-registry.ts:124`)
  writes rows straight into a container. A declarative tab can host it only inside a `render` row or an
  imperative sub-page. Either way, both paths share the backend rows unchanged, and these rows stay
  imperative on 1.13 too.
- **How the two paths can share code.** A `render` definition receives a ready `Setting`
  (`render: (setting: Setting, group) => …`; see the prior note §1). If each row builder is refactored
  from `new Setting(containerEl).…` to `(setting: Setting) => …`, then `display()` and
  `getSettingDefinitions()` both call the same builders. What still exists twice is the *structure*:
  order, groups and headings, `visible` conditions versus the `if`s in `render*`, and the redraw paths.
  Rows that become real `control`s (toggles, text, dropdowns; values in `plugin.data`, partly nested,
  so `getControlValue`/`setControlValue` are overridden; prior note §1) are written a second time in
  the declarative form, and their side effects (`invalidateRenders`, `rearmAutoSyncInterval`, the
  Readwise `refreshStatus`) move into `setControlValue` or stay `render`.
- **The redesign doubles the price.** Ground rules 3, 4 and 6 change the order, the groups and Tag
  routing (pills). Under Path B, either `display()` gets the new layout as well, and pills, the
  compact unmapped list and the new group order are built twice, or `display()` stays frozen as
  today's layout for users below 1.13. The second option is cheaper, but those users see a different
  tab, which is the "drift" the docs warn about. Ticket 07 picks one of the two.
- **Redraws:** under Path B, `redraw()` (`src/settings-tab.ts:109`) becomes
  `requireApiVersion("1.13.0") ? this.update() : <imperative redraw>`, the shape the prior note §3
  already gives. Its scroll-restore code (lines 111-136) stays for the imperative path only.
- **Tests:** `src/settings-tab.test.ts` (1930 lines) drives `display()` through
  `tests/stubs/fake-obsidian.ts`. The stub can already pretend to be an older Obsidian
  (`requireApiVersion` override, lines 185-204). Path B needs tests for both the definitions and the
  imperative tab. Path A needs only the definitions. Either way, the stub needs a minimal declarative
  renderer (or the tests need to walk the definitions array), and that work is the same for both
  paths.
- **Lint** (0.4.2): at 1.5.7, `settings-tab/require-display` demands a `display()` (prior note §2).
  At ≥ 1.13.0, `no-deprecated-display` reports a `display()` that sits beside a `getSettingDefinitions()`,
  and `prefer-update-over-display` reports every `this.display()` call
  (`noDeprecatedDisplay.js` 19-23, `preferUpdateOverDisplay.js` 20-25, `DECLARATIVE_MIN_VERSION = "1.13.0"`).
  So the linter steers each floor to its own path and does not tolerate a mixed form.

## 4. What else a 1.13 floor unlocks or removes here

| Today at 1.5.7 | At a 1.13 floor | Source |
| --- | --- | --- |
| `requireApiVersion("1.11.4")` guards: `src/settings-tab.ts:867` (Readwise heading + "Needs Obsidian 1.11.4 or newer."), `:917` (second guard so lint sees it), `src/main.ts:897` (`readwiseToken()`) | all three go, along with the one-sentence fallback for old apps; `secretStorage` and `SecretComponent` (d.ts `@since 1.11.4`/`1.11.1`) become plain calls | **code**, d.ts 1383, 8115, 8138 |
| Destructive buttons via `buttonEl.addClass("mod-warning")`: `src/settings-tab.ts:954` (Readwise *Start over*), `:1254` (tag *Remove*), `src/local-register.ts:303` (model *Delete*); `setWarning()` is `@deprecated` | `button.setDestructive()` (d.ts 2343, `@since 1.13.0`) | **code**, d.ts 2330-2343 |
| `redraw()`: private imperative redraw with scroll restore | `this.update()` / `refreshDomState()` (d.ts 9253, 9290); the framework keeps the scroll position | **code**, d.ts |
| Readwise token is a `SecretComponent` inside `addComponent` | declarative `control: { type: 'secret' }` (d.ts 9163, `@since 1.13.2`; every public 1.13 build is ≥ 1.13.4). Not yet in **Settings**' control-type table (last edited 2026-08-10), so the d.ts is the only source | d.ts 9157-9169 |
| Not available | group `search` (`@since 1.13.1`), page `displayValue`/`status: 'warning'` (`@since 1.13.1`), `Setting.addDisplayValue` (`@since 1.13.1`), slider `displayFormat` | d.ts 3496-3521, 8275, 8749-8763, 8873-8881, 9202 |
| `display()` kept (lint `require-display`) | `display()` deleted; Path A is the documented target | **Migrate**, **lint** |

**What a 1.13 floor does not change:** whether the Readwise section exists. It needs 1.11.4 today, and
1.13 is above that. The `renderSettings` contract also stays: backend rows are `render` rows in both
paths. Anything after 1.13.x (`@since 1.14.3`/`1.14.4`: `TExternalFile`, a frontmatter `groupOrder`)
is not settings-related.

## Trade-off for ticket 07

| | Stay at 1.5.7 (Path B, or `display()` only) | Raise to 1.13 (Path A) |
| --- | --- | --- |
| Who loses updates | nobody | users on app < 1.13: auto-update turned off, or installer < 1.1.9 (stuck on 1.12.7); they keep 1.10.x silently. Size unknown; 1 of 6 issue reporters (1.12.7, 2026-08) |
| Code | 60 rows: shared builders but two structures (or a frozen old tab); redraw branches; both paths tested | one tab; delete `display()`, the `redraw()` scroll code and 3 version guards; `setDestructive()` |
| Redesign | new layout either twice or only for 1.13+ (drift) | once |
| Docs' advice | "only if … a user base on < 1.13.0 that you can't drop" | "Prefer Path A whenever you can" |
| Readwise (1.11.0) | gate at 1.11.4 stays | gate goes away |
| Reversible | the later step to Path A remains open ("Once your user base on < 1.13.0 is small enough…") | lowering the floor again would require a `display()` again |

Middle ground, if ticket 07 wants one: ship the declarative tab with Path B and *freeze* today's
`display()` (with no new layout) for users below 1.13, then raise the floor in a later release. That is
the documented end state of Path B. The cost is a known drift between the two tabs.
