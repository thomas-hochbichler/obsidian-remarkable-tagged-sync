# Research: which large plugins use `getSettingDefinitions()`, and how?

Ticket: `.scratch/settings-redesign/issues/02-plugins-on-the-new-api.md` (map `settings-redesign`).
Researched 2026-11-03. Every fact below comes from plugin source code (default branch HEAD as of
2026-11-03, read from shallow clones), `manifest.json` history, GitHub releases, GitHub issues, or
Obsidian's own repos. Where a link is not spelled out, the source is
`https://github.com/<repo>/blob/<HEAD>/<path>` for the repo, HEAD and file named in the table.

## Sources

| Short name | What | Version / location |
| --- | --- | --- |
| **stats** | `community-plugin-stats.json` (cumulative downloads) | `obsidianmd/obsidian-releases`, commit `6a3f2be` (2026-11-03 00:13 UTC) |
| **list** | `community-plugins.json` (id → repo) | same repo, same day; 9,864 plugins |
| **desktop** | `desktop-releases.json` commit history | `obsidianmd/obsidian-releases` |
| **d.ts** | `obsidian.d.ts` | npm `obsidian` 1.14.4 (`node_modules/obsidian/obsidian.d.ts` in the main checkout) |
| **Migrate** | "Migrate to declarative settings" guide | `obsidianmd/obsidian-developer-docs` `en/Plugins/Guides/Migrate to declarative settings.md` |
| **search** | GitHub code search `gh search code getSettingDefinitions` with `--language TypeScript/JavaScript` and `--extension ts/tsx/js/mjs` (100 hits each, the API cap), plus `--repo` searches | run 2026-11-03 |

## Timeline of the API (for reading the dates below)

- 1.13.0 typings with the "new preliminary API for new settings configuration options" were
  published 2026-05-04 (`obsidianmd/obsidian-api` commit "Update to 1.13.0…").
- 1.13.0 went to the **beta** (Catalyst) channel 2026-05-28; the **first public** 1.13 build was
  **1.13.4 on 2026-07-30** (desktop, commits `bfd7ab8`, `583c3d4`). Public is 1.15.0 since
  2026-11-02 (`eed197c`).
