# ADR-004: AWS KMS for Official Signatures

**Status**: Accepted
**Date**: 2025-11-06
**Deciders**: Security Team, Infrastructure Lead
**Consulted**: Security Advisors
**Informed**: All stakeholders

---

## Context and Problem Statement

For official dossiers published by imboard-ai, we need cryptographic signatures that demonstrate enterprise-grade security and key management. The private key must be protected to prevent unauthorized signatures.

**Key Question**: Which key management system should we use for official dossier signatures?

---

## Decision Drivers

### Security Requirements
- **Key Security**: Private key never exposed or extracted
- **Access Control**: Fine-grained permissions (who can sign)
- **Auditability**: Complete log of all signing operations
- **Compliance**: Meet industry standards (FIPS, SOC 2)
- **Revocation**: Ability to disable keys immediately

### Operational Requirements
- **Automation**: CI/CD integration (GitHub Actions)
- **Reliability**: High availability, fault tolerance
- **Backup**: Automatic key material backup
- **Rotation**: Support key rotation procedures
- **No Credentials**: No long-lived credentials in CI/CD

### Cost Considerations
- **Budget**: Reasonable cost for open source project
- **Scaling**: Cost doesn't explode with usage
- **Free Tier**: Ideally has free tier or low base cost

---

## Considered Options

### Option 1: GPG with Self-Managed Keys
**Approach**: Generate GPG key pair, store private key encrypted

**Implementation**:
```bash
# Generate GPG key
gpg --full-generate-key

# Store in GitHub Secrets (encrypted)
gpg --armor --export-secret-keys KEY_ID > private.key
# Upload to GitHub Secrets: GPG_PRIVATE_KEY

# Sign in GitHub Actions
echo "${{ secrets.GPG_PRIVATE_KEY }}" | gpg --import
gpg --detach-sign --armor dossier.md
```

**Pros**:
- ✅ Free (no cloud costs)
- ✅ Widely used (industry standard)
- ✅ Works offline (no cloud dependency)
- ✅ Self-sovereign (full control)

