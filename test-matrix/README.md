# The feature matrix

Coverage numbers say how much code ran. They cannot say whether a scenario was **thought about**.
So the completeness truth for this plugin is here, and coverage runs alongside it purely as a leak
detector.

`node scripts/matrix-link.mjs` is the gate. It fails on a row naming a test that does not exist, a
test that no row claims, and a row that says nothing.

## Shape

One `.yaml` file per feature group. A feature is a **container**; the rows underneath it are its
scenarios.

```yaml
- feature: D16                       # id from the feature inventory
  name: Deterministic attachment paths
  code: src/attachment-writer.ts     # file, no line number -- lines rot, files do not
  tier: free                         # free | pro
  scenarios:
    - id: D16.1
      scenario: A notebook-level page is rendered and its PDF written
      expect: The path is <folder>/<docId>.pdf -- identity, never the title
      layer: unit                    # unit | engine | vault | e2e | nightly
      file: src/attachment-writer.test.ts
      test: "attachmentPath > names a notebook-level attachment by docId only"
```

Every scenario needs `id`, `scenario`, `expect`, `layer`, and **exactly one** of:

| state | means |
|---|---|
| `test:` + `file:` | it is covered, by this exact test |
| `gap:` | not covered yet, and this is the gap id it is tracked under |
| `waived:` | it will never be automated, and this says why |

`tier:` may be repeated on a row where free and Pro differ inside one feature.

## Two rules that are easy to get wrong

**A row binds to a test by its file plus the exact `describe > it` name** — never by an id embedded
in the test name. An id survives a rename, which sounds like the point and is exactly the objection:
it lets a row keep a claim about a test whose promise changed underneath it, while the gate stays
green. A test name here is a sentence about a user-visible behaviour, so changing it *should* force
a visit to the row.

**"Partial" is not a state.** A feature whose rows sit in different states is what "partial" means;
the tally is computed, never maintained. A partial marker records a not-quite-ness that the rows
already imply, where a row saying *"2 → 2 must not warn, see G26"* is a task somebody can do.

## `unclaimed-tests.txt`

The 993 tests that predate this matrix. **It may only ever shrink.** A new test may not be added to
it — it needs a row. This is what let the mechanism land in one green commit instead of after the
whole matrix existed.

`--write-allowlist` regenerates it and is a loaded gun: the diff has to be read as a ratchet reset,
which nothing enforces.

## What this directory is not

It is not `test/`. That is the local Obsidian demo vault — gitignored, and a nested git repository,
so nothing inside it can be committed.