- So a plugin that set `minAppVersion: 1.13.x` before 2026-07-30 was invisible as an update to every
  user on public Obsidian. Local REST API says this in a commit (see §2, "The 1.13-before-public
  trap").

## Answer in one paragraph

Adoption is **real, not thin**: GitHub code search finds `getSettingDefinitions` in 294 repos, 226 of
them listed community plugins, and the search is a lower bound (it missed Templater, Tasks, Git,
Editing Toolbar and Linter, which `--repo` searches confirmed). Of the **top 20 plugins by downloads,
7 have truly moved** (Excalidraw, Templater, Tasks, Obsidian Git, QuickAdd, Editing Toolbar, Minimal
Theme Settings), **2 wrap their old UI in one `render` row** (Claudian, TaskNotes), **1 returns `[]`**
to opt out (Copilot), and **10 have no trace** (Dataview, Advanced Tables, Calendar, Style Settings,
Kanban, Remotely Save, Iconize, Omnisearch, Importer, Outliner). The plugins most like ours
(Self-hosted LiveSync, Local REST API, ZotLit, Obsidian Git, QuickAdd) all **keep complex UI in
`render` rows** and move whole areas onto **sub-pages** (`type: 'page'`); all four that hold a token
put `SecretComponent` in a `render` row — none of the 19 repos read uses the `secret` control type.
For user-added lists, the dominant pattern is `type: 'list'` with `addItem` → **modal**, one row per
entry whose `name`/`desc` summarise it, edit via modal (row `action` or a pencil extra button),
and `onDelete`/`onReorder` — Templater's *Folder templates* (folder → template) is almost exactly our
tag → folder shape. On `minAppVersion`: the majority went **straight to 1.13** (Templater, QuickAdd,
Git, Minimal, Homepage, Maps, Local REST API); the dual-path adopters either **dropped the old path
within weeks** (Tasks: "to stop maintaining two parallel sets of settings code"; Notebook Navigator,
Linter, Claudian, ZotLit all raised to 1.13+) or keep it by building **both paths from one page
model** (Excalidraw, LiveSync). Reported problems are concrete and avoidable (§5).

## 1. Adoption among the top 20 by downloads

Downloads from **stats**. "Adopted" = HEAD of the default branch implements `getSettingDefinitions()`
with real definitions (checked by reading the method, not just the search hit).

| # | Plugin | Downloads | Status at HEAD | `minAppVersion` now |
| ---: | --- | ---: | --- | --- |
| 1 | Excalidraw | 8,871,725 | **adopted, dual path** + user opt-out toggle | 1.8.7 |
| 2 | Templater | 6,087,034 | **adopted, 1.13-only** | 1.13.0 |
| 3 | Dataview | 5,249,533 | none (`--repo` search: 0 hits) | – |
| 4 | Tasks | 4,556,622 | **adopted**, dual path 8.5.0 → 1.13.1-only 8.6.0 | 1.13.1 |
| 5 | Obsidian Git | 3,393,481 | **adopted, 1.13-only** | 1.13.0 |
| 6 | Advanced Tables | 3,335,016 | none | – |
| 7 | Calendar | 3,242,157 | none | – |
| 8 | Copilot | 3,176,988 | **opt-out stub**: `getSettingDefinitions(): never[] { return []; }`, React UI in `display()` (`src/settings/SettingsPage.tsx`, commit `f40e8f87`, 4.0.14) | 1.11.4 |
| 9 | Style Settings | 2,820,091 | none | – |
| 10 | Kanban | 2,807,612 | none | – |
| 11 | Claudian | 2,603,210 | **shim**: one row `{ name: 'Claudian', searchable: false, render: … }` holding the whole old UI (`src/features/settings/ClaudianSettings.ts:57`) | 1.13.0 |
| 12 | TaskNotes | 2,544,688 | **shim**: one `render` row with tab names as `aliases`, `display()` kept (`src/settings/TaskNotesSettingTab.ts:58`) | 1.12.2 |
| 13 | Remotely Save | 2,352,830 | none | – |
| 14 | QuickAdd | 2,298,837 | **adopted, 1.13-only** | 1.13.0 |
| 15 | Iconize | 2,291,582 | none | – |
| 16 | Editing Toolbar | 2,122,870 | **adopted, dual path** (feature-detects `update`) | 1.4.5 |
| 17 | Omnisearch | 2,093,957 | none | – |
| 18 | Importer (obsidianmd) | 1,876,898 | none | – |
| 19 | Minimal Theme Settings | 1,874,945 | **adopted, 1.13-only** | 1.13.0 |
| 20 | Outliner | 1,477,106 | none | – |

Also checked, no hits: Smart Connections (1,258,678), Recent Files, Tag Wrangler, Readwise Official
(253,052), Zotero Integration (`mgmeyers/obsidian-zotero-integration`), Hypothes.is, Web Clipper and
Obsidian's sample plugin. Relay (226,615) is a second opt-out stub (`return [];`, commit message
"declare that the settings tab has no declarative definitions", 0.8.11). Opt-out stubs and shims are
counted in the 294/226 search figure, so that figure overstates real migrations.

Core plugins are closed source and could not be checked. The only open-source first-party plugin
found is **Maps** (`obsidianmd/obsidian-maps`, 70,728), which adopted in 0.2.0 with
`minAppVersion` 1.10.0 → 1.13.1 (§3.9).

## 2. Per adopter: version, `minAppVersion`, dual path

"Adopted in" = first release tag containing the first commit that added `getSettingDefinitions`
(`git log -S`), with the GitHub release date. `minAppVersion` history from `git log -- manifest.json`.

