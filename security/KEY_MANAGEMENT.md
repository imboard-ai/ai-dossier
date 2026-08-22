# Cryptographic Key Management

**Version**: 1.0.0
**Date**: 2025-11-06
**Status**: Active

---

## Executive Summary

This document defines the complete lifecycle management for cryptographic keys used in the Dossier system. We use a **dual-signature system**:

- **AWS KMS** (ECDSA-SHA256) - Official imboard-ai dossiers
- **minisign** (Ed25519) - Community dossiers

Both systems are cryptographically secure but target different use cases and security profiles.

---

## Official Keys (AWS KMS)

### Overview

**Purpose**: Sign official dossiers published by imboard-ai
**Algorithm**: ECDSA with P-256 curve (secp256r1)
**Signing**: ECDSA_SHA_256
**Key Storage**: AWS Key Management Service (KMS)
**HSM**: FIPS 140-2 Level 3 validated

### Generation

#### Initial Key Creation

```bash
# AWS CLI command (run by authorized admin)
aws kms create-key \
  --description "Dossier Official Signing Key 2024" \
  --key-usage SIGN_VERIFY \
  --key-spec ECC_NIST_P256 \
  --multi-region false \
  --tags TagKey=Project,TagValue=Dossier \
         TagKey=Purpose,TagValue=CodeSigning \
         TagKey=Year,TagValue=2024

# Create alias for easy reference
aws kms create-alias \
  --alias-name alias/dossier-official-prod \
  --target-key-id <key-id-from-above>
```

#### Key Specifications

| Property | Value |
|----------|-------|
| Key Type | Asymmetric (ECC) |
| Key Spec | ECC_NIST_P256 |
| Key Usage | SIGN_VERIFY |
| Origin | AWS_KMS |
| Key State | Enabled |
| Multi-Region | No (single region: us-east-1) |
| Automatic Rotation | Not supported for asymmetric keys |

### Access Control

#### IAM Policy for GitHub Actions (OIDC)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowGitHubActionsSign",
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::942039714848:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": [
        "kms:Sign",
        "kms:GetPublicKey",
        "kms:DescribeKey"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:sub": "repo:imboard-ai/ai-dossier:ref:refs/heads/main",
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

#### Access Restrictions

**Automated Access**:
- ✅ GitHub Actions (OIDC only, no long-lived credentials)
- ✅ Only from main branch
- ✅ Only workflow_dispatch or release events

**Human Access**:
- ❌ NO direct access to private key (stays in HSM)
- ⚠️ AWS Console access for key management (MFA required)
- ⚠️ Limited to 2 authorized administrators

**Audit**:
- ✅ All operations logged to CloudTrail
- ✅ CloudWatch alarms for anomalous usage

### Rotation

#### Regular Rotation Schedule

**Frequency**: Annually (November of each year)
**Next Rotation**: 2026-11-06

#### Rotation Procedure

**Preparation (T-14 days)**

```bash
# Generate new key
aws kms create-key \
  --description "Dossier Official Signing Key 2025" \
  --key-usage SIGN_VERIFY \
  --key-spec ECC_NIST_P256

# Create new alias
aws kms create-alias \
  --alias-name alias/dossier-official-2025 \
  --target-key-id <new-key-id>
```

**Dual Signing Period (14 days)**

- Sign all new dossiers with BOTH old and new keys
- Publish both public keys in KEYS.txt
- Allow users to add new key to trusted-keys.txt

**Switchover (T+14 days)**

```bash
# Update production alias
aws kms update-alias \
  --alias-name alias/dossier-official-prod \
  --target-key-id <new-key-id>
```

**Deprecation (T+30 days)**

- Mark old key as "DEPRECATED" in KEYS.txt
- Keep old key enabled for 90 days (verification of old dossiers)

**Deactivation (T+120 days)**

```bash
# Disable old key
aws kms disable-key --key-id <old-key-id>
```

**Archive (T+365 days)**

```bash
# Schedule deletion (7-30 day waiting period)
aws kms schedule-key-deletion \
  --key-id <old-key-id> \
  --pending-window-in-days 30
```

### Revocation

#### Emergency Revocation (Compromise)

**Trigger Events**:
- AWS account compromise detected
- Unauthorized signatures detected
- GitHub account takeover
- Insider threat incident

**Procedure (Execute within 24 hours)**:

**Immediate Actions (Hour 0)**

```bash
# Disable key immediately
aws kms disable-key --key-id <compromised-key-id>

# Audit all recent signatures
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=ResourceName,AttributeValue=<key-id> \
  --max-results 100
```

**Communication (Hour 1)**

