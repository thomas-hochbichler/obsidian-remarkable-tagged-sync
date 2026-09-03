# Changelog

All notable changes to this plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

New entries go under `## [Unreleased]`, **in the same commit as the change** -- not at release
time. At release time that heading is renamed to `## [<version>] - <date>`, and the release
workflow publishes the section as the GitHub release body. See
[docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

### Fixed

- **Re-targeting a tag's folder no longer pulls back notes you had moved.** Since 1.6.1 a synced
  note you moved out of its mapped folder stays where you put it -- except when you then changed
  the tag's folder in settings, which moved every note under that tag into the new folder, the
  moved ones included. Now only notes still in the old folder follow the mapping; a note you
  sorted yourself stays there and is updated in place. (#101)

## [1.6.1] - 2026-09-03

### Fixed

- **Tagging one more document no longer re-imports the rest.** A synced note you had moved out of
  its mapped folder was mistaken for a mapping you had re-targeted in settings, so the next change
  on the device re-fetched, re-transcribed and moved back every such note -- 352 transcription
  requests for one tag change, on a metered backend. A note you moved now stays where you put it
  and is updated there; only re-targeting the tag's folder in settings moves it. The same change
  stops a second cause of the same re-import: a document that had lost a tag at some point was
  reopened on every full scan, and for a PDF or EPUB that meant a fresh transcription of its
  margin notes each time. (#101)

## [1.6.0] - 2026-08-26

### Added

- **Frontmatter properties (Pro).** Turn on one switch under *Vault output* and every synced note
  carries its reMarkable tags and metadata as Obsidian properties: the document's tags — the sync
  tag included — namespaced under `remarkable/`, plus when it was last modified on the device, when
  its note was last written, its device folder, whether it is a notebook, PDF or EPUB, whether it
  is pinned, and its id. Built for queries: every synced note answers `FROM #remarkable` in
  Dataview, and the README shows a "latest five synced notes" table to start from. The plugin
  manages only its own lines — frontmatter you write yourself is preserved byte-for-byte.
  Enabling writes the properties into every already-synced note, so views are complete from day
  one; disabling removes exactly what the plugin added. Off by default. (#95, #96)

## [1.5.1] - 2026-08-25

### Fixed

- **Deleting a document on your reMarkable now stops it from syncing.** Moving a tagged document
  to the device's trash only re-parents it; its tags stay in place until the next cloud sync wipes
  it for good. The plugin kept reading those tags, so the document's notes came back on every sync
  — even after you had deleted them from the vault by hand. A document in the trash now counts as
  deleted: its notes are left alone in your vault and their index rows are retired, exactly as if
  the document had vanished. A document inside a trashed folder counts too. (#91)

- **One highlight is now one digest entry.** A marker stroke drawn across several lines of a book
  or PDF arrives from the device as one run per line, and the digest used to print it as one entry
  per sentence it crossed — a four-line highlight became three entries. The runs of one gesture are
  now rejoined by their shape on the page, so the digest shows the one passage you highlighted,
  with one page reference. (#92)

- **A quote no longer prints its ending twice behind a stray quotation mark.** Closing punctuation
  now stays with the sentence it ends, on both sides of a sentence boundary. Before, a highlight
  ending in a parenthetical could appear twice — once as context, once as its own entry opening
  with a stranded `”`. (#92)

- **The handwriting clip now shows the paragraph, not just the line.** Opening the picture behind
  a margin note used to show only the strip of prose level with the ink. The clip now spans the
  paragraph the note sits beside — including in books, which separate paragraphs by first-line
  indent rather than by spacing — so the context the note is about is in the picture. (#92)

## [1.5.0] - 2026-08-25

### Added

- **Pro: sync straight from your reMarkable, without the reMarkable cloud.** The plugin can now read
  your tablet directly over USB or Wi-Fi, so a sync no longer depends on a cloud API that reMarkable
  neither documents nor promises to keep. Settings gained two rows for it: *Sync from*, and what to
  try when that source is not reachable.

  **Switching between the two costs nothing.** The direct connection computes the same content
  hashes the cloud does, so a vault that already synced through the cloud keeps its whole index:
  nothing is re-rendered, nothing is transcribed a second time, and a failover in either direction is
  invisible in your notes.

  Pairing asks for the root password from your tablet's *Settings → Help → About →
  Copyrights and licenses* screen. It is used once, to install a key for this vault, and is never
  stored. The tablet's host key is shown to you and pinned; if it ever changes, the plugin refuses
  to connect and tells you why rather than reconnecting to something else.

  **On a Paper Pro or Paper Pure this costs a factory reset.** Those devices only allow SSH in
  Developer Mode, and turning it on erases the tablet — your notes come back from the reMarkable
  cloud afterwards, but the tablet shows a warning screen at every start from then on. If a tablet
  does not answer, the plugin spells this out rather than leaving you to find it. reMarkable 1 and 2
  need none of it; SSH is on by default there.

  Background syncs check whether the tablet is awake before starting, so a sleeping device is a
  quiet skip rather than a failed sync every night. Desktop only, like the rest of the plugin.

- **A book you read as an EPUB now syncs as the book.** Tagging one used to give you your
  handwriting on blank pages, with none of the text you wrote it on underneath — the plugin took
  anything that was not a PDF for a notebook.

  A reMarkable has no EPUB reader. It converts the book to a PDF on the tablet and reads that, and
  keeps that render beside the book. Tagged Sync now reads the same one, so a passage you swiped
  the marker across comes through as the quote it is, a sentence you underlined or circled with the
  pen does too, and each sits under the chapter it belongs to — named the way the book's own table
  of contents names it. The wording is taken from the EPUB itself rather than from the device's
  rendering of it, so a quote is the book's text and not an approximation of it.

  **One thing to know before you start, and it is the device's doing rather than the plugin's.**
  Changing a book's font, its size or its margins makes the reMarkable lay the whole book out again
  and rebuild that PDF. Measured on a real tablet: every mark survived — and every mark kept its
  exact position while the text moved out from under it, so a highlight that had covered one
  sentence covered a different one afterwards. Tagged Sync mirrors what the device holds and cannot
  put those marks back. What it does is say so: a book whose page count has moved since its notes
  were written is reported after the sync, and so is a note that comes back with fewer highlights
  than it had. Nothing else would flag it, because a quote you never marked reads exactly like one
  you did. So settle the font before you start annotating.

  Books already synced the old way are re-rendered on the next sync; nothing changes on your tablet.

### Changed

- **You now enter the transcription model yourself; the plugin no longer suggests one.** Every
  provider — Anthropic, OpenAI, Google Gemini, OpenRouter, Ollama — used to arrive with a model id
  already filled in. Those suggestions go stale: Google shut down `gemini-2.0-flash` on 1 June 2026,
  and until now the plugin kept sending it, so anyone who took the suggested value got a provider
  error that read like a problem with their API key.

  The plugin cannot know which models a provider still serves, so it no longer pretends to. The
  Model field starts empty and is yours to fill in from your provider's own list of current models.

  **If you never touched that field, you have to fill it in once** — transcription will otherwise
  stop with *"No model is set for this OCR backend — open the plugin settings and enter one."* and
  say so per sync rather than failing quietly. If you had already typed a model, nothing changes for
  you.

- **The status bar now shows how much of the sync is left, not where it is in a list.** It used to
  read something like `17/74`, which was the position in a walk through every document on your
  reMarkable — and most of those are skipped without any work at all, so the number raced through
  sixty in seconds and then sat still for minutes on the one page that was actually being
  transcribed. Neither number said anything about how long anything would take.

  A sync now counts the pages it is really going to work on before it starts, and fills a bar
  against that count, next to the name of the notebook it is on. The count is honest: a notebook
  filed under three tags is written three times, and the bar says so. While the work is being
  measured the item reads `checking 3 of 12 · Reading List`, naming each notebook as it is reached,
  so the wait before the bar appears is neither silent nor mistakable for a hang. Hover the item for
  the full name, the tag, the page within the notebook, and what is happening to it right now.

### Fixed

- **Your notes now land in the folder your vault really holds, and the plugin remembers them there.**
  On Windows and macOS, `media` and `Media` are one folder on disk but two different names to
  Obsidian's file list, so a tag or attachments folder typed in another capitalisation than the
  existing one used to fail the sync with *"Folder already exists."* (issue #73). Release 1.4.4
  stopped that error, and the sync then wrote into the folder on disk while recording the spelling
  you had typed — a path the plugin could not resolve again on the next run. The configured name is
  now resolved to the vault's own spelling before any note or attachment path is built from it, so
  what is written and what is remembered are the same path. On Linux, where the two names really are
  two folders, nothing is merged.

- **"Re-transcribe all synced notes" no longer offers to run where it would erase your transcripts.**
  On Windows and Linux the command was in the command palette even with *Apple Vision* selected —
  and Apple Vision only runs on macOS. Running it there re-fetched every notebook from reMarkable,
  got nothing back for each page, and **removed the Transcript section from every synced note**,
  then reported success.

  You could reach this without ever choosing Apple Vision on that machine: the plugin's settings
  travel with your vault through Obsidian Sync, so a Mac in the same vault selects the backend for
  all of them.

  The command now asks whether the transcription backend can actually run on this machine before
  offering itself, the same question the settings dropdown asks before greying an option out. If
  this already happened to you, running the command once on a Mac writes the transcripts back.

- **A note is no longer overwritten when a document you had removed comes back.** When a notebook
  loses its tag or leaves your reMarkable, the plugin stops tracking its note but leaves the note
  itself in your vault. From that moment it is an ordinary file: you can correct it, rename another
  note over it, or delete it. If the document later came back, the plugin wrote over whatever was at
  that path — without the usual check that the note is still the one it wrote.

  That check now runs for these notes too. A note you changed by hand is left alone and counted in
  the *"N notes were not updated because they were edited"* notice, exactly as it is during a normal
  sync. A note that is untouched is still refreshed, and one you deleted is still written again.

- **A licence server that stops answering no longer freezes the sync.** The plugin checks your
  licence before a sync that uses a paid transcription backend, and it waited for that answer
  without a time limit. A server that accepts the connection and then goes quiet — a bad connection,
  a proxy holding the request — left the sync running with nothing to show for it, the status bar
  spinning, and no way out but restarting Obsidian.

  The check now gives up after ten seconds and treats the silence the way it already treats an
  unreachable server: Pro keeps working on its last confirmed answer, and the sync carries on.

- **Two syncs can no longer start at once and write over each other's bookkeeping.** Pressing *Sync
  now* twice in quick succession — or confirming a *Re-transcribe synced notes* dialog that had been
  left open while a sync started in the meantime — could start a second run on top of the first.
  Both runs then wrote the same record of what is synced, and whichever finished second decided.
  Notes written by the other run could be left in your vault with nothing recording them, so the
  next sync wrote them a second time.

  The plugin already refused a second run, but it checked and then took a moment to make the check
  true, and a second press landed in that moment. It now claims the run in the same breath as
  checking, and re-checks after the re-transcribe dialog is answered rather than trusting what was
  true before it opened.

- **A notebook whose name matches a note you already have, except for capitalisation, now syncs.**
  Before this, if your vault held `Work/my notebook.md` and a synced notebook was called *My
  Notebook*, the sync stopped with *"File already exists."* — and it stopped again on every run
  after that, because nothing about the situation changed by itself.

  The plugin was asking the wrong thing. It asked Obsidian's file list whether the name was free,
  and that list treats `My Notebook` and `my notebook` as two different names. Your disk does not:
  on macOS and Windows they are one and the same file. So the plugin picked a name it had just
  proved was free, and the write failed on it.

  It now asks the same question Obsidian itself asks before writing, so a name that is really taken
  is treated as taken and the note gets a distinguishing suffix — `My Notebook (sync).md` — exactly
  as it already did for any other kind of clash. **Your own note is never touched.** On Linux, where
  two names differing in capitalisation really are two files, nothing changes at all.

  The same now holds when a *folder* happens to sit exactly where a note was going to go.

- **A notebook whose title contains an invisible character no longer breaks its own sync, forever.**
  Some titles carry a character that looks exactly like an ordinary space but is not one — a
  non-breaking space, say, which the title metadata of EPUB books carries very often. Obsidian
  quietly replaces such a character when it writes the file, but not when it looks the file up
  again. The result was a note the plugin wrote once and could then never find: the next sync
  concluded you had deleted it, wrote it a second time, and failed with "File already exists." on a
  path that looks identical to the one it had just asked for. Every following sync of that notebook
  failed the same way. The same held for a title in a different Unicode spelling of the same letters
  — "Bücher" written as "u" plus a separate accent.

  Titles are now put into the exact form Obsidian writes them in, and every path the plugin looks up
  is put into that form too — so a note that already exists under a rewritten name is simply found
  again. Nothing has to be repaired by hand, and no note is moved.

  Two smaller ones of the same family, both invisible outside Windows until now: a notebook whose
  title ends in a dot ("To do...") and a notebook called `CON`, `NUL`, `COM3` or one of their
  siblings. Windows refuses both outright. They are renamed on every platform, not only on Windows,
  so a vault shared between a Mac and a PC does not grow one note per machine.

- **Pointing a tag at a different folder now moves its notes there.** Changing a mapping in the
  settings — say `sync` from `Inbox` to `Reading` — left every note that tag had already written
  sitting in the old folder, and the next sync kept writing them back into it. Even deleting a note
  first did not help: it reappeared where it used to be. A sync now moves such a note into the
  folder the tag currently points at, keeping the note itself and the links to it intact, and a note
  you deleted is recreated in the new folder rather than the old one.

## [1.4.4] - 2026-08-23

### Fixed

- **An attachments or tag folder that already exists no longer fails the sync.** When the folder
  name in the settings differed from the one on disk only in a way the filesystem ignores —
  letter case, on Windows and macOS — the plugin's lookup missed it, the create ran into it, and
  every sync stopped with *"Folder already exists."*. An existing folder is now simply used. (#73)
- **A local vault name conflict is no longer blamed on the reMarkable cloud.** The error above
  surfaced as *"reMarkable's cloud answered in a way this plugin did not expect"*, sending users
  hunting an API problem that was a folder conflict in their own vault. Obsidian's own refusals
  now get a message that says the problem is local and points at the folder settings. (#73)

## [1.4.3] - 2026-08-23

### Fixed

- **A library item without a `parent` field no longer stops tag discovery.** The reMarkable cloud
  can send an item whose metadata omits `parent` (or stores `null` there) — rmapi-js's own types
  document the omission as meaning "root directory". The plugin rejected such an item with
  *"reMarkable metadata field "parent" was not a string"*, and because the whole library is listed
  in one go, that single item took down tag discovery and sync for the entire account. A missing
  `parent` is now read as the root folder, which is what it means. (#69)

## [1.4.2] - 2026-08-15

### Changed

- **The author's name in the plugin browser now opens the plugin's own site**,
  [taggedsync.com](https://taggedsync.com), instead of a GitHub profile. The README links it too.

## [1.4.1] - 2026-08-15

### Fixed

- **The Buy button led nowhere.** The checkout address shipped in 1.3.0 and 1.4.0 was a Polar
  checkout *session*, not a checkout *link*. Sessions expire, and this one had: both the button in
  the settings and the link in the README answered "Page not found", so nobody could buy Pro even
  if they wanted to. Replaced with a checkout link, which mints a fresh session per visitor and
  does not go stale.

## [1.4.0] - 2026-08-15

### Added

- **A tag on a folder now syncs everything inside it.** reMarkable keeps a folder's tag on the
  folder alone and copies it to nothing below, so a notebook sitting in a tagged folder used to be
  skipped. It is now routed exactly as if you had tagged it yourself — every notebook and PDF in the
  folder, and in the folders nested below it. Taking the tag off the folder, or moving it to another
  mapped tag, is picked up as well. Contributed by
  [@raghavpillai](https://github.com/raghavpillai).

## [1.3.0] - 2026-08-14

### Added

- **Tagged Sync Pro — €24, once.** Two things are now paid: transcription by a cloud model
  (Anthropic, OpenAI, Google, OpenRouter, with your own API key), and mapping more than one tag to a
  folder. Everything else stays free and stays free permanently: Apple Vision, a local server you
  run yourself, the downloadable local model, annotated PDFs, margin notes, and the one tag mapping
  that has always been there. **Nothing that worked yesterday is behind the new gate.**

  There is no subscription and no expiry — the licence is bought once and does not run out. It
  covers one person on up to 50 devices, at home and at work, and every future Pro feature is
  included at no further cost.

  **Try it for 14 days** from the plugin settings: one click, no key, no email, and nothing sent
  anywhere to start it.

- **The four cloud backends now ship to everyone**, locked rather than absent. Choosing one without
  a licence falls back to the best free backend and says so, instead of failing silently or hiding
  the option — you can see what Pro is before deciding whether you want it.

- **A licensed user can free a device slot themselves**, from a button in settings that opens their
  own page at Polar. A licence covers 50 devices and each vault counts as one, so a laptop you no
  longer have would otherwise hold its slot forever.

### Changed

- **The plugin now contacts one more host, and only if you own or are trialling Pro:** `polar.sh`,
  to check the licence. It is called only when a paid feature is used, at most once every 7 days,
  and it carries the licence key, this vault's activation id and a public organization id — no email
  address, no vault name, no note content. **A free user never causes this call.** If it cannot be
  reached, nothing locks: the last answer carries, and after 30 days the settings tab says so while
  Pro keeps working.

- **The README no longer claims that transcription always happens on your own machine.** That was
  true while the cloud backends were not in the download; it is not true now, and the
  [Network use](README.md#network-use) section says exactly which backend sends what, and where.

- **The premium source is published.** `pro/` is in this repository under the PolyForm Strict
  licence — readable and auditable by anyone, with commercial use granted by
  [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md). The plugin is one build and one `main.js` again,
  so store updates reach paying users like everyone else.

### Fixed

- **Three free backends would have disappeared for everyone.** The premium entry point had stopped
  registering the local-server backends (Ollama, LM Studio, custom) — the only transcription a free
  Windows or Linux user has. It never reached anyone because no premium build was ever released;
  the merged entry point registers all four.

## [1.2.0] - 2026-08-13

### Added

- **The notes you write in the margin of a PDF now arrive in the digest**, switched on under
  Settings → Handwritten notes. They are off until you say otherwise: transcribing handwriting is
  work your machine does per note, and it is your own hand, so nobody's vault fills up with it
  unasked.

  Each note is transcribed where a transcription backend can run, and printed where it was written —
  under the section heading it sits in, or beside the sentence it points at, with a link to its
  page.

  **And you can look at the handwriting itself.** In the corner of every entry sits a small eye that
  draws the strip of page the note sits on, out of the PDF the note already embeds. It appears when you press
  it and not before, so a note with thirty margin notes costs nothing to open — and **no image is
  ever written to your vault**. What you see is the page: the printed text the note was written
  beside, with your own ink on it.

  A note whose handwriting could not be transcribed says so in words rather than standing empty, and
  keeps its anchor and its page link. If the PDF has moved out of the vault, or the page is gone, the
  entry says that too — where you are reading, not only in the console.

- **An article you send to the device now arrives as a digest, not as a transcript of itself.** Send
  a web page over with the "Read on reMarkable" Chrome extension in notebook mode, or write on a page
  with the Type Folio, and the device stores that text inside the notebook. The plugin used to treat
  the whole page as handwriting: it took a picture of the printed article, sent it to be read back
  letter by letter, and wrote the result into your vault. Your own four words of ink sat somewhere in
  21 000 characters of guessed-at text.

  Such a page is now read as what it is — a document with your marks on it. You get the passages you
  highlighted, quoted with the sentence around them, under the article's own section headings, and
  your handwritten notes beside the lines they were written next to. On the page this was measured on:
  10 KB of digest in place of 21 KB of transcript, and nothing of the article's text transcribed at
  all, because it was already text.

  A notebook you wrote by hand is untouched and still gets its transcript. So does a page carrying
  only a typed line or two — the digest is for a page whose text is a document, and the difference is
  measured from the text itself, not from what kind of file the device calls it.

### Fixed

- **Text you highlight in a notebook is in your vault now.** A page whose text was typed rather than
  carried by a PDF — an article sent over by the "Read on reMarkable" Chrome extension, or anything
  written with the Type Folio — lost every one of its highlights: they were read from the file in a
  form the plugin refused, and each one was quietly dropped. On the page that brought this to light,
  53 of them. They are drawn again, and every affected note is re-synced once.

- **A passage you swipe the marker across is quoted too.** The device stores two different things
  under one gesture: tap a word and drag the selection, and it records *which words* you marked;
  take the marker and drag it across the line freehand, and it records a stroke that knows nothing
  but its own shape. The first has always been in the digest. The second was drawn on the page and
  named nowhere — you marked a sentence and the note had no entry for it.

  It is read now, as an underline already was: the words under the swipe, quoted with the sentence
  around them. A dab of marker too short to be aimed at anything is left alone, and a swipe that
  lands beside the text rather than on it stays what it always was — ink on the page.

- **A mark that stops in the space after a word no longer takes the next word with it.** Widening a
  mark out to whole words counted the space it ran into as a word begun, so `context engineering.`
  came through as `context engineering. Building`.

- **The pictures on a page are in your vault now.** An article you send over keeps its
  illustrations, and the device shows them; the plugin left a blank gap where each one should be, on
  every page it has ever rendered. It reads them now — and so does any notebook page you put an
  image on yourself.

  The pictures are files of their own on the device, so a page that has one takes them along: an
  article with large diagrams makes a heavier attachment than it used to. A picture that cannot be
  fetched leaves the gap it always left, and costs the note nothing else.

- **The highlights on an article you sent over sit on the words you marked.** The Chrome extension
  opens such an article with one invisible character the device draws nothing for. The plugin was
  charging it the width of a letter, which pushed the last word of the paragraph's first line onto
  the second line — and from there every word of the paragraph stood one word to the right of the
  yellow drawn over it: you marked "context engineering" and the page showed the mark over
  "minence: context engine". The character now costs what the device charges for it, nothing, and
  the paragraph breaks line for line as it does on the device. What the digest quoted was right all
  along; it is the page beside it that was out of step.

- **A note written down the margin arrives as one note.** Several lines standing in the margin as a
  block used to become one entry per line — each transcribed separately, each anchored somewhere of
  its own, a single sentence torn into four. They are now read as the one note they are: one entry,
  one transcription, one strip of page to look at. Only in the margin: over the printed text a note
  spanning two lines still becomes two entries, because there two notes written across each other
  look exactly like one paragraph, and joining those would silently glue two thoughts together.

- **Handwriting written beside a page is no longer cut off at the paper's edge.** The reMarkable does
  not stop the pen where the paper stops: zoom a PDF out and you can write in the space next to it,
  and that ink was landing outside the page the plugin built, so it was drawn nowhere. Such a page is
  now drawn a few percent smaller, so that everything you wrote fits on it and the margin note is in
  your vault whole; every page you kept inside the paper is untouched, at its own size. Every
  PDF-backed document is re-synced once for this — measured on a real annotated paper, one page in
  twelve was losing ink this way, one of them a whole sentence.

## [1.1.0] - 2026-08-10

### Added

- **Windows and Linux can transcribe handwriting now**, for the first time since the plugin
  shipped. Point the plugin at a local AI server you run yourself — **Ollama**, **LM Studio**, or
  any other server speaking the same API — and it sends each page there and gets the text back.
  Nothing leaves your machine, there is no account and no key, and it works on **every** system,
  including Windows on x64 where nothing else does.

  Until now the backend list on those systems had nothing selectable in it: Apple Vision is macOS
  only, and the downloadable local model needs Apple Silicon or Windows on ARM. Notes synced with
  the handwriting picture and no text, and that was the end of it.

  **You choose the model.** The plugin fills in the address for Ollama and LM Studio and asks you
  which model you loaded; it checks that the model can actually read images and says so if it
  cannot. As a starting point we measured **Qwen2.5-VL-7B at 7.6 % character error**, about three
  times more accurate than Apple Vision — though we measured it running the model directly rather
  than through one of these servers, so your result may differ.

  Two honest limits: you have to install and start that server yourself, and it uses your machine's
  memory and battery while a sync runs — so background syncing with it asks first. If the server
  is not running, settings tells you, and a sync says so at the end instead of quietly producing
  nothing. The same goes for a server that answers and refuses: whatever it said — LM Studio's "no
  models loaded", a model name it does not know — is repeated back to you at the end of the sync.
  And until you name a model, settings says so plainly and a sync stops rather than letting the
  server transcribe with whichever model it happens to have loaded.

- **You can stop a sync that is running.** Click the turning icon in the status bar and confirm, or
  run **Stop sync** from the command palette. It works on every kind of run — a manual sync, an
  automatic one you never started, and **Re-transcribe all synced notes** — and there was no way to
  do it before: once a sync began, it ran to the end.

  It stops **safely rather than instantly**: the note being transcribed right now is finished first,
  so on a large notebook with the local model this can take a moment. The status bar says
  `stopping…` while it winds down. Everything already written is kept, and the next sync carries on
  from where it left off — no duplicates, and nothing is left half-written.

- **A local AI model you can switch transcription to**, on Apple Silicon Macs with 18 GB of memory
  or more and on Windows-on-ARM PCs with 24 GB or more. It reads handwriting about three times more
  accurately than Apple Vision and keeps your headings and lists, and it runs entirely on your
  machine — no account, no key, nothing sent anywhere. **It is never a default**: a fresh install
  downloads nothing, and Apple Vision stays the default on macOS.

  It is a real cost, stated before you agree to it: **5.5 GB of model files plus a 12 MB program**,
  checked against a published SHA-256 before anything runs, roughly 15 seconds a page against
  Vision's 0.4, and about 14 GB of memory while it runs. **The first pages after the download are
  far slower than that** while your system indexes 5.5 GB of new files, which settings now says
  rather than leaving you to discover it; it settles by itself. **The download picks itself up when the
  connection drops** — it keeps what it already has and carries on, and only gives up if several
  attempts in a row get nowhere. Settings has a button to delete the whole thing again — which you will need, because it lives
  outside your vault and uninstalling the plugin does not remove it.

  It also misreads *differently*. Vision's mistakes usually look broken on the page; this model
  writes its mistakes as fluent text. Check anything that matters against the handwriting.

  Windows on x64 and Linux do not get the option, and settings says so on the machine itself.
- **Text you typed on the device now appears in the transcript**, in the right place between the
  handwriting around it. It is taken from the file exactly as you typed it — never read off an
  image — so it cannot come out misspelled. It was missing entirely before: transcription reads a
  picture of your ink, and typed text is not ink.
- **Underlining or circling a sentence in a PDF now quotes the words it points at**, exactly like a
  marker highlight does. A passage you marked with the pen instead of the highlighter used to reach
  your vault as nothing at all. It goes through no transcription, so Windows and Linux get it too —
  and a mark on a page whose text the plugin cannot read is still left out, as before.

### Changed

- **The transcript now tells you which page each part came from.** A long notebook used to arrive as
  one unbroken wall of text — a 29-page notebook gave you 29 pages of handwriting with nothing
  marking where one ended and the next began. Every page that produced text now gets its own heading
  that links straight into that page of the embedded PDF, so you can read a line and jump to the
  handwriting behind it.

  Pages with nothing on them stay out of the way: instead of a heading each, they are named once at
  the end — *No text on pages 2–6, 9–29.* A page that could not be read says so on its own page,
  because that is something you can act on.

  **Notes you have already synced keep the transcript they have.** The new format applies as each
  note is next synced. To convert everything at once, run **Re-transcribe synced notes** from the
  command palette — it tells you the cost before it starts.

  A trade-off worth knowing: a notebook with text on every page now puts one entry per page in
  Obsidian's outline pane. That was the price of being able to navigate to a page at all, and it
  seemed the better half of the deal.

- **Cloud transcription sends one page per request instead of the whole notebook at once.** This is
  what makes the page split trustworthy rather than a request the model could ignore, and it fixes
  two older problems on the way: a long notebook could exceed the response limit and come back
  truncated while still reporting success, and a local Ollama server could not fit a whole notebook's
  images in its default context at all. A page that hits a provider's rate limit is now retried
  before it is given up on. Expect a few percent more input tokens — the page images themselves cost
  the same either way.

- **The status bar icon turns while a sync is running.** A long page could sit on the same
  "3/8 · Meeting" for minutes with nothing to say whether the sync was working or stuck. The icon
  now spins for as long as there is work — during a sync and during **Re-transcribe all synced
  notes** — and stops on the check or the cross. If your system asks for reduced motion, it stays
  still.
- **Handwriting is transcribed noticeably more accurately.** Ink was drawn far too thin in the
  image handed to Apple Vision — two to nine times thinner than you wrote it — and a hairline is
  what its layout pass declines to call text. Writing that still comes back with nothing over it is
  now read a second time on its own. Over a ten-page corpus with hand-corrected ground truth,
  character errors fall from 31.6% to 26.1% and the share of lines found rises from 72% to 80%, in
  about the same time per page.
- **Existing notes keep the transcripts they have.** Run **Re-transcribe all synced notes** to redo
  them with the better transcription — the command now says so. It is the only thing that can spend
  an API quota, so it stays your choice.
- The diagnostics block reports which Apple Vision revision your Mac ran, and how much writing it
  refused to read at all. Nothing is sent anywhere; you copy it and paste it into a bug report.
- The **Highlights** section is no longer a stack of quote boxes. Each page is a heading that links
  into the PDF, with your highlights as a plain list under it — the same boxless look the digest has.
  Nothing about the highlights themselves changes.
- A synced note now says at the top that it belongs to the plugin: a collapsed callout,
  "Generated by Tagged Sync — do not edit". The sync markers around the note are HTML
  comments, so nothing in Reading View used to show where your own writing was safe. The
  opening marker is gone with it — the callout says what it said, and one line of comment
  clutter in Live Preview goes away.
- Text typed **above** the callout is no longer overwritten. It used to fall outside the
  managed block, so a sync replaced it without a word; now it counts as an edit, and the
  note is left alone and reported like any other.
- **Your own writing now belongs in a note of your own**, linked to the synced one, instead
  of below the sync block. New notes no longer offer that area. Anything you already wrote
  there stays exactly where it is and is still preserved on every sync — nothing to move.
- **Every synced note is rewritten once** when you update, to add the callout. Notes are
  unchanged otherwise, but the whole vault touching at once is visible if you run git or a
  cloud sync over it.
- The notice for skipped notes no longer points below the sync block; it explains that
  Tagged Sync only rewrites notes it wrote itself.
- A digest section heading now carries the section number the page shows, so `Introduction`
  reads `1 Introduction`. Many papers leave the number out of their PDF bookmarks, which is
  where the digest takes its headings from.

### Fixed

- **A mark could be quoted from the middle of a word.** Where a line break splits a word across two
  lines — which is every second line of a two-column paper — a mark under the second half quoted
  from where the break fell: `accumu==lates both environment observations.==` instead of
  `==accumulates both environment observations.==`. Marks now widen to whole words after the line
  break has been closed up, not only within each line. Text your tablet recorded itself is left as
  it is; the change is to the marks the plugin works out from the shape of your ink.
- **A pen mark the digest could not place now says so.** An underline drawn a little too low, one
  struck through the line rather than under it, or a mark over a patch the PDF has no text for is not
  recognised as a mark — and with margin notes off, it reached your vault nowhere at all and nothing
  said why. The sync now reports it with the page number, so you can look. The mark was never lost
  from the embedded render, and still is not.

- **Highlights on a page full of figures could start quoting from the middle of a sentence.** The
  digest measures a page's line spacing to work out where a line of text begins and ends, and a page
  of charts made it read the axis labels as text lines — a third of the real spacing.
- **A sync interrupted partway through a notebook could duplicate its notes.** The plugin recorded
  what it had done once per notebook, but a notebook with several mapped tags — or many tagged pages
  — is several notes, and quitting Obsidian in the middle of one left the notes already written
  unrecorded. The next sync would not overwrite a file it no longer recognised, so it wrote a second
  copy beside each of them, and they never healed. It now records each note the moment it is written.
- **A re-transcribe that did not finish could silently freeze the notes it had already rewritten.**
  Refreshing a transcript changes the note, so the plugin's record of it has to change too — and that
  record was only saved once the whole run finished. If it did not, every note already refreshed
  looked hand-edited on the next sync, and the plugin will not touch a note you have edited. They
  would have stopped updating for good, with nothing to say why. The record is now saved per note.
- **The OCR settings claimed your pages go over the network when they did not.** On a Mac where the
  local model can run, the backend description said that transcription providers send each page to
  that provider using your own API key — true of neither backend that build could run.

## [1.0.9] - 2026-08-09

### Fixed

- **A single old notebook could stop the whole plugin working.** **Discover tags** and **Sync now**
  both failed with "reMarkable's cloud answered in a way this plugin did not expect", and no tag was
  ever found. reMarkable stores four leftover fields from an older version of its sync on every
  document, and on some older documents it sends them as `null` rather than leaving them out — which
  the library this plugin reads the cloud with rejected. The document list is fetched in one go, so
  one such document failed the listing for the entire account. The plugin never reads those four
  fields, and now treats them as absent.

## [1.0.8] - 2026-08-03

### Fixed

- Annotated pages in large documents could fail to render and were skipped during sync
  (console error `ValidationNotEqualError: not equal, expected [84], but got [0]`). The
  parser misread a scene-tree block whose ids grow with document size; it no longer decodes
  that block at all, since the sync never uses it.

## [1.0.7] - 2026-08-03

**Renamed:** The plugin's display name is now **Tagged Sync for reMarkable** (previously
"reMarkable Tagged Sync"). This is trademark hygiene only — "reMarkable" is a trademark of
reMarkable AS, and the new name makes clear this is an unofficial, community-built plugin.
Same plugin, same features, nothing to do on your side; updates arrive as usual.

Also ships the store-scorecard cleanup: 341 automated-scan findings down to the 8 deliberately
deferred settings-API notices (analysis in `.scratch/store-scorecard-fixes/`).

### Changed

- Display name renamed to "Tagged Sync for reMarkable"; the store description now carries an
  "Unofficial; not affiliated with reMarkable AS." note, and the README leads with a trademark
  disclaimer. The plugin id is unchanged, so existing installs update in place.
- The generated rmv6 parser is now post-processed by `generate:kaitai`: emitted as ESM
  (no UMD `require`/`define`), deduplicated `_io__raw_body` declarations, unused loop
  counters removed, and a scoped `eslint-disable` pair for the type-aware `no-unsafe-*`
  rules with the rationale inline.
- `src/shims/setimmediate.ts` uses `window` instead of `globalThis`/bare `setTimeout` for
  popout-window compatibility.
- Local ESLint now mirrors the store scanner's `no-unsafe-*`-on-`.js` overlay, so the lint
  ratchet counts what the store counts (baseline lowered 22 → 8).

### Added

- `CONTRIBUTING.md` (store scorecard hygiene finding), including the clean-room rule for
  the rmv6 parser.

## [1.0.6] - 2026-07-29

Fixes from the Obsidian community-store review.

### Changed

- The reMarkable connect field describes the one-time code instead of showing a lowercase
  example.
- The background-transcription description no longer refers to the "Sync now" button by name.

### Fixed

- The plugin bundle no longer creates `<script>` elements or calls `new Function`. These came
  from a compression library bundled inside the reMarkable cloud client, not from this plugin's
  own code, and were the reason the store review rejected 1.0.5. The library is now built from
  source with those two polyfills replaced, and the resulting sync output is byte-for-byte
  identical.
- Requests are resolved correctly when given a `Request` object rather than a URL string. This
  never happened in practice, but it would have failed as a malformed URL rather than as anything
  readable.
- Apple Vision transcription now fails with a clear message instead of hanging forever if the
  helper process cannot be given input.

### Added

- The README now states that the clipboard is written but never read, and that the folder list is
  read only to fill the tag-routing dropdown.

## [1.0.5] - 2026-07-28

### Fixed

- Fixes the OCR backend hint on Windows and Linux: the settings screen no longer prints "Apple
  Vision: flat text only, no headings or tables." on systems where Apple Vision is not selectable.

## [1.0.4] - 2026-07-28

Fixes from pre-submission review of the community-store release.

### Added

- The status bar shows theme-consistent icons instead of raw text glyphs. This release adds a
  `styles.css` asset.

### Changed

- Synced notes are written with `vault.process()` so background writes merge safely with open
  editors; settings text field saves are debounced.
- Notices drop the "Tagged Sync: " prefix.
- `minAppVersion` is now 1.5.7 (for `getFileByPath`/`getFolderByPath`).

### Fixed

- The plugin no longer replaces the app-wide `fetch`. The CORS workaround for the reMarkable
  cloud API is now compiled into the plugin bundle at build time, so it cannot affect Obsidian
  core or other plugins. Request bodies of all types the plugin sends are forwarded faithfully,
  and 204/304 responses no longer error.
- The attachments folder setting is normalized with `normalizePath()` and falls back to the
  default if a `.`/`..` segment could point outside the vault.
- On-launch auto-sync waits for `onLayoutReady` before its startup delay.

## [1.0.3] - 2026-07-28

### Added

- **Sync to the vault root.** Tag mappings can now target "Vault root", so a brand-new empty
  vault no longer shows "No folders exist in your vault yet" for every discovered tag.
- **Configurable attachments folder.** The vault folder for rendered PDFs can be changed in
  settings. The default (`tagged-sync/attachments`) is unchanged, and already-synced files stay
  where they are.

## [1.0.2] - 2026-07-28

### Fixed

- Notes synced without transcription (backend Off, or on Windows/Linux where Apple Vision is
  unavailable) no longer contain an empty "## Transcript" section. The "Re-transcribe all synced
  notes" command is hidden when the active backend produces no text. Enabling a backend later
  grows the section into existing notes via re-transcribe.

## [1.0.1] - 2026-07-28

### Fixed

- Adding or changing a tag mapping now triggers a sync even when nothing changed on the
  reMarkable side. Previously the plugin reported "up to date" until the device contents changed.

## [1.0.0] - 2026-07-28

### Added

- Initial release. Sync tagged reMarkable notebooks into Obsidian as searchable Markdown notes,
  routed to folders by tag.