| Plugin (repo) | Downloads | Adopted in | `minAppVersion` before → at adoption → now | Path |
| --- | ---: | --- | --- | --- |
| Excalidraw (`zsviczian/obsidian-excalidraw-plugin`) | 8,871,725 | 2.26.0-beta.3 (2026-07-30, pre); first stable 2.26.1 (2026-08-03) | 1.8.7 → 1.8.7 → 1.8.7 | dual, kept |
| Templater (`silentvoid13/Templater`) | 6,087,034 | 2.21.0 (2026-06-02) | 1.12.2 → **1.13.0** → 1.13.0 | 1.13-only, while 1.13 was beta-only |
| Tasks (`obsidian-tasks-group/obsidian-tasks`) | 4,556,622 | 8.5.0 (2026-10-10) | 1.8.7 → 1.8.7 → **1.13.1** in 8.6.0 (2026-10-16) | dual, dropped after 6 days |
| Obsidian Git (`vinzent03/obsidian-git`) | 3,393,481 | 2.41.0 (2026-10-01) | (before not in clone) → **1.13.0** → 1.13.0 | 1.13-only |
| QuickAdd (`chhoumann/quickadd`) | 2,298,837 | 2.13.0 (2026-06-11) | 1.11.4 → **1.13.0** → 1.13.0 | 1.13-only, while 1.13 was beta-only |
| Editing Toolbar (`pkm-er/obsidian-editing-toolbar`) | 2,122,870 | 4.1.0 (2026-08-13) | 0.14.0 → 0.14.0 → 1.4.5 | dual, kept |
| Minimal Theme Settings (`kepano/obsidian-minimal-settings`) | 1,874,945 | 9.0.0 (2026-07-31) | 1.11.1 → **1.13.0** → 1.13.0 | 1.13-only, day after 1.13 public |
| Homepage (`mirnovov/obsidian-homepage`) | 1,422,872 | 4.5.0 (2026-09-02) | 1.12.2 → **1.13.0** → 1.13.0 | 1.13-only |
| Linter (`platers/obsidian-linter`) | 1,270,569 | 1.33.0-rc-1 (2026-07-20, pre); stable 1.33.0 (2026-09-11) | 1.12.0 → 1.12.0 (rc) → **1.13.0** at 1.33.0 → 1.14.4 at 1.35.0 | dual in rc, 1.13-only at stable |
| BRAT (`TfTHacker/obsidian42-brat`) | 1,146,322 | 2.1.0-beta.3 (tag only); stable 2.2.0 (2026-07-01) | 1.11.4 → 1.11.4 → 1.11.4 | dual, kept |
| Notebook Navigator (`johansan/notebook-navigator`) | 1,108,779 | 3.0.1 (2026-05-25) | 1.11.0 → 1.11.0 → **1.13.0** in 3.5.0 (2026-10-27) | dual, dropped after 5 months |
| Self-hosted LiveSync (`vrtmrz/obsidian-livesync`) | 1,075,094 | 1.0.19 (2026-08-25, pre) | 1.7.2 → 1.7.2 → 1.7.2 | dual, kept |
| Local REST API (`coddingtonbear/obsidian-local-rest-api`) | 833,715 | 5.0.0 (2026-07-24) | 1.8.7 → **1.13.1** → back to 1.8.7 in 5.0.2 → **1.13.1** again in 5.1.0 | 1.13-only (after a rollback) |
| Claudian (`YishenTu/claudian`) | 2,603,210 | 2.0.37 (2026-07-17), shim | 1.7.2 → 1.7.2 → **1.13.0** in 2.2.0 | shim |
| TaskNotes (`callumalpass/tasknotes`) | 2,544,688 | 4.12.1 (2026-08-08), shim | 1.12.2 → 1.12.2 → 1.12.2 | shim, dual |
| ZotLit (`aidenlx/zotlit`) | 83,152 | 2.0.0-beta.1 (2026-07-24, pre); stable 2.0.0 (2026-08-05) | 1.6.7 → **1.13.4** at 2.0.0 → 1.14.5 | 1.13-only at stable |
| Enveloppe (`Enveloppe/obsidian-enveloppe`) | 77,322 | **not released**: HEAD `8d7dd2a` (2026-07-31) is in no tag; latest stable 7.8.2 (2026-04-07) predates it | 1.11.14 → 1.13.1 at HEAD | 1.13-only (unreleased) |
| Maps (`obsidianmd/obsidian-maps`) | 70,728 | 0.2.0 (tag; latest 0.2.2 released 2026-08-01) | 1.10.0 → **1.13.1** → 1.13.1 | 1.13-only |

