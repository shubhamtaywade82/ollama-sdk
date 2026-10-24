# ADR 0040: Automated versioning with release-please

**Status**: Accepted
**Date**: 2026-10-24

## Context

Until now, every release meant editing `package.json` by hand and then publishing a GitHub release, which triggers `publish.yml`. PRs are squash-merged with Conventional Commit titles (`feat:`, `fix:`, `chore:` …), so the information needed to pick the bump was already in history, but nothing used it.

The weekly upstream watch (ADR 0039) also opens PRs on its own. Those PRs need to say whether they change the shipped surface.

## Decisions

1. **release-please runs on every push to `main`** (`.github/workflows/release-please.yml`, config in `release-please-config.json` + `.release-please-manifest.json`). It keeps one release PR open that bumps `package.json`/`package-lock.json`:
   - `fix:` → patch
   - `feat:` → minor
   - `feat!:` / `BREAKING CHANGE:` → major
   - `chore`/`docs`/`test`/`ci`/`refactor` → no release

   A `Release-As: x.y.z` footer overrides the computed version.
2. **Publishing is chained, not event-triggered.** A release created with `GITHUB_TOKEN` does not fire other workflows' `release` events. So when release-please reports `release_created`, the same workflow calls `publish.yml` (which gained `workflow_call`). Manual GitHub releases still publish through the existing `release` trigger.
3. **The changelog stays hand-written** (`skip-changelog: true`). Its entries carry ADR-level context that commit subjects can't. Before merging a release PR, rename `## [Unreleased]` to the new version on the release PR branch.
4. **PR titles are checked** (`.github/workflows/pr-title.yml`, `amannn/action-semantic-pull-request`). The squash-merged title is the commit subject release-please reads.
5. **Upstream-watch PRs pick their own type.** If regeneration changed `src/generated`, the PR is `feat(contract): …` (a minor release). A pin-only refresh is `chore(contract): …` (no release).

## Consequences

- Version numbers follow from merged PR titles; humans review the release PR instead of editing versions.
- A mistyped PR title can't silently skip a release, because the title check fails first.
- Merge commits (instead of squash) would make release-please read the branch's individual commits; keep squash merging.
