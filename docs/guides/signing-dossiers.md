# Signing Dossiers: Practical Guide

**Last Updated**: 2026-06-14
**Status**: Active

---

## Overview

Signing is what turns a skill into a *trusted* skill — the single biggest thing a dossier adds over a plain `SKILL.md`. A plain skill has no way to prove who wrote it or that it hasn't been tampered with; a signed dossier does, and `ai-dossier install-skill` / `run` verify that signature before the agent executes anything.

This guide covers the practical steps for signing dossiers locally and in CI/CD. It complements the [Key Management documentation](../../security/KEY_MANAGEMENT.md) with hands-on procedures and troubleshooting.

## Prerequisites

- Node.js installed (for signing tools)
- AWS credentials configured (for AWS KMS signing)
- Access to the dossier repository

---

## Local Signing (Development)

### Two Signing Methods

Dossier supports two signing methods:

1. **AWS KMS** - For official imboard-ai team dossiers (requires AWS credentials)
2. **Ed25519** - For community contributors (no special access needed)

### Using Ed25519 (Community Contributors) ✅ RECOMMENDED

Community contributors should use Ed25519 signing, which uses Node.js built-in crypto (no external dependencies).

#### Step 1: Generate Your Key Pair

The CLI does this for you, writing `~/.dossier/<name>.pem` (private, `0600`) and
`~/.dossier/<name>.pub` (public), and printing the public key in its canonical
raw base64 form:

```bash
ai-dossier keys generate --name my-name-2025
```

<details>
<summary>Or generate the pair by hand</summary>

```bash
# Generate Ed25519 key pair
node -e "
const { generateKeyPairSync } = require('crypto');
const fs = require('fs');

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

// Save keys
fs.writeFileSync('my-signing-key.pem', privateKey, { mode: 0o600 });
fs.writeFileSync('my-public-key.pem', publicKey);

console.log('✅ Keys generated:');
console.log('   Private key: my-signing-key.pem (keep this secret!)');
console.log('   Public key: my-public-key.pem (share this)');
"
```

</details>

The steps below use the hand-generated `my-signing-key.pem` / `my-public-key.pem`
names; if you used `keys generate`, substitute `~/.dossier/my-name-2025.pem` and
`~/.dossier/my-name-2025.pub`.

#### Step 2: Sign a Dossier

```bash
# Sign with your Ed25519 key
ai-dossier sign --method ed25519 path/to/your-dossier.ds.md \
  --key my-signing-key.pem \
  --key-id "my-name-2025" \
  --signed-by "Your Name <your.email@example.com>"
```

#### Step 3: Verify the Signature

```bash
# Verify locally (requires adding your key to trusted keys).
# The `--` is required: a PEM starts with "-", which the option parser would
# otherwise read as a flag. The key is stored in its canonical raw base64 form.
ai-dossier keys add -- "$(cat my-public-key.pem)" "my-name-2025"
ai-dossier verify path/to/your-dossier.ds.md
```

#### Step 4: Publish Your Public Key

Add your public key to your repository so others can verify your signatures.

Publish the **canonical raw base64** form, not the PEM. It is a single line, so
readers can copy it straight into `keys add` without the `--` escape, and it is
exactly what `trusted-keys.txt` stores:

```bash
# Canonical form = the last 32 bytes of the SPKI DER, base64-encoded.
# (`ai-dossier keys generate` prints this directly as "Public key (base64)".)
KEY=$(openssl pkey -pubin -in my-public-key.pem -outform DER | tail -c 32 | base64)

# Write it to KEYS.txt (unquoted heredoc, so the variables expand)
cat > KEYS.txt << EOF
# Dossier Author Public Keys

## Your Name (your.email@example.com)

- **Key ID**: my-name-2025
- **Algorithm**: Ed25519
- **Created**: 2025-11-24
- **Public Key**: \`${KEY}\`
EOF
```

Readers then trust you with one line — no PEM, no `--`:

```bash
ai-dossier keys add "<the base64 string from KEYS.txt>" "my-name-2025"
```

### Using AWS KMS (Official Dossiers)

AWS KMS signing requires AWS credentials with appropriate permissions.

#### Step 1: Verify AWS Credentials

```bash
# Check if AWS credentials are configured
aws sts get-caller-identity

# Expected output shows your AWS user/role:
# {
#     "UserId": "AIDA...",
#     "Account": "123456789012",
#     "Arn": "arn:aws:iam::123456789012:user/yourname"
# }
```

#### Step 2: Sign a Dossier

```bash
# Basic signing
ai-dossier sign path/to/your-dossier.ds.md

# With signed_by identity (recommended)
ai-dossier sign path/to/your-dossier.ds.md \
  --signed-by "Your Name <your.email@example.com>"

# Specify KMS key (if not using default)
ai-dossier sign path/to/your-dossier.ds.md \
  --key-id alias/dossier-official-prod \
  --region us-east-1 \
  --signed-by "Your Name <your.email@example.com>"
```

