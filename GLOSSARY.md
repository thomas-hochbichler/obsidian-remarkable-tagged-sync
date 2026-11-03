# Context

The words this repo uses for its own domain. Where a term is defined here, code, tests, issues and
docs use *this* word rather than a synonym — a second name for one thing costs more than it saves.

Architecture and set-up live in [docs/DEVELOPING.md](docs/DEVELOPING.md); what the plugin does for
the person using it lives in [README.md](README.md).

## Glossary

- **Tag mapping** — one reMarkable tag assigned to exactly one vault folder. Everything on the
  tablet that carries the tag syncs into that folder; nothing else syncs. An **unmapped tag** is a
  tag found on the tablet that has no mapping, so nothing carrying only that tag is ever synced.
  Not *routing rule* or *filter*.
- **Digest** — what a marked-up document leaves in the vault: the passages you marked, the sentence
  around each one, the margin notes placed at the passage they point at, each linked back to its
  page. A digest is not a transcript of the document — nothing you did not mark appears in it.
- **Zotero-linked document** — a synced reMarkable document matched to exactly one Zotero PDF
  attachment, in the personal library or in a group library the vault has switched on. The link
  is by attachment key *and* library and lives in `data.json`; nothing is written into the
  document's name on the tablet, so renaming it there costs nothing.
- **Send** — the Obsidian command that puts a Zotero PDF onto the tablet, already tagged for sync.
  Send only ever *adds* a file: nothing on the tablet is changed, deleted, moved, renamed or
  re-tagged, and a second Send never overwrites the first.
- **Added page** — a page inserted into a PDF on the tablet. It is part of the document but not of
  the source PDF, so it has no page number there and nothing on it sits at a place in the source.
  A separate notebook is not an added page, whatever it was written about.
- **Write-back** — what you wrote on a Zotero-linked document reaching the user's own Zotero
  library as text: highlights and margin notes as native Zotero annotations on the PDF, added pages
  as Zotero notes under the paper. Add-and-refresh only: a field the user edited in Zotero wins,
  and is never overwritten again.
- **Readwise push** — the highlights and margin notes of a synced document becoming highlights in
  the user's own Readwise library, one Readwise book per document. Unlike write-back, the tablet
  wins: an edit made in Readwise lasts until the same highlight changes on the tablet, and a mark
  erased on the tablet is deleted in Readwise. A book deleted in Readwise stays deleted until the
  user runs *Push to Readwise again* on its note. Not *Send*
  (that goes to the tablet) and not *export* (Readwise's own way into the vault).
- **Render** — the PDF of a synced document that the plugin writes into the vault and embeds at
  the top of its note: the pages with everything you wrote and drew on them. The render is not the
  transcript, and not the source PDF on the tablet. Users call it the *annotated* or *flattened
  PDF*; this repo says render. A render can also sit in Zotero, as a second attachment beside the
  paper's source PDF; it is never a source itself.
- **Text layer** — the transcript, laid over the handwriting in the render as invisible text, each
  word on the word it transcribes. It changes nothing you can see on the page; it only gives
  search something to find. The words are the transcript's words, so the layer and the note say
  the same thing. Not the text a PDF from elsewhere already carries, which the digest quotes
  from: that is the *source PDF's own text*.
- **Searchable PDF** — a render that carries a text layer: searching it finds the handwritten word.
  *Searchable PDF* names the result, *text layer* the feature; *searchable text* still means the
  transcript under the note.
