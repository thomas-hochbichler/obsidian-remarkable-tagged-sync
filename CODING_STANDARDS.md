# Coding standards

Read at review time. Rules here are judgement calls no linter, type check or matrix gate can make;
anything mechanical belongs in one of those instead.

## Writes

- **A rewritten note and its `blockHash` reach the index together.** Whatever runs after a note is
  written -- a render, a Zotero call, a second write -- is either caught or moved before the note
  write, so the code that hands back the refreshed row always runs. A throw in between leaves a note
  whose stored hash no longer describes it, and every later sync reads the plugin's own work as a hand
  edit and never touches the note again. Check each `await` between the note write and the returned
  row: can it throw, and who catches it? (Ticket 20: the render written after `updateTranscript`.)

## Diagnostics

- **A "last sync" figure survives a run that measured nothing.** A sync with nothing to do, or one on a
  platform where the figure cannot exist, leaves the previous value in "Copy diagnostics" rather than
  writing zeros over it. An idle background sync runs minutes after the one that matters, and the
  reporter pastes the block after it. Check each value a sync result feeds into diagnostics: what does
  an idle sync write there? (Ticket 21: "Text layer" turned to "0 of 0 pages".)

## Tests

- **A fake answers only what the real adapter can answer.** A stub backend, runner or store returns
  shapes the shipped implementation produces: same fields present, same failure forms. A fake that
  leaves out a field the real one always sends tests a branch production never takes, and the case it
  claims to cover goes untested. Check each fake against the adapter it stands in for (for Vision, the
  JXA driver in `src/vision-ocr-runtime.ts`).
- **A test for one leg of a condition isolates that leg.** Where code decides on `a || b`, the test
  for `a` uses an input where `a` holds and `b` does not, or it stays green with `a` deleted. Check it
  by deleting the leg in your head: would the test still pass? Fixtures bundle traits silently -- every
  typed-text `.rm` fixture here also has ink anchored to that text, so a "typed page" test built on
  one exercises the anchoring leg (ticket 19 stages a typed page by dropping the anchor groups).
