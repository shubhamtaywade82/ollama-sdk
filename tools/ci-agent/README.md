# Ollama Cloud CI Agents

These agents provide advisory engineering assistance around the repository's deterministic GitHub Actions pipeline. They do not replace CI, approve pull requests, merge branches, create tags, or publish npm packages.

## Configuration

Create a **repository Actions secret** named `OLLAMA_API_KEY` in the `ollama-sdk` repository. Do not create an organization-wide secret for this single-repository integration.

Optional repository Actions variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_MODEL_REVIEW` | `glm-5.3-flash:cloud` | Model used for PR review |
| `OLLAMA_MODEL_FIX` | `glm-5.3-flash:cloud` | Model used for CI autofix proposals |
| `OLLAMA_MODEL_RELEASE` | `glm-5.3-flash:cloud` | Model used for release readiness |

The secret is passed only to the agent steps that need it. It is not passed to `.github/workflows/publish.yml`; npm publishing remains on the existing trusted-publishing OIDC path.

## Agents

### AI PR Review

`ai-review.yml` runs on opened, synchronized, and ready-for-review PRs. It runs only for non-draft pull requests whose head repository is this repository. It checks out the default branch rather than executing PR code, fetches the diff through the GitHub API, and posts advisory comments only.

The secret-availability guard receives `OLLAMA_API_KEY` through the step environment. It never interpolates the secret into a shell command.

### AI CI Autofix

`ai-autofix.yml` reacts to failed `CI` workflow runs and supports a manual dispatch with a workflow run ID. The agent independently validates the run before it reads logs or proposes changes. Only failed `pull_request` runs from this repository are eligible; fork runs, push runs, other workflows, and successful runs are rejected.

The agent:
- validates the workflow run ID as a positive numeric value;
- uses argument-safe process invocation to retrieve logs;
- treats logs, diffs, filenames, and source contents as untrusted data;
- rejects absolute paths, path traversal, alternate separators, duplicate paths, protected files, low-confidence proposals, and oversized proposals;
- writes only within `src/`, `lib/`, `test/`, `tests/`, and `scripts/`;
- creates a draft PR for human review and never merges it.

The job has narrowly scoped `contents: write`, `actions: read`, and `pull-requests: write` permissions because creating a branch and draft PR requires write access. It can use the repository `GITHUB_TOKEN` fallback. For downstream Actions runs to be triggered by the agent-created PR, configure a GitHub App and set `CI_AGENT_APP_ID` and `CI_AGENT_APP_PRIVATE_KEY` as repository secrets. Grant the App repository permissions for Contents (read/write), Actions (read), and Pull requests (read/write).

### AI Release Readiness

`ai-release-readiness.yml` is manually dispatched from `main`. It runs the deterministic `npm run verify:release` gate first, then asks Ollama to assess version/changelog alignment, recent commit signals, changed source/contract paths, and the npm package manifest.

The result is advisory and is written to the workflow summary. This workflow has read-only repository permissions and cannot publish or modify repository state.

## Authority boundaries

| Component | Authority |
| --- | --- |
| `ci.yml` | Deterministic quality gate |
| AI PR Review | Advisory review comments |
| AI CI Autofix | Draft repair PR only |
| AI Release Readiness | Advisory pre-release assessment |
| `release-please.yml` | Deterministic version/release orchestration |
| `publish.yml` | npm trusted publishing via OIDC |

Do not add `OLLAMA_API_KEY` to the publish job. Do not give any LLM workflow permission to merge, tag, or publish.
