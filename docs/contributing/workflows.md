# GitHub Actions Workflows Documentation

This document describes all GitHub Actions workflows in the Dossier project, their purpose, and how they work.

## Table of Contents

- [Workflow Overview](#workflow-overview)
- [1. Sign Workflow](#1-sign-workflow-signyml)
- [2. Publish Packages Workflow](#2-publish-packages-workflow-publish-packagesyml)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Workflow Overview

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| Sign | `sign.yml` | Manual | Test AWS KMS signing for dossier authentication |
| Publish Packages | `publish-packages.yml` | Push to main / Manual | Publish npm packages to GitHub Packages |

---

## 1. Sign Workflow (`sign.yml`)

### Motivation

Dossiers support cryptographic signatures for authenticity verification. This workflow tests the AWS KMS (Key Management Service) signing infrastructure to ensure we can sign dossiers with production keys.

**Why AWS KMS?**
- Hardware security module (HSM) backed keys
- Never expose private keys
- Audit trail for all signing operations
- Enterprise-grade key management
- Complies with security best practices

### Trigger

**Manual only** via GitHub Actions UI:
```
Actions → sign → Run workflow
```

### Flow

```
1. Checkout code
   ↓
2. Configure AWS credentials via OIDC
   - Uses GitHub OIDC to assume AWS IAM role
   - No static AWS credentials stored
   - Role: github-dossier-oidc (account: 942039714848)
   ↓
3. Create test artifact
   - Generate test file: "hello from github"
   ↓
4. Sign with AWS KMS
   - Calculate SHA-256 digest of artifact
   - Sign digest with KMS key: alias/dossier-official-prod
   - Algorithm: ECDSA_SHA_256
   - Output: signature.b64
   ↓
5. Export public key
   - Retrieve public key from KMS
   - Output: publickey.der
   ↓
6. Display results
   - Show file sizes for verification
```

### Configuration

**Environment Variables:**
- `AWS_REGION`: `us-east-1` - AWS region for KMS
- `ROLE_ARN`: `arn:aws:iam::942039714848:role/github-dossier-oidc` - IAM role to assume
- `KMS_KEY_ALIAS`: `alias/dossier-official-prod` - Production signing key

**Permissions:**
- `id-token: write` - Required for OIDC authentication
- `contents: read` - Read repository code

### Outputs

The workflow produces three files (not uploaded as artifacts currently):
- `artifact.bin` - Test data signed
- `signature.b64` - Base64-encoded ECDSA signature
- `publickey.der` - DER-encoded public key

### Use Cases

- **Test signing infrastructure** before releasing new dossiers
- **Verify AWS credentials** and permissions are configured correctly
- **Generate signatures** for high-risk dossiers
- **Export public key** for signature verification setup

### Future Enhancements

- [ ] Upload signature and public key as workflow artifacts
- [ ] Sign actual dossier files passed as input
- [ ] Batch signing for multiple dossiers
- [ ] Automatic signing on dossier updates
- [ ] Integration with dossier publishing workflow

---

## 2. Publish Packages Workflow (`publish-packages.yml`)

### Motivation

Automate the publishing of `@ai-dossier/core` and `@ai-dossier/cli` npm packages to GitHub Packages. This enables:
- **Continuous delivery**: Automatic publishing on code changes
- **Version management**: Centralized version bumping
- **Consistency**: Same build process every time
- **Testing**: Validate packages before public npm release
- **Distribution**: Easy installation for users via npm

### Triggers

**1. Automatic (Push to main)**

Triggers when pushing to `main` branch AND changes affect:
- `cli/**` - CLI package files
- `packages/core/**` - Core package files
- `.github/workflows/publish-packages.yml` - Workflow itself

**2. Manual (workflow_dispatch)**

Run manually via GitHub Actions UI with options:
```
Actions → Publish Packages to GitHub Packages → Run workflow
```

**Input: Version bump**
- `skip` (default) - Publish current version without bumping
- `patch` - Bug fixes (0.1.0 → 0.1.1)
- `minor` - New features (0.1.0 → 0.2.0)
- `major` - Breaking changes (0.1.0 → 1.0.0)

### Flow

```
1. Checkout code
   - Full repository checkout
   ↓
2. Setup Node.js (v18)
   - Configure npm for GitHub Packages
   - Set @dossier scope to GitHub registry
   ↓
3. Install dependencies
   - npm install (all workspaces)
   ↓
4. Build @ai-dossier/core
   - Compile TypeScript → JavaScript
   - Generate type definitions
   ↓
5. Bump version (if requested)
   - Update version in packages/core/package.json
   - Update version in cli/package.json
   - Update CLI dependency on core
   ↓
6. Commit version bump (if bumped)
   - Commit updated package.json files
   - Push to main branch
   ↓
7. Publish @ai-dossier/core
   - Publish to https://npm.pkg.github.com
   - Includes: dist/, package.json, README
   ↓
8. Publish @ai-dossier/cli
   - Publish to https://npm.pkg.github.com
   - Includes: bin/, README, package.json
   ↓
9. Create Git tag (if version bumped)
   - Tag format: v0.1.0, v0.2.0, etc.
   - Push tag to repository
```

### Configuration

**Permissions:**
- `contents: write` - Commit version bumps, create tags
- `packages: write` - Publish to GitHub Packages

**Node.js Setup:**
- Version: 18
- Registry: `https://npm.pkg.github.com`
- Scope: `@dossier`

**Authentication:**
- Uses `GITHUB_TOKEN` (automatic, no setup needed)
- Token automatically has package write permissions

### Outputs

**Published Packages:**
- `@ai-dossier/core@1.0.0` → https://github.com/imboard-ai/ai-dossier/packages
- `@ai-dossier/cli@0.1.0` → https://github.com/imboard-ai/ai-dossier/packages

**Git Artifacts:**
- Version bump commit (if bumped)
- Git tag (e.g., `v0.2.0`)

### Use Cases

**Automatic Publishing (Push-based)**
```bash
# Make changes to CLI
vim cli/bin/ai-dossier

# Commit and push
git add cli/
git commit -m "fix: improve error messages"
git push origin main

# Workflow automatically publishes new version
```

**Manual Release with Version Bump**
1. Go to Actions → Publish Packages → Run workflow
2. Select `minor` for new feature release
3. Workflow bumps version, publishes, and tags

**Testing Before Public npm**
1. Publish to GitHub Packages first
2. Test installation on various platforms
3. Verify functionality
4. Then publish to public npm (see PUBLISHING.md)

### Version Management

**Automatic (workflow manages it):**
```
Input: patch
Before: @ai-dossier/cli@0.1.0, @ai-dossier/core@1.0.0
After:  @ai-dossier/cli@0.1.1, @ai-dossier/core@1.0.1

- Both packages bumped to same version
- CLI dependency updated: "@ai-dossier/core": "^1.0.1"
- Commit: "chore: bump version to 0.1.1"
- Tag: v0.1.1
```

**Why bump both packages together?**
- Keeps version numbers in sync
- Simplifies dependency management
- Clear release history
- Matches semver expectations

---

## Best Practices

### For Workflow Maintainers

1. **Test workflows in fork first** before merging changes
2. **Use path filters** to prevent unnecessary workflow runs
3. **Keep secrets secure** - use OIDC, avoid static credentials
4. **Document all changes** in this file
5. **Version workflows** - commit history serves as changelog

### For Contributors

1. **Check workflow runs** after pushing to ensure success
2. **Review failed workflows** and fix issues promptly
3. **Don't bypass workflows** - they enforce quality and security
4. **Understand triggers** to avoid surprise publishes
5. **Use manual triggers** for testing

### For Package Publishing

1. **Always test locally first**:
   ```bash
   npm pack
   npm install -g ./dossier-cli-0.1.0.tgz
   ```

2. **Bump versions appropriately**:
   - `patch` - Bug fixes only
   - `minor` - New features, backward compatible
   - `major` - Breaking changes

3. **Verify published packages**:
   ```bash
   npm info @ai-dossier/cli
   ```

4. **Create GitHub releases** for significant versions

---

## Troubleshooting

### Workflow Fails: "Package already exists"

**Problem**: Trying to publish a version that's already published.

**Solution**: Bump the version first:
```bash
# Manual
cd cli
npm version patch
git push

# Or use workflow with version bump
Actions → Publish Packages → Run workflow → Select "patch"
```

### Workflow Fails: "Permission denied" (Publishing)

**Problem**: `GITHUB_TOKEN` lacks package write permissions.

**Solution**:
1. Check workflow permissions in job definition
2. Ensure repository settings allow workflows to write packages:
   - Settings → Actions → General → Workflow permissions
   - Select "Read and write permissions"

### Workflow Fails: AWS KMS "Access Denied"

**Problem**: GitHub OIDC role doesn't have KMS permissions.

**Solution**: Contact AWS administrator to verify:
1. IAM role trust policy allows GitHub OIDC
2. Role has `kms:Sign` and `kms:GetPublicKey` permissions
3. KMS key policy allows the role

### Workflow Doesn't Trigger on Push

**Problem**: Push to main didn't trigger publish workflow.

**Possible causes:**
1. **Path filter**: Changes not in `cli/**` or `packages/core/**`
   - Check: `git diff --name-only HEAD~1`
2. **Branch protection**: Merge commits don't trigger path-filtered workflows
   - Use manual trigger instead
3. **Workflow disabled**: Check Actions settings

**Solution**: Trigger manually if needed:
```
Actions → Publish Packages → Run workflow
```

### Published Package Can't Be Installed

**Problem**: `npm install @ai-dossier/cli` fails with 404.

**Solution**: Configure npm for GitHub Packages:
```bash
# Add to ~/.npmrc
@dossier:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

See `PUBLISHING.md` for detailed installation instructions.

---

## Adding New Workflows

When adding a new workflow:

1. **Create workflow file** in `.github/workflows/`
2. **Add documentation** to this file:
   - Motivation section
   - Trigger conditions
   - Flow diagram
   - Configuration details
   - Use cases
   - Troubleshooting
3. **Test thoroughly** in a fork or feature branch
4. **Update table of contents** at the top of this document
5. **Commit with descriptive message**

### Workflow Template

```markdown
## N. Workflow Name (`filename.yml`)

### Motivation
Why does this workflow exist? What problem does it solve?

### Triggers
- Automatic: When does it run automatically?
- Manual: Can it be triggered manually?

### Flow
1. Step one
2. Step two
...

### Configuration
- Environment variables
- Secrets required
- Permissions needed

### Use Cases
- When to use this workflow
- Example scenarios
```

---

## Related Documentation

- [PUBLISHING.md](../PUBLISHING.md) - Package publishing guide
- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [GitHub Packages Docs](https://docs.github.com/en/packages)
- [AWS KMS Docs](https://docs.aws.amazon.com/kms/)

---

**Last Updated**: 2025-11-15
**Maintained By**: Dossier Core Team
