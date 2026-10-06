# ADR-001: Dual Signature System (AWS KMS + minisign)

**Status**: Accepted
**Date**: 2025-11-06
**Deciders**: Security Team, Engineering Lead
**Consulted**: Community
**Informed**: All stakeholders

---

## Context and Problem Statement

Dossiers are executable workflows that require cryptographic signatures to establish authenticity and trust. We need to choose a signature system that:

1. **For official dossiers**: Demonstrates enterprise-grade security and key management
2. **For community dossiers**: Enables participation without infrastructure barriers
3. **For both**: Provides strong cryptographic guarantees against forgery

**Key Question**: Should we standardize on a single signature technology, or support multiple approaches?

---

## Decision Drivers

### Must Have
- Strong cryptographic security (infeasible to forge)
- Clear trust model (users know who to trust)
- Verifiable signatures (anyone can verify)
- Offline capability (works without network)

### Nice to Have
- Enterprise credibility (CISOs will approve)
- Low barrier to entry (community can participate)
- Simple key management (easy to rotate, revoke)
- Industry standards compliance (FIPS, NIST)

### Constraints
- Open source project (must be free)
- Cross-platform (Linux, macOS, Windows)
- LLM-friendly (verification tools must be simple)

---

## Considered Options

### Option 1: GPG Only
**Technology**: GNU Privacy Guard (GPG/PGP)
**Algorithm**: RSA or ECC

**Pros**:
- ✅ Industry standard for decades
- ✅ Widely installed
- ✅ Strong cryptographic foundation
- ✅ Existing key infrastructure (keyservers)

**Cons**:
- ❌ Complex (~20MB install, many dependencies)
- ❌ Poor UX (confusing command-line interface)
- ❌ Keyserver trust issues (abandoned/compromised servers)
- ❌ Overly complex for code signing (designed for email)

**Verdict**: ❌ Rejected - Complexity outweighs benefits

---

