# rmv6 test fixtures

`normal-a-stroke-2-layers.rm` is a real firmware-v6 `.rm` page (two named
layers, one pen stroke each), vendored unmodified from:

- Source: https://github.com/ricklupton/rmscene, `tests/data/Normal_A_stroke_2_layers.rm`
- License: MIT (Copyright (c) 2023 Rick Lupton)
- Retrieved: 2026-07-19

Used to prove `rm-parser.ts` against a real device-produced file rather than
synthetic bytes, per ticket 04's fixture-based test requirement.

`color-and-tool-v3.14.4.rm` is a real firmware-v6 `.rm` page exercising the
extended ("Paper Pro") color palette and the newer `SHADER` tool, vendored
unmodified from:

- Source: https://github.com/ricklupton/rmscene, `tests/data/Color_and_tool_v3.14.4.rm`
- License: MIT (Copyright (c) 2023 Rick Lupton)
- Retrieved: 2026-07-21

Confirmed by rmscene's own `tests/test_color_tool.py` to contain: `Pen.SHADER`
strokes colored `PenColor.HIGHLIGHT` (colorId 9, whose true color lives in the
per-stroke optional `color_rgba` field), and `Pen.BALLPOINT_2` strokes in
`PenColor.GREEN_2`/`CYAN`/`MAGENTA` (the extended palette). Used to prove
`rm-parser.ts`'s `color_rgba` parsing and `pdf-renderer.ts`'s extended-palette
lookup against real device-produced data, per the pdf-color-rendering map
(`.scratch/pdf-color-rendering/map.md`).

`weather-station-page1.rm` is a real firmware-v6 `.rm` page from a PDF-backed
document, written by the maintainer for publication:

- Source: page 1 of `weather-station.pdf` (committed beside it), annotated on the
  maintainer's reMarkable Paper Pro on 2026-08-24 following
  `.scratch/test-strategy/fixture-source/README.md` (ticket 16 of the test-strategy
  effort)
- Rights: the maintainer's own handwriting over a wholly invented text; everything
  on the page was authored for this repository

Contains one layer with 59 pen strokes (four handwritten margin notes, one body
underline, two circles) and 7 `glyph_def` text highlights carrying text, rects,
color and real `start`/`length` fields indexing the PDF's text layer. Three of the
four logical highlights wrap the printed line, so one run arrives as two blocks.
Used to prove highlight parsing, margin-note clustering and digest anchoring
against device-produced data. The source PDF is public, so a reader can open it
and see exactly which words every rectangle covers.

`cape-marrow-typed-highlights.rm` is a real firmware-v6 notebook page of typed
text, written by the maintainer for publication:

- Source: a one-page typed-text notebook ("Cape Marrow — notes") produced on the
  maintainer's reMarkable on 2026-08-24, per the same ticket-16 instructions; its
  wording deliberately repeats `weather-station.pdf`, so a test confusing the two
  fixtures fails loudly
- Rights: wholly invented text, authored for this repository

That page is typed text rather than a source PDF, and its two highlights carry
**no** `start`/`length` fields — those index a PDF's text layer, which such a page
does not have. `parseGlyphBody` dropped such highlights whole until the two fields
were made optional. The page also carries several tombstoned runs (a line was
typed, partly highlighted, then deleted), so the fixture covers the
`deleted_length` path with real device bytes.

`notebook-with-image.rm` is `normal-a-stroke-2-layers.rm` with an `image_table`
(`0x0E`) and an `image_def` (`0x0F`) block appended, both **hand-built** — no device
bytes, and no picture: the table names a file called `picture.png` that does not
exist, which is all a scene ever holds. The quad matches the shape a real imported
article uses (936 x 527 device px, uv laid over it in order), and the item hangs from
the base fixture's anchored node `0114`, so the fixture also exercises the placement
that moves a picture onto the line its anchor names.

Both block types were read off a real page and are documented in
`.scratch/notebook-images/spec.md`; nothing of that page is in the repo.

## goldens/

One render golden per fixture above plus five synthetic scenes
(`test-support/golden/scenes.ts` — each exists because no device page on hand
can express its case), plus `weather-station-page1-annotated` — the same
seven-highlight page composited onto `weather-station.pdf` through
`renderAnnotatedPdf`, the one render entry point the notebook goldens never
exercise (its off-paper margin strokes also force the shrink-to-fit branch). A golden holds the render cluster's four products as
plain text — `## scene`, `## pdf`, `## text layer`, `## raster` — and the suite
regenerates and compares them on every run. Update with `npm run goldens:update`,
which **refuses a change to any drawn section while `RENDER_VERSION` is
unchanged**: the renderer changing and the bump that re-renders every synced
note are one event, shipped together or not at all. A golden contains only what
its fixture contains, and the target list is explicit — nothing outside
`test-fixtures/` may ever feed one.
