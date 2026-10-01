# Publishing Guide

Guide for publishing `@ai-dossier` packages to the public npm registry.

## Quick Start

### Automatic Next Releases

Every merge to `main` publishes a unique prerelease cohort such as `0.89.3-next.123` under npm's `next` dist-tag. The build keeps all publishable workspace dependencies pinned to that same cohort, so `npm install @ai-dossier/cli@next` resolves matching prerelease dependencies.

The pipeline runs: **lint → build → test → prepare next cohort → publish → verify next**. It never advances `latest`.

### Manual Dispatch

1. Go to: https://github.com/imboard-ai/ai-dossier/actions/workflows/publish-packages.yml
2. Click "Run workflow"
3. Click "Run workflow" to publish the current `main` commit as a `next` cohort.

To deliberately promote the current cohort, run **Promote npm next to latest** from the Actions page. It reads each package's current `next` version and moves that version's `latest` dist-tag. The workflow uses the repository's `NPM_TOKEN` secret because npm trusted publishing does not authorize dist-tag mutations. Default installs, `ai-dossier update`, and scheduler version checks continue to use `latest`.

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
- **`latest`**: promoted manually from the current `next` cohort when it is ready for stable users.
- Package manifest versions remain the next intended stable baseline; the workflow derives its temporary prerelease versions without committing them back to `main`.

### Enforced on Pull Requests

CI's `version-bump` job fails a PR that changes a publishable package's `src/` or `bin/` without
bumping that package's `package.json` version (or bumps it to a number the base-branch tip already
holds). The publish workflow derives a unique prerelease from that stable baseline for each run.
Apply the `no-release-needed` label when a change truly needs no release.

### Manual Version Bumps

```bash
# Bump core version
cd packages/core
npm version patch  # or minor, major

# Bump CLI version and update dependency
cd ../../cli
npm version patch
npm pkg set "dependencies.@ai-dossier/core=^$(cd ../packages/core && node -p 'require(\"./package.json\").version')"

# Bump MCP server version
cd ../mcp-server
npm version patch

# Commit and tag
cd ..
git add packages/core/package.json cli/package.json mcp-server/package.json
VERSION=$(cd cli && node -p "require('./package.json').version")
git commit -m "chore: bump version to $VERSION"
git tag "v$VERSION"
git push && git push --tags
```

---

## Workflow Triggers

The publish pipeline runs on:

1. **Push to main** — automatically publishes the next cohort
2. **Tag push** (`v*`) or **GitHub Release** — publishes a next cohort for that ref
3. **Manual dispatch** — publishes the selected ref as a next cohort

`latest` moves only through the manually dispatched **Promote npm next to latest** workflow.

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

### Authentication Errors

Ensure the `NPM_TOKEN` repository secret is set:
1. Get an automation token from https://www.npmjs.com/settings/YOUR_USERNAME/tokens
2. Add to GitHub: Settings → Secrets → Actions → New repository secret
3. Name: `NPM_TOKEN`

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
