# Context

The words this repo uses for its own domain. Where a term is defined here, code, tests, issues and
docs use *this* word rather than a synonym — a second name for one thing costs more than it saves.

Architecture and set-up live in [docs/DEVELOPING.md](docs/DEVELOPING.md); what the plugin does for
the person using it lives in [README.md](README.md).

## Glossary

- **Digest** — what a marked-up document leaves in the vault: the passages you marked, the sentence
  around each one, the margin notes placed at the passage they point at, each linked back to its
  page. A digest is not a transcript of the document — nothing you did not mark appears in it.
- **Zotero-linked document** — a synced reMarkable document matched to exactly one Zotero PDF
  attachment. The link is by attachment key and lives in `data.json`; nothing is written into the
  document's name on the tablet, so renaming it there costs nothing.
- **Send** — the Obsidian command that puts a Zotero PDF onto the tablet, already tagged for sync.
  Send only ever *adds* a file: nothing on the tablet is changed, deleted, moved, renamed or
  re-tagged, and a second Send never overwrites the first.
- **Write-back** — the highlights and margin notes of a Zotero-linked document becoming native
  Zotero annotations in the user's own library. Add-and-refresh only: a field the user edited in
  Zotero wins, and is never overwritten again.
