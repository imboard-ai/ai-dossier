# Contributing to Dossier

Thanks for your interest in contributing to the Dossier project! We welcome issues, discussions, example dossiers, documentation improvements, and code contributions.

## Ground Rules

- **Be respectful and constructive** - Follow our [Code of Conduct](./CODE_OF_CONDUCT.md)
- **Discuss large changes** - Use the RFC process (see `/rfcs`) for significant protocol or spec changes
- **Security first** - Never merge effectful examples without validation steps
- **Clear communication** - Explain your reasoning and be open to feedback

## Ways to Contribute

### 1. File an Issue

Use the issue templates for:
- **Bug reports** - Something isn't working as expected
- **Feature requests** - Ideas for improvements or new capabilities
- **Documentation improvements** - Unclear or missing documentation

### 2. Start a Discussion

Use GitHub Discussions for:
- Questions about using dossiers
- Ideas that need refinement before becoming issues
- Showcasing your dossier implementations
- General feedback and suggestions

### 3. Open a Pull Request

**Before submitting a PR**:
- Check if there's an existing issue or discussion
- For large changes, create an RFC first (see below)
- Ensure your changes follow our guidelines

**PR Guidelines**:
- Keep commits focused and use descriptive messages
- Include tests or runnable examples when applicable
- Update documentation to reflect behavior changes
- Add validation steps to any effectful examples
- Reference related issues with `Fixes #123` or `Relates to #456`

## Local Development

### Prerequisites
- Node.js 18+ recommended
- Git

### Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/imboard-ai/dossier.git
   cd dossier
   ```

2. **Install dependencies** (for CLI and MCP server):
   ```bash
   cd cli && npm install && cd ..
   cd mcp-server && npm install && cd ..
   ```

3. **Build the tools**:
   ```bash
   cd cli && npm run build && cd ..
   cd mcp-server && npm run build && cd ..
   ```

4. **Test the CLI**:
   ```bash
   cd cli
   npm test  # If tests are available
   node bin/dossier-verify.js --help
   ```

5. **Test the MCP server** (requires Claude Code):
   - Add to `~/.claude/settings.local.json`:
     ```json
     {
       "mcpServers": {
         "dossier-dev": {
           "command": "node",
           "args": ["/path/to/dossier/mcp-server/dist/index.js"]
         }
       }
     }
     ```
   - Restart Claude Code and test MCP tools

### Code Quality

This project uses [Biome](https://biomejs.dev/) for linting and formatting.

**Automatic enforcement (pre-commit hook):**
After running `npm install`, a Git pre-commit hook is automatically set up via [husky](https://typicode.github.io/husky/). Every commit will run Biome on your staged files and auto-fix issues before committing.

**Manual commands:**
```bash
npm run lint          # Check for lint & format errors (read-only)
npm run lint:fix      # Auto-fix lint & format errors
npm run format        # Auto-format all files
```

**CI enforcement:**
Pull requests are checked by a dedicated `lint` job in CI. Merging is blocked until the codebase passes `npm run lint`.

## Adding an Example Dossier

Example dossiers are one of the most valuable contributions!

### Location
Put your example under `examples/<topic>/`:
- `examples/development/` - Development workflows
- `examples/devops/` - Operations and deployment
- `examples/database/` - Database operations
- `examples/data-science/` - ML and data workflows
- `examples/security/` - Security validation

For atomic, focused examples:
- `examples/<topic>/atomic/` - Quick, minimal runnable cases (< 2 min)

### Requirements

1. **Use the `.ds.md` extension** for consistency

2. **Include JSON schema frontmatter**:
   ```markdown
   ---dossier
   {
     "dossier_schema_version": "1.0.0",
     "title": "Your Dossier Title",
     "version": "1.0.0",
     "protocol_version": "1.0",
     "status": "Stable",
     "objective": "Clear, measurable goal",
     "risk_level": "low",
     "validation": {
       "success_criteria": [
         "Specific verifiable outcome",
         "Another measurable result"
       ]
     }
   }
   ---
   ```

3. **Add clear validation steps** that prove success with evidence:
   ```markdown
   ## Validation
   - ✓ File created at `path/to/file.txt`
   - ✓ Tests pass (run `npm test`)
   - ✓ Version tag exists: `git tag | grep v1.0.0`
   ```

4. **Create a README.md** in the example directory describing:
   - Purpose and use case
   - Expected time to run
   - Prerequisites
   - What the example demonstrates

5. **Test your dossier**:
   - Run it with an LLM (Claude Code, ChatGPT, etc.)
   - Verify all steps execute successfully
   - Ensure validation criteria pass
   - Check for edge cases

### Example Structure
```
examples/
└── your-topic/
    ├── README.md                    # Overview of examples in this category
    ├── your-example.ds.md           # Main example dossier
    └── atomic/                      # Optional: smaller focused examples
        ├── minimal-case-1.ds.md
        └── minimal-case-2.ds.md
