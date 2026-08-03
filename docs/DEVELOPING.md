# Developing

How a change — feature or bug fix — travels from an idea to `main`. Releasing is a separate
document: `docs/RELEASING.md`.

**`main` only takes changes via pull request.** An active ruleset (`protect-main`) requires the
CI `verify` check, allows squash merges only, and blocks direct pushes, force pushes and branch
deletion. There are no bypass actors; in an emergency, temporarily disable the ruleset under
Settings → Rules.

## The loop

| # | Step | Command |
|---|---|---|
| 1 | Branch off `main` | `git switch -c feature/<slug>` (or `fix/<slug>`) |
| 2 | Develop; push early and often | CI runs the full gate list on every push, on any branch |
| 3 | Test manually in the test vault | `npm run dev`, then reload the plugin (see below) |
| 4 | Optionally, cut a beta for BRAT testing | `git tag 1.0.9-beta.1 && git push origin 1.0.9-beta.1` |
| 5 | Open a PR, wait for green | `gh pr create` |
| 6 | Squash-merge | the merged branch is auto-deleted |
| 7 | Release when ready | `docs/RELEASING.md` |

Details that matter:

- **No version bump on a branch.** The version gate checks consistency across the four files,
  not that a bump happened — bumping stays part of the release steps, on `main`.
- **Changelog lines ride with the change**, under `## [Unreleased]`, in the same commit — exactly
  as on `main`.
- **A branch with an open PR runs CI twice per push**: the push run checks the branch tip, the PR
  run checks the merge result against `main`. Both are meaningful; the duplication is accepted.
- **No e2e checklist template.** What to test is written in the PR description when it isn't
  obvious — a standing template earned its upkeep nowhere yet.

## Watching CI from the terminal

GitHub emails on a failed run and marks the commit/PR. To see it without leaving the shell:

```bash
gh run list --branch "$(git branch --show-current)" --limit 3   # recent runs of this branch
gh run watch                                                    # follow a run live (interactive picker)
gh pr checks --watch                                            # the PR's checks, once one exists
```

## The test vault

The repo contains a dedicated vault at `test/` (gitignored, registered in Obsidian). The plugin
files inside it are **symlinks to the repo root**, so whatever branch is checked out is what the
vault runs:

```
test/.obsidian/plugins/remarkable-tagged-sync/main.js       -> ../../../../main.js
test/.obsidian/plugins/remarkable-tagged-sync/manifest.json -> ../../../../manifest.json
test/.obsidian/plugins/remarkable-tagged-sync/styles.css    -> ../../../../styles.css
```

The e2e flow per branch: `git switch feature/<slug>` → `npm run dev` (watch build) → reload the
plugin in the `test/` vault (toggle it off/on, or reload Obsidian) → test by hand. The vault runs
the free build only; `pro/` testing stays ad hoc.

Should `test/` ever be lost, recreate the links:

```bash
mkdir -p test/.obsidian/plugins/remarkable-tagged-sync
cd test/.obsidian/plugins/remarkable-tagged-sync
ln -s ../../../../main.js ../../../../manifest.json ../../../../styles.css .
```

## Beta releases for BRAT

To test a branch build on a real device setup — or another machine — publish a **pre-release**
that [BRAT](https://github.com/TfTHacker/obsidian42-brat) can install:

```bash
git tag 1.0.9-beta.1        # on the branch commit you want to ship
git push origin 1.0.9-beta.1
```

`beta-release.yml` builds in a fresh checkout, stamps the tag into `manifest.json` **in the
runner only**, runs the release gates (minus version/changelog/attestation — rationale in the
workflow header), and publishes with `--prerelease`. Install it via BRAT's "Add beta plugin with
frozen version" using this repo and the tag.

Rules that keep betas harmless:

- **Never commit a pre-release version** to `manifest.json` or `versions.json`. The community
  store reads `main`'s manifest and resolves exactly that tag — as long as `main` only ever names
  stable versions, betas are invisible to it.
- **Betas are disposable.** If a run fails or a build is bad, delete the tag or just bump `n`.
  Nobody depends on a beta staying available.
- The beta tag namespace `x.y.z-beta.n` never collides with release tags: `release.yml`'s tag
  pattern cannot match it.

Background and sources: `.scratch/feature-branch-workflow/` (map, tickets, BRAT research).
