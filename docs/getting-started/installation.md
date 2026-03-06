# Dossier Quick Start Guide

New to dossiers? This guide gets you up and running in **under 5 minutes**.

---

## What Are Dossiers? (30 seconds)

**Dossiers** are structured instructions for AI assistants to automate complex workflows intelligently.

Instead of writing brittle scripts that break on edge cases, you write clear instructions that AI agents can follow and adapt to your specific project.

**Example**: A "deploy-to-aws" dossier tells the AI how to deploy, but the AI figures out your specific AWS setup, validates prerequisites, and handles errors intelligently.

> **❓ First time here?** See [FAQ.md](../explanation/faq.md) for common questions like "Why not just use AGENTS.md?", "Who controls this protocol?", and detailed comparisons with alternatives.

### File extensions & frontmatter at a glance

- **`.ds.md`** — Dossier files (immutable instructions, checksummed)
- **`.dsw.md`** — Working files (mutable execution state, not verified)
- **`---dossier`** — Custom frontmatter delimiter (contains JSON metadata, not YAML). Uses `---dossier` instead of `---` to avoid conflicts with standard YAML frontmatter parsers. If your markdown previewer shows the JSON block as text, that's expected.

See the [FAQ](../explanation/faq.md#what-do-the-dsmd-and-dswmd-file-extensions-mean) for details.

---

## Choose Your Path

### Path 1: I Have File-Access AI Tools ⭐ (Recommended)

**Works with**: Claude Code, Cursor, Aider, Continue, Windsurf, etc.

These tools can read files, so they can learn about dossiers on-the-fly.

#### Step 1: Get a dossier-enabled project

```bash
# Clone this repo (has example dossiers)
git clone https://github.com/imboard-ai/ai-dossier.git
cd ai-dossier
```

Or add dossiers to your existing project:

```bash
# In your project directory
mkdir -p dossiers
curl -o dossiers/project-init.md \
  https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/development/setup-react-library.md
```

#### Step 2: Tell your AI to learn and execute

Copy-paste this to your AI assistant:

```
I want to use the dossier automation system. First, learn about it:

1. Read README.md to understand what dossiers are
2. Read one example: examples/devops/deploy-to-aws.md
3. Read PROTOCOL.md to understand execution protocol

Then help me list and execute dossiers in this project.
```

#### Step 3: Use dossiers

```
"List available dossiers in this project"
"Execute the project-init dossier"
"Use the deploy-to-aws dossier for staging environment"
```

**That's it!** Your AI now understands dossiers and can execute them.

---

### Path 2: I Use ChatGPT/Claude.ai/Gemini (Web UIs)

**Works with**: ChatGPT, Claude.ai, Gemini, or any chat-based LLM

These tools can't read files, so you need to provide the dossier content.

#### Step 1: Get the dossier content

```bash
# View a dossier
cat dossiers/project-init.md

# Or download an example
curl https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/devops/deploy-to-aws.md
```

#### Step 2: Use the universal template

Copy this template and paste to your LLM:

```
I'm using the "dossier" automation system. Dossiers are structured
instructions for AI agents to execute complex workflows intelligently.

Here's the dossier I want you to execute:

--- BEGIN DOSSIER ---
[PASTE DOSSIER CONTENT HERE]
--- END DOSSIER ---

Please:
1. Read and understand the dossier structure
2. Validate prerequisites
3. Gather the context specified
4. Execute the actions step-by-step
5. Validate success criteria
6. Report the outcome

Start by confirming you understand the objective and prerequisites.
```

#### Step 3: Execute

The AI will follow the dossier instructions, adapt to your project, and execute the workflow.

---

### Path 3: I Want Zero Friction 🚀 (MCP Server)

**Available Now**: MCP Server for Claude Code and other MCP-compatible tools

With the MCP server, you can simply say:

```
"Use the project-init dossier"
```

And it just works! The AI automatically:
- Understands what dossiers are
- Finds available dossiers
- Reads the content
- Executes following the protocol

**Status**: MVP Complete — core security verification tools working, ready for testing.

📚 See [mcp-server/README.md](./mcp-server/README.md) for details and contribute!

---

## Example: Deploy to AWS

Let's walk through a real example using the AWS deployment dossier.

### Scenario

You have a Node.js app and want to deploy it to AWS staging environment.

### Using Claude Code (or similar)

```
User: "I want to use the dossier automation system. Read README.md and
       examples/devops/deploy-to-aws.md to understand dossiers. Then
       execute the deploy-to-aws dossier for the staging environment."

AI:   *Reads README.md to understand dossiers*
      *Reads deploy-to-aws.md dossier*
      *Reads PROTOCOL.md for execution guidelines*

      Executing: deploy-to-aws dossier v2.1.0

      Prerequisites Check:
      ✓ AWS credentials configured
      ✓ Terraform installed (v1.5.0)
      ✓ Project has terraform/ directory

      Context Gathering:
      - Detected: Node.js application
      - IaC Tool: Terraform
      - Target: staging environment
      - Region: us-west-2 (from config)

      Decision: Using Terraform workflow with staging variables

      Actions:
      ✓ Validating Terraform configuration
      ✓ Running terraform plan
      ✓ Reviewing changes (47 resources to modify)

      ⚠️  This will modify infrastructure. Proceed? (y/N)

User: "yes"

AI:   ✓ Executing terraform apply
      ✓ Deployment complete
      ✓ Running health checks
      ✓ All services healthy

      Validation:
      ✓ Application responding at https://staging.example.com
      ✓ Database migrations applied
      ✓ Monitoring configured

      Deployment successful!
      Staging URL: https://staging.example.com
```

### Using ChatGPT (copy-paste method)

1. **Get dossier**:
```bash
cat examples/devops/deploy-to-aws.md
```

2. **Copy content**

3. **Paste to ChatGPT** with template:
```
I'm using the dossier automation system. Here's the dossier:

--- BEGIN DOSSIER ---
[paste deploy-to-aws.md content here]
--- END DOSSIER ---

Please execute this dossier for deploying to AWS staging environment.
Follow the steps carefully and validate each stage.
```

4. **AI executes**, asking for information as needed

---

## CLI Installation & Registry Setup

### Install the CLI

```bash
npm install -g @ai-dossier/cli
```

### Authentication

```bash
# Interactive login (opens browser)
ai-dossier login

# Non-interactive (CI/CD, agents)
export DOSSIER_REGISTRY_TOKEN=<your-token>
```

### Registry Configuration

By default the CLI uses the public Dossier registry. Teams can configure additional registries in `~/.dossier/config.json`:

```json
{
  "registries": {
    "public": {
      "url": "https://dossier-registry.vercel.app",
      "default": true
    },
    "internal": {
      "url": "https://dossier.internal.example.com"
    }
  }
}
```

Or per-project via `.dossierrc.json` in your project root:

```json
{
  "registries": {
    "team": { "url": "https://dossier.myteam.example.com" }
  },
  "defaultRegistry": "team"
}
```

Authenticate to each registry:

```bash
ai-dossier login                      # default registry
ai-dossier login --registry internal  # named registry
```

### Viewing Configured Registries

Use `--list-registries` to see which registries are configured and which is the default:

```bash
# Human-readable output
dossier config --list-registries

# Machine-readable JSON (useful for scripts and agents)
dossier config --list-registries --json
```

This is helpful when an error message says a registry was not found — run `--list-registries` to see what's available and verify the name.

See the [CLI README](../../cli/README.md#registry-configuration) for full registry configuration details.

---

## Next Steps

### 1. Explore Examples

See [examples/](./examples/) for real-world dossiers:
- **Data Science**: [ML Training Pipeline](./examples/data-science/train-ml-model.md)
- **Database**: [Schema Migration](./examples/database/migrate-schema.md)
- **Frontend**: [React Component Library](./examples/development/setup-react-library.md)
- **DevOps**: [AWS Deployment](./examples/devops/deploy-to-aws.md)

### 2. Create Your Own Dossiers

```bash
# Copy the template
cp templates/dossier-template.md dossiers/my-custom-dossier.md

# Edit with your workflow
vim dossiers/my-custom-dossier.md
```

Follow the structure in [SPECIFICATION.md](../reference/specification.md).

### 3. Organize Multiple Dossiers

See [examples/sample-implementation/dossiers-registry.md](./examples/sample-implementation/dossiers-registry.md) for how to create a registry when you have 5+ dossiers.

### 4. Understand the Protocol

Read [PROTOCOL.md](../reference/protocol.md) to learn about:
- Self-improving dossiers
- Safety guidelines
- Validation patterns
- Error handling

---

## Tool-Specific Tips

### Claude Code

```
# Best practice: Have AI learn once per project
"Read README.md and PROTOCOL.md to learn about dossiers.
Then find and list all dossiers in this project."

# Then you can just reference by name
"Execute project-init dossier"
"Run the deploy-to-aws dossier for production"
```

### Cursor

```
# Similar to Claude Code
"Learn about dossiers from README.md, then execute
the dossier at dossiers/setup-environment.md"
```

### Aider

```
# Aider can read files in context
"Read the dossier automation standard from README.md.
Then execute dossiers/feature-start.md to begin
working on the authentication feature."
```

### ChatGPT / Claude.ai

```
# Always use the copy-paste template
# Save common templates as snippets
# Consider using custom instructions to remember dossier format
```

### Windsurf / Continue

```
# These work like Claude Code
# Have the AI read documentation first
# Then reference dossiers by path or name
```

---

## Troubleshooting

### "AI doesn't understand dossiers"

**Solution**: Provide the README.md content or use the copy-paste template.

### "AI can't find the dossier file"

**Solution**:
- Give explicit path: `dossiers/project-init.md`
- Or have AI search: `"Find all .md files in dossiers/ directory"`

### "AI isn't following the protocol"

**Solution**: Explicitly reference the protocol:

```
"Execute this dossier following the Dossier Execution Protocol
defined in PROTOCOL.md. This includes:
- Pre-execution analysis
- Context gathering
- Decision points
- Validation
- Self-improvement suggestions"
```

### "Execution failed"

**Solution**: Dossiers include troubleshooting sections. Tell the AI:

```
"Check the Troubleshooting section of the dossier and
diagnose the issue. Then propose a fix."
```

### "insecure permissions" warning on credentials

The CLI stores authentication tokens in `~/.dossier/credentials.json` with restricted permissions (`0600`). If the file permissions are loosened, you'll see:

```
⚠️  Warning: ~/.dossier/credentials.json has insecure permissions (644). Expected 0600. Credentials may have been compromised. Fixing permissions.
```

Fix by running:
```bash
chmod 600 ~/.dossier/credentials.json
```

The CLI will also attempt to fix this automatically.

### "Failed to save credentials"

This means the CLI couldn't write to the credentials file after login. Common fixes:

1. Ensure `~/.dossier/` exists and is writable:
   ```bash
   mkdir -p ~/.dossier && chmod 700 ~/.dossier
   ```
2. In containers or CI where the home directory is read-only, use an environment variable instead:
   ```bash
   export DOSSIER_REGISTRY_TOKEN=<your-token>
   ```

See the [CLI README troubleshooting](../../cli/README.md#troubleshooting) for more details.

---

## Common Questions

**For comprehensive answers, see [FAQ.md](../explanation/faq.md)**

### Q: Do I need special tools?

**A**: No! Dossiers work with any AI assistant. File-access tools (Claude Code, Cursor, etc.) make it easier, but copy-paste works everywhere.

### Q: How is this different from AGENTS.md?

**A**: AGENTS.md provides project context. Dossiers provide executable workflows with validation and security. They're complementary! See [FAQ.md § Dossiers vs. AGENTS.md](../explanation/faq.md#how-are-dossiers-different-from-agentsmd-files) for detailed comparison.

### Q: Who controls this protocol?

**A**: It's an open protocol - you control your dossiers. See [FAQ.md § Protocol & Governance](../explanation/faq.md#protocol--governance) for governance model.

### Q: Are dossiers secure?

**A**: Yes - multi-layer security with checksums, signatures, and risk assessment. See [FAQ.md § Security & Trust](../explanation/faq.md#security--trust) for details.

### Q: Do dossiers work with all LLMs?

**A**: Yes! The standard is LLM-agnostic. Works with Claude, GPT-4, Gemini, Llama, and any capable AI agent.

---

## Get Help

- **FAQ**: [FAQ.md](../explanation/faq.md) - Comprehensive objection handling & comparisons
- **Issues**: https://github.com/imboard-ai/ai-dossier/issues
- **Discussions**: https://github.com/imboard-ai/ai-dossier/discussions
- **Examples**: See [examples/](./examples/)
- **Spec**: See [SPECIFICATION.md](../reference/specification.md)
- **Protocol**: See [PROTOCOL.md](../reference/protocol.md)

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│ DOSSIER QUICK REFERENCE                                     │
├─────────────────────────────────────────────────────────────┤
│ What:  Structured instructions for AI automation            │
│ Why:   Adapt to your project vs brittle scripts            │
│ Where: Store in dossiers/ directory as .md files           │
├─────────────────────────────────────────────────────────────┤
│ FILE-ACCESS TOOLS (Claude Code, Cursor, etc.)              │
│   "Read README.md to learn about dossiers, then            │
│    execute dossiers/project-init.md"                       │
├─────────────────────────────────────────────────────────────┤
│ WEB LLMs (ChatGPT, Claude.ai, etc.)                        │
│   Use copy-paste template (see above)                      │
├─────────────────────────────────────────────────────────────┤
│ CREATE NEW DOSSIER                                          │
│   cp templates/dossier-template.md dossiers/my-task.md    │
│   Edit: Objective, Prerequisites, Actions, Validation      │
├─────────────────────────────────────────────────────────────┤
│ KEY FILES                                                   │
│   README.md                      - Concept overview        │
│   PROTOCOL.md                    - Execution protocol      │
│   docs/reference/specification.md - Dossier spec           │
│   docs/explanation/faq.md         - FAQ & comparisons      │
│   examples/                       - Real-world examples    │
└─────────────────────────────────────────────────────────────┘
```

---

**Ready to automate?** Pick your path above and start using dossiers in under 5 minutes! 🚀