- Update KEYS.txt with "REVOKED" status
- Publish GitHub Security Advisory
- Email notification to all known users
- Post to GitHub Discussions

**Generate Replacement (Hour 2-4)**

- Generate new key with different key spec if vulnerability-related
- Update GitHub workflows
- Sign critical dossiers with new key

**Investigation (Day 1-7)**

- Root cause analysis
- Identify all dossiers signed during compromise window
- Determine if any malicious dossiers published

**Recovery (Day 7-30)**

- Re-sign all official dossiers with new key
- Publish incident report
- Implement additional controls

### Backup and Recovery

**Key Material Backup**: Automatic by AWS KMS

- Multi-AZ replication within us-east-1
- Encrypted at rest with AWS-managed keys
- Regular integrity checks by AWS

**Disaster Recovery**:

- **RTO (Recovery Time Objective)**: 1 hour
- **RPO (Recovery Point Objective)**: 0 (KMS is always current)

**DR Procedure**:

```bash
# If primary region (us-east-1) unavailable:
# 1. Create new key in secondary region (us-west-2)
# 2. Update GitHub workflows to use new region
# 3. Publish new public key
# 4. Dual-sign transition period
```

### Monitoring

#### CloudWatch Alarms

```yaml
Alarms:
  - Name: DossierKMSUnusualActivity
    Metric: kms:Sign
    Threshold: > 100 in 1 hour
    Action: SNS notification to security team

  - Name: DossierKMSUnauthorizedAccess
    Metric: kms:Sign errors
    Threshold: > 5 in 5 minutes
    Action: SNS + PagerDuty

  - Name: DossierKMSAccessOutsideHours
    Metric: kms:Sign
    Condition: Time outside 08:00-20:00 UTC
    Action: SNS notification
```

#### CloudTrail Analysis

Weekly review of:
- All Sign operations (who, when, what)
- Failed access attempts
- Key administrative changes
- Unusual patterns

---

## Community Keys (minisign)

### Overview

**Purpose**: Sign community-contributed dossiers
**Algorithm**: Ed25519 (Edwards-curve Digital Signature Algorithm)
**Key Storage**: Author's local filesystem (self-custody)
**Distribution**: Decentralized (authors publish their own public keys)

### Generation

#### Create Key Pair

```bash
# Install minisign
brew install minisign  # macOS
# OR
apt-get install minisign  # Debian/Ubuntu
# OR
yum install minisign  # RHEL/CentOS

# Generate key pair
minisign -G -p author-2024.pub -s author-2024.key

# minisign will prompt for password to protect private key
# Use strong password (20+ chars, mix of types)
```

#### Key Specifications

| Property | Value |
|----------|-------|
| Algorithm | Ed25519 |
| Key Size | 256 bits (32 bytes) |
| Public Key Format | Base64-encoded (68 chars) |
| Private Key Format | Encrypted with Argon2 |
| Signature Format | Detached or embedded |

#### Best Practices

**Password Protection**:
- ✅ Use 20+ character passphrase
- ✅ Store in password manager
- ✅ Different password for each key
- ❌ Never store password in plaintext

**File Permissions**:

```bash
chmod 600 author-2024.key  # Read/write for owner only
chmod 644 author-2024.pub  # Readable by all
```

**Storage Location**:

```bash
# Recommended structure
~/.minisign/
  ├── author-2024.key        # Private key (NEVER commit to git)
  ├── author-2024.pub        # Public key (safe to publish)
  └── README.txt             # Key metadata
```

### Access Control

#### Private Key Security

**Storage Options (from most to least secure)**:

1. **Hardware Security Key (Recommended for high-value keys)**
   - YubiKey with GPG/PIV
   - Nitrokey
   - Ledger hardware wallet

2. **Encrypted Volume**
   - LUKS (Linux)
   - FileVault (macOS)
   - BitLocker (Windows)
   - VeraCrypt (cross-platform)

3. **Password Manager**
   - 1Password
   - Bitwarden
   - KeePassXC

4. **Local Filesystem (Minimum security)**
   - At least use full-disk encryption
   - Set strict file permissions

**Never**:
- ❌ Commit to git repositories
- ❌ Email or chat services
- ❌ Cloud storage (Dropbox, Google Drive) unless encrypted
- ❌ Shared computers

#### Publishing Public Keys

**In Your Repository**

Create KEYS.txt in your dossier repository:

