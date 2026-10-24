# Which fetch calls can move to requestUrl?

Research for wayfinder ticket `store-scorecard-caution/05`, 2026-10-24, at `origin/main` cdfdf97
(same plugin code as 1.9.0).

## Answer in one paragraph

All 8 plugin-code `fetch` findings can be switched. No call needs anything that `requestUrl`
lacks, and none of them uses `fetch` at run time anyway: esbuild's `inject` rewrites every
free `fetch` in the bundle to `obsidianFetch` (`src/obsidian-fetch.ts`), which already calls
`requestUrl({ …, throw: false })`. So each call already runs on `requestUrl` in production
today. The finding concerns the source text only. To fix it, change the default from the
global `fetch` to an explicit `import { obsidianFetch } from "./obsidian-fetch"` (or
`"../src/obsidian-fetch"` from `pro/`). The bundle behaves the same, and 8 Warnings go away.
**Keeping a call is not an option with a disable comment:** `no-restricted-globals` is on
the `eslint-comments/no-restricted-disable` list in the plugin's `recommended` config. An
inline disable would itself be an error. "Keep" can only mean accepting the Warning.

## 1. Is a scoped, described `eslint-disable` legal for this rule?

No. In `eslint-plugin-obsidianmd@0.4.1`, `dist/lib/index.js`:

