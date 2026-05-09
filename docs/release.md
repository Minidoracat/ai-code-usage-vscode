# Release Checklist

This document describes how to prepare and publish `AI Coding Usage` without leaking local usage data or bypassing release gates.

## Release Model

The repository is prepared for a release-ready dry run first. A real Marketplace publish requires explicit manual setup and confirmation.

The workflow must not publish from ordinary pushes or pull requests.

## One-Time Marketplace Setup

1. Create or verify the Visual Studio Marketplace publisher:
   - Publisher ID: `minidoracat`
   - The publisher ID is written to `package.json` and is used in Marketplace URLs.
2. Create an Azure DevOps Personal Access Token:
   - Scope: Marketplace `Manage`
   - Store it securely. Do not commit it.
3. Verify the publisher locally if needed:

```bash
npx @vscode/vsce login minidoracat
```

## GitHub Environment Setup

Create a GitHub environment named:

```text
marketplace-production
```

Recommended protection:

- Required reviewers enabled
- Prevent self-review enabled when available
- Deployment branch/tag policy restricted to release tags or release branches
- `VSCE_PAT` stored as an environment secret, not a repository file

Important: a workflow that references an environment name does not prove that protection rules are configured. Confirm the environment settings in GitHub UI and keep a manual record or screenshot before the first real publish.

## Local Release Dry Run

Run:

```bash
npm ci
npm test
npm run check:i18n
npm run check:privacy
npm run check:pricing
npm run check:test-data
npm run package:vsix
npm run inspect:vsix
```

The `.vsix` must not contain source files, tests, local state, raw fixtures, or assistant/runtime configuration.

## GitHub Actions

`ci.yml` runs on pull requests and pushes to `main`. It must not read `VSCE_PAT` or call `vsce publish`.

`publish.yml` reruns all release gates in the same workflow. Real publish is locked behind:

- Release event or explicit manual dispatch
- Successful package and VSIX inspection job
- `environment: marketplace-production`
- `VSCE_PAT` environment secret
- Explicit confirmation input for manual publish
- Concurrency lock

Manual dry runs must not read `VSCE_PAT` and must not call `vsce publish`.

## First Publish

Before the first real publish:

- Confirm `package.json` version.
- Confirm `CHANGELOG.md` describes that version.
- Confirm screenshots, if present, use synthetic fixture data.
- Confirm Marketplace publisher `minidoracat` exists and belongs to you.
- Confirm `VSCE_PAT` has Marketplace `Manage` scope.
- Confirm the GitHub environment protection settings.

If the first publish partially succeeds and Marketplace accepts the version, do not reuse the same version. Bump `patch` or follow Marketplace recovery guidance based on the actual Marketplace state.

## Commands

Package only:

```bash
npm run package:vsix
npm run inspect:vsix
```

Publish from a prepared environment:

```bash
npm run deploy
```

Do not run `npm run deploy` unless the Marketplace publisher, PAT, and release checklist are ready.
