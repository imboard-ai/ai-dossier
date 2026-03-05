# Dossier Security: Current Status & Roadmap

**Last Updated**: 2025-11-07
**Current Status**: MCP Server Available, Enforcement In Development

---

## 🎯 Executive Summary

**Current Reality**: The dossier security model (checksums + signatures) provides strong cryptographic verification **when used**, but automatic enforcement is not yet available in all environments.

**What Works Today**:
- ✅ MCP server provides verification tools
- ✅ Manual verification is reliable
- ✅ Protocol defines security requirements
- ✅ Examples demonstrate the model

**Current Gap**:
- ⚠️ LLMs don't automatically enforce verification
- ⚠️ Users can bypass security checks
- ⚠️ No mandatory verification layer

**The Path Forward**: Build enforcement tooling and advocate for platform support.

---

## 1. Acknowledging the Gap

### What We Built

**MCP Server** (`@ai-dossier/mcp-server`):
- ✅ `verify_dossier()` - Verifies checksums and signatures
- ✅ `read_dossier()` - Reads with automatic verification
- ✅ `list_dossiers()` - Discovers dossiers
- ✅ Resources for protocol/security docs

**Protocol** (PROTOCOL.md):
- ✅ Defines security verification requirements
- ✅ Specifies checksum validation steps
- ✅ Documents signature verification process

**Documentation**:
- ✅ Security model explained
- ✅ Examples provided
- ✅ Best practices documented

### The Gap

**What's Missing**: **Automatic Enforcement**

LLMs with MCP server can verify dossiers, but:
- ❌ **Not automatic** - LLM must explicitly call verify_dossier()
- ❌ **Not mandatory** - LLM can skip verification
- ❌ **Not guaranteed** - Depends on LLM behavior

**Real-World Behavior**:
```
User: "run https://example.com/dossier.ds.md"

What happens:
1. LLM fetches dossier
2. LLM MIGHT call verify_dossier() (if it remembers)
3. Or LLM MIGHT just execute (if it doesn't)
4. No enforcement mechanism
```

**Why This Happens**:
- LLMs optimize for helpfulness, not security
- No built-in hooks for mandatory verification
- Protocol is advisory, not enforced
- MCP tools are passive (must be called)

### Our Mistake

**We documented the security model as if it was enforceable through LLM instructions alone.**

That was wrong. Security cannot be delegated to LLMs - it must be enforced by code.

**We should have been clearer from the start**:
- MCP server is a **tool**, not an **enforcement mechanism**
- Protocol is a **standard**, not a **guarantee**
- Verification is **possible**, not **automatic**

---

## 2. Our Vision for the Future

### Short-Term (3-6 months)

**Command-Line Tool**: `ai-dossier verify`
```bash
# Verify before executing
ai-dossier verify https://example.com/dossier.ds.md
# Exit code 0 = safe, 1 = unsafe

# Verify and run (enforces verification)
ai-dossier verify --run https://example.com/dossier.ds.md
```

**Platform Support**: Advocate for native dossier support in:
- Claude Code
- Cursor
- Continue
- Aider
- Other LLM coding tools

**Community Wrappers**: Templates and examples for custom enforcement.

### Medium-Term (6-12 months)

**Native Platform Integration**:

**Ideal flow**:
```
User: "run dossier://examples/deploy-to-aws"

Platform:
1. Recognizes dossier:// protocol
2. Fetches dossier
3. ENFORCES verification (code-level, not LLM)
4. Blocks if verification fails
5. Passes to LLM only if verified
```

**MCP Protocol Enhancement**:
```json
{
  "capabilities": {
    "beforeFileRead": {
      "patterns": ["*.ds.md"],
      "handler": "verify_before_read"
    }
  }
}
```

This would let MCP servers intercept file access and enforce verification.

### Long-Term (12+ months)

**Universal Dossier Runtime**:
- Standard across all LLM tools
- Built-in verification enforcement
- Signature verification by default
- Trust management UI
- Automatic updates for security

**Registry Integration**:
- Central registry of trusted dossiers
- Automatic signature verification
- Reputation system
- Version pinning with security updates

**Certification Program**:
- Certified dossiers (security audited)
- Trust levels (community, verified, certified)
- Automatic trust decisions

---

## 3. What We're Providing Today

### Command-Line Tool: `ai-dossier verify`

**Install**:
```bash
npm install -g @ai-dossier/cli
```

