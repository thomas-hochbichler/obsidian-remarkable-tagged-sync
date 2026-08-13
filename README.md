# Tagged Sync for reMarkable

> **Disclaimer:** Tagged Sync for reMarkable is an unofficial, community-built plugin. It is not
> affiliated with, endorsed by, or supported by reMarkable AS. "reMarkable" is a trademark of
> reMarkable AS, used only to describe compatibility.

Tag a notebook or a PDF on your reMarkable, and it lands in the vault folder you mapped — your
handwriting transcribed, your highlights quoted.

## A notebook you wrote in

The pages as you drew them, embedded in the note, plus a searchable transcript underneath — split
by page, so a long notebook stays navigable.

![Writing a note on the reMarkable, tagging it sync, running Sync now in Obsidian, and the note arriving with the handwriting render and a searchable transcript split by page](docs/showcase-handwriting.gif)

## A PDF you marked up

Every passage you highlighted or underlined, quoted with the sentence around it and filed under the
section it came from. Each quote carries a block ID, so you can link a single passage from anywhere
in your vault. None of it goes through transcription, so this works the same on Windows and Linux as
it does on a Mac.

![Highlighting and underlining passages in a PDF on the reMarkable, tagging it sync, and the digest arriving in Obsidian as quotes grouped by section, each linking back to its page](docs/showcase-annotations.gif)

<sub>PDF shown: Kang et al., <a href="https://arxiv.org/abs/2510.00615">ACON: Optimizing Context
Compression for Long-horizon LLM Agents</a>, CC BY 4.0.</sub>

**Desktop only** · **one-way** (reMarkable → Obsidian) · never writes back to your tablet.

## Before you install

Two limits, so you know them up front:

- **This free version syncs one tag.** You map one reMarkable tag to one vault folder. You can
  change or remove that mapping at any time. The one-tag limit is a limit of the free version: a
  paid version that lifts it is planned but not yet available. Everything described in this
  README works without payment.