**Cons**:
- ❌ Key in GitHub Secrets (less secure than HSM)
- ❌ Manual rotation (export, re-encrypt, update secret)
- ❌ No audit trail (can't see who used key when)
- ❌ GitHub Secrets breach = key compromised
- ❌ Complex to manage (large key files, keyserver issues)

**Risk Assessment**: MEDIUM-HIGH
- If GitHub Secrets compromised, attacker can sign malicious dossiers
- No way to detect unauthorized use

**Verdict**: ❌ Rejected - Insufficient key protection

---

### Option 2: HashiCorp Vault with Transit Engine
**Approach**: Store keys in Vault, use transit engine for signing

**Implementation**:
```bash
# Create signing key in Vault
vault write transit/keys/dossier-signing type=ecdsa-p256

# Sign via API
vault write transit/sign/dossier-signing \
  input=$(base64 <<< "$HASH") \
  hash_algorithm=sha256
```

**Pros**:
- ✅ HSM-backed (with Vault Enterprise)
- ✅ Audit trail (Vault audit logs)
- ✅ Access control (Vault policies)
- ✅ Key rotation support
- ✅ Automatic backup

**Cons**:
- ⚠️ Requires running Vault (self-hosted or HCP)
- ⚠️ Cost (HCP Vault not free, or ops burden for self-hosted)
- ⚠️ Complexity (Vault infrastructure, policies, unsealing)
- ⚠️ Still need to auth to Vault from GitHub Actions

**Cost**: $30-100/month (HCP Vault) or ops burden (self-hosted)

**Verdict**: 🤔 Good option, but overhead for OSS project

---

### Option 3: GitHub Actions with Repository Secrets
**Approach**: Store minisign key in GitHub repository secrets

**Implementation**:
```yaml
# .github/workflows/sign.yml
jobs:
  sign:
    steps:
      - name: Sign dossier
        env:
          MINISIGN_KEY: ${{ secrets.MINISIGN_PRIVATE_KEY }}
        run: |
          echo "$MINISIGN_KEY" > /tmp/key.key
          minisign -s /tmp/key.key -m dossier.md
```

**Pros**:
- ✅ Free (no cloud costs)
- ✅ Simple integration
- ✅ GitHub native

**Cons**:
- ❌ Same issue as GPG: Key in GitHub Secrets
- ❌ No HSM protection
- ❌ Limited audit (GitHub audit log, but not crypto-focused)

**Verdict**: ❌ Rejected - Same security issues as Option 1

---

### Option 4: AWS KMS with GitHub OIDC ⭐
**Approach**: Keys in AWS KMS HSM, GitHub Actions auth via OIDC

**Implementation**:
```yaml
# .github/workflows/sign.yml
jobs:
  sign:
    permissions:
      id-token: write  # Required for OIDC
    steps:
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::ACCOUNT:role/github-dossier-oidc
          aws-region: us-east-1

      - name: Sign with KMS
        run: |
          HASH=$(shasum -a 256 dossier.md | awk '{print $1}')
          aws kms sign \
            --key-id alias/dossier-official-prod \
            --message-type DIGEST \
            --signing-algorithm ECDSA_SHA_256 \
            --message "$(echo -n $HASH | xxd -r -p | base64)"
```

**Pros**:
- ✅ HSM-backed: FIPS 140-2 Level 3 hardware security module
- ✅ Key never leaves AWS: Can't be extracted or stolen
- ✅ No credentials in GitHub: OIDC token exchange (short-lived)
- ✅ CloudTrail audit: Every signature logged with identity
- ✅ IAM policies: Fine-grained access control
- ✅ Automatic backup: AWS handles key material backup
- ✅ High availability: Multi-AZ, 99.99% SLA
- ✅ Compliance: SOC 2, ISO 27001, PCI DSS, HIPAA
- ✅ Rotation: Built-in key rotation (though manual for asymmetric)
- ✅ Immediate revocation: Disable key instantly

**Cons**:
- ⚠️ Cost: ~$1/month per key + $0.03 per 10k API calls
- ⚠️ AWS dependency: Vendor lock-in
- ⚠️ Network required: Can't sign offline (but CI/CD always online)
- ⚠️ Complexity: Requires AWS account, IAM setup, OIDC trust

**Cost Analysis**:

Monthly:
- KMS key: $1/month
- API calls: ~1000 signs/month = ~$0.03
- CloudTrail: Free (first trail)
- IAM: Free

Total: ~$1-2/month

**Security Analysis**:
- Key Storage: HSM (FIPS 140-2 Level 3) ✅
- Key Extraction: Impossible ✅
- Access Control: IAM + OIDC ✅
- Audit Trail: CloudTrail ✅
- Credential Theft: No long-lived creds ✅
- Detection: CloudWatch alarms ✅
- Revocation: Immediate via `aws kms disable-key` ✅

**Verdict**: ✅ **SELECTED** - Best security-to-cost ratio

---

### Option 5: Google Cloud KMS
Similar to AWS KMS but on GCP

**Pros**: Same HSM benefits as AWS KMS

**Cons**: Team already has AWS expertise, no advantage over AWS KMS

**Verdict**: ❌ Rejected - AWS KMS preferred due to existing AWS usage

---

### Option 6: Azure Key Vault
Similar to AWS KMS but on Azure

**Pros**: Same HSM benefits

**Cons**: Same as Google Cloud KMS

**Verdict**: ❌ Rejected - AWS KMS preferred

---

### Option 7: Sigstore/Cosign (Keyless Signing)
**Approach**: Use Sigstore's keyless signing (OIDC-based)

**Implementation**:
```bash
# Sign with cosign (keyless)
cosign sign --oidc-issuer=https://token.actions.githubusercontent.com \
  dossier.md
```

**Pros**:
- ✅ No key management (keyless)
- ✅ Transparency log (rekor)
- ✅ OIDC-based (no credentials)
- ✅ Free (open source)

**Cons**:
- ⚠️ Relatively new (less proven than KMS)
- ⚠️ Requires Sigstore infrastructure (Rekor, Fulcio)
- ⚠️ OIDC token lifetimes (signatures tied to short-lived identity)
- ⚠️ Learning curve (new tooling for ecosystem)

**Future Consideration**: May add as additional signature type in future

**Verdict**: 🔮 Future consideration - Not ready for v1.0

---

## Decision

**Use AWS KMS for official dossier signatures**:

### Implementation Details

#### KMS Key Configuration

```terraform
# Terraform (Infrastructure as Code)
resource "aws_kms_key" "dossier_signing" {
  description             = "Dossier Official Signing Key 2024"
  key_usage              = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_SECG_P256K1"

  tags = {
    Project = "Dossier"
    Purpose = "CodeSigning"
    Environment = "Production"
  }
}

resource "aws_kms_alias" "dossier_signing" {
  name          = "alias/dossier-official-prod"
  target_key_id = aws_kms_key.dossier_signing.key_id
}
```

#### IAM Role for GitHub Actions (OIDC)

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
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:imboard-ai/ai-dossier:*"
        }
      }
    }
  ]
}
```

#### Key Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Enable IAM User Permissions",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:root"
      },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "Allow GitHub Actions to Sign",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/github-dossier-oidc"
      },
      "Action": [
        "kms:Sign",
        "kms:GetPublicKey",
        "kms:DescribeKey"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "kms:MessageType": "DIGEST"
        }
      }
    }
  ]
}
```

