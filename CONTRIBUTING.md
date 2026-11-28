# Contributing

## Local setup

Use Node.js 22 or newer and install the locked dependencies:

```sh
npm ci
```

The repository installs its Git hooks through `prepare`.

## Automatic fixes

Run the repository-wide deterministic fixers at any time:

```sh
npm run fix
```

This runs Prettier and ESLint's supported automatic fixes. It does not attempt to repair type errors, failing tests, or behavioral defects.

The pre-commit hook automatically runs `npm run fix:staged` against files already staged for commit. It formats supported staged file types, applies ESLint fixes to staged JavaScript/TypeScript files, and re-stages only those same paths. It does not stage unrelated unstaged files. The existing repository-wide lint, formatting, and typecheck gates then run.

To inspect the exact changes before committing:

```sh
git diff --cached
git diff
```

You can bypass the hook with `git commit --no-verify`, but CI remains authoritative. Do not bypass verification to conceal a failure.

## Verification

Run the relevant checks after changes:

```sh
npm run format:check
npm run lint
npm run typecheck
npm run typecheck:examples
npm run typecheck:ci-agent
npm run test:ci-agent
npm test
npm run build
```

Automated fixes are intentionally limited to deterministic formatter and linter transformations. Type errors, test failures, security findings, and behavior changes require diagnosis and review.
