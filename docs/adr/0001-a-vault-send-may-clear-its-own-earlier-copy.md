---
status: accepted
---

# A vault send may clear away its own earlier copy

Send was add-only, and `SendTransport` said so as a type: one method that writes, no delete, no
move. That fits a paper, which does not change. A note does: a spec revised five times left five
documents on the tablet that only the reader could delete (lived on 2026-11-13, eleven documents
after nine rounds). So a second vault send may move the plugin's **own** earlier copy of that file
to the tablet's trash — without asking while the copy is untouched, and only on the reader's
say-so once it carries their ink. Decided 2026-11-13, before the feature was built.

## Considered options

- **Add only.** Keeps the promise word for word and the type as it was; the clutter stays the
  reader's to clear, one document per revision.
- **Always replace.** Tidy, but a copy written on yesterday and not synced yet leaves with it.
- **Replace only an untouched copy; ask about one that carries ink** (chosen). The rule the plugin
  already keeps in Zotero — what the reader has touched is theirs — applied to the tablet.

## Consequences

- The transports get a second writing method. It moves a document to the trash and nothing else;
  it never deletes for good, and it is only ever called for a document this vault's own record
  says it sent. A Zotero send stays add-only.
- "Untouched" is narrow on purpose: no ink, no tag on the document or a page, still in the send
  folder, still under the name it was sent as, not pinned. Erased ink cannot be told from ink and counts as written on, so the error falls on the
  safe side. A document of the same name that this vault did not send is never touched.
- The new version is uploaded first and the earlier copy cleared second, so a failure never leaves
  the reader without the document.
- Over the cloud only. Over SSH it would mean rewriting an existing document's `.metadata` on the
  device, which could not be checked on a tablet when this was decided; there a vault send only
  adds.
- The README's "only adds, never changes, deletes or moves anything" is reworded: nothing the
  reader put on the tablet is changed, deleted or moved; the one thing Send clears away is its own
  earlier copy of a vault file, and one the reader has touched only on their say-so.