```markdown
# Dossier Author Public Keys

## John Doe (john@example.com)

**Key ID**: john-doe-2024
**Algorithm**: Ed25519
**Created**: 2024-11-06
**Expires**: 2025-11-06

**Public Key**:
RWTx5V7Kf1KLN8BVF3PqZ8cN9nJxH5kM2wQ4pS6rT7yU8vW9xA0bC1dD2e==

**Fingerprint**: (from minisign -p john-doe-2024.pub)

**Verification**:
```bash
curl https://raw.githubusercontent.com/johndoe/dossiers/main/KEYS.txt | grep RWTx5V7K
```
```

**In Dossier Metadata**

```json
{
  "signature": {
    "algorithm": "ed25519",
    "public_key": "RWTx5V7Kf1KLN8BVF3PqZ8cN9nJxH5kM2wQ4pS6rT7yU8vW9xA0bC1dD2e==",
    "signature": "trustedComment: timestamp:1699200000\tfile:my-dossier.md\n...",
    "key_id": "john-doe-2024",
    "signed_by": "John Doe <john@example.com>",
    "timestamp": "2024-11-06T12:00:00Z"
  }
}
```

### Rotation

#### Regular Rotation

**Recommended Frequency**: Annually
**Optional**: More frequently for high-risk dossiers

#### Rotation Procedure

**Generate New Key (T-30 days)**

```bash
minisign -G -p author-2025.pub -s author-2025.key
```

**Publish Both Keys (T-30 to T)**

- Update KEYS.txt with both keys
- Mark old key as "will be deprecated"

**Dual Signing (14 days)**

- Sign new dossiers with new key
- Consider re-signing critical existing dossiers

**Deprecate Old Key (T)**

```markdown
## DEPRECATED - Do Not Use for New Signatures
**Key ID**: john-doe-2024
**Status**: DEPRECATED as of 2025-11-06
**Reason**: Regular annual rotation
**Still Valid For**: Verifying signatures created before 2025-11-06
```

**Archive (T+90 days)**

```bash
# Move old key to archive
mkdir -p ~/.minisign/archive
mv ~/.minisign/author-2024.key ~/.minisign/archive/
```

### Revocation

#### Compromise or Loss

**Immediate Actions**:

**Publish Revocation Notice (Hour 0)**

```markdown
# SECURITY ALERT - KEY COMPROMISED

**Date**: 2024-11-06
**Key ID**: john-doe-2024
**Status**: REVOKED - DO NOT TRUST
**Reason**: Private key potentially compromised

**Action Required**:
- Remove from trusted-keys.txt immediately
- Do not execute any dossiers signed with this key after 2024-11-06
- Review any dossiers signed with this key

**Replacement Key**:
- New key ID: john-doe-2024-emergency
- Public key: RWT...
```

**Update All Channels**

- GitHub README.md
- Repository KEYS.txt
- Social media / communication channels
- Email to known users (if possible)

**Re-sign Critical Dossiers (Day 1-7)**

- Generate new key
- Re-sign all published dossiers
- Update signatures in all copies

### Backup

#### Private Key Backup

1. **Paper Backup (Recommended)**

```bash
# Print private key to paper (store in safe)
minisign -R -s author-2024.key
# Follow prompts to see recovery information
```

2. **Encrypted USB Drive**

```bash
# Copy to encrypted USB drive
# Store in physically secure location (safe, safety deposit box)
cp ~/.minisign/author-2024.key /media/usb-encrypted/backups/
```

3. **Split Secret (For very sensitive keys)**

```bash
# Use Shamir's Secret Sharing
# Split key into N parts, require M to recover
# Example: 5 parts, need any 3 to recover
ssss-split -t 3 -n 5 < author-2024.key
```

#### Public Key Backup

- Not sensitive, safe to have multiple copies
- Publish in repository, website, key servers
- Store with private key for reference

---

## Trust Management

### Trusted Keys File Format

`~/.dossier/trusted-keys.txt` holds **two whitespace-separated fields per line**:

```
<public-key> <identifier>
```

The first field is the key material itself — there is no algorithm column, and
anything extra is absorbed into the identifier. Blank lines and `#` comments are
ignored; lines that do not parse are reported by `ai-dossier keys list` and are
**not** trusted.

Prefer the CLI over hand-editing, so the key is normalized and validated before
it is written:

```bash
ai-dossier keys add <public-key> <identifier>
```

#### Community Keys (Ed25519)

The canonical form is the raw 32-byte key in base64 — what `ai-dossier keys
generate` prints and what `keys add` stores, whatever encoding you hand it:

```bash
ai-dossier keys add "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=" "john-doe-2024"
```

Resulting line:

```
m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE= john-doe-2024
```

#### Official Keys (AWS KMS)

KMS signatures are verified by asking KMS itself, using `signature.key_id` — the
key ARN. The public key a KMS signature also carries is never read, so the **ARN
is what the trust check matches**, and the ARN is what to add:

