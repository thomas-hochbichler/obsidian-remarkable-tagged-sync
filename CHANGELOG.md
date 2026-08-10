# Changelog

All notable changes to this plugin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

New entries go under `## [Unreleased]`, **in the same commit as the change** -- not at release
time. At release time that heading is renamed to `## [<version>] - <date>`, and the release
workflow publishes the section as the GitHub release body. See
[docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

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