Counts: of 16 real adopters above (excluding the two shims), **9 went 1.13-only at once or at their
first stable** (Templater, Git, QuickAdd, Minimal, Homepage, Linter, Local REST API, ZotLit, Maps),
**2 ran dual and then dropped it** (Tasks, Notebook Navigator), **4 still run dual** (Excalidraw,
Editing Toolbar, BRAT, LiveSync); Enveloppe is unreleased.

### How the dual-path plugins do it

The rule from **d.ts** 9295: `display()` is "Not called when `getSettingDefinitions` returns a
non-empty array"; on < 1.13 `getSettingDefinitions` is never called. Patterns seen:

- **Two parallel implementations** (Tasks 8.5.0, BRAT, Notebook Navigator before 3.5.0). Tasks' class
  doc: "Obsidian picks the right path per host, so BOTH implementations must be updated whenever a
  setting is added, removed or changed" (`src/Config/SettingsTab.ts:70–80`). Tasks then filed #4079
  (2026-10-10): "I have ruled out maintaining both lots of code, as not a good use of contributor
  time", required 1.13.1 in 8.6.0 (commit `78276747e`, "chore: Require Obsidian 1.13.1 in
  manifest.json") and removed the version checks (`68a3bf2d2`); HEAD has no `display()` override.
- Notebook Navigator 3.4.0 and Linter 1.33.0-rc-1 did the same: "display() remains the fallback for
  Obsidian versions before native settings pages" (NN `src/settings.ts:62` at 3.4.0); "1.12.x
  fallback lives in display() above" (Linter `src/ui/settings.ts:141` at the rc).