- line 172: `"no-restricted-globals": ["warn", ...restrictedGlobalsOptions]`. The `fetch`
  entry comes from `dist/lib/ruleOptions.js:8-9` ("Use the built-in `requestUrl` function
  instead of `fetch` …"). That is the scorecard's wording.
- lines 272-285: `"eslint-comments/no-restricted-disable": ["error", "obsidianmd/*",
  "no-console", "no-restricted-globals", …]`, applied to every `**/*.{ts,…,js,…}` file.
- lines 269-271 also make `require-description`, `no-unlimited-disable` and
  `disable-enable-pair` errors.

So even a described, single-line `// eslint-disable-next-line no-restricted-globals -- …` is
reported as an error by `no-restricted-disable`. The repo already knew this:
`.eslint-baseline.json` repeats "eslint-comments/no-restricted-disable forbids disabling
no-restricted-globals inline", and the comments at `src/localhost-vision-detect.ts:101-103`
and `src/openai-compat-ocr-backend.ts:207-211` say the same.

## 2. What `requestUrl` can and cannot do

Source: `node_modules/obsidian/obsidian.d.ts` (obsidian 1.13.1), lines 5438-5486, and
https://docs.obsidian.md/Reference/TypeScript+API/requestUrl ,
https://docs.obsidian.md/Reference/TypeScript+API/RequestUrlParam .

| Need | `requestUrl` |
| --- | --- |
| CORS | None. "request a URL using HTTP/HTTPS, without any CORS restrictions" (d.ts 5439). |
| Request body | `string \| ArrayBuffer` only (`RequestUrlParam.body`). The shim turns typed arrays into `ArrayBuffer` and throws on anything else (`obsidian-fetch.ts:118-125`). |
| Binary response | Yes, `RequestUrlResponse.arrayBuffer`. |
| Status without throw | `throw?: boolean`, "Whether to throw an error when the status code is 400+. Defaults to true". The shim passes `throw: false` and builds a real `Response` with the status. |
| AbortSignal | Not in `RequestUrlParam`. The repo already works around it: timeouts are races (`withTimeout`, `withZoteroTimeout`, `Promise.race` in `serverContext`), never aborts. See `licence-client.ts:69-70`, `llm-transcript.ts:385`, `trial-ticket.ts:152-153`. |
| Timeout | Not in `RequestUrlParam`. Same race workaround. |
| Streaming | No. The response is fully buffered. None of the 8 calls streams: all read `.json()`/`.text()` of a complete answer. |
| localhost / 127.0.0.1 | No documented restriction. It already works in production: Zotero local (127.0.0.1:23119) and the Ollama / LM Studio / llama.cpp probes go through the shim today (baseline comment, 2026-09-12 entry). |
| minAppVersion 1.5.7 | `requestUrl` and its `throw` flag carry no `@since` in the d.ts or the docs. The shim has shipped with `throw: false` at minAppVersion 1.5.7 for every reMarkable cloud request since the plugin began. |

The unsupported features (abort, timeout, streaming) are already missing in production for
all 8 calls, because the bundle sends them through `requestUrl` anyway. The code was
written for that: the comments at the sites above say so.

## 3. Per-call verdict

Locations are from ticket 02. "Today at run time" means what the identifier resolves to
in the shipped `main.js` (`esbuild.config.mjs:79`, `inject: ["src/fetch-shim.ts"]`).
`pro/` is in the same bundle (`src/entry.ts:15` imports `../pro/llm-register`), so the
inject covers it as well.

| # | Location | What it calls | Needs beyond requestUrl? | Verdict |
| --- | --- | --- | --- | --- |
| 1 | `pro/anthropic-ocr-backend.ts:111` `options.fetchFn ?? fetch` | Anthropic Messages API, JSON POST with base64 images, read whole | No. 429 retry and timeout come from `fetchWithRetry`/`withTimeout` (race) | **switch** |
| 2 | `pro/ocr-vision-detect.ts:107` `input.fetchFn ?? fetch` | OpenRouter / Ollama / LM Studio model metadata, GET JSON | No. Localhost is already shimmed | **switch** |
| 3 | `src/licence-client.ts:92` `fetchImpl: Fetch = fetch` | Polar licence API, JSON POST | No. The comment at 69-70 already notes there is no abort and the call is raced instead | **switch** |
| 4 | `src/localhost-vision-detect.ts:104` `input.fetchFn ?? fetch` | Ollama `/api/show`, LM Studio `/api/v0/models`, `/api/v1/models` on localhost | No. Localhost already goes through the shim | **switch** |
| 5 | `src/openai-compat-ocr-backend.ts:212` `options.fetchFn ?? fetch` | OpenAI-compatible chat completions (local servers) plus context lookup | No. Not streamed (whole JSON), and the context lookup is raced (88-91) | **switch** |
| 6 | `src/trial-ticket.ts:149` `fetchFn: typeof fetch = fetch` | Trial issuer, one JSON POST | No. `withTimeout`, not AbortSignal (comment 152-153) | **switch** |
| 7 | `src/zotero-local.ts:84` `fetchImpl: Fetch = fetch` | Zotero desktop app at 127.0.0.1:23119 | No. Localhost works via the shim, and the timeout is `withZoteroTimeout` (race) | **switch** |
| 8 | `src/zotero-web.ts:57` `fetchImpl: Fetch = fetch` | api.zotero.org, GET JSON and headers (`Backoff`, `Retry-After`) | No. The headers come through (`obsidianFetch` copies `response.headers`) | **switch** |

No call gets "keep". If one did, it would cost 1 Warning on the scorecard per call, and it
could not be silenced (section 1).

### What the switch looks like

At each site, swap only the value default:

```ts
import { obsidianFetch } from "./obsidian-fetch"; // "../src/obsidian-fetch" in pro/
…
this.fetchFn = options.fetchFn ?? obsidianFetch;
```

`typeof fetch` in type positions (for example `fetchFn?: typeof fetch`,
`type Fetch = typeof fetch`) is **not** reported. Ticket 02's scan flags only the 8 value
lines, never the type lines next to them (for example `localhost-vision-detect.ts:66`), so
the types can stay.

The bundle does not change: the free identifier `fetch` already resolves to `obsidianFetch`
there. The only difference is that the source now says what happens instead of relying on
a build-time rewrite. Several of the comments mentioned above (`localhost-vision-detect.ts:101-103`,
`openai-compat-ocr-backend.ts:207-211`, `licence-client.ts:9-10`, `zotero-web.ts:10`)
explain the inject. They should be shortened or reworded, because the explicit import
makes them unnecessary. `src/fetch-shim.ts:2` names "the OCR backends' `fetchFn ?? fetch`
defaults" as a reason for the inject. After the switch, only rmapi-js needs it, so that
line should change too.

One earlier decision may look like it argues against this, so here is how it fits.
`localhost-vision-detect.ts:102-103` says that "quietly working around it would hide the
one thing worth knowing". That comment concerns silencing or disguising the warning. An
explicit `obsidianFetch` import does neither: it states the real run-time path in the
source, which is the thing worth knowing.

## 4. What the switch costs

- **Tests (the real cost).** `src/settings-tab.test.ts` replaces the global `fetch` with
  `vi.stubGlobal("fetch", …)` 10 times (lines 950-1231, Zotero web/local through the
  settings tab). Those tests rely on the `= fetch` default reading the global at call time.
  After the switch, the default is `obsidianFetch` → `requestUrl` from the test stub, which
  throws on purpose (`test-stubs/fake-obsidian.ts:1253-1254`: "A test tried to make a real
  network request"). Those tests need another seam, for example
  `vi.mock("./obsidian-fetch", …)` or a stub `requestUrl` that the test drives. Other
  tests inject `fetchFn`/`fetchImpl` directly and are not affected. This is a sizing
  question for the spec, not a reason to keep any call.
- **Ratchet.** `.eslint-baseline.json` (`problems: 41`, measured 2026-09-18) carries these
  `no-restricted-globals` warnings as intentional. It drops by however many land, and its
  explanatory comment needs those passages removed.
- **Scorecard.** Warnings −8 (`fetch` 9 → 1). The 9th, `test-support/nightly/ocr-main.ts:57`,
  is ticket 11's move under a scanner-ignored path. The "network request calls"
  Disclosure stays: it describes that the plugin talks to the network, not how.

## Sources

- `node_modules/eslint-plugin-obsidianmd/dist/lib/index.js` (0.4.1), lines 160-172, 266-287
- `node_modules/eslint-plugin-obsidianmd/dist/lib/ruleOptions.js`, lines 6-10
- `node_modules/obsidian/obsidian.d.ts` (1.13.1), lines 5430-5486
- https://docs.obsidian.md/Reference/TypeScript+API/requestUrl
- https://docs.obsidian.md/Reference/TypeScript+API/RequestUrlParam
- `src/obsidian-fetch.ts`, `src/fetch-shim.ts`, `esbuild.config.mjs:76-79`, `src/entry.ts:15`
- `vitest.config.ts:42-45`, `test-stubs/fake-obsidian.ts:1253-1254`, `src/settings-tab.test.ts`
- `.eslint-baseline.json`
- Ticket 02 answer table (`.scratch/store-scorecard-caution/issues/02-scanner-parity-locations.md`)
