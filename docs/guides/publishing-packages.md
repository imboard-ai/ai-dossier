# Publishing Guide

Guide for publishing `@ai-dossier` packages to the public npm registry.

## Quick Start

### Automatic Next Releases

Every merge to `main` publishes a unique prerelease cohort such as `0.89.3-next.123` under npm's `next` dist-tag. The build keeps all publishable workspace dependencies pinned to that same cohort, so `npm install @ai-dossier/cli@next` resolves matching prerelease dependencies.

The pipeline runs: **lint → build → test → prepare next cohort → publish → verify next**. It never advances `latest`.

### Manual Dispatch

1. Go to: https://github.com/imboard-ai/ai-dossier/actions/workflows/publish-packages.yml
2. Click "Run workflow"
3. Select `next` (the default) to publish a prerelease cohort, or select `stable` to publish the committed stable manifest versions from `main`.

The **Dispatch stable npm publishing** workflow is a shortcut for the `stable` channel: it dispatches `publish-packages.yml` on `main`. Both channels publish through the existing npm Trusted Publishing/OIDC identity in `publish-packages.yml`; no `NPM_TOKEN` is used. Stable publishing skips temporary prerelease preparation, checks each committed version with `publish-guard`, and publishes with `--tag latest`. Default installs, `ai-dossier update`, and scheduler version checks continue to use `latest`.

### Manual Publishing (Local)

```bash
# From repository root
npm run publish:all
```

---

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `@ai-dossier/core` | Core verification and parsing logic |
| `@ai-dossier/worktree-pool` | Pre-warmed Git worktree pool for coding agents |
| `@ai-dossier/sched` | Deterministic scheduler for multi-agent coding workflows |
| `@ai-dossier/cli` | Command-line tool for dossier operations |
| `@ai-dossier/mcp-server` | MCP server for LLM integrations |

---

## Installation

No special setup needed — packages are public on npm:

```bash
# Install CLI globally
npm install -g @ai-dossier/cli

# Or use with npx
npx @ai-dossier/cli --help

# Use core as a library
npm install @ai-dossier/core

# MCP server
npx @ai-dossier/mcp-server
```

---

## Version Management

### Channels

- **`next`**: automatically updated by every publish workflow run with a unique prerelease version.
- **`latest`**: updated by a stable-channel publish of the committed stable versions. Bump the publishable package manifests as a cohort; the workflow publishes those exact versions and does not retag prereleases.
- Package manifest versions are the stable baseline. The `next` channel derives temporary prerelease versions without committing them back to `main`.

### Enforced on Pull Requests

CI's `version-bump` job fails a PR that changes a publishable package's `src/` or `bin/` without
bumping that package's `package.json` version (or bumps it to a number the base-branch tip already
holds). The publish workflow derives a unique prerelease from that stable baseline for each run.
Apply the `no-release-needed` label when a change truly needs no release.

### Manual Stable Cohort Bumps

```bash
# Patch-bump every publishable package in the same PR.
npm version patch --no-git-tag-version --workspace=@ai-dossier/core
npm version patch --no-git-tag-version --workspace=@ai-dossier/worktree-pool
npm version patch --no-git-tag-version --workspace=@ai-dossier/sched
npm version patch --no-git-tag-version --workspace=@ai-dossier/cli
npm version patch --no-git-tag-version --workspace=@ai-dossier/mcp-server
npm install --package-lock-only
```

After the PR merges, dispatch the stable channel (directly from `publish-packages.yml` or through **Dispatch stable npm publishing**) to publish the cohort under `latest`.

---

## Workflow Triggers

The publish pipeline runs on:

1. **Push to main** — automatically publishes the next cohort
2. **Tag push** (`v*`) or **GitHub Release** — publishes a next cohort for that ref
3. **Manual dispatch** — `next` (default) publishes a prerelease cohort; `stable` publishes committed stable manifests from `main`

The stable channel uses the same trusted-publisher workflow as `next`; **Dispatch stable npm publishing** only dispatches `publish-packages.yml` with `channel=stable`.

A `concurrency` group prevents duplicate runs when both a tag push and release event fire.

---

## Troubleshooting

### "Package already exists"

Bump the version before publishing:
```bash
cd cli
npm version patch
git add package.json
git commit -m "chore: bump version"
git push
```

### "Cannot find module @ai-dossier/core"

Core must be published before CLI and MCP server. The workflow handles ordering automatically. For manual publishing, use:
```bash
npm run publish:core
npm run publish:cli
npm run publish:mcp
```

### Trusted Publishing / OIDC Errors

Both publish channels must run in `.github/workflows/publish-packages.yml`, which requests the OIDC identity token. If publishing cannot authenticate, confirm the npm Trusted Publisher remains bound to this repository and workflow. The dispatcher only needs GitHub Actions permission to dispatch that workflow and does not use npm credentials.

---

## Best Practices

1. **Always bump versions** when making changes
2. **Test locally first** with `npm pack` and local installation
3. **Use semantic versioning** (patch/minor/major appropriately)
4. **Document changes** in commit messages
5. **Create GitHub releases** after significant updates
6. **Test installation** with `npx @ai-dossier/cli --help` after publishing

---

## Related

- Issue #48: npm publishing CI/CD pipeline
- Issue #28: Standalone binaries (future)
- npm docs: https://docs.npmjs.com/
