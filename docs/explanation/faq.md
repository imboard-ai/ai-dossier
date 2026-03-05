# Frequently Asked Questions

## Table of Contents
- [Understanding Dossiers](#understanding-dossiers)
- [Dossiers vs. Alternatives](#dossiers-vs-alternatives)
- [Protocol & Governance](#protocol--governance)
- [Security & Trust](#security--trust)
- [Technical Concerns](#technical-concerns) (file extensions, `---dossier` delimiter, determinism)
- [Practical Usage](#practical-usage)

---

## Understanding Dossiers

### What exactly is a dossier?

A dossier is a structured instruction set (in markdown format) that an LLM agent can execute to automate complex workflows. Think of it as a recipe that tells an AI how to accomplish a multi-step task, complete with validation steps, prerequisites, and success criteria.

**Key difference from other approaches**: Dossiers combine human-readable instructions with machine-readable metadata (via JSON frontmatter), making them both documentation AND executable automation.

### Who needs dossiers? Can't LLMs just work from natural language?

**The objection**: LLMs are powerful precisely because they understand natural language. Why add structure?

**The reality**: LLMs work BETTER with structure. Here's what happens without it:

**❌ Without Structure (ad-hoc prompts)**:
```
You: "Deploy the app to production with zero downtime"
LLM: "Sure! Should I use blue-green deployment or rolling updates?"
You: "Um... which is better?"
LLM: "It depends on your setup. Do you have health checks configured?"
You: "I don't know. What should they check?"
```
*Result: 10+ back-and-forth messages, inconsistent results, forgotten steps*

**✅ With Dossiers**:
```yaml
name: "Zero-Downtime Production Deploy"
prerequisites:
  - Health check endpoint at /health
  - Load balancer configured
  - Rollback plan documented
context:
  - deployment_strategy: "blue-green"
  - health_check_timeout: "30s"
validation:
  - "New version responds to health checks"
  - "Traffic gradually shifted to new version"
  - "Old version remains available for rollback"
```
*Result: Consistent execution, validated steps, clear requirements*

**Why structure matters**:
1. **Zero ambiguity**: The LLM doesn't have to guess your infrastructure setup
2. **Validated prerequisites**: Catch missing requirements BEFORE execution
3. **Consistent results**: Same dossier = same approach across team members
4. **Token efficiency**: LLM doesn't waste tokens figuring out structure
5. **Improvement over time**: Each execution refines the instructions

**Analogy**: You could tell a contractor "build me a house" (natural language), but architects use blueprints (structured plans) because structure ensures nothing is forgotten and everyone interprets the plan identically.

---

## Dossiers vs. Alternatives

### How are dossiers different from AGENTS.md files?

**The objection**: "My project already has an AGENTS.md file with instructions for AI. Why do I need dossiers?"

**Great question!** AGENTS.md files are a valuable pattern, and dossiers build on that concept. Here's the evolution:

#### The AGENTS.md Pattern (Informal Agent Instructions)

Many projects create files like:
- `AGENTS.md` - General instructions for AI assistants
- `.cursorrules` - IDE-specific agent guidance
- `.claude.md` - LLM-specific instructions

**This works for project-level context**, but has limitations for specific workflows:

**❌ What breaks without structure**:

**Example: "Migrate Database" instructions in AGENTS.md**
```markdown
## Database Migration
When migrating the database:
- Create a backup first
- Run the migration script
- Test on staging
- If it works, deploy to prod
```

**Problems**:
1. **No validation**: LLM can't verify backup actually happened
2. **No versioning**: How does LLM know if these instructions are current?
3. **No security**: Was this modified maliciously? No way to verify.
4. **No composition**: Can't reference this from other workflows
5. **No tooling**: CLI can't validate syntax or check prerequisites
6. **Interpretation variance**: GPT-4 vs Claude might interpret differently

**❌ Real failure mode**:
```
Developer: "Migrate the database using AGENTS.md instructions"
Claude: *Creates backup to /tmp (gets deleted on reboot)*
Claude: *Runs migration*
Claude: *"Testing on staging..." but no validation step defined*
Claude: "Looks good! Deploying to prod..."
Production: *Migration breaks due to missed edge case*
Developer: "Where's the backup?"
System: *Backup was in /tmp, now gone*
```

#### The Dossier Approach (Structured Protocol)

**✅ Same workflow as dossier**:
```yaml
---
name: "Database Migration with Safety Checks"
version: "1.2.0"
schema_version: "1.0.0"
checksum: "sha256:a3f2c..."

prerequisites:
  - Database credentials with migration privileges
  - Backup storage with >50GB free space
  - Staging environment available

context:
  backup_location: "/var/backups/db"
  backup_retention: "30 days"
  staging_url: "staging.example.com"

validation:
  - name: "Backup created"
    check: "Backup file exists and size > 1MB"
  - name: "Migration successful"
    check: "Migration script exit code = 0"
  - name: "Staging tests pass"
    check: "All integration tests return green"

rollback:
  - "If validation fails, restore from backup"
  - "Document failure reason in incident log"
---

# Instructions
[Detailed markdown instructions here...]
```

**What you gain**:

| Feature | AGENTS.md | Dossier Protocol |
|---------|-----------|------------------|
| Human-readable instructions | ✅ Yes | ✅ Yes |
| Machine-readable metadata | ❌ No | ✅ Yes (JSON frontmatter) |
| Validation before execution | ❌ No | ✅ Yes (schema validation) |
| Integrity verification | ❌ No | ✅ Yes (checksums) |
| Author verification | ❌ No | ✅ Yes (signatures) |
| Version compatibility | ❌ Informal | ✅ Semantic versioning |
| Composition/chaining | ❌ Ad-hoc | ✅ Structured relationships |
| Tooling support (CLI, IDE) | ❌ No | ✅ Yes |
| Deterministic parsing | ❌ No (LLM interprets) | ✅ Yes (schema-defined) |
| Risk assessment | ❌ No | ✅ Yes (risk metadata) |
| Improvement protocol | ❌ No | ✅ Yes (built-in) |
| Works across all LLMs | ⚠️ Variable | ✅ Consistent |

**Key insight**: AGENTS.md and dossiers serve DIFFERENT purposes:
- **AGENTS.md**: Project-level context, coding standards, architecture overview
- **Dossiers**: Specific executable workflows with validation and security

**They're complementary, not replacements**. Use both:
- AGENTS.md tells the LLM about your project
- Dossiers tell the LLM HOW to execute specific tasks safely

**Migration path**: Convert critical workflows from AGENTS.md into dossiers while keeping AGENTS.md for project context.

---

### How portable are dossiers across different projects?

**The question**: "Can I reuse the same dossier across multiple projects, or do I need project-specific versions?"

**Short answer**: Dossiers are **operation-specific, not project-specific** — this is a key differentiator from AGENTS.md.

#### What This Means

**AGENTS.md** = Project context (stays with one project)
- "Here's how OUR codebase is structured"
- "Here are OUR naming conventions"
- Tied to a specific repository

**Dossiers** = Portable workflows (work across projects)
- "Here's how to deploy a Node.js app"
- "Here's how to run security checks"
- Work with ANY project that matches the operation

#### Real Examples

**Example 1: Deployment Dossier**
```markdown
# dossier: deploy-nodejs-app
objective: Deploy a Node.js application to production
```

This dossier works with:
- ✅ Your e-commerce API
- ✅ Your microservices backend
- ✅ Your colleague's SaaS app
- ✅ Any Node.js project with npm scripts

**Example 2: Security Audit Dossier**
```markdown
# dossier: security-audit
objective: Run security checks on dependencies and code
```

This dossier works with:
- ✅ Python projects
- ✅ JavaScript projects
- ✅ Any project with dependency files

#### When Customization Is Needed

**Most dossiers are portable**. Customize when:
1. **Stack-specific details**: Using a specific framework/tool
2. **Organization standards**: Your company's specific workflows
3. **Environment-specific**: Particular cloud provider/infrastructure

**Solution**: Use dossier **variants** or **parameters**:
```markdown
# dossier: deploy-nodejs-app
parameters:
  - platform: [aws, gcp, azure]
  - environment: [staging, production]
```

#### The Power of Portability

Because dossiers are portable:
- 📦 **Share across your organization**: Same deployment workflow for all teams
- 🌐 **Build community libraries**: Contribute to ecosystem of reusable dossiers
- 🚀 **Onboard faster**: New projects start with proven workflows
- 🔄 **Improve once, benefit everywhere**: Update affects all projects using it

**Key insight**: Unlike project-specific context files, dossiers describe HOW to do something, not WHAT your project is. This makes them naturally reusable.

---

### How do I share dossiers with my team/community?

**The question**: "What's the best way to distribute dossiers to my team, other projects, or the open-source community?"

**Short answer**: Dossiers are built for sharing. Because they're protocol-based plain text, share them like code.

#### Sharing Scenarios

**1. Team Collaboration** (within your organization)

**Git Repository** (recommended):
```bash
# Central dossiers repo for your organization
my-company/
  dossiers/
    deployment/
      deploy-api.ds.md
      deploy-frontend.ds.md
    security/
      audit-dependencies.ds.md
```

**Benefits**:
- ✅ Version control for dossiers
- ✅ Pull requests for improvements
- ✅ Team can contribute updates
- ✅ Track what works

**Shared Network Location**:
```bash
# Point your team to a shared directory
/shared/team-dossiers/
```

---

**2. Cross-Project Reuse** (your own multiple projects)

**Approach 1: Git Submodule**
```bash
# In each project
git submodule add https://github.com/you/shared-dossiers .dossiers
```

**Approach 2: Registry Pattern** (see [examples/sample-implementation/dossiers-registry.md](./examples/sample-implementation/dossiers-registry.md))
```markdown
# In your project's dossiers-registry.md
## Deployment
- [Deploy Node.js App](https://github.com/you/dossiers/deploy-nodejs.ds.md)
- [Database Migration](https://github.com/you/dossiers/db-migrate.ds.md)
```

---

**3. Community/Ecosystem** (open source)

**GitHub Repository** (standard pattern):
```bash
awesome-dossiers/
  README.md          # Gallery of dossiers
  nodejs/
    deploy.ds.md
    test.ds.md
  python/
    django-deploy.ds.md
  devops/
    k8s-deploy.ds.md
```

**NPM Package** (for Node.js ecosystem):
```bash
npm install @your-org/dossiers
# Dossiers available in node_modules/@your-org/dossiers/
```

**Direct URLs**:
```bash
# LLMs can fetch directly
https://raw.githubusercontent.com/you/dossiers/main/deploy.ds.md
```

---

#### Why Sharing Works So Well

**Protocol-based design** means:
- ✅ **No dependencies**: Just Markdown files
- ✅ **No vendor lock-in**: Works with any LLM environment
- ✅ **No installation**: Copy file and run
- ✅ **Trust system**: Signatures and checksums travel with the dossier
- ✅ **Version compatibility**: Semantic versioning ensures compatibility

**Example workflow**:
1. Alice writes `deploy-api.ds.md` for her project
2. Commits to company's dossiers repo
3. Bob clones repo to his project
4. His LLM reads the dossier
5. **It just works** — no setup, no configuration

---

#### Security Considerations When Sharing

**From trusted sources**:
- ✅ Review dossier content before using
- ✅ Check signatures if available
- ✅ Verify checksums for critical operations
- ✅ Start with low-risk dossiers (read-only operations)

**From community**:
- ⚠️ Treat like code: review before executing
- ✅ Use verification tools: `ai-dossier verify`
- ✅ Test in safe environments first
- ✅ Check dossier metadata (risk level, author)

**See [security/README.md](./security/README.md) for comprehensive security guidance.**

---

#### Getting Started with Sharing

**Quick start**:
1. **Create a dossiers directory** in your project or organization
2. **Add your first reusable dossier** (deployment, testing, etc.)
3. **Document in a registry file** (see examples)
4. **Share the location** with your team
5. **Iterate based on feedback**

**Community contribution**:
- Open PRs to improve existing dossiers
- Share your specialized workflows
- Build domain-specific dossier collections (ML, DevOps, etc.)

**Remember**: Every dossier you share makes the entire ecosystem stronger. Think of it like sharing Dockerfiles or GitHub Actions — you're contributing to a library of proven workflows.

---

### How do dossiers compare to scripts (bash/Python/etc.)?

See the comprehensive comparison table in the [main README](README.md#dossiers-vs-scripts-when-to-use-each).

**TL;DR**:
- **Scripts**: Fast, deterministic, brittle (must handle every edge case in code)
- **Dossiers**: Adaptive, context-aware, handles novel situations intelligently

**Use scripts when**: You need speed, determinism, no decisions required
**Use dossiers when**: You need adaptability, decisions, context awareness

**They're not mutually exclusive**: Dossiers can call scripts for deterministic steps!

---

### What about CI/CD tools like GitHub Actions or Jenkins?

**The objection**: "We already have GitHub Actions for automation. Why dossiers?"

**Key difference**: **Fixed vs. Adaptive Automation**

#### CI/CD Tools (Fixed Automation)
```yaml
# GitHub Actions workflow
- name: Deploy
  run: |
    npm build
    npm test
    deploy.sh
```

**Characteristics**:
- ✅ Runs on events (push, PR, schedule)
- ✅ Fast, deterministic execution
- ✅ Great for repetitive pipelines
- ❌ Cannot adapt to novel situations
- ❌ Requires coding all edge cases
- ❌ Brittle when requirements change

**❌ What breaks**:
```
Scenario: "Deploy fails because new environment variable is required"
GitHub Actions: *Fails, requires developer to add env var to config file*
Developer: *Must commit config change, wait for next run*
```

#### Dossiers (Adaptive Automation)

```yaml
name: "Adaptive Deployment"
context:
  - Check environment configuration
  - Verify all required variables exist
  - If missing, check documentation for defaults
  - Prompt developer if ambiguous
```

**Characteristics**:
- ✅ LLM can make context-aware decisions
- ✅ Adapts to novel situations
- ✅ Can read docs, logs, error messages
- ✅ Explains reasoning to developer
- ❌ Slower (LLM overhead)
- ❌ Non-deterministic execution path

**✅ What works**:
```
Scenario: "Deploy fails because new environment variable required"
Dossier execution:
  1. Detects missing variable from error message
  2. Searches codebase/docs for variable name and purpose
  3. Finds default value in documentation
  4. Asks developer: "Found reference to API_TIMEOUT=30s in docs. Use this?"
  5. Sets variable and retries deploy
```

**When to use each**:

| Use Case | Best Tool | Why |
|----------|-----------|-----|
| Run tests on every commit | CI/CD | Fast, deterministic, high frequency |
| Deploy with standard process | CI/CD | Well-defined, no decisions needed |
| Investigate why tests are flaky | Dossier | Requires analysis, context awareness |
| Upgrade dependencies safely | Dossier | Needs to read changelogs, assess breaking changes |
| Generate weekly reports | CI/CD | Repetitive, fixed format |
| Debug production incident | Dossier | Novel situation, requires reasoning |

**Best practice**: Use BOTH:
- CI/CD for standard pipelines
- Dossiers for ad-hoc tasks, debugging, complex decisions
- Dossiers can even trigger CI/CD pipelines!

---

### How do dossiers compare to LangChain, CrewAI, or AutoGPT?

**The objection**: "Why not just use an agent framework like LangChain?"

**Key difference**: **Code Framework vs. Instruction Protocol**

#### Agent Frameworks (LangChain, CrewAI, etc.)
```python
# LangChain example
from langchain.agents import create_agent
from langchain.tools import Tool

agent = create_agent(
    llm=ChatOpenAI(),
    tools=[deploy_tool, test_tool],
    memory=ConversationBufferMemory()
)
agent.run("Deploy to production")
```

**Characteristics**:
- ✅ Powerful programmatic control
- ✅ Rich ecosystem of tools/integrations
- ✅ Great for building custom applications
- ❌ Requires coding expertise
- ❌ Framework lock-in (Python, JavaScript)
- ❌ Must maintain code as dependencies change

#### Dossiers (Instruction Protocol)
```yaml
# Dossier (markdown + metadata)
---
name: "Deploy to Production"
---
# Instructions
1. Run test suite
2. If tests pass, deploy...
```

**Characteristics**:
- ✅ No coding required (just markdown)
- ✅ LLM-agnostic (works with any AI)
- ✅ Human-readable documentation
- ✅ Low maintenance (no dependencies)
- ❌ Less programmatic control
- ❌ Dependent on LLM capabilities

**They're different abstraction levels**:

| Aspect | Agent Frameworks | Dossiers |
|--------|-----------------|----------|
| **Target user** | Developers | Anyone who can write docs |
| **Skill required** | Programming | Markdown writing |
| **Execution** | Framework code runs | LLM interprets instructions |
| **Maintenance** | Update code + dependencies | Update markdown |
| **Portability** | Framework-specific | Works with any LLM |

**Not mutually exclusive**: You could BUILD a dossier executor using LangChain!

**Use agent frameworks when**: Building production applications, need precise programmatic control, have engineering resources

**Use dossiers when**: Documenting workflows, sharing across teams, want LLM-agnostic automation, prefer markdown over code

---

### What about Jupyter notebooks or literate programming?

**Similar philosophy** (executable documentation) but different execution model:

| Aspect | Jupyter Notebooks | Dossiers |
|--------|------------------|----------|
| **Contains** | Code + documentation | Instructions + metadata |
| **Executed by** | Python/R interpreter | LLM agent |
| **Deterministic?** | Yes (same code = same result) | No (LLM adapts) |
| **Best for** | Data exploration, reproducible research | Adaptive automation, workflows |
| **Interactive?** | Yes (REPL style) | No (autonomous execution) |
| **Language** | Python, R, Julia, etc. | Natural language |

**Use Jupyter when**: Exploring data, reproducible research, teaching code
**Use dossiers when**: Automating workflows, adaptive tasks, cross-platform instructions

---

## Protocol & Governance

### Who controls the dossier protocol? Is this vendor lock-in?

**The objection**: "This feels like a proprietary system you invented and control."

**Answer**: **Dossiers are an OPEN PROTOCOL, not a proprietary platform.**

Think **Docker** (open container spec, commercial registry):
- ✅ Container specification: open standard
- ✅ Anyone can build containers
- ✅ Anyone can run containers (Docker, Podman, containerd)
- ✅ Docker provides commercial registry (DockerHub) but you can self-host
- ✅ Multiple implementations encouraged

**Dossier governance model**:

| Aspect | Status | Details |
|--------|--------|---------|
| **Protocol specification** | Open source | Apache 2.0 after 2028 (BSL 1.1 now) |
| **Schema definition** | Open | JSON Schema publicly documented |
| **Creating dossiers** | Free & open | Anyone can create/modify/share |
| **Executing dossiers** | Open | Any LLM can execute (Claude, GPT, Gemini) |
| **Tooling** | Open + commercial | Basic tools open source, premium services commercial |
| **Governance** | Community-driven | RFC process for protocol changes |

**What this means for you**:

✅ **No lock-in**:
- Dossiers are markdown files you own
- Stored in your repositories, not our servers
- Can execute locally or airgapped
- No external API calls required

✅ **No gatekeeping**:
- You don't need permission to create dossiers
- You don't pay us to execute dossiers
- You don't need our infrastructure to use dossiers

✅ **Multiple implementations welcome**:
- Build your own dossier executor
- Create alternative tooling
- Fork the protocol if needed

**Commercial services** (optional):
- Registry hosting (like DockerHub, but you can self-host)
- Signing key management
- Premium validation tools
- Enterprise support

**Think of it as**: Open standard (like HTTP), commercial services optional (like CDNs).

**Protocol changes**:
- Semantic versioning ensures compatibility
- Breaking changes require major version bump
- Community input via RFC process
- No unilateral changes that break existing dossiers

---

### Can I trust a protocol that one company created?

**Valid concern!** Here's how we address it:

**1. Specification is open source**
- Full protocol documented publicly
- JSON Schema publicly available
- No hidden behaviors

**2. Reference implementation is open**
- Core tools are open source
- You can audit the code
- You can fork if needed

**3. Data portability**
- Dossiers are plain markdown files
- No proprietary binary formats
- Easy to migrate if needed

**4. Multiple LLM support**
- Not locked to one AI provider
- Works with Claude, GPT, Gemini, local models
- No single point of failure

**5. Community governance**
- RFC process for significant changes
- Public discussion on protocol evolution
- Semantic versioning guarantees

**Historical precedent**: Many successful open protocols started from single companies:
- **Kubernetes**: Created by Google, now CNCF standard
- **React**: Created by Facebook, now community-driven
- **Kafka**: Created by LinkedIn, now Apache project
- **Docker**: Created by Docker Inc., now OCI standard

**Our commitment**:
- Protocol specification will remain open
- No rug-pulling (BSL converts to Apache 2.0 in 2028)
- Community input drives evolution
- Multiple implementations encouraged

**If you're still concerned**:
- Fork the protocol and create your own variant
- Self-host all infrastructure
- Use only open-source tooling
- Implement your own executor

**The protocol is a STANDARD, not a service.** You're as locked in as you are to markdown, JSON, or HTTP.

---

## Security & Trust

### How can I trust dossiers from strangers on the internet?

**The objection**: "Anyone can create a dossier. What if it's malicious?"

**Answer**: Dossiers have a **multi-layer security model** similar to code repositories:

#### Layer 1: Checksum Verification (Required)
```yaml
checksum: "sha256:a3f2c8d9..."
```

- **Prevents**: Tampering, corruption, man-in-the-middle attacks
- **Ensures**: The dossier you execute is exactly what the author published
- **How it works**: Hash of entire dossier content, verified before execution

**❌ Without checksums**:
```
Scenario: Attacker modifies "Deploy to staging" dossier to say "Deploy to production"
Result: You execute modified version unknowingly
```

**✅ With checksums**:
```
Scenario: Same attack
Result: Checksum mismatch detected, execution blocked
```

#### Layer 2: Signature Verification (Optional)
```yaml
signature:
  signer: "security-team@company.com"
  key_id: "0x1234ABCD"
  signature: "LS0tLS1CRUd..."
```

- **Prevents**: Impersonation, unauthorized modifications
- **Ensures**: Dossier comes from who you think it does
- **How it works**: PGP/GPG signatures, web of trust model

**Trust model**:
1. **Trust by signature**: Only execute dossiers signed by keys you trust
2. **Trust by review**: Read the dossier before executing (it's markdown!)
3. **Trust by source**: Official dossiers in verified registries
4. **Trust by reputation**: Community ratings and reviews

#### Layer 3: Risk Assessment Metadata
```yaml
risk: "high"  # or "low", "medium"
capabilities_required:
  - filesystem_write
  - network_access
  - environment_variables
```

- **Prevents**: Accidental execution of high-risk dossiers
- **Ensures**: You understand what the dossier can access
- **How it works**: Explicit declaration of required permissions

**Security checklist before executing unknown dossiers**:
1. ✅ Verify checksum matches
2. ✅ Check signature from trusted key
3. ✅ Read the instructions (it's markdown!)
4. ✅ Review risk level and capabilities
5. ✅ Test in non-production environment first
6. ✅ Check community reviews if using registry

**Compared to running random scripts from the internet**:
- ❌ Shell script: Often obfuscated, hard to audit, no verification
- ✅ Dossier: Human-readable, checksum verified, signature optional, risk metadata

**Remember**: The LLM runs in YOUR environment with YOUR permissions. Same risk as running any code, but dossiers are MORE auditable because they're readable instructions, not compiled binaries.

---

### What if a dossier contains malicious instructions?

**Scenario**: "A dossier says 'delete all files in /var/www' but claims to be a backup tool."

**Protections**:

**1. Readability** (Best defense)
```yaml
---
name: "Backup Website"  # Misleading name
risk: "high"  # Red flag
---

# Instructions
1. Delete all files in /var/www  ⚠️ VISIBLE IN PLAINTEXT
2. ...
```

**Unlike obfuscated code**, dossiers are HUMAN-READABLE. You can see exactly what they instruct the LLM to do.

**2. Risk metadata**
```yaml
risk: "high"
capabilities_required:
  - filesystem_write: "/var/www"  # Makes it obvious
```

**3. LLM safety guardrails**
- Modern LLMs have built-in safety checks
- Will question destructive commands
- May refuse obviously malicious instructions

**4. Validation steps**
```yaml
validation:
  - name: "Backup created"
    check: "Backup file exists at /backups/website.tar.gz"
```
If validation doesn't match the stated goal, red flag!

**5. Community reporting**
- Registries can flag malicious dossiers
- Community reviews warn others
- Signature revocation for bad actors

**Best practices**:
- ⚠️ Never execute dossiers blindly
- ✅ Read the instructions before running
- ✅ Test in safe environment first
- ✅ Only trust signed dossiers from known authors
- ✅ Check community reviews
- ✅ Use risk metadata as a guide

**Comparison**: This is MORE secure than running shell scripts from GitHub where code can be obfuscated or binary executables where you can't see what they do.

---

### What about compliance and audit requirements?

**The objection**: "My company needs to audit every change. How do dossiers help?"

**Answer**: Dossiers are MORE auditable than traditional automation:

#### Audit Trail Benefits

**1. Version control friendly**
```bash
git log database-migration.dossier.md
# See full history of instruction changes
git diff v1.0.0 v2.0.0
# See exact changes between versions
```

**2. Checksum verification**
```yaml
checksum: "sha256:a3f2c..."
# Tamper-evident: any change breaks checksum
```

**3. Signature chain**
```yaml
signature:
  signer: "senior-dba@company.com"
  timestamp: "2025-01-07T10:30:00Z"
# Cryptographic proof of who approved
```

**4. Execution logging**
```json
{
  "dossier": "database-migration.dossier.md",
  "version": "1.2.0",
  "checksum": "sha256:a3f2c...",
  "executed_by": "deploy-bot",
  "timestamp": "2025-01-07T14:45:00Z",
  "result": "success",
  "validation_steps": [...]
}
```

**5. Human-readable instructions**
- Auditors can READ what was executed (it's markdown!)
- No need to reverse-engineer compiled code
- Clear intent documented inline

#### Compliance Scenarios

**SOC 2 / ISO 27001**:
- ✅ Change control: Git history + signatures
- ✅ Access control: Signature verification enforces approval
- ✅ Audit trail: Execution logs with checksums
- ✅ Segregation of duties: Author ≠ Signer ≠ Executor

**HIPAA / Healthcare**:
- ✅ PHI handling procedures documented in dossier
- ✅ Risk assessment metadata indicates data sensitivity
- ✅ Validation steps ensure compliance requirements met
- ✅ Immutable audit trail (checksums prevent post-hoc tampering)

**Financial (SOX, PCI-DSS)**:
- ✅ Production change approval: Signature required
- ✅ Change documentation: Instructions are the documentation
- ✅ Rollback procedures: Documented in dossier
- ✅ Evidence retention: Git history provides years of records

**Comparison to traditional scripts**:

| Audit Requirement | Traditional Script | Dossier |
|-------------------|-------------------|---------|
| What ran? | Reverse-engineer code | Read markdown instructions |
| Who approved? | Git commit author | Cryptographic signature |
| Was it modified? | Git hash (code level) | Checksum + signature |
| Why did it run? | Code comments (maybe) | Documented purpose/context |
| What can it access? | Analyze code | Risk metadata explicit |

---

## Technical Concerns

### What do the `.ds.md` and `.dsw.md` file extensions mean?

Dossier files use two extensions:

| Extension | Purpose | Mutable? | Verified? |
|-----------|---------|----------|-----------|
| `.ds.md` | **Dossier** — immutable instructions | No | Yes (checksums + signatures) |
| `.dsw.md` | **Working file** — mutable execution state | Yes | No |

**`.ds.md` (Dossier files)** contain the instructions, metadata, and validation criteria. They are checksummed and optionally signed. Their content should not change during execution.

**`.dsw.md` (Working files)** track execution state: progress, context gathered, decisions made, and action logs. They are mutable and intentionally outside the security boundary. See the [working files example](../../examples/working-files/) for the full pattern.

**Why not just `.md`?** The `.ds.md` extension makes dossiers discoverable by tooling (CLI, MCP server, IDE plugins) without needing to parse every markdown file in a project.

### Why does the frontmatter use `---dossier` instead of `---`?

Standard YAML frontmatter uses `---` as its delimiter. Dossier frontmatter uses `---dossier` intentionally:

1. **Disambiguation** — Tools like Jekyll, Hugo, and VS Code treat `---` as YAML frontmatter. Since dossier frontmatter contains **JSON** (not YAML), using `---` would cause parsing errors or incorrect syntax highlighting in many editors.
2. **Explicit identification** — `---dossier` signals to parsers that this block is a dossier metadata block, not generic frontmatter. This enables fast detection without reading the full file.
3. **Coexistence** — A project can have both standard frontmatter files and dossier files without conflicts.

**Tradeoff**: Some markdown previewers won't render the frontmatter as hidden metadata — they'll show it as text. This is expected. The frontmatter is meant for tooling (CLI, MCP server, registries), not for human reading in a previewer.

If your editor shows the JSON block as visible text, that's normal behavior and does not affect execution.

### LLMs are non-deterministic. How can I rely on dossiers for production?

**The objection**: "LLMs give different results each time. How is this reliable?"

**Answer**: Dossiers provide **deterministic structure** with **adaptive execution**.

#### What IS Deterministic

**1. Schema validation** (happens before LLM execution)
```bash
# Validates structure instantly
dossier validate my-workflow.dossier.md
# ✓ Valid schema
# ✓ Checksum verified
# ✓ All required fields present
```

**2. Checksum verification**
```yaml
checksum: "sha256:a3f2c..."
# Same file always has same checksum
```

**3. Prerequisites checking**
```yaml
prerequisites:
  - Docker installed (version ≥20.0)
  - AWS credentials configured
# Either met or not met (deterministic)
```

**4. Validation steps**
```yaml
validation:
  - name: "Tests pass"
    check: "pytest exit code = 0"
# Binary: pass or fail
```

#### What IS Adaptive

**1. Execution approach**
```
Task: "Deploy with zero downtime"
Dossier: Provides goals, not exact commands
LLM: Chooses approach based on current state
```

**2. Error handling**
```
Error: "Port 8080 already in use"
Fixed script: Fails (didn't anticipate this)
Dossier + LLM: Checks what's using port, decides to stop it or use different port
```

**3. Context awareness**
```
Dossier: "Run tests"
LLM detects: "This is a Python project"
LLM runs: "pytest" (not "npm test")
```

#### Reliability Strategies

**For high-risk operations**, combine dossiers with validation:

```yaml
---
name: "Production Database Migration"
risk: "high"

# Deterministic safeguards
prerequisites:
  - Backup completed successfully
  - Staging migration succeeded
  - Rollback plan documented

validation:
  - name: "Backup exists"
    check: "File size > 1GB at /backups/prod-YYYY-MM-DD.sql"
  - name: "Migration ran"
    check: "Database version = 2.0"
  - name: "Data integrity"
    check: "Row count matches pre-migration count ±0.1%"

rollback:
  - "If any validation fails, restore from backup"
  - "Alert on-call engineer"
---

# Instructions
[LLM executes these adaptively...]
```

**Result**:
- ✅ Structure ensures critical steps aren't skipped
- ✅ Validation catches errors before they cause damage
- ✅ LLM adapts to environment details
- ✅ Rollback procedures documented

**Risk-appropriate usage**:

| Risk Level | Reliability Strategy | Example |
|------------|---------------------|---------|
| **Low risk** | Basic validation | Generate documentation |
| **Medium risk** | Prerequisites + validation | Deploy to staging |
| **High risk** | Prerequisites + validation + human approval | Production database changes |
| **Critical** | Human executes, dossier is checklist | Financial transactions |

**Key insight**: Dossiers are MORE reliable than scripts for complex tasks because:
- Scripts fail hard on unexpected situations
- LLMs adapt intelligently when edge cases arise
- Validation ensures outcome meets requirements
- Human-readable instructions catch logical errors

---

### What about cost? Every execution uses LLM tokens.

**The objection**: "This sounds expensive with all those token costs."

**Cost-benefit analysis**:

#### Token Costs

**Typical dossier execution**:
```
Input tokens:  ~2,000 (dossier + context)
Output tokens: ~1,000 (commands + reasoning)
Total: ~3,000 tokens per execution
```

**At current pricing** (as of early 2025):
```
Claude Sonnet: ~$0.01 per execution
GPT-4: ~$0.03 per execution
```

#### Time Savings

**Traditional approach** (manual execution):
```
Engineer time: 30 minutes
Engineer cost: $50/hour
Total: $25 per execution
```

**Dossier approach** (automated):
```
LLM tokens: $0.01
Engineer review: 5 minutes ($4)
Total: $4.01 per execution
```

**Savings: $20.99 per execution (84% reduction)**

#### When Costs Make Sense

**✅ Good cost-benefit**:
- Complex workflows (saves hours of engineer time)
- Infrequent execution (occasional deploy vs. every commit)
- High-value tasks (prevents costly mistakes)
- Cross-team collaboration (shared knowledge)

**❌ Poor cost-benefit**:
- Simple tasks (just use a script)
- High-frequency execution (thousands per hour)
- Well-defined deterministic processes (CI/CD better)

#### Cost Optimization Strategies

**1. Use appropriate LLM**
```yaml
# Simple dossier
recommended_model: "claude-3-haiku"  # Cheap, fast

# Complex reasoning required
recommended_model: "claude-sonnet-4"  # More capable
```

**2. Efficient structure**
```yaml
# ❌ Wasteful
instructions: |
  Here's everything about our entire system architecture...
  [10,000 words]

# ✅ Efficient
context:
  - "See ARCHITECTURE.md for system overview"
instructions: |
  Deploy the API service...
  [focused instructions]
```

**3. Hybrid approach**
```yaml
# Let dossier generate scripts, then run them
1. LLM generates deploy script based on context
2. Save script for future use
3. Next time: run cached script (zero LLM cost)
```

**4. Amortize over time**
```
First execution: $0.01 (LLM) + $10 (engineer creation) = $10.01
Subsequent executions: $0.01 each

After 10 runs: $10.01 + (9 × $0.01) = $10.10 total
VS manual: 10 × $25 = $250

Savings: $239.90
```

#### Future Cost Trends

- LLM token costs decreasing rapidly (90% reduction since GPT-3)
- Local models increasingly capable (zero marginal cost)
- Smaller, task-specific models emerging (cheaper per token)

**Verdict**: For complex, high-value workflows executed occasionally, dossiers are a MASSIVE cost savings compared to engineer time.

---

### What if the LLM hallucinates during execution?

**The objection**: "LLMs sometimes make things up. What if it hallucinates a command that breaks something?"

**Answer**: Dossiers include **hallucination mitigation** at multiple levels.

#### Mitigation Layer 1: Structured Instructions

**❌ Prone to hallucination** (vague prompts):
```
"Deploy the app"
```
LLM might hallucinate:
- Where to deploy
- Which version
- What deployment method
- Success criteria

**✅ Resistant to hallucination** (structured dossier):
```yaml
context:
  deployment_target: "production-cluster-us-east"
  version: "v2.3.1"
  method: "blue-green"

validation:
  - "Deployment exists in production-cluster-us-east"
  - "Version tag = v2.3.1"
  - "Health checks return 200"
```

**Why it helps**: LLM doesn't have to guess or fill in blanks.

#### Mitigation Layer 2: Validation Steps

```yaml
validation:
  - name: "Database backup exists"
    check: "ls /backups/db-*.sql | wc -l > 0"
  - name: "Backup is recent"
    check: "Backup file modified within last hour"
```

**If LLM hallucinates**: "Backup created successfully" (but didn't actually create it)
**Validation catches it**: Check fails, execution stops, rollback triggered

#### Mitigation Layer 3: Explicit Expectations

```yaml
expected_outcome:
  - "New version running on 100% of pods"
  - "Old version terminated"
  - "Zero error rate in logs"
```

**LLM compares actual state to expectations**. If mismatch, flags discrepancy.

#### Mitigation Layer 4: Human Review Points

```yaml
human_approval_required:
  - before: "production_deploy"
    show: "Deployment plan summary"
  - after: "migration"
    show: "Row count changes and validation results"
```

**Catches hallucination**: Human reviews LLM's plan before critical actions.

#### Real-World Example

**❌ Without mitigation**:
```
Task: "Backup database"
LLM hallucinates: "Created backup at /tmp/backup.sql"
Reality: Didn't actually run command
Result: No backup exists, database migration proceeds
Outcome: Data loss
```

**✅ With dossier validation**:
```yaml
validation:
  - name: "Backup file exists"
    check: "stat /backups/db-backup.sql"
  - name: "Backup size reasonable"
    check: "File size > 1MB"
```

```
Task: "Backup database"
LLM hallucinates: "Created backup successfully"
Validation runs: "stat /backups/db-backup.sql" → File not found
Validation fails: Execution stops
Outcome: Error caught before migration, data safe
```

#### Best Practices

1. **Never trust LLM output without validation**
   - Always include `validation` section for critical steps
   - Check actual system state, not just LLM claims

2. **Use explicit success criteria**
   - Define `expected_outcome` clearly
   - LLM compares reality to expectations

3. **Require human approval for high-risk actions**
   - `human_approval_required` for production changes
   - Review before execution, not just after

4. **Fail safe, not fail dangerous**
   ```yaml
   rollback:
     - "If any validation fails, restore previous state"
   ```

**Key insight**: Dossiers don't eliminate hallucination risk, but they CREATE CHECKPOINTS that catch hallucinations before they cause damage.

---

## Practical Usage

### When should I NOT use dossiers?

**Dossiers are powerful but not universal.** Here's when to use alternatives:

#### ❌ Don't Use Dossiers For:

**1. Simple, deterministic tasks**
```bash
# Just use a script
export DATABASE_URL="postgres://..."
```
No need for LLM overhead.

**2. High-frequency execution**
```yaml
# Run tests on every commit (1000x/day)
# Use: GitHub Actions, not dossiers
```
Token costs add up, latency matters.

**3. Performance-critical loops**
```python
# Process 1M records
for record in records:
    transform(record)  # Use script, not dossier
```
LLM overhead too high for tight loops.

**4. Extremely low-risk operations**
```bash
# Create a directory
mkdir -p /var/logs
```
Overhead not worth it.

**5. No LLM access available**
```
Airgapped environment with no LLM
# Use traditional scripts
```

**6. Highly regulated environments prohibiting LLMs**
```
Financial transaction processing
Medical device control systems
# Regulatory compliance may forbid LLM usage
```

**7. When output must be byte-for-byte identical**
```
Cryptographic signing
Binary compilation
# Non-deterministic LLM execution unsuitable
```

#### ✅ DO Use Dossiers For:

**1. Complex workflows with decisions**
```yaml
# "Deploy with zero downtime"
# Requires analyzing current state, making choices
```

**2. Context-dependent tasks**
```yaml
# "Upgrade dependencies safely"
# Must read changelogs, assess breaking changes
```

**3. Adaptive error handling**
```yaml
# "Fix failing tests"
# Requires understanding errors, trying solutions
```

**4. Cross-platform workflows**
```yaml
# "Setup development environment"
# Adapts to macOS / Linux / Windows
```

**5. Knowledge work**
```yaml
# "Generate migration guide from v1 to v2"
# Requires understanding codebases, writing docs
```

**6. Infrequent, high-value tasks**
```yaml
# "Quarterly security audit"
# Worth token cost, saves hours of engineer time
```

#### Decision Matrix

| Task Characteristic | Use Script | Use Dossier |
|---------------------|------------|-------------|
| Frequency | High (>100x/day) | Low (<10x/day) |
| Decisions required | None | Multiple |
| Context awareness | Not needed | Critical |
| Determinism required | Yes | No |
| Performance critical | Yes | No |
| Cost sensitivity | High | Low |
| Complexity | Low | High |
| Adaptability needed | No | Yes |

**Remember**: Use the right tool for the job. Dossiers complement scripts, don't replace them.

---

### How do I migrate from existing scripts to dossiers?

**You probably shouldn't migrate everything.** Here's a practical approach:

#### Step 1: Identify Good Candidates

**Look for scripts that**:
- ✅ Require manual intervention when they break
- ✅ Have lots of conditional logic
- ✅ Need frequent updates as environment changes
- ✅ Require deep context to execute correctly
- ✅ Are poorly documented

**Skip scripts that**:
- ❌ Run frequently (CI/CD pipelines)
- ❌ Are simple and stable
- ❌ Require precise determinism
- ❌ Have performance requirements

#### Step 2: Convert Incrementally

**Example: Database migration script**

**Original bash script** (`migrate-db.sh`):
```bash
#!/bin/bash
set -e

# Create backup
pg_dump $DB_URL > /backups/backup-$(date +%Y%m%d).sql

# Run migrations
psql $DB_URL < migrations/001_add_users.sql
psql $DB_URL < migrations/002_add_posts.sql

# Verify
psql $DB_URL -c "SELECT COUNT(*) FROM users"

echo "Migration complete"
```

**Converted to dossier** (`migrate-db.dossier.md`):
```yaml
---
name: "Database Migration with Safety Checks"
version: "1.0.0"
schema_version: "1.0.0"

prerequisites:
  - PostgreSQL client installed
  - DATABASE_URL environment variable set
  - Backup directory exists at /backups

context:
  backup_location: "/backups"
  migrations_dir: "./migrations"

validation:
  - name: "Backup created"
    check: "Backup file exists and size > 1MB"
  - name: "Migration applied"
    check: "users table exists"
  - name: "Data present"
    check: "users table has at least 1 row"

rollback:
  - "Restore from backup: psql $DB_URL < [backup_file]"
---

# Database Migration

## Overview
This dossier safely applies database migrations with automatic backups and validation.

## Instructions

### 1. Create Backup
```bash
pg_dump $DB_URL > /backups/backup-$(date +%Y%m%d-%H%M%S).sql
```
Verify the backup file was created and has reasonable size (>1MB).

### 2. Apply Migrations
Run all SQL files in `./migrations` in numerical order:
```bash
for file in ./migrations/*.sql; do
    echo "Applying $file"
    psql $DB_URL < $file
done
```

### 3. Validate
Check that key tables exist:
```bash
psql $DB_URL -c "\dt"  # List tables
psql $DB_URL -c "SELECT COUNT(*) FROM users"
```

### 4. Success Criteria
- All migrations applied without errors
- Tables exist as expected
- Data is present in key tables

## Rollback
If anything goes wrong:
```bash
# Restore from backup
psql $DB_URL < /backups/backup-[timestamp].sql
```
```

**What you gained**:
- ✅ Validation steps (catches errors)
- ✅ Documented rollback procedure
- ✅ Checksum verification (tamper-evident)
- ✅ Context documentation
- ✅ Human-readable instructions

#### Step 3: Hybrid Approach

**Keep both** (don't delete scripts):

```yaml
---
name: "Database Migration (Hybrid)"
---

# Instructions

Use the existing `migrate-db.sh` script, but with safety checks:

1. Verify prerequisites are met
2. Run the script: `./migrate-db.sh`
3. Validate outcome meets success criteria
4. If validation fails, rollback
```

**Benefits**:
- ✅ Reuse existing, tested scripts
- ✅ Add validation and error handling
- ✅ Document context and rollback procedures
- ✅ No need to rewrite everything

#### Step 4: Gradual Improvement

```
Version 1.0: Dossier calls existing script
   ↓
Version 1.1: Add validation steps
   ↓
Version 1.2: LLM handles error cases adaptively
   ↓
Version 1.3: Remove script, LLM executes directly
```

**You don't have to go all the way to 1.3** if 1.1 solves your needs!

#### Migration Checklist

- [ ] Identify 3-5 painful scripts as pilots
- [ ] Convert to dossiers (keeping original scripts)
- [ ] Test in non-production environment
- [ ] Gather team feedback
- [ ] Iterate on structure
- [ ] Expand to more workflows
- [ ] Document patterns for team

**Don't**: Try to convert everything at once
**Do**: Start small, learn, scale gradually

---

### Will dossiers create merge conflicts in version control?

**Short answer**: **Less than code**, about the same as markdown documentation.

#### Why Dossiers Are VCS-Friendly

**1. Human-readable diffs**
```diff
diff --git a/deploy.dossier.md b/deploy.dossier.md
--- a/deploy.dossier.md
+++ b/deploy.dossier.md
@@ -8,7 +8,8 @@
 validation:
   - name: "Health check passes"
-    check: "curl http://localhost/health returns 200"
+    check: "curl https://localhost/health returns 200"
+  - name: "SSL certificate valid"
```

**Clear change**: HTTP → HTTPS, added SSL validation

**2. JSON frontmatter is structured**
```yaml
# Conflicts are localized
version: "1.2.0"  # Easy to see version bumps
checksum: "sha256:..."  # Changes when content changes
```

**3. Markdown content is diff-friendly**
```markdown
# Instructions
1. Deploy to staging
2. Run tests
3. Deploy to production
```
Adding a step inserts a line (clean diff), doesn't reformat entire file.

#### Conflict Resolution

**Scenario**: Two developers update the same dossier

```yaml
# Developer A adds validation
validation:
  - name: "Tests pass"
  + - name: "Linting passes"

# Developer B adds different validation
validation:
  - name: "Tests pass"
  + - name: "Security scan passes"
```

**Conflict**:
```diff
<<<<<<< HEAD
validation:
  - name: "Tests pass"
  - name: "Linting passes"
=======
validation:
  - name: "Tests pass"
  - name: "Security scan passes"
>>>>>>> feature-branch
```

**Resolution** (keep both):
```yaml
validation:
  - name: "Tests pass"
  - name: "Linting passes"
  - name: "Security scan passes"
```

**Update version and checksum**:
```bash
# After resolving conflict
dossier recalculate-checksum deploy.dossier.md
# Updates checksum automatically
```

#### Best Practices

**1. Semantic versioning guides changes**
```yaml
# Patch version (1.2.0 → 1.2.1)
- Fixed typo in instructions
- Added clarifying comment

# Minor version (1.2.0 → 1.3.0)
- Added new validation step
- Added new prerequisite

# Major version (1.2.0 → 2.0.0)
- Changed expected output format
- Removed deprecated fields
```

**2. Small, focused dossiers**
```
❌ One massive dossier with 50 workflows
✅ 50 small dossiers (one per workflow)
```
Reduces conflict probability (different files).

**3. Use branches for experiments**
```bash
git checkout -b improve-deploy-validation
# Modify deploy.dossier.md
# Test thoroughly
git checkout main
git merge improve-deploy-validation
```

#### Comparison to Code

| Aspect | Traditional Code | Dossiers |
|--------|------------------|----------|
| **Merge conflicts** | Common | Less common |
| **Conflict readability** | Complex | Clear (markdown) |
| **Auto-merge success** | Moderate | High (structured) |
| **Manual resolution** | Requires code knowledge | Readable by anyone |

**Verdict**: Dossiers are EASIER to merge than code because they're:
- Structured (JSON frontmatter)
- Human-readable (markdown)
- Localized changes (validation steps, prerequisites are separate blocks)

---

### Can I use dossiers offline / airgapped?

**Yes!** Dossiers work entirely offline.

#### What Works Offline

**1. Creating dossiers**
```bash
# Just create a markdown file
vim my-workflow.dossier.md
```

**2. Validating dossiers**
```bash
# Schema validation (local)
dossier validate my-workflow.dossier.md
```

**3. Calculating checksums**
```bash
# Local cryptographic hash
dossier checksum my-workflow.dossier.md
```

**4. Signing dossiers**
```bash
# Uses local GPG keyring
dossier sign my-workflow.dossier.md --key 0x1234ABCD
```

**5. Executing dossiers**
```bash
# If you have local LLM (Ollama, etc.)
claude-code execute my-workflow.dossier.md

# Or manual execution (follow instructions yourself)
cat my-workflow.dossier.md
```

#### What Requires Internet

**1. Using cloud LLMs**
```bash
# Claude, GPT-4, Gemini require API calls
# Solution: Use local LLM (Ollama, LM Studio)
```

**2. Accessing registries**
```bash
# Discovering shared dossiers
# Solution: Pre-download or self-host registry
```

**3. Verifying signatures (if keys not in local keyring)**
```bash
# Fetching public keys from keyservers
# Solution: Pre-import keys or use key bundles
```

#### Airgapped Setup

**For secure / classified environments**:

```bash
# 1. Download dossiers in advance
git clone https://github.com/your-org/dossiers.git

# 2. Use local LLM
docker run -d ollama/ollama
ollama pull llama2

# 3. Pre-import signing keys
gpg --import team-keys.asc

# 4. Execute entirely offline
claude-code execute --model local/llama2 deploy.dossier.md
```

**Benefits**:
- ✅ No external dependencies
- ✅ No data exfiltration risk
- ✅ Works in classified networks
- ✅ Zero internet requirement

#### Offline Workflow

```
Developer Workstation (Offline)
├── Dossiers (git repo)
├── Local LLM (Ollama)
├── GPG keyring (local signatures)
└── Validation tools (local)

Everything works without internet.
```

**Comparison**: Dossiers are MORE offline-friendly than many tools:
- ❌ GitHub Actions: Requires GitHub cloud
- ❌ LangChain with OpenAI: Requires API access
- ✅ Dossiers: Markdown files, local execution

**Verdict**: Dossiers work fully offline with local LLM. Cloud LLMs are optional, not required.

---

## Still Have Questions?

### Where can I learn more?

- **Documentation**: [Main README](README.md)
- **Getting Started**: [Quick Start Guide](QUICK_START.md)
- **Schema Details**: [Schema Documentation](SCHEMA.md)
- **Security**: [Security Model](SECURITY.md)
- **Examples**: [examples/](examples/) directory

### How can I contribute?

- **Report issues**: [GitHub Issues](https://github.com/your-org/dossier/issues)
- **Submit dossiers**: Share your workflows with the community
- **Improve docs**: PRs welcome for documentation improvements
- **Join discussion**: Community forum / Discord / Slack

### How can I get help?

- **Community support**: Forum / Discord / Slack
- **Documentation**: Search the docs
- **Examples**: Check examples/ for similar use cases
- **Commercial support**: Available for enterprises

---

*Last updated: 2025-01-07*