#### Step 3: Verify the Signature

```bash
# Verify locally
ai-dossier verify path/to/your-dossier.ds.md

# Should show:
# ✅ PASSED: Checksum and signature valid
```

### What the Signing Command Does

With either method, `ai-dossier sign` (CLI 0.92.0 and later) performs these steps:

1. **Reads the dossier file** and parses frontmatter + body, in either layout
2. **Drops any existing signature** and fills `name` (from the file name) and `description` (from `objective`) when either is absent
3. **Calculates the checksum** (SHA256 of the body)
4. **Builds the spec-shaped frontmatter**: `name`/`description` at the top level, every other field under `metadata` as a `dossier.<field>` string ([Agent Skills layout](../reference/spec-shape.md))
5. **Signs the v3 payload**: the `dossier-signature-v3` tag, the canonical JSON of that frontmatter without the signature entry, and the body. With KMS the payload is hashed (`SHA256(payload)`) and sent to the KMS Sign API with `MessageType: 'DIGEST'`; with Ed25519 the payload is signed directly
6. **Writes the file** in the spec layout, with `metadata["dossier.checksum"]` and `metadata["dossier.signature"]` (`covers: "spec-frontmatter+body"`). It reparses the output first and refuses to write if it does not read back as the same object

Signing converts a legacy JSON-fronted dossier to the spec layout. That is how you migrate a dossier, including one whose old signature `format` would not touch. See [Migrating from the legacy layout](../reference/spec-shape.md#migrating-from-the-legacy-layout).

### Important Notes

**What is covered**:
- The **checksum** covers the body only (content after the closing `---`)
- The **signature** covers the frontmatter and the body. Under v3 that is every top-level field and every `metadata` entry as written (other tools' keys included), except the signature entry itself. Editing any of them, `risk_level` included, invalidates the signature: re-sign after every change
- Older signatures stay verifiable: `covers` absent (v1, body only) and `frontmatter+body` (v2) on legacy-layout files. Each scheme is accepted only on its own layout, and an unknown `covers` is refused. See the [verification matrix](../reference/spec-shape.md#verification-matrix)

**Message Type**:
- Signing uses `MessageType: 'DIGEST'` (signs the hash, not raw content)
- Verification MUST also use `DIGEST` mode (fixed in v1.0.2)

**signed_by Field**:
- Always include `--signed-by` parameter
- Format: `"Name <email@domain.com>"`
- This field is used for trust verification

---

## GitHub CI/CD Signing

### Overview

GitHub Actions can sign dossiers automatically using AWS KMS with OIDC authentication (no long-lived credentials).

### Workflow: Manual Signing

Location: `.github/workflows/sign.yml`

#### Current Workflow

```yaml
name: sign
on:
  workflow_dispatch: {}  # Manual trigger only

permissions:
  id-token: write  # Required for OIDC
  contents: read

env:
  AWS_REGION: us-east-1
  ROLE_ARN: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/github-dossier-oidc
  KMS_KEY_ALIAS: alias/dossier-official-prod

jobs:
  sign:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS creds via OIDC
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ env.ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Sign dossiers
        run: |
          # Sign all unsigned dossiers in examples/
          for file in examples/**/*.ds.md; do
            if ! grep -q '"signature"' "$file"; then
              echo "Signing: $file"
              npx @ai-dossier/cli sign "$file" \
                --signed-by "Dossier Team <team@dossier.ai>"
            fi
          done

      - name: Commit signed dossiers
        run: |
          git config user.name "GitHub Actions Bot"
          git config user.email "actions@github.com"
          git add examples/
          git commit -m "chore: Sign dossiers with AWS KMS" || echo "No changes"
          git push
```

### How to Use

1. **Navigate to Actions tab** on GitHub
2. **Select "sign" workflow**
3. **Click "Run workflow"**
4. **Select branch** (usually `main`)
5. **Click "Run workflow" button**

The workflow will:
- Checkout the code
- Authenticate with AWS via OIDC (no stored credentials)
- Sign all unsigned `.ds.md` files
- Commit and push the signed versions

### OIDC Authentication

GitHub Actions uses OpenID Connect (OIDC) to get temporary AWS credentials:

**Benefits**:
- ✅ No long-lived AWS credentials in GitHub Secrets
- ✅ Automatic credential rotation
- ✅ Scoped permissions (only what the role allows)
- ✅ Audit trail in CloudTrail

**How it Works**:
1. GitHub generates an OIDC token for the workflow
2. Token includes claims: repository, branch, workflow
3. AWS validates the token against configured trust policy
4. AWS issues temporary credentials (valid ~1 hour)
5. Workflow uses credentials to call KMS

**IAM Role Trust Policy**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:sub": "repo:imboard-ai/ai-dossier:*",
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

---

## Verification Process

### How Verification Works

The `ai-dossier verify` command runs an integrity stage followed by a risk assessment:

**Stage 1: Integrity Check (checksum + signature)**
1. Parse dossier file (separate frontmatter and body; legacy or spec layout)
2. Calculate checksum: `SHA256(body)` and compare with `checksum.hash` in frontmatter
3. If a signature is present, rebuild the payload its `covers` value names (v1, v2 or v3, which must match the file's layout), verify it (Ed25519 / AWS KMS) and check the signer against your trusted keys (`~/.dossier/trusted-keys.txt`)

**Risk assessment**
- Evaluate `risk_level`, `risk_factors`, and `destructive_operations` from frontmatter
- Determine whether the dossier is safe to execute or requires approval

> A valid signature from a key that isn't in your trusted list is reported as "valid but untrusted" — it is not auto-trusted. Add the key with `ai-dossier keys add` to trust it.

### AWS KMS Signature Verification

**Critical Implementation Detail**: Verification must match signing process.

#### Signing Process (`ai-dossier sign`, KMS method)

`payload` is the signed payload for the dossier's scheme: the body alone for v1, or the scheme tag, canonical frontmatter and body for v2/v3.

```javascript
// 1. Hash the signed payload
const hash = crypto.createHash('sha256').update(payload, 'utf8').digest();

// 2. Sign with KMS using DIGEST mode
const signCommand = new SignCommand({
  KeyId: keyId,
  Message: hash,              // Pass the hash
  MessageType: 'DIGEST',      // Important: DIGEST mode
  SigningAlgorithm: 'ECDSA_SHA_256'
});
```

#### Verification Process (packages/core/src/signature.ts)
```typescript
// 1. Hash the same payload (MUST match signing)
const hash = createHash('sha256').update(content, 'utf8').digest();

// 2. Verify with KMS using DIGEST mode
const command = new VerifyCommand({
  KeyId: keyId,
  Message: hash,              // Pass the hash
  MessageType: 'DIGEST',      // MUST match signing!
  Signature: signatureBuffer,
  SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256,
});
```

**Bug Fixed in v1.0.2** (2025-11-24):
- ❌ **Before**: Verification used `MessageType: 'RAW'` (default)
- ✅ **After**: Verification uses `MessageType: 'DIGEST'` (matches signing)
- **Impact**: All AWS KMS signatures now verify correctly locally

### Testing Verification

```bash
# Test on the meta-dossier
ai-dossier verify examples/authoring/create-dossier.ds.md

# Test from GitHub URL
ai-dossier verify https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/authoring/create-dossier.ds.md

# Verbose output
ai-dossier verify examples/authoring/create-dossier.ds.md --verbose
```

---

## Troubleshooting

### Signature Verification Fails Locally

**Symptom**: `⚠️ Signature verification FAILED`

**Possible Causes**:

1. **AWS Credentials Not Configured**
   ```bash
   # Check credentials
   aws sts get-caller-identity

   # If error, configure AWS CLI:
   aws configure
   # Or set environment variables:
   export AWS_ACCESS_KEY_ID=...
   export AWS_SECRET_ACCESS_KEY=...
   export AWS_REGION=us-east-1
   ```

2. **Insufficient KMS Permissions**
   ```bash
   # Test KMS access
   aws kms describe-key --key-id alias/dossier-official-prod

   # Required permissions:
   # - kms:Verify
   # - kms:GetPublicKey
   # - kms:DescribeKey
   ```

3. **Wrong MessageType** (fixed in v1.0.2)
   - Update to latest version of `@ai-dossier/core`
   - Rebuild: `cd packages/core && npm run build`

4. **Content Modified After Signing**
   - Checksum will also fail if body changed
   - A frontmatter edit fails the signature but not the checksum
   - Re-sign the dossier

5. **Scheme and layout disagree, or `covers` is unknown**
   - `Spec-shaped dossier carries a frontmatter+body signature`: the file was converted to the spec layout without re-signing (for example by hand). Re-sign it with `ai-dossier sign`
   - `Unsupported signature coverage "…"`: the signature uses a scheme your CLI does not know. Upgrade `@ai-dossier/cli` (v3 needs 0.91.0 or later to verify)
   - See the [verification matrix](../reference/spec-shape.md#verification-matrix)

### Registry Rejects a Publish with `INVALID_SIGNATURE`

The registry verifies a submitted signature before it stores the dossier, using the same scheme and layout rules as `ai-dossier verify`. A 400 `INVALID_SIGNATURE` means the signature does not match the content, its `covers` value is unknown or does not fit the file's layout, the algorithm is unsupported, or the key is a legacy minisign (`RWT…`) key. Re-sign with `ai-dossier sign` and publish again. AWS KMS signatures get a structural check only at publish time and are verified cryptographically by clients on install. Unsigned dossiers are accepted.

### Signing Tool Errors

**Error: "AWS SDK not found"**
```bash
# Install AWS SDK
npm install @aws-sdk/client-kms
```

**Error: "File not found"**
```bash
# Use absolute or correct relative path
ai-dossier sign $(pwd)/examples/my-dossier.ds.md
```

**Error: "Access Denied" from KMS**
```bash
# Check your IAM permissions
aws kms describe-key --key-id alias/dossier-official-prod

# Need these actions:
# - kms:Sign
# - kms:GetPublicKey
# - kms:DescribeKey
```

### GitHub Actions Signing Fails

**Error: "Could not assume role"**
- Check OIDC provider is configured in AWS IAM
- Verify role trust policy allows your repository
- Ensure workflow has `id-token: write` permission

**Error: "KMS operation denied"**
- Check IAM role has KMS permissions
- Verify KMS key policy allows the role
- Check role session duration (default 1 hour)

**Dossiers Not Signed**
- Check workflow ran successfully (Actions tab)
- Verify glob pattern matches your files: `examples/**/*.ds.md`
- Check if dossiers already have signatures (skipped)

---

## Best Practices

### For Dossier Authors

1. **Always include `--signed-by`**
   ```bash
   ai-dossier sign file.ds.md \
     --signed-by "Your Name <email@domain.com>"
   ```

2. **Verify after signing**
   ```bash
   ai-dossier verify file.ds.md
   ```

3. **Sign before committing**
   - Never commit unsigned high-risk dossiers
   - Use pre-commit hook to check signatures

4. **Document your signing key**
   - Add to repository KEYS.txt
   - Include fingerprint and expiry

### For Repository Maintainers

1. **Use OIDC for CI/CD**
   - Never store AWS credentials in GitHub Secrets
   - Configure OIDC provider in AWS
   - Use short-lived credentials

2. **Automate signing in CI**
   - Sign on merge to main
   - Or manual workflow_dispatch
   - Never sign on every PR (security risk)

3. **Audit signing operations**
   - Monitor CloudTrail for KMS operations
   - Alert on unusual patterns
   - Regular access review

4. **Keep signing tools updated**
   - Watch for security patches
   - Test in staging before production
   - Document tool versions used

### Security Checklist

- [ ] AWS credentials secured (not in code)
- [ ] KMS key policy restricts access appropriately
- [ ] OIDC configured for GitHub Actions
- [ ] CloudTrail logging enabled for KMS
- [ ] Signing tool version documented
- [ ] Emergency key rotation procedure tested
- [ ] Backup of public keys maintained
- [ ] Trust policy reviewed quarterly

---

## Examples

### Sign Multiple Dossiers

```bash
# Sign all dossiers in a directory
for file in examples/devops/*.ds.md; do
  echo "Signing: $file"
  ai-dossier sign "$file" \
    --signed-by "DevOps Team <devops@example.com>"
done
```

### Re-sign After Updates

```bash
# After editing a dossier, re-sign it
vim examples/my-dossier.ds.md
ai-dossier sign examples/my-dossier.ds.md \
  --signed-by "Your Name <email@domain.com>"
```

### Verify Before Push

```bash
# Pre-push hook script
#!/bin/bash
for file in $(git diff --cached --name-only | grep '\.ds\.md$'); do
  if ! ai-dossier verify "$file"; then
    echo "❌ Verification failed: $file"
    exit 1
  fi
done
echo "✅ All dossiers verified"
```

---

## Related Documentation

- [Key Management](../../security/KEY_MANAGEMENT.md) - Comprehensive key lifecycle
- [Security Architecture](../../security/ARCHITECTURE.md) - Overall security design
- [AWS KMS Choice Decision](../../security/decisions/004-aws-kms-choice.md) - Why AWS KMS
- [Dual Signature System](../../security/decisions/001-dual-signature-system.md) - KMS + Minisign
- [Spec-Shaped Dossiers and Signature v3](../reference/spec-shape.md) - The Agent Skills layout, v1/v2/v3 signature schemes, migration

---

## Changelog

### 2026-10-07
- `sign` writes the Agent Skills (spec) layout with a v3 (`spec-frontmatter+body`) signature
- Documented the v1/v2/v3 scheme-to-layout binding and the registry's publish-time signature check

### 2025-11-24
- Initial guide created
- Documented local and CI/CD signing processes
- Added troubleshooting section
- Documented MessageType: DIGEST bug fix

---

**Questions or Issues?**
- GitHub Discussions: https://github.com/imboard-ai/ai-dossier/discussions
- Security Issues: security@imboard.ai