```bash
ai-dossier keys add \
  "arn:aws:kms:us-east-1:942039714848:key/1234abcd-12ab-34cd-56ef-1234567890ab" \
  "imboard-ai-2024-kms"
```

Resolve an alias to the underlying key ARN with:

```bash
aws kms describe-key --key-id alias/dossier-official-prod \
  --output text --query KeyMetadata.Arn
```

### Verification Before Trust

Always verify public keys through multiple channels:

1. Official Website (HTTPS)
2. GitHub Repository (verified commits)
3. Social Media (verified accounts)
4. Direct Communication (if possible)

**Never trust**:
- Keys from unverified emails
- Keys from third-party websites
- Keys without context

### Trust Levels

| Level | Criteria | Usage |
|-------|----------|-------|
| OFFICIAL | AWS KMS, imboard-ai | Auto-execute low/medium risk |
| TRUSTED | Community key in trusted-keys.txt | Execute with standard approval |
| SIGNED_UNKNOWN | Valid signature, unknown key | Warn user, require approval |
| UNSIGNED | No signature | Warn user, require approval |
| INVALID | Signature verification failed | BLOCK execution |

---

## Key Escrow (Enterprise)

For enterprise deployments requiring key escrow:

### AWS KMS

**Built-in**: AWS KMS automatically backs up key material

- Encrypted with AWS master keys
- Multi-AZ redundancy
- Accessible only by authorized IAM principals

### minisign (Organization Keys)

For organizations managing team keys:

#### Split Key Storage

```bash
# Use secret sharing to split key
# Require M of N keyholders to recover
ssss-split -t 3 -n 5 < team-key.key > shares.txt
# Distribute shares to 5 different trusted individuals
```

#### Recovery Procedure

```bash
# Collect M shares (e.g., 3 of 5)
ssss-combine -t 3 < collected-shares.txt > recovered-key.key
```

#### Access Control

- Document who has shares
- Require approval from senior management for recovery
- Audit all recovery operations

---

## Compliance

### Cryptographic Standards

| Standard | Requirement | Dossier Compliance |
|----------|-------------|-------------------|
| FIPS 140-2 | Level 2+ for signing | ✅ AWS KMS is Level 3 |
| NIST SP 800-57 | Key management lifecycle | ✅ Documented in this file |
| NIST SP 800-131A | Cryptographic algorithms | ✅ ECDSA P-256, Ed25519 |
| SOC 2 | Key access controls | ✅ IAM policies, audit logs |

### Audit Requirements

**Quarterly Review**:
- All AWS KMS usage (CloudTrail)
- Access control changes
- Key rotation schedule adherence
- Revocation events

**Annual Certification**:
- Key management procedures followed
- No unauthorized access
- Backup and recovery tested
- Compliance with standards

---

## Emergency Contacts

**AWS KMS Issues**:
- Primary: AWS Support (Enterprise plan)
- Secondary: security@imboard.ai

**Key Compromise**:
- Immediate: security@imboard.ai
- PagerDuty: (to be configured)

**General Questions**:
- GitHub Discussions: https://github.com/imboard-ai/ai-dossier/discussions
- Email: support@imboard.ai

---

## Appendix

### A. Key Formats

#### AWS KMS Public Key (DER format)

```bash
# Get public key from KMS
aws kms get-public-key \
  --key-id alias/dossier-official-prod \
  --output text \
  --query PublicKey | base64 --decode > publickey.der

# Convert to PEM (optional)
openssl ec -pubin -inform DER -in publickey.der -outform PEM -out publickey.pem
```

#### minisign Public Key Format

Format: "RWT" + base64(32-byte Ed25519 public key + metadata)
Example: `RWTx5V7Kf1KLN8BVF3PqZ8cN9nJxH5kM2wQ4pS6rT7yU8vW9xA0bC1dD2e==`

### B. Signature Formats

#### AWS KMS Signature

- Format: ASN.1 DER-encoded signature (ECDSA)
- Encoding: Base64
- Length: ~96 bytes (before base64)

#### minisign Signature

- Format: minisign-specific format
- Includes:
  - Trusted comment with timestamp and file name
  - Global signature
  - Base64-encoded signature
- Length: ~150 characters

### C. Migration Guide

#### From GPG to minisign

Many projects migrate from GPG to minisign for simplicity. If migrating:

1. Announce transition (30 days notice)
2. Dual-sign new dossiers with both GPG and minisign (30 days)
3. Deprecate GPG signatures
4. Archive GPG keys (keep for historical verification)

---

**Last Updated**: 2025-11-06
**Version**: 1.0.0
**Next Review**: 2026-02-06
