# Changelog

All notable changes to the Dossier project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [@ai-dossier/cli@0.4.1] - 2026-02-20

### Fixed
- Skip URL download in dry-run mode (#128)
- Detect non-TTY stdin and fail gracefully instead of hanging (#107, #127)
- Add CDN propagation warning after publish and remove (#106, #118)
- install-skill cache validation, `--fresh` flag, and `--json` output (#117)

### Changed
- Return `VerifyResult` from crypto verification instead of bare boolean (#83, #125)
- Use core `validateFrontmatter` and import constants from core (#119, #123)

### Added
- `--json` flag on `remove`, `whoami`, `list`, and `publish` commands (#105, #102, #121, #114)
- `commands` command for JSON inventory of all CLI commands (#122)
- Publish collision warning and full path output (#114)

## [@ai-dossier/cli@0.4.0] - 2026-01-15

### Added
- Unified dossier parser across core/cli/mcp (#81, #115)
- Registry integration — merged dossier-registry into monorepo (#68)
- Batch verification for dossier graphs (#71, #111)
- Dependency graph resolver for dossier relationships (#100)

### Changed
- License changed from ELv2 to AGPL-3.0 (#129)
- Use core library signers directly in sign command (#99)
- Upgraded to Node 24 and ES2024 target

### Fixed
- Security vulnerabilities in dependencies (#65)
- Biome lint enforcement on every commit and PR (#57)

## [@ai-dossier/cli@0.3.0] - 2025-12-15

### Added
- Modular TypeScript migration from monolithic CLI (#54, #59)
- Comprehensive test suite with 261+ tests (#47, #62)
- CLI parity with dossier-tools (#61, #63, #64)
- npm CI/CD publishing under `@ai-dossier` scope (#48)

### Changed
- Package scope: `@imboard-ai/*` → `@ai-dossier/*`
- Default registry URL updated to `dossier-registry.vercel.app`

## [@imboard-ai/dossier-cli@0.2.1] - 2025-11-15

### Added
- **`dossier run` command** - Complete verify, audit, and execute workflow
  - 5-stage verification pipeline:
    - Stage 1: Integrity (checksum + signature)
    - Stage 2: Author whitelist/blacklist (demo mode)
    - Stage 3: Dossier whitelist/blacklist (demo mode)
    - Stage 4: Risk assessment
    - Stage 5: Review dossier analysis (demo mode)
  - LLM auto-detection (Claude Code, Cursor)
  - Console audit logging
  - Dry-run mode
  - Configurable verification flags (--skip-* options)
  - Custom review dossier support

### Features
- Multi-stage security verification with toggleable checks
- Audit trail logging (console output for MVP)
- LLM execution integration
- Risk-based prompts (--force, --no-prompt)

## [@imboard-ai/dossier-cli@0.2.0] - 2025-11-15

### Added
- Multi-command CLI structure with 10 commands
- Command router using commander.js framework
- Placeholder commands: run, create, list, sign, publish, checksum, validate, init, info
- Comprehensive help system with roadmap guidance
- Registry sharing workflow (publish command - MVP simulation)

### Changed
- **BREAKING**: Removed `dossier-verify` command - use `dossier verify` instead
- Command structure: `dossier <command>` instead of standalone binary
- Package scope: `@dossier/*` → `@imboard-ai/*` (GitHub Packages requirement)
- Updated all imports and dependencies

### Fixed
- MODULE_NOT_FOUND error from package scope migration
- Import statements updated to new package names

## [Documentation] - 2025-11-15

### Added
- Comprehensive documentation restructure following Diataxis framework
- Architecture Decision Records (ADRs) structure
- Root ARCHITECTURE.md for quick reference
- Root CHANGELOG.md for version tracking
- CLI evolution planning document

### Changed
- Reorganized documentation from root to `docs/` folder
- Moved 20+ markdown files to appropriate `docs/` subdirectories
- Updated documentation to follow OSS best practices

## [@dossier/core@1.0.0] - 2024-11-15

### Added
- Core verification and parsing library
- SHA256 checksum verification
- Minisign signature verification
- AWS KMS signature verification
- TypeScript type definitions

### Dependencies
- `@aws-sdk/client-kms` ^3.927.0
- `tweetnacl` ^1.0.3

## [@dossier/cli@0.1.0] - 2024-11-15

### Added
- Command-line verification tool
- Support for local files and remote URLs
- Verbose mode for detailed output
- Exit codes for scripting integration
- npm publishing configuration
- GitHub Packages publishing support

### Dependencies
- `@dossier/core` ^1.0.0

## [@dossier/mcp-server@1.0.0] - 2024-11-15

### Added
- Model Context Protocol server implementation
- Resource discovery for dossiers
- Verification tools for AI agents
- Integration with Claude Code and other MCP clients

### Dependencies
- `@dossier/core` ^1.0.0
- `@modelcontextprotocol/sdk`
- `zod` for schema validation

## [Documentation] - 2024-11-15

### Added
- Getting Started guides
- How-to Guides
- Tutorials structure
- Reference documentation (Protocol, Schema, Specification)
- Explanation documentation (Concepts, FAQ, Security Model)
- Architecture documentation with overview and ADR structure
- Contributing guidelines
- Planning and roadmap documentation

### Infrastructure
- GitHub Actions workflow for automated publishing
- CI/CD pipeline for npm package distribution
- Publishing guide for maintainers

## Earlier History

See git commit history for changes before structured changelog:
```bash
git log --oneline
```

---

## Types of Changes

- **Added** - New features
- **Changed** - Changes in existing functionality
- **Deprecated** - Soon-to-be removed features
- **Removed** - Removed features
- **Fixed** - Bug fixes
- **Security** - Vulnerability fixes

## Release Process

1. Update version in package.json files
2. Update CHANGELOG.md with release notes
3. Commit changes
4. Tag release: `git tag v1.0.0`
5. Push: `git push && git push --tags`
6. GitHub Actions will publish to GitHub Packages

For detailed publishing instructions, see [docs/guides/publishing-packages.md](docs/guides/publishing-packages.md).

[Unreleased]: https://github.com/imboard-ai/ai-dossier/compare/v0.4.1...HEAD
[@ai-dossier/cli@0.4.1]: https://github.com/imboard-ai/ai-dossier/compare/v0.4.0...v0.4.1
[@ai-dossier/cli@0.4.0]: https://github.com/imboard-ai/ai-dossier/compare/v0.3.0...v0.4.0
[@ai-dossier/cli@0.3.0]: https://github.com/imboard-ai/ai-dossier/compare/v0.2.1...v0.3.0
[@dossier/core@1.0.0]: https://github.com/imboard-ai/ai-dossier/releases/tag/v1.0.0
[@dossier/cli@0.1.0]: https://github.com/imboard-ai/ai-dossier/releases/tag/v0.1.0
[@dossier/mcp-server@1.0.0]: https://github.com/imboard-ai/ai-dossier/releases/tag/v1.0.0