#### CloudWatch Alarms

```yaml
Alarms:
  - Name: DossierKMSUnusualActivity
    Metric: kms:Sign
    Threshold: 100 calls/hour
    Action: SNS notification to security team

  - Name: DossierKMSUnauthorizedAccess
    Metric: CloudTrail ErrorCode
    Filter: AccessDenied
    Action: Immediate alert
```

---

## Consequences

### Positive
- **Enterprise Security**: HSM-backed keys meet enterprise security requirements
- **No Credential Management**: OIDC eliminates GitHub Secrets for AWS access
- **Complete Audit Trail**: CloudTrail logs every signature with identity
- **Immediate Revocation**: Can disable key in seconds if compromised
- **Compliance Ready**: Meets SOC 2, ISO 27001, PCI DSS requirements
- **High Reliability**: AWS 99.99% SLA for KMS

### Negative
- **Monthly Cost**: ~$1-2/month (acceptable for project value)
- **AWS Dependency**: Vendor lock-in (but can migrate to minisign if needed)
- **Complexity**: Requires AWS account setup and IAM configuration
- **Network Dependency**: Requires internet for signing (not an issue for CI/CD)

### Neutral
- **Learning Curve**: Team needs to understand AWS KMS and OIDC
- **Migration Path**: Can switch to other HSMs if needed (re-sign dossiers)

---

## Migration Path

### If Migrating FROM AWS KMS (Future)

1. Generate new key in alternative system (e.g., GCP KMS, Azure Key Vault)
2. Re-sign all official dossiers with new key
3. Update KEYS.txt with new public key
4. Mark old KMS key as deprecated (keep for verification of old signatures)
5. After 90 days, disable old KMS key

### If Migrating TO AWS KMS (Initial Setup)

1. Create AWS account (if needed)
2. Set up GitHub OIDC provider in AWS IAM
3. Create IAM role with trust policy for GitHub Actions
4. Create KMS key with appropriate key policy
5. Update GitHub Actions workflows to use OIDC
6. Test signing workflow in development
7. Deploy to production

---

## Validation

### Security Validation
- ✅ Penetration Testing: Key extraction attempts should fail
- ✅ Access Control Testing: Unauthorized roles cannot sign
- ✅ Audit Testing: All signatures appear in CloudTrail
- ✅ Revocation Testing: Disabled key immediately stops working

### Operational Validation
- ✅ Sign 100 dossiers successfully
- ✅ Verify signatures with public key
- ✅ Monitor CloudTrail logs for expected events
- ✅ Test key rotation procedure
- ✅ Verify CloudWatch alarms trigger correctly

---

## Cost-Benefit Analysis

### Annual Costs
- KMS key: $12/year
- API calls: ~12,000/year = $0.36/year
- CloudTrail: $0 (first trail free)
- TOTAL: ~$12-15/year

### Benefits (Value)
- Enterprise-grade security: Priceless for reputation
- Compliance: Enables enterprise adoption
- Audit trail: Critical for security incidents
- No credential theft risk: Prevents supply chain attacks
- Peace of mind: Keys can't be stolen from GitHub

**ROI**: Excellent - minimal cost for maximum security

---

## Alternatives for Community

For community dossier authors who don't have AWS accounts:
- **minisign**: Free, simple, Ed25519 signatures
- **GPG**: Traditional but more complex
- **Cosign** (future): Keyless signing via OIDC

This maintains a low barrier to entry for community contributions while ensuring official dossiers meet enterprise security standards.

---

## Related Decisions

- [ADR-001: Dual Signature System](./001-dual-signature-system.md) - Why we support both AWS KMS and minisign
- [ADR-002: Optional Signatures](./002-optional-signatures.md) - Why signatures aren't required

---

## References

### AWS KMS Documentation
- AWS KMS Developer Guide
- FIPS 140-2 Validation
- KMS Key Policies Best Practices
- OIDC Federation with GitHub Actions

### Security Standards
- NIST FIPS 140-2 (Hardware Security Modules)
- ECDSA on NIST Curves (FIPS 186-4)
- NIST SP 800-57 (Key Management)

### Similar Implementations
- **Docker Content Trust**: Uses TUF + Notary with HSM support
- **npm**: Package signing with registry-managed keys
- **Sigstore**: Keyless signing with transparency log
- **GitHub**: SSH key signing with hardware security keys

---

**Last Updated**: 2025-11-06
**Version**: 1.0.0
