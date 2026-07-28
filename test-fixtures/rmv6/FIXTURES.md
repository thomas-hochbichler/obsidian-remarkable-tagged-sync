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
