# Research: can `getSettingDefinitions()` be offered without raising `minAppVersion`?

Ticket: `.scratch/store-scorecard-caution/issues/03-settings-api-compat.md` (map `store-scorecard-caution`).
Researched 2026-10-24 against `origin/main` (`cdfdf97`), `manifest.json` `minAppVersion` 1.5.7.

## Sources

| Short name | What | Version / location |
| --- | --- | --- |
| **d.ts** | `obsidian.d.ts` from the `obsidian` npm package | 1.13.1 (`node_modules/obsidian/obsidian.d.ts`) |
| **Migrate** | Obsidian developer docs, "Migrate to declarative settings" | https://docs.obsidian.md/plugins/guides/migrate-declarative-settings, source `obsidianmd/obsidian-developer-docs` `en/Plugins/Guides/Migrate to declarative settings.md`, last commit `c56c7e7` (2026-08-10) |
| **Settings** | Obsidian developer docs, "Settings" | https://docs.obsidian.md/Plugins/User+interface/Settings (read 2026-10-24) |
| **plugin** | `eslint-plugin-obsidianmd` | 0.4.1, `dist/lib/index.js`, `dist/lib/rules/settingsTab/*.js`, `dist/lib/rules/noUnsupportedApi.js`; repo https://github.com/obsidianmd/eslint-plugin |
| **probe** | Local `npx eslint src/settings-tab.ts` with temporary edits (reverted, not committed) | repo `eslint.config.mjs` = `obsidianmd.configs.recommended` |

Caveat: whether the store scanner runs plugin 0.4.1 with the same `recommended` preset is ticket 02
(parity). Everything below about lint is what 0.4.1 `recommended` does.

## Answer in one paragraph

Yes, it can be offered without raising `minAppVersion` — Obsidian documents exactly this as
"Path B: dual support" (keep `display()`, add `getSettingDefinitions()`; 1.13+ uses the definitions,
older versions use `display()`). But **adopting the API does not remove the 18 `no-deprecated`
findings**: they are not on the `display()` *definition* but on the 18 `this.display()` *calls* used to
redraw the tab. Those calls go away by routing redraws through one helper (`this.update()` on 1.13+
behind a `requireApiVersion` guard, a private imperative render method below that), which is a
refactor independent of whether the declarative path exists. An inline `eslint-disable` is **not**
scanner-legal here: `@typescript-eslint/no-deprecated` and `obsidianmd/*` are on 0.4.1's
`no-restricted-disable` list, so a disable turns a warning into an error.

## 1. What does `getSettingDefinitions()` cover?

Far more than simple fields. The return type is `SettingDefinitionItem[]` (d.ts 6147):

- **Controls** (`SettingDefinitionControl`, d.ts 6031; `SettingControl` union, d.ts 5878): toggle,
  dropdown, text, textarea, number, file, folder, slider, color — bound by `key`, saved by Obsidian.
  Each control has `defaultValue`, `validate`, and `disabled?: boolean | (() => boolean)` (d.ts 5884–5925).
- **Action rows** (`SettingDefinitionAction`, d.ts 5938): a clickable row running a callback.
- **Render rows** (`SettingDefinitionRender`, d.ts 6265): `render: (setting: Setting, group) => void | cleanup`
  — the escape hatch that hands you an ordinary imperative `Setting` row. Docs: "Use a `render` callback
  when the setting needs anything beyond a simple bind: side effects, custom UI" (Settings, "Render
  callback"); multi-button rows and standalone buttons "use `render` or `action`" (Settings, "What's not
  yet a first-class control"). A `render` row does **not** auto-save (Migrate, "Common pitfalls").
- **Empty rows** (`SettingDefinitionEmpty`, d.ts 6053): name + desc only (info text).
- **Groups** with heading, `extraButtons`, `visible` predicate, and (1.13.1) an in-group search
  (`SettingDefinitionGroup`, d.ts 6079–6140).
- **Lists** for mutable collections with `onDelete`, `onReorder`, `addItem`, `emptyState`
  (`SettingDefinitionList`, d.ts 6157).
- **Sub-pages**, declarative (`items`) or imperative (`page: () => SettingPage`, a class with its own
  `display()`), plus 1.13.1 `displayValue` / `status: 'warning'` (`SettingDefinitionPage`, d.ts 6202–6259).
