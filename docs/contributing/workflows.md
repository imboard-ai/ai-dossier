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
| CI | `ci.yml` | Pull request to main | Lint, build, test, and enforce version bumps on publishable packages |
| Sign | `sign.yml` | Manual | Test AWS KMS signing for dossier authentication |
| Publish Packages | `publish-packages.yml` | Push to main / Manual | Publish npm packages to the public npm registry |

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
   - Role: github-dossier-oidc (account: the `AWS_ACCOUNT_ID` repo variable)
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
- `ROLE_ARN`: `arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/github-dossier-oidc` - IAM role to assume
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

Automate the publishing of `@ai-dossier/core`, `@ai-dossier/sched`, `@ai-dossier/cli`, `@ai-dossier/mcp-server`, and `@ai-dossier/worktree-pool` npm packages to the public npm registry. This enables:
- **Continuous delivery**: Automatic publishing on code changes
- **Version management**: Centralized version bumping
- **Consistency**: Same build process every time
- **Distribution**: Easy installation for users via npm
- **Provenance**: npm provenance attestation for supply chain security

### Triggers

**Automatic**

- Push to `main`, tag push matching `v*`, and published GitHub releases publish to npm's `next` dist-tag.
- The workflow has no path filter; each matching event runs the publish checks and attempts a complete prerelease cohort.

**Manual (`workflow_dispatch`)**

Run **Publish Packages to npm** from GitHub Actions and choose `next` (the default) or `stable`. `next` prepares and publishes a prerelease cohort. `stable` must run from `main`, skips prerelease preparation, and publishes the committed manifest versions to `latest`.

### Flow

```
1. The `test` job checks out the ref, installs dependencies, lints, builds, and runs tests.
2. The `smoke` job packs the five packages and verifies the CLI from those tarballs.
3. The `publish` job checks out full history, installs npm 11+ for OIDC trusted publishing, and runs `publish-guard.mjs` for every package.
4. For `next`, it prepares a unique prerelease cohort. For `stable`, it keeps the committed manifest versions; guard outputs skip safe unchanged versions and the final collision report fails closed on collisions or unavailable checks.
5. It publishes the packages in dependency order with provenance, using the selected `next` or `latest` dist-tag.
6. The `verify` job retries registry reads up to five times with backoff and verifies the selected dist-tag (including the expected committed version for `stable`).
```

### Configuration

**Permissions:**
- The publish job grants `contents: write` and `id-token: write` for repository checkout and npm trusted publishing.
- The dispatcher grants `actions: write` only, to dispatch `publish-packages.yml`.

**Node.js Setup:**
- Version: 22
- Registry: `https://registry.npmjs.org`
- Scope: `@ai-dossier`

**Authentication:**
- Uses OIDC-based npm trusted publishing (no token secrets needed)
- `id-token: write` permission enables provenance attestation

### Outputs

**Published Packages:**
- `@ai-dossier/core` → https://www.npmjs.com/package/@ai-dossier/core
- `@ai-dossier/sched` → https://www.npmjs.com/package/@ai-dossier/sched
- `@ai-dossier/cli` → https://www.npmjs.com/package/@ai-dossier/cli
- `@ai-dossier/mcp-server` → https://www.npmjs.com/package/@ai-dossier/mcp-server
- `@ai-dossier/worktree-pool` → https://www.npmjs.com/package/@ai-dossier/worktree-pool

**Git Artifacts:**
- No package version commit or tag is created by the workflow. Stable cohort version bumps are committed in the PR; `next` derives temporary prerelease versions in the runner.

### Use Cases

**Automatic Publishing (Push-based)**
Merge a change to `main` after satisfying the package version-bump check. The automatic publish run prepares a prerelease cohort and publishes it under `next`; it does not commit version bumps or tags.

**Manual Stable Release**
1. Bump all five publishable package versions and synchronize `package-lock.json` in one PR.
2. After merge, dispatch the `stable` channel from `main` (or use the **Dispatch stable npm publishing** shortcut).
3. Confirm the workflow's verification job succeeds for `latest`.

**Testing Before Release**
1. Ensure CI passes on the branch
2. Test installation on various platforms
3. Verify functionality via the publish pipeline's verify job

### Version Management

**Stable versions are maintained in source control.** A stable release bumps all five publishable manifests as a cohort and keeps the root lockfile synchronized. The `next` workflow derives temporary prerelease versions without committing them to `main`.

**Why bump these packages together?**
- Keeps version numbers in sync
- Simplifies dependency management
- Clear release history
- Matches semver expectations

---

## Best Practices

### For Workflow Maintainers

1. **Test workflows in fork first** before merging changes
2. **Keep the publishing guide aligned** with the workflow's channels, triggers, and OIDC publisher.
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

### Workflow Fails: "<pkg>@<ver> version collision" / "Fail on version collisions"

**Problem**: The package's version is already on npm but was published from a commit whose
`src/`/`bin/` or `@ai-dossier/*` pins differ from this one — usually two PRs bumped to the same
number and the other published first (#826), or an unbumped change merged under
`no-release-needed`. Unaffected packages were published; this one (and its dependents) were not.
Every publish run fails this way until the bump lands.

**Solution**: Open a follow-up PR bumping the named package past that version; its merge publishes
the unreleased change:
```bash
cd cli && npm version patch --no-git-tag-version
```

### Workflow Fails: "Publish guard could not decide" / "publish-guard (<dir>) could not run"

**Problem**: The guard could not tell whether a package's already-published version matches this
commit — the registry answered something other than 200/404 after retries, the published version
has no usable `gitHead`, or that `gitHead` could not be fetched. The package is recorded as
`unavailable`: it is not published, its `@ai-dossier/*` dependents are held, unrelated packages
still publish, and `Fail on version collisions` fails the job naming it. Nothing is skipped silently.

**Solution**: Follow the `Fix:` line in that package's "Check if ... needs publishing" log — re-run
the workflow for a registry outage; bump the package's version for a missing gitHead.

### CI Fails: "Version-bump check FAILED"

**Problem**: The PR changes a publishable package's `src/` or `bin/` but its `package.json`
version still matches the base branch. After merge the publish workflow would find that version
already on npm from different source and fail the run (version collision), leaving the change
unreleased. The check also reports `STALE (X is not above Y on the base-branch tip)` when another
PR bumped the package after your branch was cut — merge the base branch and bump above Y.

**Solution**: Bump the package's version, or apply the `no-release-needed` label when the change
needs no release:
```bash
cd cli
npm version patch --no-git-tag-version
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

**Solution**: The packages are published to the public npm registry. Verify:
```bash
npm view @ai-dossier/cli
```

If the package was just published, it may take a few minutes to propagate.

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

- [Publishing packages guide](../guides/publishing-packages.md) - Package publishing guide
- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [npm Provenance Docs](https://docs.npmjs.com/generating-provenance-statements)
- [AWS KMS Docs](https://docs.aws.amazon.com/kms/)

---

**Last Updated**: 2026-03-07
**Maintained By**: Dossier Core Team
