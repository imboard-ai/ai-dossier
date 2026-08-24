# Publishing Guide

Guide for publishing `@ai-dossier` packages to the public npm registry.

## Quick Start

### Tag-based Publishing (Recommended)

Create a git tag and push it to trigger the publish pipeline:

```bash
git tag v1.2.0
git push origin v1.2.0
```

This runs: **lint → build → test → publish core → publish cli → publish mcp-server → verify**.

### Manual Dispatch

1. Go to: https://github.com/imboard-ai/ai-dossier/actions/workflows/publish-packages.yml
2. Click "Run workflow"
3. Select version bump (patch/minor/major) or skip
4. Click "Run workflow"

The workflow will bump versions, commit, tag, and publish automatically.

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

### Via Manual Dispatch

When running the workflow manually:
- **patch**: 1.0.0 → 1.0.1 (bug fixes)
- **minor**: 1.0.0 → 1.1.0 (new features, backward compatible)
- **major**: 1.0.0 → 2.0.0 (breaking changes)
- **skip**: Don't bump version, just publish current

### Enforced on Pull Requests

CI's `version-bump` job fails a PR that changes a publishable package's `src/` or `bin/` without
bumping that package's `package.json` version, because the publish workflow silently skips any
version already on npm. Apply the `no-release-needed` label when a change truly needs no release.

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

1. **Tag push** (`v*`) — the primary trigger
2. **GitHub Release** — when a release is published
3. **Manual dispatch** — via GitHub Actions UI with optional version bump

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
