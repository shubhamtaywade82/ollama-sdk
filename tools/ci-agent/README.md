# Ollama Cloud CI Agents

These agents provide advisory engineering assistance around the repository's deterministic GitHub Actions pipeline. They do not replace CI, approve pull requests, merge branches, create tags, or publish npm packages.

## Configuration

Create a repository Actions secret named `OLLAMA_API_KEY`. Configure these repository Actions variables explicitly; the review workflow deliberately has no expensive model fallback.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OLLAMA_MODEL_REVIEW` | Yes | Cost-controlled default PR review model |
| `OLLAMA_MODEL_REVIEW_ESCALATION` | No | Optional stronger model used only for security-sensitive paths |
| `OLLAMA_MODEL_FIX` | No | Model used for CI autofix proposals; defaults to `glm-5.3-flash:cloud` |
| `OLLAMA_MODEL_RELEASE` | No | Model used for release readiness; defaults to `glm-5.3-flash:cloud` |

Choose `OLLAMA_MODEL_REVIEW` based on the current Ollama Cloud catalog and your price/quality target. If it is not configured, the PR review agent skips without making a paid model request. The optional escalation model is called only for paths such as workflows, authentication, authorization, tokens, secrets, security, release, and publishing.

## Agents

### AI PR Review

`ai-review.yml` runs on opened, synchronized, and ready-for-review PRs. It runs only for non-draft pull requests from this repository and skips branches created by the CI autofix agent. It checks out the default branch rather than executing PR code.

The reviewer prioritizes security-sensitive files, reviews at most 8 file diffs and 28,000 diff characters per run, suppresses informational and low-confidence findings, caps output at 12 findings and 2 per file, and deduplicates findings. It writes one marker-based conversation comment and updates that comment on subsequent runs instead of adding a new set of inline review threads. The summary reports the selected models and a character-based input-token estimate; this estimate is not provider billing usage.

The review is advisory. It does not approve or request changes.

### AI CI Autofix

`ai-autofix.yml` reacts to failed `CI` workflow runs and supports manual dispatch with a workflow run ID. The agent independently validates the run before reading logs or proposing changes. Only failed same-repository pull-request runs are eligible; fork runs, push runs, other workflows, and successful runs are rejected.

The agent validates workflow run IDs, retrieves logs with argument-safe process invocation, treats logs and repository content as untrusted data, rejects path traversal and protected files, and creates draft PRs for human review only. Its write allowlist is limited to `src/`, `lib/`, `test/`, and `tests/`; it cannot modify scripts, workflows, dependencies, or repository configuration.

### AI Release Readiness

`ai-release-readiness.yml` is manually dispatched from `main`. It runs deterministic `npm run verify:release` first, then produces an advisory assessment. It cannot publish or modify repository state.

## Authority and secret boundaries

| Component | Authority |
| --- | --- |
| `ci.yml` | Deterministic quality gate |
| AI PR Review | One advisory conversation comment |
| AI CI Autofix | Draft repair PR only |
| AI Release Readiness | Advisory report |
| `release-please.yml` | Deterministic version/release orchestration |
| `publish.yml` | npm trusted publishing via OIDC |

Do not add `OLLAMA_API_KEY` to the npm publishing workflow. Keep GitHub App permissions minimal. The App private key is used only by the token-generation action; pass only the resulting short-lived installation token to jobs that need it. Human review remains mandatory before merging agent-generated code.
