# Coding standards

Read at review time. Rules here are judgement calls no linter, type check or matrix gate can make;
anything mechanical belongs in one of those instead.

## Tests

- **A fake answers only what the real adapter can answer.** A stub backend, runner or store returns
  shapes the shipped implementation produces: same fields present, same failure forms. A fake that
  leaves out a field the real one always sends tests a branch production never takes, and the case it
  claims to cover goes untested. Check each fake against the adapter it stands in for (for Vision, the
  JXA driver in `src/vision-ocr-runtime.ts`).
