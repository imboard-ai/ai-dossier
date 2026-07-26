# Security Policy

## 🔒 Reporting Security Vulnerabilities

The Dossier project takes security seriously. We appreciate your efforts to responsibly disclose your findings.

### How to Report

**DO NOT** open public GitHub issues for security vulnerabilities.

Instead, please report security vulnerabilities via:
- **Email**: security@imboard.ai
- **Subject**: `[SECURITY] Brief description`
- **Include**:
  - Description of the vulnerability
  - Steps to reproduce
  - Potential impact
  - Suggested fix (if any)

### What to Expect

- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days
- **Disclosure Timeline**: 90-day coordinated disclosure
  - We'll work with you to understand and fix the issue
  - We'll notify you before public disclosure
  - Credit will be given unless you prefer to remain anonymous

### PGP Encryption (Optional)

For highly sensitive reports, PGP encryption will be supported in the future:
- **PGP Key**: Will be available at `KEYS.txt` in this repository
- **Fingerprint**: Will be added with official key generation

---

## 🛡️ Supported Versions

We release security patches for the following versions:

| Version | Supported          | Status                    |
| ------- | ------------------ | ------------------------- |
| 1.x     | ✅ Yes             | Active development        |
| < 1.0   | ❌ No              | Pre-release, unsupported  |

**Recommendation**: Always use the latest stable release.

---

## 🎯 Security Scope

### In Scope

We consider the following security concerns in scope:

- **Signature Bypass**: Ability to execute unsigned/untrusted dossiers without warning
- **Checksum Collision**: Ability to create dossiers with same checksum but different content
- **Tampering Detection Bypass**: Methods to modify dossiers without detection
- **Execution Sandbox Escape**: Breaking out of intended security boundaries
- **Supply Chain Attacks**: Compromising the dossier distribution/verification chain
- **Key Management Issues**: Private key exposure, weak key generation
- **Cryptographic Weaknesses**: Issues with signature algorithms, hash functions
- **MCP Server Vulnerabilities**: Security issues in the Model Context Protocol server
- **Privilege Escalation**: Gaining unintended permissions during dossier execution
- **Information Disclosure**: Leaking sensitive data through dossier execution
- **Denial of Service**: Resource exhaustion attacks via malicious dossiers

### Out of Scope

The following are explicitly **out of scope**:

- **Social Engineering**: Tricking users into approving malicious dossiers
- **Compromised User Systems**: Security of the underlying execution environment
- **Third-Party Tools**: Vulnerabilities in minisign, AWS KMS, Node.js, etc.
- **Physical Access**: Attacks requiring physical access to signing keys
- **Deprecated Features**: Issues in unsupported versions or deprecated functionality

**Note**: If you're unsure whether an issue is in scope, please report it anyway.

---

## 🔐 Security Features

Dossier implements multiple security layers:

1. **Integrity Verification** (SHA256 checksums of the body) - Required
2. **Cryptographic Signatures** (AWS KMS + Ed25519), covering frontmatter and body - Optional
3. **Risk Assessment Metadata** - Required
4. **Automated Verification** (MCP tools) - Optional
5. **User Approval Flows** - Required for high-risk operations

For detailed security architecture, see [security/ARCHITECTURE.md](./security/ARCHITECTURE.md).

---

## 📋 Security Advisories

Security advisories will be published via:
- **GitHub Security Advisories**: https://github.com/imboard-ai/ai-dossier/security/advisories
- **Release Notes**: Tagged with `[SECURITY]`
- **Email Notifications**: For critical vulnerabilities (if you've reported issues before)

### Severity Levels

We use the CVSS v3.1 scoring system:

| Score     | Severity | Response Time |
|-----------|----------|---------------|
| 9.0-10.0  | Critical | 24 hours      |
| 7.0-8.9   | High     | 7 days        |
| 4.0-6.9   | Medium   | 30 days       |
| 0.1-3.9   | Low      | 90 days       |

---

## 🏆 Recognition

We believe in recognizing security researchers who help us improve Dossier:

- **Hall of Fame**: Security researchers will be recognized with permission
- **CVE Credit**: Named in CVE entries and security advisories
- **GitHub Thanks**: Mentioned in release notes

**Note**: We do not currently offer monetary bug bounties, but we deeply appreciate your contributions to the security of the open source community.

---

## 📚 Additional Resources

- **Threat Model**: [security/THREAT_MODEL.md](./security/THREAT_MODEL.md)
- **Key Management**: [security/KEY_MANAGEMENT.md](./security/KEY_MANAGEMENT.md)
- **Incident Response**: [security/INCIDENT_RESPONSE.md](./security/INCIDENT_RESPONSE.md)
- **Security Architecture**: [security/ARCHITECTURE.md](./security/ARCHITECTURE.md)
- **Public Keys**: [KEYS.txt](./KEYS.txt)

---

## ⚖️ Legal

By reporting security vulnerabilities to this project, you agree to:
- Allow us a reasonable time to investigate and fix the issue
- Not publicly disclose the vulnerability until we've released a fix
- Not exploit the vulnerability for malicious purposes

We commit to:
- Acknowledge your report within 48 hours
- Keep you informed of our progress
- Credit you for your discovery (unless you prefer anonymity)
- Not pursue legal action against good-faith security researchers

---

**Last Updated**: 2025-11-06
**Version**: 1.0.0

For questions about this policy, contact: security@imboard.ai