### Option 2: minisign Only
**Technology**: minisign (Jedisct1's signing tool)
**Algorithm**: Ed25519

**Pros**:
- ✅ Purpose-built for code signing
- ✅ Lightweight (~100KB install)
- ✅ Simple trust model (no keyservers)
- ✅ Battle-tested (OpenBSD packages, Homebrew)
- ✅ Cross-platform (single binary)
- ✅ Fast and modern crypto (Ed25519)

**Cons**:
- ❌ Less "enterprise credible" than AWS KMS
- ❌ Private keys on developer machines (risk of theft)
- ❌ No automatic key backup/rotation infrastructure
- ❌ Self-custody (users responsible for key security)

**Verdict**: 🤔 Partial solution - Great for community, insufficient for official

---

### Option 3: AWS KMS Only
**Technology**: AWS Key Management Service
**Algorithm**: ECDSA with P-256 curve

**Pros**:
- ✅ Enterprise-grade key security (FIPS 140-2 Level 3 HSM)
- ✅ Key never leaves AWS (highest security)
- ✅ Automatic backup and multi-AZ redundancy
- ✅ CloudTrail audit logs (full accountability)
- ✅ IAM/OIDC access control (no long-lived credentials)
- ✅ Industry compliance (SOC 2, HIPAA, PCI DSS)

**Cons**:
- ❌ Requires AWS account (barrier for community)
- ❌ Not free (KMS charges apply)
- ❌ Vendor lock-in (AWS-specific)
- ❌ Requires network for signing (no airgapped signing)
- ❌ Complex for individuals (overkill for simple dossiers)

**Verdict**: 🤔 Partial solution - Perfect for official, blocks community

---

### Option 4: Dual System (AWS KMS + minisign) ⭐
**Technology**: Both systems, distinguished by signature type
**Algorithms**: ECDSA-SHA256 (AWS) + Ed25519 (minisign)

**Pros**:
- ✅ **Official dossiers**: Enterprise security via AWS KMS
- ✅ **Community dossiers**: Low-barrier participation via minisign
- ✅ **Clear trust hierarchy**: Users decide which keys to trust
- ✅ **Best of both worlds**: Security AND accessibility
- ✅ **Demonstrates security commitment**: Shows we take official dossiers seriously
- ✅ **Enables community**: Doesn't require AWS account to contribute

**Cons**:
- ⚠️ Increased complexity (two verification paths)
- ⚠️ User education required (understand two signature types)
- ⚠️ More code to maintain (two signing/verification implementations)

**Verdict**: ✅ **SELECTED** - Balances security and accessibility

---

## Decision

**We will implement a dual signature system**:

### Official Dossiers (imboard-ai)
- **Signature**: AWS KMS (ECDSA-SHA256)
- **Key Storage**: AWS KMS (FIPS 140-2 Level 3 HSM)
- **Access**: GitHub Actions via OIDC (no stored credentials)
- **Trust Level**: HIGH (enterprise-grade security)

```json
{
  "signature": {
    "algorithm": "ecdsa-sha256",
    "public_key": "imboard-ai-2024-kms",
    "signature": "MEUCIQDx...",
    "signed_by": "Imboard AI Security Team <security@imboard.ai>",
    "key_id": "arn:aws:kms:us-east-1:123456789012:key/xxx"
  }
}
```

### Community Dossiers
- **Signature**: minisign (Ed25519)
- **Key Storage**: Author's local filesystem (self-custody)
- **Access**: Author's private key file (password-protected)
- **Trust Level**: MEDIUM (user decides which community keys to trust)

```json
{
  "signature": {
    "algorithm": "ed25519",
    "public_key": "RWTx5V7Kf1KLN8BVF3PqZ...",
    "signature": "trustedComment: timestamp:1699200000...",
    "signed_by": "Author Name <author@example.com>",
    "key_id": "author-2024"
  }
}
```

### Trust Hierarchy

```text
┌──────────────────────────────────────┐
│ HIGH TRUST                           │
│ • AWS KMS signatures                 │
│ • imboard-ai official key            │
│ • Auto-approved (low/medium risk)    │
├──────────────────────────────────────┤
│ MEDIUM TRUST                         │
│ • minisign signatures                │
│ • User-trusted community keys        │
│ • Require approval per risk level    │
├──────────────────────────────────────┤
│ LOW TRUST                            │
│ • Valid signature, unknown key       │
│ • Warning + require approval         │
├──────────────────────────────────────┤
│ UNTRUSTED                            │
│ • Unsigned dossiers                  │
│ • Warning + require approval         │
├──────────────────────────────────────┤
│ BLOCKED                              │
│ • Invalid signatures                 │
│ • Failed checksum                    │
│ • Do not execute                     │
└──────────────────────────────────────┘
```

---

## Consequences

### Positive
- **Enterprise Credibility**: CISOs see AWS KMS and approve deployment
- **Community Velocity**: Individuals can sign dossiers without AWS account
- **Defense in Depth**: Multiple independent verification paths
- **Clear Differentiation**: Users immediately recognize official vs community
- **Future Proof**: Can add more signature types if needed (e.g., Sigstore)

### Negative
- **Complexity**: Verification code must handle both signature types
- **Documentation**: Must explain two different signing processes
- **Testing**: Must test both signature paths thoroughly
- **User Education**: Users need to understand trust levels

### Neutral
- **Schema Change**: Must add algorithm field to distinguish signature types
- **Tool Updates**: sign-dossier.js and verify-dossier.js need dual-mode support
- **Migration Path**: Existing signed dossiers (if any) must be re-signed

---

## Implementation

### Phase 1: Core Support ✅

- Update schema to support both algorithms
- Extend `sign-dossier.js` with `signKMS()` and `signMinisign()`
- Extend `verify-dossier.js` to detect and verify both types
- Document key management for both types
- Create GitHub Actions workflow for KMS signing

### Phase 2: Ecosystem Integration (Next)

- MCP server support for both signature types
- Trust level UI indicators
- Verification caching (performance)
- Signature transparency log (optional)

### Phase 3: Advanced Features (Future)

- Multi-signature support (require N of M signatures)
- Hardware key support (YubiKey) for minisign
- Signature timestamping (RFC 3161)
- Integration with Sigstore (container signing)

---

## Validation

### Success Criteria
- ✅ Official dossiers signed with AWS KMS
- ✅ Community members can sign with minisign
- ✅ Verification tools handle both types correctly
- ✅ Users understand trust levels
- ✅ No security vulnerabilities in dual-signature logic

### Monitoring
- Track percentage of dossiers with signatures (target: 100% official, 50%+ community)
- Monitor verification failures (should be rare)
- User feedback on signature system complexity

---

## Related Decisions

- [ADR-002: Optional Signatures](./002-optional-signatures.md) - Why signatures aren't required
- [ADR-004: AWS KMS Choice](./004-aws-kms-choice.md) - Why AWS KMS over alternatives

---

## References

### AWS KMS
- AWS KMS Documentation
- FIPS 140-2 Validation
- ECDSA on NIST Curves

### minisign
- minisign GitHub
- Ed25519 Paper
- OpenBSD Signify

### Industry Examples
- Docker Hub: Decentralized trust (anyone can publish)
- Homebrew: minisign for package verification
- Debian: GPG signatures for packages
- Sigstore: Keyless signing with transparency log

---

**Last Updated**: 2025-11-06
**Version**: 1.0.0
