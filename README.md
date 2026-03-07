# Dossier — Automation Instructions for AI Agents

**Stop writing brittle scripts. Start writing instructions that AI executes intelligently.**

✅ Portable workflows that adapt to your project
✅ Built-in verification (checksums, signatures, success criteria)
✅ Works with Claude, ChatGPT, Cursor—any LLM

[![CI](https://github.com/imboard-ai/ai-dossier/actions/workflows/ci.yml/badge.svg)](https://github.com/imboard-ai/ai-dossier/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@ai-dossier/cli)](https://www.npmjs.com/package/@ai-dossier/cli)
[![npm downloads](https://img.shields.io/npm/dm/@ai-dossier/cli)](https://www.npmjs.com/package/@ai-dossier/cli)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Spec](https://img.shields.io/badge/Dossier%20Spec-v1.0-blue)](docs/reference/README.md)
[![MCP Ready](https://img.shields.io/badge/MCP-Ready-brightgreen)](mcp-server)
[![Verification](https://img.shields.io/badge/Verification-Checksums%20%26%20Signatures-yellow)](docs/explanation/security-model.md)
[![GitHub](https://img.shields.io/github/stars/imboard-ai/ai-dossier?style=social)](https://github.com/imboard-ai/ai-dossier)

> **Quick Concept**
> Dossier turns plain-text instructions into executable workflows with built-in verification.
> Like Dockerfiles for AI automation—structured, portable, verifiable.

**New here?** → [5-min Quick Start](docs/getting-started/installation.md) | **Want to try now?** → [30-sec demo](#try-it-now)

---

## At a Glance

📝 **What**: Structured instruction files (`.ds.md`) that AI agents execute intelligently
🎯 **Why**: Replace brittle scripts with adaptive, verifiable automation that handles edge cases naturally
⚡ **How**: Create dossier → Run with your AI → Get validated results with evidence
🔒 **Safety**: Built-in checksums, cryptographic signatures, and CLI verification tools
🔗 **Multi-registry**: Configure multiple registries for teams and organizations
🌐 **Works with**: Claude, ChatGPT, Cursor, any LLM—no vendor lock-in

**Status**: v1.0 protocol | 15+ production examples | Active development

> **File conventions**: Dossiers use `.ds.md` (immutable instructions) and `.dsw.md` (mutable working files). Frontmatter uses `---dossier` (JSON) instead of `---` (YAML) to avoid parser conflicts. [Learn more](docs/explanation/faq.md#what-do-the-dsmd-and-dswmd-file-extensions-mean)

---

## Try it Now

**Option A — Claude Code with MCP (Recommended)**

Add the Dossier MCP server to enable automatic verification:

**Step 1**: Create or edit `~/.claude/settings.local.json`
```json
{
  "mcpServers": {
    "dossier": {
      "command": "npx",
      "args": ["-y", "@ai-dossier/mcp-server"]
    }
  }
}
```

**Step 2**: Restart Claude Code to load the MCP server

---

**Option B — Command-Line Verification (Works Anywhere)**

Verify dossier security before execution:

```bash
# Clone the repo and use the CLI verification tool
git clone https://github.com/imboard-ai/ai-dossier.git
cd ai-dossier
npx @ai-dossier/cli verify examples/git-project-review/atomic/readme-reality-check.ds.md
```

---

**Option C — Try with Any LLM (Zero Installation)**

Copy this into any LLM chat (Claude, ChatGPT, Gemini):
```markdown
---dossier
{
  "title": "Hello World",
  "version": "1.0.0",
  "protocol_version": "1.0",
  "status": "stable",
  "objective": "Print a friendly greeting and verify success",
  "risk_level": "low"
}
---

# Hello World

## Actions
1. Print: "Hello from Dossier!"

## Validation
- Output contains "Hello from Dossier"
```

**Expected result**: The LLM will print "Hello from Dossier!" and confirm success.

---

## Why Use Dossier?

**"How is this different from AGENTS.md files?"** Many projects already use files like `AGENTS.md` or `.cursorrules` for AI context. Here's the key distinction:

|  | AGENTS.md | Dossier |
|--|-----------|---------|
| **Purpose** | Project context & conventions | Executable workflow automation |
| **Validation** | None | Built-in success criteria |
| **Security** | None | Checksums + cryptographic signatures |
| **Portability** | Project-specific | Cross-project, shareable |
| **Tooling** | None | CLI verification, MCP integration |
| **Versioning** | Informal | Semantic versioning (v1.0.0) |

**They're complementary**: Use AGENTS.md to explain *your project*, use dossiers to automate *workflows*.

---

## Examples Gallery

Real-world dossiers demonstrating the protocol across different domains:

| Example | Use Case | Est. Time |
|---------|----------|-----------|
| [Git Project Reality Check](./examples/git-project-review/) | Audit README claims against actual code with evidence | ~5 min |
| [Setup React Library](./examples/development/setup-react-library.ds.md) | Initialize production-ready component library with TypeScript, Storybook, tests | ~10 min |
| [ML Training Pipeline](./examples/data-science/train-ml-model.ds.md) | Train and validate ML models with reproducible experiment logs | ~10-15 min |
| [DB Migration](./examples/database/migrate-schema.ds.md) | Execute schema changes with automatic backup and rollback capability | ~10 min |
| [AWS Deploy](./examples/devops/deploy-to-aws.ds.md) | Deploy applications to AWS with infrastructure validation | ~15 min |

**Who should try these**: Project maintainers, DevOps/SRE teams, ML engineers, frontend developers

**Run the first one now:**

Ask your LLM:
```
Analyze my project using the readme-reality-check dossier from:
https://raw.githubusercontent.com/imboard-ai/ai-dossier/main/examples/git-project-review/atomic/readme-reality-check.ds.md
```

---

## Security & Verification

- Use the CLI tool (`ai-dossier verify`) to verify checksums/signatures before execution
- Prefer MCP mode for sandboxed, permissioned operations
- **External reference declaration**: Dossiers that fetch or link to external URLs must declare them in `external_references` with trust levels. The linter flags undeclared URLs, and the MCP server's `read_dossier` tool returns `security_notices` for any undeclared external URLs found in the body. This mitigates transitive trust risks from unvetted external content.
- See [SECURITY_STATUS.md](./SECURITY_STATUS.md) for current guarantees and limitations

---

## Registry & Multi-Registry Support

The CLI supports multiple registries for discovering, publishing, and sharing dossiers across teams and organizations.

- **Multi-registry**: Configure multiple registries (public, internal, mirrors) queried in parallel
- **HTTPS enforcement**: All registry URLs must use HTTPS to protect credentials in transit
- **Per-registry credentials**: Each registry has isolated authentication — a compromised token cannot access other registries
- **Project-level config**: Add a `.dossierrc.json` to your project for team-shared registry settings

```bash
# Add a private registry
dossier config --add-registry internal --url https://dossier.company.com

# List configured registries
dossier config --list-registries
```

See the [CLI documentation](./cli/README.md#config-command) for full registry management options.

---

## Adopter Playbooks

- **Solo Dev**: paste a `.ds.md` into your LLM and run via MCP or CLI
- **OSS Maintainer**: add `/dossiers` + a CI check that runs the Reality Check on your README
- **Platform Team**: start with init → deploy → rollback dossiers; wire secrets & scanners

👉 Detailed playbooks in [docs/guides/adopter-playbooks.md](docs/guides/adopter-playbooks.md)

---

## Learn More

- [Dossier Guide](docs/guides/dossier-guide.md) - Deep dive into concepts, schema, security, self-improvement, and best practices
- [FAQ](docs/explanation/faq.md) - Common questions and comparisons to alternatives
- [Protocol](docs/reference/protocol.md) - Execution protocol specification
- [Specification](docs/reference/specification.md) - Formal dossier specification
- [Schema](docs/reference/schema.md) - JSON schema reference
- [MCP Server](./mcp-server/README.md) - Model Context Protocol integration for Claude Code
- [Security](./security/ARCHITECTURE.md) - Security architecture and trust model

---

## Documentation

### Getting Started
- [Quick Start Guide](docs/getting-started/installation.md) - Get started in 5 minutes
- [Tutorials](docs/tutorials/) - Step-by-step learning experiences
- [FAQ](docs/explanation/faq.md) - Frequently asked questions

### Reference
- [Protocol Specification](docs/reference/protocol.md) - Dossier execution protocol
- [Formal Specification](docs/reference/specification.md) - Complete formal specification
- [Schema](docs/reference/schema.md) - Dossier schema specification (v1.0.0)
- [dossier-schema.json](./dossier-schema.json) - JSON Schema definition

### Guides & Examples
- [How-To Guides](docs/guides/) - Task-oriented guides
- [Example Dossiers](./examples/) - Example implementations
- [Adopter Playbooks](docs/guides/adopter-playbooks.md) - Adoption strategies

### Architecture & Contributing
- [Architecture Overview](ARCHITECTURE.md) - System architecture
- [Contributing Guide](CONTRIBUTING.md) - How to contribute
- [Security](SECURITY.md) - Security policy and verification
- [Changelog](CHANGELOG.md) - Version history

### Integrations
- [MCP Server](./mcp-server/) - Model Context Protocol integration
- [CLI Tool](./cli/) - Command-line verification tool
- [Registry](./registry/) - Dossier registry API (deployed via Vercel)
- [MI6](https://github.com/imboard-ai/mi6) - Community implementation example

---

## Philosophy

> "Agents need structure. Dossiers provide it."

Dossiers embody this philosophy - they give AI agents clear structure and guidance, enabling them to intelligently automate complex workflows that would be brittle to script.

**The dossier standard** enables:
- **Adaptability**: LLMs understand context and adjust behavior
- **Maintainability**: Markdown documentation instead of complex scripts
- **Collaboration**: Clear, readable instructions anyone can contribute to
- **Continuous improvement**: Self-improving through the protocol
- **Universal adoption**: Any project, any workflow, any implementation

---

**🎯 Dossier: Universal LLM Automation Standard**
*Structure your agents. Not your scripts.*

---

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE). You are free to use, copy, modify, and distribute it, provided that any modified versions or network services using this software also make their source code available under the same license.

## References

[^1]: Liu, M. X., Liu, F., Fiannaca, A. J., Koo, T., Dixon, L., Terry, M., & Cai, C. J. (2024). "We Need Structured Output": Towards User-centered Constraints on Large Language Model Output. *CHI Conference on Human Factors in Computing Systems (CHI EA '24)*.

[^2]: Yang, J., Jiang, D., He, L., et al. (2025). StructEval: Benchmarking LLMs' Capabilities to Generate Structural Outputs. *arXiv:2505.20139*.

[^3]: Perozzi, B., Fatemi, B., Zelle, D., Tsitsulin, A., Kazemi, M., Al-Rfou, R., & Halcrow, J. (2024). Let Your Graph Do the Talking: Encoding Structured Data for LLMs. *arXiv (CS > Machine Learning)*.

[^4]: Microsoft Research. (2024). Token Efficiency with Structured Output from Language Models. *Microsoft Technical Blog*.

[^5]: Grigorev, D. S., Kovalev, A. K., & Panov, A. I. (2025). VerifyLLM: LLM-Based Pre-Execution Task Plan Verification for Robots. *IROS 2025*.

[^6]: Chuang, Y.-N., Tang, R., Jiang, X., & Hu, X. (2024). SPeC: A Soft Prompt-Based Calibration on Performance Variability of Large Language Model in Clinical Notes Summarization. *Journal of Biomedical Informatics*.

[^7]: Errica, F., Siracusano, G., Sanvito, D., & Bifulco, R. (2025). What Did I Do Wrong? Quantifying LLMs' Sensitivity and Consistency to Prompt Engineering. *Annual Conference of the Nations of the Americas Chapter of the Association for Computational Linguistics (NAACL 2025)*.

[^8]: dottxt.ai. (2024). Structured Generation Improves LLM Performance. *Technical Blog/Research*.

[^9]: Zhu, Y., Moniz, J. R. A., Bhargava, S., Lu, J., Piraviperumal, D., Li, S., Zhang, Y., Yu, H., & Tseng, B.-H. (2024). Can Large Language Models Understand Context? *EACL 2024 (Findings)*.

[^10]: Using an LLM to Help With Code Understanding. (2024). *arXiv*.

[^11]: Natural Language based Context Modeling and Reasoning for Ubiquitous Computing with Large Language Models: A Tutorial. (2023). *arXiv:2309.15074*.

[^12]: Tyen, G., Mansoor, H., Cărbune, V., Chen, P., & Mak, T. (2024). LLMs cannot find reasoning errors, but can correct them given the error location. *ACL 2024 Findings*.

[^13]: The STROT Framework: Structured Prompting and Feedback-Guided Reasoning with LLMs for Data Interpretation. (2025). *arXiv:2505.01636*.

[^14]: Are Retrials All You Need? Enhancing Large Language Model Reasoning Without Verbalized Feedback. (2025). *arXiv:2504.12951*.

[^15]: Pan, L., Saxon, M., Xu, W., Nathani, D., Wang, X., & Wang, W. Y. (2024). Automatically Correcting Large Language Models: Surveying the Landscape of Diverse Automated Correction Strategies. *Transactions of the Association for Computational Linguistics (TACL)*, 12, 484-506.

[^16]: Progress or Regress? Self-Improvement Reversal in Post-training. (2024). *arXiv:2407.05013*.

[^17]: Stack Overflow. (2024). Developer Survey 2024. 82% of professional developers use ChatGPT, 43% use Microsoft Copilot, 25% use GitHub Copilot, 16% use Claude.

[^18]: McKinsey. (2024). Enterprise AI Survey 2024. 78% of organizations use AI in at least one business function (up from 55% prior year); 71% enterprise adoption of generative AI.

[^19]: LangChain. (2024). State of AI 2024 Report. 61.7% of developers/ML teams have or plan to have LLM apps in production within a year; 37.3% use AI chatbots in their work every day; 60.6% implementing prompt engineering.

[^20]: Anthropic. (2024). Market Analysis 2024. Anthropic leads enterprise AI with 32% market share; 73% of enterprises spend over $50,000 annually on LLMs; 37% spend over $250,000 annually.

[^21]: Balancing Automation with Human Expertise in Exploratory Testing and Edge-Case Analysis. (2024). *ResearchGate*.

[^22]: De Reanzi, S. R., & Thangaiah, P. R. J. (2021). Survey on Software Test Automation Return on Investment. *SAGE Journals*. Maintenance overhead (fixing script failures) is 22-30% for traditional scripts.

[^23]: DAPLab Research. (2025). Columbia University Technical Blog. Notes that "digital environments are messy and stateful: every agent action perturbs hidden processes, files, and I/O, making single-shot execution brittle."

[^24]: Schema Matching with Large Language Models: an Experimental Study. (2024). *arXiv:2407.11852*.

[^25]: LLM4Schema.org: Generating Schema.org Markups. (2024). *HAL Science*.
