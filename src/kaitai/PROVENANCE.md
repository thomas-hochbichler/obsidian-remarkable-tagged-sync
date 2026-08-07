# Provenance: rmv6 `.rm` parser

Clean-room. This parser was built from public specs and reference
implementations only; **Tim Dommett's `Remarkable-Sync---Obsidian-Plugin`
(GPL-3.0) was never read, opened, or referenced** at any point.

## Sources

- **`rmv6.ksy`** (Kaitai Struct spec): vendored from
  https://github.com/YakBarber/remarkable_file_format, commit as of
  2026-07-19. License: MIT (Copyright (c) Barry Van Tassell).
- **rmscene** (https://github.com/ricklupton/rmscene), a Python v6 reader.
  License: MIT (Copyright (c) 2023 Rick Lupton). Consulted to cross-check
  and correct the parts of `rmv6.ksy` below — this is the same reference
  the project's build spec (`.scratch/tagged-sync-plugin/spec.md`, §3)
  names as the intended clean-room source for the parser.
- **rmc** (https://github.com/ricklupton/rmc), the SVG/PDF exporter by
  rmscene's author, `main` as of 2026-08-06. License: MIT (Copyright (c)
  Rick Lupton). Consulted for **the y half of scene-tree group placement
  only**: `exporters/svg.py`'s `get_anchor` / `build_anchor_pos` /
  `draw_group` — that a group's y comes from the laid-out line position of
  the character its `anchor_id` names, the paragraph accumulator that
  computes it, and the two reserved `anchor_id` sentinels for top and
  bottom of the text. Its constants (`TEXT_TOP_Y`, `LINE_HEIGHTS`) are
  treated as starting values to be measured against device output, not as
  delivered values — rmc itself documents the line height as fitted. The x
  half (`anchor_origin_x` as a translation in the stroke frame) was derived
  from our own files and is not owed to rmc. No rmc code is copied or
  bundled; rmc is Python, this plugin is TypeScript.
- Test fixtures: also from rmscene's `tests/data/` (MIT). See
  `/test-fixtures/rmv6/FIXTURES.md`.
- `kaitai-struct-compiler` (devDependency, generates `rmv6-generated.js`
  from `rmv6.ksy`) is GPL-3.0-licensed, but is a build-time tool only — it
  is never bundled into the plugin. Its own license explicitly disclaims
  copyleft on compiler output: "these clauses only apply to the compiler
  itself, not ... to compiler's output files."
- `kaitai-struct` (runtime dependency, `KaitaiStream`) is Apache-2.0.

## Corrections to the vendored `rmv6.ksy`

The upstream spec is reverse-engineered and, by its own README, "nearly
complete" rather than exhaustively verified. Byte-comparing it against a
dozen real v6 fixtures (see `/test-fixtures/rmv6`, plus the broader rmscene
fixture set used only for local verification, not vendored) surfaced three
gaps, all fixed here and cross-checked against rmscene's reader:

1. **Frontmatter was over-modeled.** The upstream spec treated ~120 bytes
   after the 43-byte version header as a fixed "boilerplate" struct. Real
   files vary in both value and structure there — it's just the ordinary
   top-level block stream starting immediately after the header (confirmed
   by rmscene, which never models a separate frontmatter section). Fixed by
   trimming `rm_frontmatter` to just the header; the previously-misparsed
   bytes are now consumed as ordinary blocks (mostly falling through the
   `_: empty` case, since this spec doesn't decode their meta block types).

2. **Block dispatch used the full 4-byte block header instead of just the
   type byte.** The upstream spec switched on `unknown + min_version +
   current_version + block_type` packed together as one `u4`, with the
   version bytes hardcoded to one sample's values. Real files use the same
   block types with other version numbers (e.g. `line_def` blocks tagged
   `min=1/current=1` as well as `min=2/current=2`), which silently fell
   through to `_: empty` — meaning stroke data went unparsed. Fixed by
   splitting the header into its four fields and switching on `block_type`
   alone (rmscene confirms the type byte alone is the discriminant).

3. **`line_def` (stroke) bodies were modeled with wrong field widths.**
   The upstream `rm_line_header`/`rm_point` assumed fixed "magic" bytes and
   a 4-byte float for brush size; the real format (per rmscene) encodes
   line bodies as a CRDT tagged-value stream (tag byte = `index<<4 | type`)
   where brush size is an 8-byte double, not a 4-byte float preceded by
   padding — the upstream reading happened to validate only on whichever
   single sample file it was written against, and threw
   `ValidationNotEqualError` on other real files with non-"nice" thickness
   values. Rather than force this tagged-value scheme into Kaitai's
   declarative format, `line_def` (and `text_def`, out of scope for this
   parser's scene model) bodies are left as raw bytes (`rm_raw_body`) and
   hand-parsed in `rm-parser.ts`, using the real tag layout confirmed
   against rmscene's `tagged_block_reader.py` / `scene_stream.py`.

All three are documented inline in `rmv6.ksy` at the point of change.

## Known limitations

- Layer/line/item CRDT ids are represented as the raw bytes of their
  encoding (1-byte `part1` + a variable-length varuint `part2`), used only
  for equality (grouping strokes under their layer). This is correct for
  any id, but the upstream spec's own layer-definition/layer-name parsing
  (untouched here) still assumes a small fixed-ish id via a
  terminator-scan rather than a real varuint decode — a pre-existing
  upstream limitation, not something introduced by the corrections above.
  In practice this covers realistic notebooks (a handful of layers).
- Typed text (as opposed to handwriting) is not parsed into the scene
  model; ticket 04's scope is pages/layers/strokes only.
- Regenerate `rmv6-generated.js` after editing `rmv6.ksy` with
  `npm run generate:kaitai`.
