# Coding standards

Read at review time. Rules here are judgement calls no linter, type check or matrix gate can make;
anything mechanical belongs in one of those instead.

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