**Usage**:
```bash
# Verify a dossier (exit 0 = safe, 1 = unsafe)
ai-dossier verify path/to/dossier.ds.md
ai-dossier verify https://example.com/dossier.ds.md

# Verify and display report
ai-dossier verify --verbose path/to/dossier.ds.md

# Verify and run (enforces verification)
ai-dossier verify --run path/to/dossier.ds.md

# Pass to your LLM tool only if verification passes
ai-dossier verify https://example.com/dossier.ds.md && \
  claude-code "run $(ai-dossier verify --output-path)"
```

**What it does**:
1. ✅ Downloads dossier (if URL)
2. ✅ Verifies checksum (ENFORCED)
3. ✅ Verifies signature (ENFORCED)
4. ✅ Checks trusted keys
5. ✅ Returns exit code (0 = safe, 1 = unsafe)
6. ✅ Optionally executes (only if verified)

**Platform Integration**:

**Claude Code**:
```bash
# Add to your shell profile
claude-run-dossier() {
  ai-dossier verify "$1" && claude-code "run $1"
}

# Then use:
claude-run-dossier https://example.com/dossier.ds.md
```

**Cursor**:
```bash
cursor-run-dossier() {
  ai-dossier verify "$1" && cursor "run $1"
}
```

**Any LLM Tool**:
```bash
safe-run-dossier() {
  local url="$1"
  local tool="${2:-claude-code}"  # Default to claude-code

  if ai-dossier verify "$url"; then
    "$tool" "run $url"
  else
    echo "❌ Security verification failed. Dossier not executed."
    return 1
  fi
}
```

### Manual Verification Script

**For users without npm**:

```bash
#!/bin/bash
# verify-dossier.sh - Manual verification wrapper

set -e

DOSSIER_URL="$1"
TEMP_FILE=$(mktemp)

# Download
curl -fsSL "$DOSSIER_URL" > "$TEMP_FILE"

# Extract declared checksum
DECLARED_HASH=$(grep -A 2 '"checksum"' "$TEMP_FILE" | \
  grep '"hash"' | cut -d'"' -f4)

# Calculate actual checksum (everything after frontmatter)
ACTUAL_HASH=$(awk '/^---$/{if(++count==2){flag=1;next}}flag' "$TEMP_FILE" | \
  shasum -a 256 | cut -d' ' -f1)

# Compare
if [ "$DECLARED_HASH" != "$ACTUAL_HASH" ]; then
  echo "❌ SECURITY ALERT: Checksum verification FAILED"
  echo "   Declared: $DECLARED_HASH"
  echo "   Actual:   $ACTUAL_HASH"
  rm "$TEMP_FILE"
  exit 1
fi

echo "✅ Checksum verified"

# Check for signature
if grep -q '"signature"' "$TEMP_FILE"; then
  echo "⚠️  Signature present but not verified (manual check required)"
  echo "   Use: node tools/verify-dossier.js $TEMP_FILE"
else
  echo "⚠️  No signature (dossier is unsigned)"
fi

# If we got here, checksum passed
echo "✅ Dossier passed integrity check"
echo "   Saved to: $TEMP_FILE"
echo ""
echo "You can now run: your-llm-tool 'run $TEMP_FILE'"

rm "$TEMP_FILE"
exit 0
```

**Usage**:
```bash
chmod +x verify-dossier.sh
./verify-dossier.sh https://example.com/dossier.ds.md
```

---

## 4. Adoption Path & Platform Support

### How Security Improves with Adoption

As the dossier standard gains adoption, security enforcement will improve through multiple layers:

#### Layer 1: Protocol Adoption (Today)
- ✅ Protocol defines verification requirements
- ✅ MCP server provides tools
- ⚠️ Users must remember to verify

**Security Level**: Low (manual, optional)

#### Layer 2: Tooling Adoption (3-6 months)
- ✅ `ai-dossier verify` CLI enforces verification
- ✅ Shell wrappers provide convenience
- ✅ Community shares best practices

**Security Level**: Medium (available, opt-in)

#### Layer 3: Platform Integration (6-12 months)
- ✅ LLM tools recognize `.ds.md` files
- ✅ Built-in verification before execution
- ✅ UI shows security status
- ✅ Users can manage trusted keys

**Security Level**: High (automatic for supporting platforms)

#### Layer 4: Universal Standard (12+ months)
- ✅ All major LLM tools support dossiers natively
- ✅ Verification is mandatory by default
- ✅ Central registry with automatic updates
- ✅ Certification and audit programs

**Security Level**: Very High (ubiquitous, enforced)

### Similar Adoption Patterns

**This follows proven security adoption paths**:

| Standard | Initial | Tooling | Platform | Universal |
|----------|---------|---------|----------|-----------|
| **HTTPS** | Manual (1994) | Cert tools (1996) | Browser warnings (2000) | Default (2018) |
| **NPM Audit** | Manual (2013) | npm audit (2018) | CI integration (2019) | Auto-fix (2020) |
| **MCP** | Spec (2024) | Servers (2024) | Claude Desktop (2024) | Expanding (2025) |
| **Dossier** | Protocol (2025) | CLI tool (2025) | TBD (2025-26) | TBD (2026+) |

