# Reddit research from Claude Code: why cURL fails and what works

Research note, 2026-08-03. Question: how can Claude (Claude Code / an agent) reliably read Reddit posts, comments, and subreddit search results, given that plain cURL requests to reddit.com return 403?

## TL;DR

Reddit blocks all anonymous automated access by policy and in practice. The sanctioned path is the **official Data API with OAuth2** (free tier: 100 queries/minute), used either directly via curl, via **PRAW**, or via a **PRAW-backed MCP server**. For quick interactive lookups without API setup, **Claude in Chrome** (browsing with the user's real session) is the pragmatic alternative. Claude's built-in WebFetch and WebSearch tools cannot reach reddit.com at all.

## 1. Why anonymous cURL fails

Verified empirically on 2026-08-03 from this machine:

- `https://www.reddit.com/r/<sub>/about.json` → **403**, with default curl UA and with a descriptive custom UA.
- `https://old.reddit.com/...json` → **403** as well.
- `https://www.reddit.com/robots.txt` → 200, and it disallows everything:

  ```
  User-agent: *
  Disallow: /
  ```

  The file itself points to Reddit's [Public Content Policy](https://support.reddithelp.com/hc/en-us/articles/26410290525844-Public-Content-Policy) ("Reddit believes in an open internet, but not the misuse of public content") and to [r/reddit4researchers](https://www.reddit.com/r/reddit4researchers/) for research access. (Source: https://www.reddit.com/robots.txt, fetched directly.)

- Reddit's [API rules](https://github.com/reddit-archive/reddit/wiki/API) additionally state that OAuth2 is mandatory for all clients, and: *"NEVER lie about your user-agent. This includes spoofing popular browsers and spoofing other bots."* — violators are banned. Default UAs like `Python/urllib` get drastically reduced limits.

So: this is not a transient block. Unauthenticated scraping is against Reddit's stated policy, and spoofing a browser UA is explicitly prohibited.

## 2. The official Reddit Data API (the sanctioned path)

- **API registration is required first.** Creating an app at https://www.reddit.com/prefs/apps silently fails (the form resets, with only a pointer to the [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)) until the account is registered for API usage. Register via the [request form](https://support.reddithelp.com/hc/requests/new?ticket_form_id=14868593862164) — select "I'm a Developer" and "I want to register to use the Reddit API". (Source: [reddit.com/wiki/api](https://www.reddit.com/r/reddit.com/wiki/api/); empirically verified in-browser 2026-08-03.)
- **Then register an app** at https://www.reddit.com/prefs/apps — choose type **"script"** for personal use; "redirect uri" is mandatory even for script apps (any value, e.g. `http://localhost:8080`). You get a `client_id` and `client_secret`. (Source: [PRAW quick start](https://praw.readthedocs.io/en/stable/getting_started/quick_start.html), [OAuth2 wiki](https://github.com/reddit-archive/reddit/wiki/OAuth2).)
- Note: Reddit now frames the legacy Data API as being for moderation use cases and points new app development to its [Developer Platform](https://developers.reddit.com/) (Devvit), which is for building on-Reddit apps, not data research. (Source: [reddit.com/wiki/api](https://www.reddit.com/r/reddit.com/wiki/api/).)
- **Rate limits (free tier):** 100 queries per minute per OAuth client ID, averaged over a 10-minute window; ~10 QPM without OAuth (and non-OAuth traffic is generally blocked). Numbers per Reddit's [Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki) (the page blocks non-browser fetches; numbers cross-confirmed via multiple 2025/2026 developer guides). The older archived wiki still says 60 rpm — the Data API Wiki figure (100 QPM) is the current one.
- **User-Agent format** (required): `<platform>:<app ID>:<version> (by /u/<username>)`, e.g. `macos:my-research-script:v1.0 (by /u/yourname)`. (Source: [API rules](https://github.com/reddit-archive/reddit/wiki/API).)
- **Free vs. paid:** free access covers non-commercial use within the rate limits. *"If you are interested in using the Data APIs for commercial purposes, research in excess of rate limits, or for any use that is not expressly permitted under the Data API Terms, then you will need to enter into a separate agreement with Reddit."* (Source: [Data API Terms](https://redditinc.com/policies/data-api-terms), §3.1, fetched 2026-08-03.)

## 3. Public `.json` endpoints

Appending `.json` to any Reddit URL used to return the page as JSON without auth. As tested above, these now return **403** from this network regardless of User-Agent (on both `www` and `old.reddit.com`). Even where they intermittently work (e.g. from residential IPs), they are unsanctioned: robots.txt disallows all paths, and the API rules require OAuth. Don't build on them.

## 4. Options for Claude specifically

| Option | Auth needed | Reliability | Best for |
|---|---|---|---|
| WebSearch / WebFetch | — | **Does not work.** Reddit blocks Anthropic's crawler: WebFetch returns "unable to fetch from www.reddit.com"; WebSearch restricted to reddit.com errors with *"The following domains are not accessible to our user agent: ['reddit.com']"* (see [Anthropic crawler docs](https://support.anthropic.com/en/articles/8896518)). Verified 2026-08-03. | Nothing on reddit.com itself; only secondary sources quoting Reddit |
| Claude in Chrome (`mcp__claude-in-chrome__*`) | User's logged-in browser session | High for interactive use; not blocked because it is the user's real browser | Quick lookups, reading a handful of threads, ad-hoc research |
| Official Data API via curl / scripts | script app (`client_id` + `secret`) | High, 100 QPM | Systematic research, search across subreddits, comment trees |
| [PRAW](https://praw.readthedocs.io/en/stable/getting_started/quick_start.html) (Python) | Same script app | High; handles rate limiting and pagination for you | Same as above, with less plumbing |
| Reddit MCP servers | Varies | Varies | Making Reddit a first-class tool in Claude Code |

MCP servers verified via their repos on 2026-08-03:

- [Arindam200/reddit-mcp](https://github.com/Arindam200/reddit-mcp) — PRAW-based; **requires** `client_id`/`client_secret` from https://www.reddit.com/prefs/apps. Uses the sanctioned API. Tools: search posts, top posts, subreddit stats, user history, fetch by URL/ID.
- [Hawstein/mcp-server-reddit](https://github.com/Hawstein/mcp-server-reddit) — redditwarp-based, **no credentials** (anonymous public API). `uvx mcp-server-reddit`. Convenient, but anonymous access is the ~10 QPM gray zone that Reddit is actively locking down — expect breakage.

Third-party search APIs (Exa, Google Programmable Search, etc.) can surface Reddit URLs but not reliably full thread content; they were not evaluated as primary tools here.

## 5. Terms-of-service notes (brief)

From the [Data API Terms](https://redditinc.com/policies/data-api-terms) (fetched 2026-08-03):

- Non-commercial use within rate limits is free; commercial use or research beyond the limits needs a separate agreement (§3.1). Academic research has a dedicated program: [r/reddit4researchers](https://www.reddit.com/r/reddit4researchers/).
- **No AI/ML training** on user content without express permission: *"no other rights or licenses are granted or implied, including any right to use User Content for other purposes, such as for training a machine learning or AI model, without the express permission of rightsholders"* (§2.4).
- Bulk scraping outside the API contradicts robots.txt and the [Public Content Policy](https://support.reddithelp.com/hc/en-us/articles/26410290525844-Public-Content-Policy); UA spoofing is explicitly banned ([API rules](https://github.com/reddit-archive/reddit/wiki/API)).

## 6. Recommendation

Ranked by effort vs. reliability for Claude Code sessions:

1. **Quick, occasional lookups → Claude in Chrome.** Zero setup, uses the user's session, fully interactive. Not suitable for volume.
2. **Systematic research → script app + official API.** One-time setup: first the [API registration request](https://support.reddithelp.com/hc/requests/new?ticket_form_id=14868593862164) (see §2 — app creation is blocked without it), then create the script app at https://www.reddit.com/prefs/apps. After that: raw curl (below), PRAW, or the Arindam200 MCP server wired into `.mcp.json` so Claude can query Reddit as a tool.
3. **Avoid:** UA-spoofed scraping, `.json` endpoints, and credential-less MCP servers for anything that matters.

### Minimal working example (official API, curl only)

```bash
# 1. Get an app-only token (script app; HTTP Basic auth = client_id:client_secret)
#    Source: https://github.com/reddit-archive/reddit/wiki/OAuth2
TOKEN=$(curl -s -X POST https://www.reddit.com/api/v1/access_token \
  -A "macos:my-research-script:v1.0 (by /u/YOURNAME)" \
  --user "CLIENT_ID:CLIENT_SECRET" \
  -d "grant_type=client_credentials" | jq -r .access_token)

# 2. Query the API — note the host is oauth.reddit.com, NOT www.reddit.com
curl -s "https://oauth.reddit.com/r/ObsidianMD/search?q=remarkable&restrict_sr=1&limit=10" \
  -A "macos:my-research-script:v1.0 (by /u/YOURNAME)" \
  -H "Authorization: bearer $TOKEN" | jq '.data.children[].data.title'
```

### Same thing in PRAW

```python
import praw

reddit = praw.Reddit(
    client_id="CLIENT_ID",
    client_secret="CLIENT_SECRET",
    user_agent="macos:my-research-script:v1.0 (by /u/YOURNAME)",
)  # read-only instance; reddit.read_only == True

for post in reddit.subreddit("ObsidianMD").search("remarkable", limit=10):
    print(post.score, post.title, post.url)
```

Endpoint reference: https://www.reddit.com/dev/api