- **Text transcription is built in on macOS 13 or later.** Everywhere else — Windows, Linux, older
  Macs — you can transcribe by pointing the plugin at a local AI server you run yourself
  ([Ollama, LM Studio, or any OpenAI-compatible server](#a-local-server-you-run-yourself)), or by
  using the optional [managed local model](#local-model-optional-opt-in) where your machine
  qualifies. With none of those set up, your notes still sync with the full handwriting render
  embedded — but there is no transcript. **Marked-up PDFs are unaffected:** their
  [digest](#annotated-pdfs) is built from the PDF's own text and needs no transcription at all, so it
  works everywhere.

## Handwriting transcription

![A synced note in Obsidian: the two handwritten pages rendered on top, the searchable transcript below them](docs/screenshot-synced-note.png)

Transcription runs locally on **macOS 13 or later** using Apple's Vision framework — no account,
no API key, no network. On **Windows and Linux** nothing transcribes by default: notes sync with
the handwriting render embedded, and no `## Transcript` text.

Two ways to change that, both entirely on your own machine:

- The [managed local model](#local-model-optional-opt-in), where your hardware qualifies — the
  plugin downloads and runs it for you, including on Windows on ARM.
- [A local server you run yourself](#a-local-server-you-run-yourself) — Ollama, LM Studio, or any
  OpenAI-compatible server. **This one works everywhere**, including Windows on x64 and Linux.

You can also set the backend to **Off** if you only want the render. That is the default where
Apple Vision cannot run.

### A local server you run yourself

If you already run — or are willing to install — a local AI server, the plugin can send each page
to it and get the text back. Nothing leaves your machine, and there is no account or key.

1. Install and start **Ollama**, **LM Studio**, or any other server that speaks the OpenAI
   `/chat/completions` API, and load a **vision** model into it.
2. In the plugin settings, set **Backend** to that server and enter the model's name. The address
   is pre-filled for Ollama and LM Studio; change it only if yours runs elsewhere.

Which model you use is your choice. For what it is worth: **we measured Qwen2.5-VL-7B at 7.6 %
character error** — about three times more accurate than Apple Vision on the same pages — but we
measured it running the model directly, not through one of these servers, so treat it as a starting
point rather than a promise. A text-only model cannot read a page image at all; settings checks the
model you name and says so when it can.

If the server is not running, settings says so, and a sync that hits it leaves the notes with their
render and reports it at the end rather than failing quietly.

How the local backend works, for transparency:

- Each page is rendered to a temporary PNG under your OS temp directory (`os.tmpdir()`), never
  under Documents/Desktop/Downloads/iCloud. The plugin deletes these images as soon as
  transcription finishes.
- The PNGs are transcribed by invoking the built-in `/usr/bin/osascript` binary, which drives
  Apple's Vision framework. This runs entirely on your machine with **no network egress** — no
  page image or text ever leaves the device.

Apple Vision auto-detects language and reads cursive well, but produces **flat text** — no
headings, lists, task lists, or tables. Its structured API is macOS Swift-only and unavailable
here. It can also misread; see [Writing your own notes](#writing-your-own-notes).

### Local model (optional, opt-in)

On some machines you can switch the backend to a **local AI model** instead. It reads handwriting
about three times more accurately than Apple Vision and keeps headings and lists, and like Vision
it runs entirely on your machine. It is **never a default**: a fresh install downloads nothing,
and Apple Vision stays the default on macOS.

Choosing it downloads **5.5 GB of model files plus a 12 MB program**, after an explicit opt-in in
settings. Both are checked against a SHA-256 published in the plugin before anything runs. It is
slow compared with Vision — roughly 15 seconds a page on a fast Mac against Vision's 0.4 — and it
holds about 14 GB of memory while it runs.

**Offered only on:**

| | Requirement |
|---|---|
| macOS | Apple Silicon, 18 GB of memory or more (32 GB recommended) |
| Windows | ARM (Snapdragon X and similar), 24 GB of memory or more |

Intel Macs, Windows on x64 and Linux do not get the option, and settings says why on the machine
itself. **Windows x64 is excluded because Windows Defender quarantines the engine** — the
`llama.cpp` builds for x64 have been flagged as `Trojan:Win32/Wacatac.B!ml` for years, the builds
are unsigned, and nothing this plugin does to its own download changes what a malware scanner
decides about someone else's binary. Windows on ARM uses a different build, which is not flagged.

Like any transcription it misreads sometimes, and it misreads *differently*: Vision's mistakes
usually look broken on the page, while this model writes its mistakes as fluent text. Check
anything that matters against the handwriting.

## Annotated PDFs

A PDF you marked up gets a **`## Digest`** in place of the transcript: your marks, quoted with the
sentence around them, grouped under the section of the document they came from.

![A digest in Obsidian: the annotated PDF embedded on top, below it the quotes grouped under their section headings, each linking back to its page](docs/screenshot-digest.png)

**Both the highlighter and the pen count.** A passage you marked with the highlighter and one you
underlined or circled with the pen arrive the same way — a quote with its surrounding sentence, the
section it sits under, and a link to the page. Marking with the pen used to reach your vault as
nothing at all.

**None of this goes through transcription.** The words come from the PDF's own text, not from a
picture of it, so the digest works the same on Windows and Linux as it does on a Mac — and no marked
word can come out misspelled.

**Every quote is linkable on its own.** Each entry ends with a block ID, so a single annotation can
be embedded anywhere in your vault: `![[My Book^hl-d449a3]]` pulls in that one quote. The IDs are
stable across syncs.

**The document's note is its digest.** There is no separate digest note collecting every document —
the marks live in the note of the document they belong to, in the folder you mapped.

### The notes you write in the margin

**Switch them on under Settings → Handwritten notes, and what you wrote beside the text arrives with
what you marked.** They are off until you say otherwise: transcribing handwriting is work your
machine does per note, and it needs a transcription backend — the same one a handwritten notebook
uses.

Each note is printed where you wrote it: under the section heading it sits in, or beside the
sentence it points at, with a link to its page. **And you can look at the handwriting itself.** The
eye in the corner of an entry draws the strip of page the note sits on, cut out of the PDF the note
already embeds — it appears when you press it and not before, and **no image is ever written to your
vault**.

![A margin note in Obsidian: the quoted sentence above, the transcribed note below it, and the clipping of the page showing the highlighted passage next to the handwriting it was written beside](docs/screenshot-margin-note.png)

A note whose handwriting could not be transcribed says so rather than standing empty, and keeps its
anchor and its page link.

Three things worth knowing before you rely on it:

- **Without margin notes switched on, the digest is built from what you *marked*, not from what you
  *wrote*.** Handwriting then stays in the render where you wrote it — no text is extracted from it,
  and a PDF you only wrote on syncs with the render and no text at all.
- **It reads the PDF's own text layer.** A scanned page without one gives less: highlights arrive as
  the words your tablet recorded, and pen marks are not recognised as marks at all.
- **Marker colour is not carried over.** Every mark reads the same in the note; the colours stay in
  the embedded render.

Section headings come from the PDF's own outline where it has one, and from a font-size guess where
it does not — so a document without bookmarks can file a quote under the wrong heading.

## Network use

This plugin makes network requests to exactly one place by default:

- **reMarkable cloud** (required) — the plugin authenticates to `my.remarkable.com` via a
  one-time device code, then reads your notebook/page list, tags, and content over the
  reMarkable cloud API to sync it into your vault. This is read-only; nothing is written back to
  your reMarkable account.

Two more hosts are contacted **only if you opt in to the local model** (see above), once, to
download it — never during a sync, and never again once the files are on disk:

- **`huggingface.co`** — the two model files, from
  `ggml-org/Qwen2.5-VL-7B-Instruct-GGUF`, pinned to one commit (4.68 GB + 853 MB).
- **`github.com`** — the `llama.cpp` engine, from release `b10295` of `ggml-org/llama.cpp`
  (11–12 MB depending on platform).

Nothing is uploaded to either. Transcription itself is always local: no page image and no
transcript ever leaves the device, whichever backend you use.

No telemetry or analytics of any kind are collected or sent by this plugin.

## Accessing files outside of Obsidian vaults

Two things, both only on the paths your OS reserves for exactly this:

- **Page images during transcription.** Each page is written as a temporary PNG under your OS
  temp directory (`os.tmpdir()`) and deleted as soon as the page has been read.
- **The local model, if you opt in to it.** The 5.5 GB of model files and the engine are written
  to the standard per-application data directory — `~/Library/Application Support/remarkable-tagged-sync/`
  on macOS, `%LOCALAPPDATA%\remarkable-tagged-sync\` on Windows — and read from there when you
  transcribe.

  They live **outside your vault on purpose**: inside it they would go through Obsidian Sync and
  every vault backup, once per vault, and 5.5 GB is not something to put in someone's backup
  without saying so. The price is that **uninstalling the plugin does not delete them.** The
  *Delete the model* button in settings does, and settings names the exact size before you agree
  to download anything.

## Other permissions this plugin uses

Two behaviours show up in Obsidian's automated plugin review, so they are spelled out here:

- **Clipboard — write only.** The *Copy diagnostics* button in settings writes your plugin
  version, Obsidian version, platform, selected OCR backend, number of mapped tags, and last sync
  time to the clipboard, so you can paste them into a bug report. The plugin **never reads** your
  clipboard, and nothing is sent anywhere — you choose where to paste it.
- **Vault folder list.** The tag-routing settings read the list of folders in your vault to fill
  the "map this tag to a folder" dropdown. Only folder *paths* are read; note contents are never
  scanned for this, and the list never leaves your machine.

## How it works

1. Tag a notebook, a PDF, or a single page on your reMarkable — e.g. `sync`.
2. It syncs to the reMarkable cloud as usual.
3. In Obsidian, map that tag to a vault folder in the plugin settings.
4. Run **Sync now** (or let automatic sync do it).
5. You get a Markdown note with the render embedded, and either a searchable transcript or a digest
   of your marks below it.

## Setup

1. Install and enable the plugin.
2. Open **Settings → Tagged Sync for reMarkable**, and follow the "Connect" link to
   `my.remarkable.com/device/browser/connect` to get a one-time code. Enter it and click
   **Connect**. Codes expire after a few minutes, so get a fresh one if it is refused.
3. Click **Discover tags** to scan your reMarkable notebooks and pages for tags, then map the
   tag you want to sync to a vault folder. Only a mapped tag is synced — an unmapped tag is
   simply not selected, not lost.
4. Click **Sync now**.

Sync is also available from the command palette as **Tagged Sync for reMarkable: Sync now**.

### Stopping a sync

While a sync is running, the status bar shows a turning icon. Click it and confirm, or run **Tagged
Sync for reMarkable: Stop sync** from the command palette. This works for an automatic sync and for
re-transcribing too.

Stopping is safe rather than instant: the note being transcribed right now is finished first, so it
can take a moment — the status bar says `stopping…` meanwhile. Everything already written is kept,
and the next sync carries on from where it left off.

![The plugin settings: reMarkable connection, OCR backend, tag mapping, and the Sync now button](docs/screenshot-settings.png)

### Automatic sync

Off by default. Under **Automatic sync** you can turn on a sync when Obsidian launches, plus an
interval backstop while it stays open. A manual sync pushes the next automatic one out rather
than triggering a redundant run.

### Re-transcribing

To refresh transcripts on notes you already synced, run **Tagged Sync for reMarkable: Re-transcribe
all synced notes**. It re-fetches each notebook and rewrites only the transcript region, leaving
your own notes and the embedded render untouched. It asks for confirmation first.

This is also the way to fill in a transcript that never arrived — a note synced while the local
model was still downloading, or while its engine was missing, keeps its render and no text, and
nothing refills it on its own. Re-transcribing does. With the local model selected the
confirmation tells you how long it will take on your machine, measured from your own pages.

## What gets synced

- A notebook tagged with a mapped tag syncs as one note for the whole notebook.
- An individual page tagged with a mapped tag syncs as its own note, independent of any
  notebook-level tag.
- A handwritten notebook's note has the rendered PDF embedded, then a `## Highlights` section (one
  quote callout per page, if you highlighted anything on the tablet), then the `## Transcript`. If
  transcription is off, fails, or finds nothing, the note is still created with the render and no
  `## Transcript` section — the render is never lost. An annotated PDF gets a
  [`## Digest`](#annotated-pdfs) instead.
- **The transcript is split by page.** Each page that produced text gets its own heading linking
  into that page of the embedded PDF, so a long notebook stays navigable. Pages with nothing to read
  are named once at the end instead of taking a heading each, and a page transcription could not
  read says so where it happened. Notes synced before this keep the transcript they have — run
  **Re-transcribe synced notes** to bring them over.
- A synced note carries **no frontmatter**. Everything the sync needs to track lives in the
  plugin's own `data.json`, not in your notes.
- Removed or untagged units are **never deleted**. The plugin stops updating them and leaves the
  note exactly where it is, so nothing you already have can disappear.

### Writing your own notes

A synced note belongs to the plugin: **every sync rewrites it from scratch**. Each note says so
at the top, in a collapsed callout. So keep your own writing in a note of your own, and link back
to the synced one.

If you do edit a synced note — for example to fix a misread word — the plugin notices and
**refuses to overwrite it**, telling you how many notes it skipped. Your edit is never silently
erased; that note simply stops updating until you undo the change.

Notes synced by earlier versions had a free area below the sync block. Anything you wrote there
stays where it is and is still preserved on every sync — new notes just no longer offer it.

## Limitations

- Desktop only. Obsidian on mobile is unsupported.
- One-way sync: reMarkable → Obsidian only. Nothing is ever written back to your tablet.
- One tag → folder mapping.
- Transcription with Apple Vision requires **macOS 13 or later**, and its transcripts are flat
  text — no headings, lists, task lists, or tables.
- The optional [local model](#local-model-optional-opt-in) keeps headings and lists, but needs
  Apple Silicon with 18 GB of memory or Windows on ARM with 24 GB, and a 5.5 GB download. Tables
  come out as plain lines.
- **Windows on x64 and Linux get the render and no transcript out of the box.** Neither Apple Vision
  nor the managed local model reaches them; [a local server you run
  yourself](#a-local-server-you-run-yourself) does, and is the only route there. This is about
  *handwriting* only — the [digest of a marked-up PDF](#annotated-pdfs) needs no transcription and
  works everywhere.
- **A PDF you only wrote on syncs with the render and no text.** The digest quotes what you marked;
  handwriting on the page is not read.
- The reMarkable cloud API used here (via `rmapi-js`) is reverse-engineered and unversioned;
  firmware changes on reMarkable's side can break sync. See below.

> **What I do not control**
>
> This plugin talks to the reMarkable cloud. I do not work for reMarkable. I have no contract with
> them and no advance warning of their plans. They can change or switch off their cloud at any
> time. This already happened: in April 2026 a format change broke every tool in this space.
>
> If it happens again:
>
> - I will work on a fix as fast as I can. **I cannot promise a date.**
> - **Your notes are safe.** Everything already synced is plain Markdown and PDF in your own
>   vault. It stays there. Nothing is deleted.

## Reporting a problem

Open an issue at
[github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync/issues](https://github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync/issues).

Before you write it, press **Copy diagnostics** in the plugin settings and paste the result into
the issue. It contains your plugin and Obsidian versions, your OS, whether Apple Vision is
available, and the last error — nothing is sent anywhere by pressing it.

## Requesting a feature

Suggest a feature by opening a
[feature request](https://github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync/issues/new?template=feature_request.md).
Vote on
[existing requests](https://github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync/issues?q=is%3Aopen+label%3Aenhancement+sort%3Areactions-desc)
with a 👍 reaction — the most-wanted features rise to the top.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # typecheck + production build
npm test         # vitest
```

## License

Apache-2.0 — see [LICENSE](./LICENSE). Third-party notices are in [NOTICE](./NOTICE).
