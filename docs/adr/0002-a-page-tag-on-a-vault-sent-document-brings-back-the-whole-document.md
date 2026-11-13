---
status: accepted
---

# A page tag on a vault-sent document brings back the whole document

A tagged page syncs as a note of its own; that is the rule for everything on the tablet. For a
document a vault send put there, a page tag counts as a tag on the document instead: one note for
the whole document, never one per page. The reader of a sent note tags the page they are writing
on — the plugin's own author did, every time, in the prototype of 2026-11-13 — and a review of one
spec then arrived as several notes that knew neither each other nor the note they came from. The
digest holds only what was marked, so one note for the document *is* the review. Decided
2026-11-13, before the feature was built.

## Considered options

- **Keep the rule.** Every page note names its origin, the origin's backlinks gather them, and the
  notice after a send advises tagging the document. No exception in the engine, but a notice does
  not change a gesture, and "hand the review to the AI" stays several files.
- **A page tag counts as a document tag, for vault-sent documents only** (chosen).

## Consequences

- Two PDFs on the tablet can behave differently under the same page tag: one a Zotero send or the
  reader put there gives a note per tagged page, one a vault send put there gives one note. The
  README says so where it states the page-tag rule.
- Marks on pages the reader did not tag come back too.
- Which documents the exception covers is decided by the vault's own record of what it sent, by
  document id — the same record that says which earlier copy a second send may clear (ADR 0001). A
  document of the same name from another vault is not covered.