**Key insight**: Security starts as optional best practice, becomes standard through tooling, then enforced by platforms.

### Advocacy & Platform Engagement

**We're actively working with**:
- **Claude Code team** - Native dossier support
- **Cursor team** - Integration discussions
- **MCP community** - Pre-execution hooks proposal
- **Community** - Wrapper scripts and best practices

**You can help**:
1. ⭐ Star the repository - Shows demand
2. 📣 Share your use cases - Demonstrates value
3. 🗣️ Advocate to your tool vendor - Request native support
4. 🛠️ Build wrappers - Share with community
5. 📝 Write about it - Spread awareness

---

## 5. Interim Security Guidance

### Until Automatic Enforcement is Available

**Current Reality**: You must be proactive about security.

#### Option 1: Trust Source, Verify Once (Recommended for Known Sources)

**For dossiers from trusted repositories** (like official examples):

```bash
# 1. Verify the dossier once
ai-dossier verify https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/devops/deploy-to-aws.ds.md

# 2. If it passes, you can use it
claude-code "run https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/devops/deploy-to-aws.ds.md"

# 3. Re-verify if content changes
```

**Trust model**:
- ✅ Official dossier repository (imboard-ai/ai-dossier)
- ✅ Signed by known authors (check KEYS.txt)
- ✅ Verified once, then trust until updates

#### Option 2: Always Verify (Recommended for Unknown Sources)

**For dossiers from unknown or untrusted sources**:

```bash
# ALWAYS use the wrapper
safe-run-dossier https://example.com/unknown-dossier.ds.md
```

**Never skip verification for**:
- ❌ Dossiers from unknown authors
- ❌ Unsigned dossiers
- ❌ Modified dossiers (checksum changed)
- ❌ High-risk dossiers (database, production, credentials)

#### Option 3: Manual Review (Highest Security)

**For critical operations**:

```bash
# 1. Download
curl https://example.com/dossier.ds.md > /tmp/dossier.ds.md

# 2. Verify
ai-dossier verify /tmp/dossier.ds.md

# 3. Read the code manually
less /tmp/dossier.ds.md

# 4. Only run if you understand what it does
claude-code "run /tmp/dossier.ds.md"
```

**When to do this**:
- Critical production operations
- High-risk changes (database, cloud resources)
- First time using a new dossier
- Learning how dossiers work

### Security Decision Tree

```
New dossier to run?
│
├─ From official repository (imboard-ai/ai-dossier)?
│  │
│  ├─ YES → Verify once, then trust
│  │         (re-verify on updates)
│  │
│  └─ NO → Continue below
│
├─ Signed by known, trusted author?
│  │
│  ├─ YES → Verify signature, then trust
│  │
│  └─ NO → Continue below
│
├─ High risk operation?
│  │  (database, production, credentials)
│  │
│  ├─ YES → Manual review required
│  │         Don't execute without understanding
│  │
│  └─ NO → Verify checksum minimum
│           (unsigned is OK for low-risk)
│
└─ When in doubt → Don't execute
                    Ask for help or clarification
```

### Risk Tolerance Levels

**Conservative** (Recommended for Production):
- ✅ Only use signed dossiers
- ✅ Only trust known authors (KEYS.txt)
- ✅ Always verify before execution
- ✅ Manual review for high-risk operations

**Moderate** (Recommended for Development):
- ✅ Verify checksums always
- ⚠️ Unsigned OK for low-risk operations
- ✅ Trust official repository
- ✅ Verify on first use, trust thereafter

**Aggressive** (⚠️ Not Recommended):
- ⚠️ Skip verification for "safe-looking" dossiers
- ⚠️ Trust without verifying
- ❌ Run directly from URLs
- ❌ Ignore security warnings

**Your risk tolerance should match your use case**:
- Production systems → Conservative
- Personal projects → Moderate
- Experiments/learning → Moderate (still verify!)
- Never → Aggressive

---

## 6. FAQ

### Q: Is the security model broken?

**A**: No, the model is sound. Checksums and signatures provide strong verification. What's missing is **automatic enforcement** in all tools.

### Q: Should I use dossiers today?

**A**: Yes, if you:
- ✅ Verify before execution (using tools provided)
- ✅ Use dossiers from trusted sources
- ✅ Understand the security model
- ✅ Accept that enforcement isn't automatic yet

### Q: Can I trust the official examples?