```

## Documentation Contributions

### Areas that Need Documentation
- More example dossiers across different domains
- Troubleshooting guides
- Integration guides (GitHub Actions, GitLab CI, Jenkins, etc.)
- Video tutorials or animated demos
- Translations (if applicable)

### Style Guide
- Use clear, concise language
- Provide code examples where helpful
- Include expected outputs
- Link to related documentation
- Use markdown formatting consistently

## RFC Process for Major Changes

For significant changes to the protocol, specification, or security model, please create an RFC (Request for Comments):

1. **Copy the template**:
   ```bash
   cp rfcs/0000-template.md rfcs/NNNN-your-proposal.md
   ```
   (Use the next available number)

2. **Fill in the RFC** with:
   - Summary (one paragraph)
   - Motivation (why we should do this)
   - Design (technical details, API/spec changes, alternatives considered)
   - Rollout plan
   - Unresolved questions

3. **Open a PR** with your RFC

4. **Discuss** - The community will review and provide feedback

5. **Decision** - Maintainers will accept, defer, or close the RFC

**When to use RFCs**:
- Changes to the Dossier protocol or execution model
- Changes to the schema specification
- New security features or trust models
- Breaking changes to existing behavior
- Significant new features

**When NOT to use RFCs**:
- Bug fixes
- Documentation improvements
- New example dossiers
- Minor tool improvements

## Code Review Process

All submissions require review. We use GitHub pull requests for this purpose.

**What reviewers look for**:
- Correctness and completeness
- Test coverage (where applicable)
- Documentation updates
- Security considerations
- Backwards compatibility
- Code quality and style

**Timeline**:
- Simple PRs (docs, examples): Usually reviewed within 2-3 days
- Complex PRs (code, spec changes): May take 1-2 weeks
- RFCs: May take several weeks for discussion

## Security Vulnerabilities

**Do NOT open public issues for security vulnerabilities.**

Please see [SECURITY.md](./SECURITY.md) for our vulnerability disclosure policy and contact information.

## Testing

### For Code Changes
- Add or update tests when modifying CLI or MCP server code
- Run existing tests: `npm test`
- Ensure builds complete: `npm run build`

### For Dossier Examples
- Execute the dossier with an LLM
- Verify all validation criteria pass
- Test edge cases and error conditions
- Document expected behavior

### For Documentation
- Check markdown formatting renders correctly
- Verify all links work
- Ensure code examples are syntactically correct
- Test any command-line examples

## Commit Message Guidelines

Write clear, descriptive commit messages:

**Good examples**:
```
Add database migration example dossier

Update README with adopter playbooks link

Fix checksum verification in CLI tool

docs: clarify MCP setup instructions
```

**Avoid**:
```
Update files
Fix bug
Changes
WIP
```

## License

By contributing to Dossier, you agree that your contributions will be licensed under the same license as the project (see [LICENSE](./LICENSE)).

## Questions?

- Check the [FAQ](./FAQ.md) for common questions
- Read the [QUICK_START](./QUICK_START.md) for usage guidance
- Review [SPECIFICATION.md](./SPECIFICATION.md) for the formal spec
- Open a discussion on GitHub for questions

## Recognition

Contributors will be recognized in:
- GitHub contributors list
- Release notes (for significant contributions)
- Example author attribution (in example READMEs)

Thank you for contributing to Dossier! 🎉
