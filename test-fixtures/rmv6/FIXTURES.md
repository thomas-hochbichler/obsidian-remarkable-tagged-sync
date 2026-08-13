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

`pdf-page-highlights-and-margin-notes.rm` is a real firmware-v6 `.rm` page from a
PDF-backed document, captured from the maintainer's own reMarkable:

- Source: page 2 of the maintainer's annotated "Best Practices für Prompting.pdf"
  (the cloud page id stays out of this file; it is in the private raw copy)
- Rights: the maintainer's own handwriting; highlight runs quote short snippets of
  the annotated document's text
- Retrieved: 2026-08-04

Contains one layer with 65 pen strokes (handwritten margin notes) and 9 `glyph_def`
text highlights with text, rects, and color. First real fixture with `glyph_def`
blocks and the first from a PDF-backed page — used by the pdf-annotation effort
(`.scratch/pdf-annotation/map.md`) to prove highlight parsing, margin-note
clustering, and anchoring against device-produced data. The full raw document
(source PDF, all 7 annotated pages, content/meta JSON) stays private in
`.scratch/pdf-annotation/fixture/`.

`notebook-typed-text-highlights.rm` holds three `glyph_def` blocks lifted verbatim
from a real firmware-v6 page and re-wrapped in a minimal v6 file (the header and
those three blocks, nothing else):

- Source: a notebook the "Read on reMarkable" Chrome extension created from
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>,
  captured from the maintainer's own reMarkable
- Rights: two highlight runs quoting four words of a public Anthropic post
  ("Why", "is the art"); no handwriting, none of the page's other content
- Retrieved: 2026-08-13

That page is typed text rather than a source PDF, and its highlights carry **no**
`start`/`length` fields — those index a PDF's text layer, which such a page does not
have. All 57 blocks on the real page are written that way. Used to prove
`parseGlyphBody` reads them, which it did not until the two fields were made optional:
the page's highlights were dropped whole. The third block is a tombstoned run, so the
fixture covers the `deleted_length` path as well.

`notebook-with-image.rm` is `normal-a-stroke-2-layers.rm` with an `image_table`
(`0x0E`) and an `image_def` (`0x0F`) block appended, both **hand-built** — no device
bytes, and no picture: the table names a file called `picture.png` that does not
exist, which is all a scene ever holds. The quad matches the shape a real imported
article uses (936 x 527 device px, uv laid over it in order), and the item hangs from
the base fixture's anchored node `0114`, so the fixture also exercises the placement
that moves a picture onto the line its anchor names.

Both block types were read off a real page and are documented in
`.scratch/notebook-images/spec.md`; nothing of that page is in the repo.