**A**: Yes, official examples from `imboard-ai/ai-dossier` are safe:
- ✅ Maintained by core team
- ✅ Code-reviewed
- ✅ Have valid checksums
- ✅ Some are signed

But still verify them using `ai-dossier verify` to build good habits.

### Q: What if my LLM tool doesn't have MCP support?

**A**: Use the command-line `ai-dossier verify` tool:
```bash
ai-dossier verify URL && your-tool "run URL"
```

This works with ANY LLM tool.

### Q: How do I know which keys to trust?

**A**: Check [KEYS.txt](./KEYS.txt) for official keys. For community dossiers, verify the author's identity through:
- Their website
- GitHub profile
- Social media
- Direct communication

### Q: Will automatic enforcement ever be available?

**A**: Yes. We're working toward it through:
1. CLI tooling (available soon)
2. Platform advocacy (in progress)
3. MCP protocol enhancements (proposed)
4. Community wrappers (available)

Timeline: 6-12 months for major platform support.

### Q: What should I tell my team?

**A**: Be honest:
- ✅ Dossiers are powerful for automation
- ⚠️ Security requires active verification
- ✅ Tools are available (`ai-dossier verify`)
- ⚠️ Automatic enforcement coming later
- ✅ Use trusted sources in the meantime

---

## 7. Current Recommendations

### For Individual Users

**Today**:
1. Install `ai-dossier` CLI (when available)
2. Always verify before execution
3. Use official examples to learn
4. Build verification into your workflow

**This Week**:
1. Set up shell wrapper functions
2. Add verification to your process
3. Share knowledge with others

**This Month**:
1. Create custom dossiers for your workflows
2. Sign your dossiers
3. Contribute improvements

### For Teams & Organizations

**Immediate**:
1. ✅ Establish policy: "Always verify dossiers"
2. ✅ Use only trusted sources initially
3. ✅ Train team on verification process
4. ✅ Set up `ai-dossier verify` for all developers

**Short-term (1-3 months)**:
1. ✅ Create organization-specific trusted keys list
2. ✅ Build custom wrappers for your tools
3. ✅ Develop internal dossier library
4. ✅ Security review for any external dossiers

**Medium-term (3-6 months)**:
1. ✅ Contribute to enforcement tooling
2. ✅ Advocate for native support in your tools
3. ✅ Share best practices with community
4. ✅ Build automation around verification

### For Dossier Authors

**Always**:
1. ✅ Sign your dossiers with your key
2. ✅ Publish your public key prominently
3. ✅ Update checksums after any change
4. ✅ Document risk levels honestly
5. ✅ Test dossiers before publishing

**Best Practices**:
1. ✅ Use semantic versioning
2. ✅ Maintain CHANGELOG
3. ✅ Provide verification instructions
4. ✅ Link to your public key
5. ✅ Respond to security reports promptly

---

## 8. Transparency Commitment

We commit to:

1. **Honesty**: Acknowledge limitations clearly
2. **Progress**: Regular updates on enforcement development
3. **Safety**: Never oversell security capabilities
4. **Community**: Listen to feedback and concerns
5. **Evolution**: Improve security as we learn

**This document will be updated** as:
- Tooling is released
- Platforms add support
- Community provides feedback
- Security model evolves

---

## 9. Get Involved

### Report Issues

**Security vulnerabilities**: security@imboard.ai (private)
**Bugs or improvements**: https://github.com/imboard-ai/ai-dossier/issues (public)

### Contribute

**Tooling**: Help build `ai-dossier` CLI
**Documentation**: Improve security guidance
**Advocacy**: Request support from your tool vendor
**Wrappers**: Share your enforcement scripts

### Stay Updated

- **GitHub**: Watch the repository for updates
- **Discussions**: Join community conversations
- **Newsletter**: [Coming soon] Security updates

---

## Summary

**Where We Are**:
- ✅ Security model designed (checksums + signatures)
- ✅ MCP server provides tools
- ✅ Documentation and examples available
- ⚠️ Automatic enforcement not yet available

**Where We're Going**:
- 🔨 CLI tool for verification
- 🤝 Platform advocacy and integration
- 🔒 Universal automatic enforcement
- 🌐 Registry and trust infrastructure

**What You Should Do**:
- ✅ Use `ai-dossier verify` when available
- ✅ Verify before execution
- ✅ Trust known sources
- ✅ Stay informed about updates

**The Bottom Line**:
Dossier security is **real and effective when used**, but **not yet automatic everywhere**. Use the tools provided, follow best practices, and help us build toward universal enforcement.

---

**Thank you for taking security seriously and helping us build a safer automation ecosystem.**

🔒 Security is a journey, not a destination. Let's travel it together.
