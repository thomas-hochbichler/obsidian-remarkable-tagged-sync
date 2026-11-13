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
- **Send** — putting a PDF onto the tablet from Obsidian. It happens only when you run it, and the
  document arrives without a sync tag: you tag it on the tablet when you want it back. There are
  two kinds. A **Zotero send** puts a paper's PDF there; a **vault send** puts a file from the
  vault there — a PDF as it is, a note printed as a PDF in the tablet's page format. Send *adds* a
  document: nothing on the tablet that the plugin did not put there itself is changed, deleted,
  moved, renamed or re-tagged. A second Zotero send never overwrites the first. A second vault send
  replaces the plugin's own earlier copy of that file while nobody has touched it; a copy you have
  touched — ink, a tag, a new name, a move — is yours and stays unless you say otherwise. What a vault send put there comes back as one note for the
  whole document, whether you tag the document or only pages of it. Not *export* or *print* (those
  leave a file on this computer), and not *Readwise push*.
- **Origin** — the vault file a vault send started from: the note that was printed, or the PDF that
  went up as it is. The note that comes back from the sent document names its origin and links to
  it; nothing is ever written into the origin itself. Not *source*: the *source PDF* is the PDF on
  the tablet — for a printed note that is the printout, not the note.
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