- Every item: `visible`, `searchable`, `aliases`, `desc: string | DocumentFragment` (d.ts 5990–6025).
- Storage: `PluginSettingTab.getControlValue/setControlValue` read/write `this.plugin.settings` by
  default and may be overridden (d.ts 5160–5173; Settings, "Custom settings storage", incl. dot-notation
  keys for nested settings).
- Refresh: `update()` re-runs `getSettingDefinitions()` for structural changes; `refreshDomState()`
  re-evaluates `visible`/`disabled` without re-render (d.ts 6585–6628).
- Constraint: `getSettingDefinitions()` runs on every `update()` and once at registration for search
  indexing — "no I/O, no network calls" (Migrate, "Common pitfalls"; d.ts 6577–6583).

**Fit with `src/settings-tab.ts`:** everything is expressible, but much of it only through `render`:

| Our pattern | Declarative fit |
| --- | --- |
| Section headings (`setHeading()`) | `group.heading` |
| Plain toggles / text / dropdowns (Handwritten notes, attachments folder, send tag, interval) | `control`, but our state lives in `plugin.data` (not `plugin.settings`) and is partly nested (`zotero.*`, `autoSync.*`) → override `getControlValue`/`setControlValue` |
| Changes with side effects (`invalidateRenders`, `setFrontmatterEnabled` with set-back, `rearmAutoSyncInterval`, debounced saves, Zotero `recheck`) | `render` (or a branching `setControlValue`) |
| Dropdowns with individually **disabled options** ("(Pro)" transports, unavailable OCR backends) | `SettingDropdownControl` has only `options: Record<string,string>` (d.ts 6291) → `render` |
| Pro-gated rows shown disabled | `disabled` predicate on control; label text unchanged |
| Conditional rows (pairing vs. paired, auto-sync sub-rows, key row under cloud switch, tag routing only when connected) | `visible` predicates + `refreshDomState()`/`update()` |
| Multi-button rows (Re-pair/Forget, Buy/Trial/Manage/Deactivate), password field + Pair | `render` |
| Async status lines (Zotero probe, "Looking up your groups…"), `<details>` pairing help | `render` (network must stay out of `getSettingDefinitions()`) |
| Tag routing rows from `planTagRouting`, group libraries | `group`/`list` items built per `update()` |
| Backend-specific rows: `ocrBackendEntry(id).renderSettings(containerEl, ctx)` (`src/ocr-registry.ts:124`, implemented in `local-register.ts`, `localhost-register.ts`, `pro/llm-register.ts`) | writes straight into a container → needs a `render` wrapper per row or an imperative `SettingPage`; registry contract would change |
| Scroll-position restore in `display()` | not needed (framework renders) |

So the gain is real (global settings search, framework rendering on 1.13+), but the declarative tab
would be largely `render` callbacks — a second, parallel implementation of most of the tab.

## 2. Can a tab implement both, and does 1.13 then ignore `display()`?

Yes, and it is the documented pattern.