- **One page model, two renderers** (Excalidraw): each page carries `buildDefinitions()` and
  `renderLegacy(container)` (`src/core/settings.ts:1200–1240`); `getSettingDefinitions()` returns
  `[]` when `requireApiVersion("1.13.0")` is false **or the user turned off** a toggle *Use
  searchable settings* ("Turn this off to use Excalidraw's legacy single-page settings. Requires
  restarting Obsidian.", `src/lang/locale/en.ts:473`).
- **Page catalogue with native and custom pages** (LiveSync): `getSettingDefinitions()` returns `[]`
  unless `requireApiVersion("1.13.0") && typeof SettingPage === "function"`; each catalogue entry is
  either `content: "native"` (declarative items) or a custom `SettingPage` subclass whose
  `display()` runs the old imperative page code (`ObsidianLiveSyncSettingTab.ts:822–1000`).
- **Feature detection** (Editing Toolbar): `display()` calls `this.update()` when it exists
  (`src/settings/settingsTab.ts:875`). BRAT gates only the 1.13.1 field: `search` on lists is
  returned only `if (requireApiVersion("1.13.1"))` (`src/ui/SettingsTab.ts:816`).

### The 1.13-before-public trap

Local REST API raised to 1.13.1 in 5.0.0, then rolled back two days later (commit `7889beb`,
2026-07-24): "Obsidian 1.13 … remains a Catalyst-only early-access release, which pins every
community-directory user to the 4.1.7 plugin release and makes the 5.x line unreachable", and restored
it on 2026-07-31 ("now that Obsidian 1.13 is public", `33d7bee`). Templater (2.21.0, 2026-06-02) and
QuickAdd (2.13.0, 2026-06-11) shipped `minAppVersion` 1.13.0 during the same beta-only window. This
no longer applies: 1.13 has been public since 2026-07-30 and 1.15.0 is public now (**desktop**).

## 3. How they handle complex UI

### 3.1 Lists of user-added items (our *Tag mappings*)

| Plugin | List | Add | Edit | Delete | Reorder | Row content |
| --- | --- | --- | --- | --- | --- | --- |
| Templater | *Folder templates*, *File regex templates*, *Startup templates*, *Template hotkeys*, *Excluded folders*, *User functions*, each on its own `page` (`src/settings/Settings.ts:476–967`) | `addItem` → modal | row `action` → same modal with current values | `onDelete` | `onReorder` | `name: folder`, `desc: template`; `emptyState: "No folder templates added."` |
| Tasks | *Custom statuses* (`src/Config/SettingsTab.ts:574–630`) | `addItem` → modal | pencil `addExtraButton` in a `render` row | `onDelete` ("no per-row delete button is needed") | – | symbol chip prepended to `nameEl`, type shown as a `flair` span |
| Maps (first-party) | *Backgrounds* (`src/settings.ts:109–158`) | `addItem` → modal | pencil extra button | trash extra button (not `onDelete`) | `onReorder` | name only: "Tile URLs can carry access tokens, so the row shows the name only" |
| BRAT | beta plugins, beta themes (`src/ui/SettingsTab.ts:541–580`) | `addItem` → modal | – | own button in `render`, two clicks (text changes to confirm) | – | `name: repository`, `desc` = tracked version |
| ZotLit | approved folders (`setting-tab/approved-folders.ts:58–80`) | `addItem` → folder picker | – | `onDelete` | – | `name: folder`, `searchable: false` |
| QuickAdd | *Template folders* (`src/quickAddSettingsTab.ts:205–240`) | `addItem` | – | `onDelete` | – | when empty, a plain `group` with one "Add folder" row instead of an empty list (search does not index empty lists, §5) |
| Linter | ignored folders, files, extensions, custom commands, custom regexes (`src/ui/settings.ts:247–405`) | helper | – | `onDelete` | – | `itemName`/`itemDesc` helpers |

Common to all: after a structural change (add, delete, rename) they call `this.update()` — Maps:
"Adding, removing or renaming a tile set changes the definitions themselves." (`src/settings.ts:154`).
**d.ts** 9284: `refreshDomState()` is the cheap call for `visible`/`disabled` changes, `update()` for
added/removed items.

No adopter in the sample shows a list of *discovered* items (entries the plugin finds, not the user
adds) with compact chips; the closest is Tasks' core statuses list, plain rows with an edit button.
Our unmapped-tag pills would be a custom `render` row.

### 3.2 Status lines and connection state

- **Page status** (`displayValue`, `status: 'warning'`, both 1.13.1, **d.ts** 8873–8881): Local REST API
  shows certificate state on the *Certificates* page entry (`displayValue` "Valid" / "Expires in N
  days" / "Expired", `status: 'warning'` for a legacy certificate, `src/main.ts:613–700`); QuickAdd
  shows provider count and a warning per AI provider page (`src/gui/ai/aiAssistantSettingsPage.ts:59–85`).
- **Live status in a row**: Local REST API's first, heading-less group starts with a *Server status*
  `render` row holding a URL table (`src/main.ts:626–642`); ZotLit's database row paints
  loading / refreshing / degraded / failed text into its description and adds a refresh extra button
  (`setting-tab/database.ts:175–200`).
- **Warning row**: Obsidian Git puts a "Git is not ready" row first with `visible: () =>
  !this.plugin.gitReady` (`src/setting/settings.ts:190–195`). (It also sets `status: "warning"` on that
  row; **d.ts** defines `status` only on pages.)

### 3.3 Secrets

All four plugins in the sample that store a token use **`SecretComponent` inside a `render` row**, not
the `secret` control type: Obsidian Git (`setting.addComponent(el => new SecretComponent(this.app, el))`,
mobile only, `src/setting/settings.ts:703–720`), BRAT (GitHub token, with validation,
`src/ui/SettingsTab.ts:120–135, 756`), QuickAdd (AI provider keys, `src/gui/ai/providerSettings.ts:29`),
Enveloppe (`src/settings/renders/github.ts:72`). A regex search over all 19 cloned repos for
`type: 'secret'` as a control found no use (QuickAdd's `type: "secret"` hits are its own user-script
option type).

### 3.4 Custom UI (`render` rows, full-width views)

- **Whole-tab wrap** (Claudian, TaskNotes): one `render` row, everything inside. Gains nothing in
  settings search (Claudian sets `searchable: false`; TaskNotes adds tab names as `aliases`).
- **Full-width views in rows** (QuickAdd): Svelte choice list and global variables are mounted in a
  `render` row whose `infoEl` is removed: "The declarative API requires a `name` on every definition
  (for search indexing); we set it on the def and remove the rendered `infoEl`"
  (`src/quickAddSettingsTab.ts:285–293`).
- **Custom page** (Obsidian Git *Line author information*, LiveSync custom pages): `type: 'page'`
  with `page: () => new (class extends SettingPage { display() {…} })` for a page that stays imperative.
- **Custom-content page** (Editing Toolbar): a `page` whose only item is one `render` row
  (`src/settings/settingsTab.ts:341–347`).

### 3.5 Grouping and order

- **Root = short index of pages** is the common shape for big tabs: Obsidian Git (pages *Automatic,
  Commit, Sync, Editor, Views, Interface, Identity, Advanced*, each with a one-line `desc`, then a
  *Support* group); Notebook Navigator (page links under group headings, plus a lazy tab class so
  "Startup search indexing stays lightweight", `src/settings/LazyNotebookNavigatorSettingTab.ts:25`);
  ZotLit (default-profile rows inline at the top "no top-level heading (per Obsidian style)", then one
  group of pages *Note import, Citations, Zotero, Attachments, Reader, Advanced*,
  `setting-tab/index.ts:56–118`); Excalidraw (pages built from a page model); LiveSync (pages with
  emoji in the names, `visible` by user level).
- **Root = groups, details on pages**: Templater (groups *Syntax highlighting, File creation, Startup
  templates, User scripts, User system commands*; lists on pages, a page `visible` only when its
  feature is on), Tasks (groups plus a *Statuses* page), Local REST API (heading-less status group,
  *Settings* group, pages for REST/MCP/certificates).
- `visible: () => …` is used everywhere for dependent settings (Templater shows *Folder templates* or
  *File regex templates* depending on a dropdown, `Settings.ts:476–495`).

### 3.6 Tests

Tasks (`tests/Config/SettingsTab.test.ts`), LiveSync (`ObsidianLiveSyncSettingTab.declarative.unit.spec.ts`),
QuickAdd (`aiAssistantSettingsPage.test.ts` asserts on the returned definitions' `status` and
`displayValue`) and ZotLit (a `*.test.ts` per setting-tab module) unit-test the **returned definition
tree**, not the DOM.

## 4. The plugins most like ours

Many integrations, long tab, connection state, tokens: Self-hosted LiveSync, Local REST API, ZotLit,
Obsidian Git, QuickAdd. What they share:

1. **Sub-pages per integration/area**, root kept short (all five).
2. **Status at the top**: a heading-less first group with a status `render` row (Local REST API), a
   conditional warning row (Git), or page `displayValue`/`status` (Local REST API, QuickAdd).
3. **Tokens via `SecretComponent` in a `render` row** (Git, QuickAdd; BRAT and Enveloppe likewise).
4. **Complex widgets stay imperative** inside `render` rows or custom `SettingPage`s (LiveSync,
   QuickAdd, ZotLit, Git) — none rebuilt them declaratively.
5. **Path**: Local REST API, ZotLit, Git and QuickAdd are 1.13-only; LiveSync keeps a dual path
   through its page catalogue. The two big AI/agent plugins with React/Svelte UIs (Copilot, Relay)
   opted out with `return []`.

## 5. Problems reported

| Problem | Source |
| --- | --- |
| A `render` callback that throws abandons the rest: QuickAdd's settings came up "as a lone 'Choices & packages' heading with nothing under it, and no other section rendered at all"; fixed with a guard in its mount helper. | QuickAdd `src/quickAddSettingsTab.ts:295–301`; issues #1451, #1507, #1566 ("A malformed folder in data.json blanks the whole settings tab"), #1584 |
| Settings search indexes list **items** only, not a list's heading or `emptyState`; QuickAdd's *Template folders* became unfindable. | QuickAdd #2057 |
| A `DocumentFragment` `desc` is used up on first render; revisiting a setting from search showed no description. Fix: return a fresh clone on each read. | Excalidraw #2935, fix `f5503b95` (`src/core/settings/reusableSettingFragments.ts`) |
| Re-render loop: calling `this.display()` (→ `update()`) from a component's change event that fires on every render made a dropdown unusable (~15 `getSettingDefinitions()` calls/s). | Editing Toolbar #372 (still open; maintainer comment: "Confirmed and fixed for 4.1.11") |
| Returning a malformed item (`{ type: "render" }`) blanks the tab, because 1.13 skips `display()` once the array is non-empty; plugin went back to `return []`. | `HarrySuen626/weave-epub-ai-reader#1` |
| CSS scoped to the tab's `containerEl` stops applying on sub-pages: "a `type: "page"` item renders into its own SettingPage container, which is not a descendant of containerEl". Scope classes to the row instead. | Local REST API `src/main.ts:575–580` |
| `visible: false` rows stay in the DOM as `display:none`, so a hidden first row still counts as `:first-child` and the next row draws a stray top border; ZotLit includes such rows conditionally instead. | ZotLit `setting-tab/resources.ts:26–32` |
| Definitions are a snapshot: the tab "does NOT re-render on store changes"; plugins subscribe to their store and call `update()` when the structure changes. | QuickAdd `src/quickAddSettingsTab.ts:86–104, 437` |
| `hide()` must call `super.hide()` now, because the framework tears down rows and runs `render` cleanups there. | QuickAdd `src/quickAddSettingsTab.ts:258–266` |
| Obsidian tears the tab down when a sub-page opens over it and re-renders it on return; QuickAdd keeps a heavy list mounted to avoid a ~300 ms remount. | QuickAdd `src/quickAddSettingsTab.ts:59–66`, #2150 |
| Adjacent 1.13 change, not the API: settings open in a **separate window** by default; copied `TextInputSuggest` code that appends to the main window's container shows no dropdown; QuickAdd saw late saves when the popout closes. | Mass-filed issues 2026-08-16/17, e.g. `anpigon/obsidian-book-search-plugin#162`; QuickAdd #2182, #1518 |

No adopter in the sample reported data loss caused by the API itself. (Templater #1770 "Lost all my
settings after update" was answered as an intentional security reset of three toggles.)

## 6. What this means for Tagged Sync (for ticket 04/06/07)

- The tag-mapping list has a proven template: `type: 'list'` on its own page or group, `addItem` →
  modal (pick tag + folder), rows `name: tag`, `desc: folder`, row `action` or pencil → modal,
  `onDelete`, `update()` after each change (Templater *Folder templates*, Maps *Backgrounds*). Give
  each row the tag as `aliases` and do not rely on the list heading for search (QuickAdd #2057).
- Unmapped-tag pills, the local-model card, the Readwise *Connection* line and device pairing have no
  declarative counterpart in any adopter; they will be `render` rows like everyone else's, with a
  try/catch around each (QuickAdd #1566).
- The Readwise token: `SecretComponent` in a `render` row is what every token-holding adopter does.
- The 1.13-before-public trap no longer applies; whether to keep a dual path is ticket 07. The
  evidence: dual paths survive only where one page model feeds both renderers (Excalidraw, LiveSync);
  hand-maintained parallel tabs were dropped (Tasks, Notebook Navigator).

## Method and limits

- GitHub code search caps at 100 results per query and indexes default branches only; five top-20
  adopters were missing from the global queries and were found with `--repo` searches. Treat 294/226
  as a lower bound that also counts stubs and shims.
- "Adopted in" is the first tag containing the first `getSettingDefinitions` commit; clones were
  shallow since 2026-04-01, so "before" values come from the commit before adoption.
- Issue search covered titles containing "setting" in each adopter repo since its adoption date,
  plus a global issue search for `getSettingDefinitions`; problems in issue bodies without that word
  in the title may be missed.
