# Ollama SDK CI agents

The repository uses deterministic GitHub Actions checks as the authority for
quality and release readiness. Nexum is the bounded repair operator; it does
not replace those checks, approve pull requests, merge branches, tag releases,
or publish npm packages.

## CI remediation architecture

`Nexum CI Healer` runs after a failed `CI` workflow on the default branch or
an open same-repository pull request. It is also available through
`workflow_dispatch` for an operator-triggered scan.

The workflow installs the pinned `@nemesis-oss/nexum@2.0.0` CLI separately.
Do not add Nexum as a dependency of this SDK: Nexum already depends on
`@nemesis-oss/ollama-sdk`, so doing so would create a circular package
dependency.

The workflow uses Nexum's existing `nexum ci-healer tick` application:

1. Scan the default branch and eligible same-repository, non-draft PR heads.
2. Match failed workflow runs to the exact current branch head.
3. Fetch and digest failed job logs.
4. Create an isolated Git worktree and install dependencies with lifecycle
   scripts disabled.
5. Run deterministic setup first: `npm run contract:generate` followed by
   `npm run fix:ci` (Prettier plus ESLint auto-fix). The currently pinned Nexum
   2.0.0 then invokes its agent. The pending [Nexum PR #101](https://github.com/shubhamtaywade82/nexum/pull/101)
   adds verification/commit of successful deterministic changes before LLM
   invocation, so formatter-only failures can be fixed without a model call
   after that change is released and pinned here.
6. Verify each configured command in a Docker sandbox with no network.
7. Enforce the changed-file limit and protected-path policy.
8. Push a fast-forward-only branch and open a draft repair PR. Never auto-merge.

Nexum's agent process receives the Ollama Cloud model credentials, but not the
GitHub token. The healer daemon retains GitHub credentials for Git and REST
operations. Repository setup and verification commands run in separate
containers without GitHub or model credentials. The CI agent cannot edit
workflow/security configuration, the deterministic fixer, or dependency manifests.

The healer's local verification list includes formatting, lint, typecheck,
unit tests, coverage, structural contract parity, edge-runtime checks, and
published-type analysis. Network-dependent gates remain with the regular PR CI:
live-doc contract parity, real-server conformance, npm consumer installation,
and external integration checks. A repair branch is still subject to the full
GitHub Actions checks before it can be merged. PR CI has an explicit read-only
`GITHUB_TOKEN`; Nexum repair branches are excluded from the advisory AI review.

The SQLite lineage ledger is restored and saved using GitHub Actions cache.
A repository-wide concurrency group serializes invocations so ephemeral runners
cannot race while restoring and updating the ledger. The integration currently
allows one repair attempt per lineage because the published Nexum 2.0.0 retry
path does not reinstall dependencies in a fresh worktree. Increase the limit to
three only after upgrading to a Nexum release containing the retry-setup fix
tracked in [Nexum PR #101](https://github.com/shubhamtaywade82/nexum/pull/101).

## Required GitHub configuration

Create a GitHub App installed on this repository with:

- **Contents: read/write** — create repair branches and push verified commits.
- **Pull requests: read/write** — scan PRs and open draft repair PRs.
- **Actions: read** — inspect workflow runs and failed job logs.

Configure these repository secrets:

| Secret | Purpose |
| --- | --- |
| `CI_AGENT_APP_ID` | GitHub App ID |
| `CI_AGENT_APP_PRIVATE_KEY` | GitHub App private key |
| `OLLAMA_API_KEY` | Ollama Cloud model access |

Optional repository variable:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_MODEL_FIX` | `glm-5.3-flash:cloud` | Nexum repair model |

The workflow skips safely when any required secret is missing. The App token
is intentional: commits made with the repository's `GITHUB_TOKEN` do not
trigger the follow-up CI run required for Nexum's bounded repair loop.

## Deterministic local fixes

Developers can run the same mechanical fixers locally:

```sh
npm run fix
npm run format:check
npm run lint
```

Pre-commit also runs the staged-file fixer. Type errors, failing tests,
behavioral defects, security findings, and dependency conflicts are not
blindly auto-fixed. They require diagnosis and review.

## Authority and release boundaries

| Component | Authority |
| --- | --- |
| `ci.yml` | Deterministic quality gate |
| Nexum CI Healer | Verified draft repair PRs only |
| AI PR Review | Advisory review only |
| AI Release Readiness | Advisory report only |
| `release-please.yml` | Deterministic version/release orchestration |
| `publish.yml` | npm trusted publishing via OIDC |

Do not add `OLLAMA_API_KEY` to release or npm publishing workflows. Human
review remains mandatory before a repair PR is merged.
