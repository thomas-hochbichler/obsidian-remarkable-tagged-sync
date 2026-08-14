# Privacy

Short version: **the plugin has no telemetry and never will.** Nothing about how you use it is
collected, counted or sent anywhere. The only personal data that reaches me at all comes from
buying a licence or from writing to me.

Responsible for this processing (controller, Art. 4 No. 7 GDPR): hochbichler.com - IT Services e.U.,
owner Thomas Hochbichler, Rapoldeck 58, 3335 Weyer, Austria, support@hochbichler.com. Full contact
details: [IMPRESSUM.md](./IMPRESSUM.md).

## 1. What the plugin sends, and when

### The reMarkable cloud, and any transcription backend you configure

These are your own accounts, used on your instruction. They are described in detail in the
README's [Network use](./README.md#network-use) section, which is the authoritative list. Nothing
there goes to me.

### The licence check — the only call added by Tagged Sync Pro

If, and only if, you use a paid feature, the plugin contacts **`polar.sh`** to check that your
licence key is valid.

| | |
|---|---|
| **When** | only on the path of a paid feature — a cloud transcription run, or adding a second tag mapping |
| **How often** | at most **once every 7 days**. A valid answer is remembered; between checks nothing is sent |
| **Never** | if you have not bought and are not in the trial. A free user causes **no** call to `polar.sh`, ever |
| **What is sent** | your licence key, the activation id of this vault, and the public organization id of the plugin. **No email address, no vault name, no note content, no usage statistics** |
| **What Polar sees** | the above, plus — unavoidably, as with any web request — your IP address and the time of the request |

If `polar.sh` cannot be reached, nothing happens: the last valid answer carries for 30 days, and
after that the settings tab says so and Pro keeps working. Silence never locks the plugin.

### The trial

The 14-day trial is entirely local. Starting it sends nothing to anyone. There is no key, no email
and no account.

## 2. What is stored on your own machine

Your licence key, the activation id, the date of the last successful check and the trial start date
are stored in the plugin's `data.json`, inside your vault, next to the reMarkable device token that
is already there. That file is yours. If your vault is synced, the file travels with it — which is
intended, because one vault is one activation.

## 3. What I store when you buy

**Polar Software Inc. is the seller** and runs the checkout. Polar collects your email address,
payment and tax data as its own controller, under
[Polar's privacy policy](https://polar.sh/legal/privacy). I never see your card details.

Separately from Polar, I keep a **minimal buyer list** of my own:

| Field | Why |
|---|---|
| email address | to reach you if a key has to be re-issued |
| order id and date | to match a key to a purchase |
| licence key | so a key can be re-issued if Polar disappears |

- **Purpose and legal basis:** performing and administering the licence contract, Art. 6(1)(b)
  GDPR, and my legitimate interest in being able to honour licences if the payment provider fails,
  Art. 6(1)(f) GDPR. This list exists for exactly one reason: Polar is a young company, and if it
  went away, without this list every licence ever sold would be unverifiable and unreplaceable.
- **Where:** exported from Polar and kept locally on my own machines, encrypted at rest. It is not
  in any cloud service, not in this repository, and never published.
- **How long:** as long as the licence exists. The licence is **perpetual**, so this means
  **indefinitely** — I would rather say that plainly than invent a retention period I could not
  keep. If you ask me to delete your entry, I will, and the trade-off is that I can then no longer
  re-issue your key.
- **Recipients:** none. It is not shared, sold or transferred to anyone.

## 4. Support

If you open a **GitHub issue**, whatever you write there is public and is processed by GitHub under
its own terms. If you **email me**, I keep the correspondence as long as it is useful for support,
and no longer.

Email is deliberately a narrow door — a key that did not arrive, or a report containing private
data that should not go into a public issue. Everything else gets a short reply pointing at GitHub
Issues, so that the answer helps the next person too.

## 5. Your rights

You can ask me for access to the data I hold about you, and for its correction, erasure,
restriction, portability, or to object to the processing (Art. 15–21 GDPR). Write to
support@hochbichler.com — no form, no account needed. You can also complain to the Austrian data
protection authority, the [Datenschutzbehörde](https://www.dsb.gv.at/).

For data held by Polar as the seller, address Polar directly; I cannot delete records in their
system.

## 6. What is not here, on purpose

- **No analytics, no telemetry, no crash reporting, no usage counters.** This is a store rule and a
  promise, and the plugin contains no such code.
- **No account.** There is nothing to sign up for and nothing to log into.
- **No page image and no transcript ever leaves your device** except to a transcription backend
  *you* configured with *your* own key. See the README.

*Last updated: «DATE».*
