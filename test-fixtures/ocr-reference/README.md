# OCR reference set

Fourteen handwritten pages and their ground truth, for measuring transcription quality per trait.
The nightly OCR job renders each scene, sends it through a backend, and reports a character error
rate per page — so "tables got worse" is a finding, where a single average would say nothing.

## Provenance

Written by the maintainer on a reMarkable Paper Pro on 2026-08-23, from templates authored for
exactly this purpose. Every text is invented and deliberately harmless: no real person, employer,
ticket or system appears anywhere. The pages were fetched straight from the device's cloud storage
as raw `.rm` scenes — nothing here is generated, because the set exists to measure the reading of
real handwriting.

## Layout

- `scenes/NN-<pageId>.rm` — the raw v6 scene of page NN, in notebook page order. `content.json`
  is the notebook's own metadata, kept for the page order and ids.
- `pages/NN-*.md` — page NN's ground truth. Frontmatter carries `id`, `trait`, `language`,
  `difficulty` and the writing instruction; the body after the frontmatter is the expected text,
  verbatim.

Page order binds a scene to its ground truth: `scenes/03-*.rm` is measured against `pages/03-*.md`.

## The traits

Each page isolates one trait. Pages 01 and 02 carry the same text on purpose — 01 written
carefully, 02 rushed — so the gap between their error rates measures legibility alone.

| Page | Trait |
|------|-------|
| 01 | clean running handwriting, German |
| 02 | the same text, rushed |
| 03 | bulleted list |
| 04 | numbered list with lettered sub-items, English |
| 05 | table with drawn lines |
| 06 | formula and one-line notation |
| 07 | German prose with English technical terms |
| 08 | diagram with few words |
| 09 | nearly empty page |
| 10 | dense page, small writing |
| 11 | numbers, dates, units |
| 12 | umlauts, ß, typographic quotes, dashes |
| 13 | struck-through corrections (ground truth is the corrected text) |
| 14 | main text plus margin notes |

## The ground truth records what is on the page

Three words came out differently than the template during writing and were adopted into the ground
truth on 2026-08-23, so the measurement compares against what is really there: page 03 "paar"
(lower case), page 04 "Mourning", page 07 "main Thread" (lower case). Struck-through words on
page 13 count as not written; only the corrections appear in its ground truth.

The comparison rules the nightly applies (NFC on both sides, whitespace and list-marker
normalisation, single line breaks inside a paragraph collapsed) are documented with the nightly
job; the bodies here are the reference the rules are applied to.