- d.ts 6630–6641 (`SettingTab.display`): "Not called when `getSettingDefinitions` returns a non-empty
  array; the tab is rendered declaratively from those definitions instead. Only implement display() as
  a fallback for plugins that need to support Obsidian versions older than 1.13.0." `@deprecated Since
  1.13.0`.
- Migrate, "Choosing a path": `minAppVersion < 1.13.0` and adopting the new API → "Path B: keep
  `display()` and add `getSettingDefinitions()` alongside it." Path B: "On Obsidian 1.13.0+,
  `getSettingDefinitions()` is called and `display()` is skipped. On Obsidian < 1.13.0, `display()` runs
  as it always has." Warning: "The two implementations must stay in sync … If the maintenance overhead
  isn't worth it, prefer Path A and bump `minAppVersion`."
- Settings: "The imperative API remains supported indefinitely as a fallback on 1.13+."
- The lint plugin is built for this: `settings-tab/require-display` **requires** a `display()` while
  `minAppVersion < 1.13.0` (`requireDisplay.js`); `settings-tab/no-deprecated-display` and
  `prefer-update-over-display` only switch on once `minAppVersion >= 1.13.0` (`noDeprecatedDisplay.js`,
  `preferUpdateOverDisplay.js`, `DECLARATIVE_MIN_VERSION = "1.13.0"` in `shared.js`).
- Corollary: if `getSettingDefinitions()` returns `[]`, 1.13 still calls `display()` (d.ts 6633).

Refresh in dual mode: on 1.13+ "calling `display()` won't refresh anything declarative" — call
`this.update()` (Migrate, "Common pitfalls"). `update()` is `@since 1.13.0`, so with `minAppVersion`
1.5.7 `obsidianmd/no-unsupported-api` (error in `recommended`) flags it unless it sits inside
`if (requireApiVersion("1.13.0"))`, a `?:` or `&&` guard — that guard is recognised
(`noUnsupportedApi.js` 135–181). Defining the method `getSettingDefinitions()` and using its types is not
flagged (the rule checks member expressions, calls, `new`, and superclasses only).

## 3. Which of the 18 `no-deprecated` findings would that remove?

**None by itself.** All 18 are on `this.display()` *calls*; the `display()` *definition* (line 93) is not
reported. `prefer-setting-definitions` is the 19th finding, at line 79:14 (class name).

| Line | Redraw after … |
| --- | --- |
| 162 | "Sync from" dropdown change |
| 180 | "If that is not reachable" dropdown change |
| 213 | Re-pair |
| 224 | Forget device |
| 323 | `pairDevice()` `finally` |
| 340 | Cloud disconnect |
| 370 | Cloud connect |
| 421 | Start free trial |
| 439 | Deactivate this vault |
| 472 | Activate licence key |
| 659 | Zotero desktop-app switch |
| 760 | Zotero groups lookup answered |
| 894 | OCR backend dropdown |
| 904 | backend `selectDefaultBackend` (ctx passed to `renderSettings`) |
| 925 | auto-sync `persist()` |
| 1017 | Discover tags (Scan) |
| 1039 | tag routing `persist()` |
| 1066 | licence re-check refused a mapping |

Mechanism: typescript-eslint's `no-deprecated` reports *references* to a deprecated symbol; the
override's call `this.display()` resolves to the deprecated `SettingTab.display` signature. Probes
(reverted):

- Adding `getSettingDefinitions() { return []; }` → `prefer-setting-definitions` 1 → 0,
  `no-deprecated` stays 18. (The rule only checks that a member with that name exists —
  `preferSettingDefinitions.js` 17–27 via `findClassMember`. An empty one satisfies the linter but
  changes nothing for users and is visibly hollow to a human reviewer.)
- `display() { this.redraw(); }` plus one call site switched to `this.redraw()` → that site disappears,
  the `display()` override is still not reported. Routing all 18 calls through a private method removes
  all 18, with or without the declarative path.

What a real Path B would look like for redraws: one helper, e.g.
`refresh() { if (requireApiVersion("1.13.0")) this.update(); else this.renderImperative(); }`, where
`display()` just calls `renderImperative()`. Result: 0 `no-deprecated`, 0 `no-unsupported-api`,
0 `prefer-setting-definitions` (with a non-empty definitions array). Inside the imperative path the
redraws can call `renderImperative()` directly, since that path never runs on 1.13+ once definitions are
non-empty.

## 4. Is a scoped, described `eslint-disable` scanner-legal for the fallback?

**No, not for these rules.** 0.4.1 `recommended` sets `eslint-comments/no-restricted-disable` at error
for `obsidianmd/*` and `@typescript-eslint/no-deprecated` among others (`dist/lib/index.js` 268–284;
same finding as predecessor ticket `store-scorecard-fixes/01`, which found scoped disables legal only
for rules *off* that list, e.g. `no-unsafe-*`). Probe: `// eslint-disable-next-line
@typescript-eslint/no-deprecated -- fallback redraw for Obsidian < 1.13` on line 162 → that warning
gone, replaced by `eslint-comments/no-restricted-disable` severity 2 ("Disabling
'@typescript-eslint/no-deprecated' is not allowed."). Net worse. The fallback needs no disable anyway:
defining `display()` is not reported (question 3).

## Consequence for the map

- The 18 `no-deprecated` findings are removable at `minAppVersion` 1.5.7 by a redraw-helper refactor
  alone; this belongs in the spec and does not depend on the declarative API.
- The 1 `prefer-setting-definitions` finding is removable at 1.5.7 only by implementing
  `getSettingDefinitions()` (Path B, a second implementation kept in sync with `display()`, mostly
  `render` callbacks, registry `renderSettings` contract to adapt) — or trivially by an empty one, which
  is linter-gaming. Raising `minAppVersion` to 1.13 (Path A) is not *required* for any of the 19.
- So the `minAppVersion` fog item is not forced by lint; it becomes a cost question (two
  implementations vs. dropping < 1.13 users).
