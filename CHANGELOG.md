# Changelog

All notable changes to the Dossier project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **`@ai-dossier/worktree-pool` 0.6.0 — a partly-failed `return` no longer destroys the worktree, and no longer lets a caller report success over a pool that is not warm (#453).** `returnWorktree` ran as a bare sequence of git calls. Any failure after the entry was marked `recycling` hit a catch that destroyed the worktree, dropped the state row, and rethrew one opaque `Recycle failed (destroyed worktree)` — so the working tree was gone before anyone could look at why, and a failure that never reached that catch left the entry `assigned` with a dirty directory while the ship tail posted `cleanup=pool_returned` (imboard#3692). Nothing verified the happy path either: `return` printed "Worktree returned to pool" whenever no call happened to throw. The recycle is now transactional in outcome. Each step is named (`fetch`, `checkout-temp-branch`, `clean`, `rename`, `repair`, `read-base-commit`, `warm-commands`, `commit-state`, `verify`), every failure is attributed to exactly one of them and thrown as a typed `ReturnFailure`, and the entry is left `status: "broken"` — never `assigned`, never a falsely-`warm` spare — recording the failed step, a credential-redacted reason, and where the directory actually is. The directory is deliberately left on disk for inspection; `claim` never hands a broken entry out, and `gc` collects one immediately rather than after `stale_after_hours`, since it is unusable from the moment it is marked and occupies pool capacity until removed. The broken entry records a pool-owned temp branch and never the branch that happens to be checked out, so the provenance check that protects developer worktrees (#438) cannot be satisfied by whatever a failed return left behind. On success `return` self-checks against reality before reporting it — the entry re-read from `.pool-state.json` really says `warm`, no tracked file is dirty, and the new `pool/spare-*` branch is really checked out — and prints that self-check. New `worktree-pool status --json` and `return --path P --json` give callers the same facts as data, including per-entry `status`, `broken_step` and `broken_reason`, so a dossier can assert the return actually happened instead of trusting an exit code. `status` counts broken entries in their own column, and the pre-existing #443 "broken" *directory* reporting is renamed to "corrupted" so the two no longer share a word. `returnWorktree` returns a `ReturnResult` instead of `void` (breaking for programmatic callers); `ReturnResult`, `ReturnVerification`, `ReturnFailure` and `ReturnStep` are exported.
- **`@ai-dossier/worktree-pool` 0.5.3 — a claimed or recycled worktree no longer corrupts on the next `git worktree prune` (#443).** `claim` and `return` move the worktree directory with `fs.renameSync` and then ran `git worktree repair` with **no path**. A pathless repair only fixes the worktree->repo back-link; the repo-side `.git/worktrees/<id>/gitdir` forward link kept pointing at the old location. The next `git worktree prune` — which the pool runs itself after every removal, and which humans and agents run routinely — saw a dangling gitdir, deleted the admin dir, and left the renamed worktree with a `.git` file pointing at nothing (`fatal: not a git repository: .../.git/worktrees/<old-id>`). This is what made a pool entry look orphaned and set off the `gc` incident in #438. Both rename sites now pass the new path, as git requires for a manually moved worktree. Entries already corrupted this way are no longer a raw fatal: `status` lists them under `Broken`, and `claim` skips them and hands out the next warm spare (or reports the breakage and exits cleanly when there is none). Brokenness is reported independently of ownership, so nothing the pool did not create becomes removable by being broken.
- **`@ai-dossier/worktree-pool` 0.5.1 — `gc` no longer deletes worktrees it did not create (#438, data loss).** `pool_dir` is routinely the directory developers already keep their own worktrees in, and `gc` treated every directory there that was missing from `.pool-state.json` as an orphan: on imboard-monorepo it removed **29 developer worktrees** in one run, taking their uncommitted work with them (branch refs and commits survived; working-tree changes did not). Ownership was inferred from location. It is now inferred from provenance: a worktree is the pool's only if its path is recorded in `.pool-state.json`, or its directory name matches the pool's own `pool-<timestamp>-<pid>` naming **and** it has a `pool/spare-*` temp branch checked out. Everything else is reported as `foreign, skipped` and is never removed, reset, or cleaned — by `gc`, by `refresh`, or by a failed `return`. `git branch -D` is held to the same rule and only ever deletes `pool/spare-*` refs, so a corrupt state file cannot destroy a real branch. `gc` now prints the exact removal list before acting and requires confirmation — interactive when stdin is a TTY, `--yes` otherwise — and `gc --dry-run` prints the plan and exits. `status` lists foreign worktrees under "Other" without ever counting them as candidates. When a recorded worktree has drifted (its directory now holds a different branch), the stale row is dropped from state and the directory is left on disk rather than guessed at.

### Security
- Lockfile refresh closing production-dependency advisories flagged by `npm audit --omit=dev --audit-level=high` (`fast-uri`, `body-parser`, `@hono/node-server` and transitives). Lockfile-only — no `package.json` ranges changed. Two moderate advisories remain, below the CI threshold.
- Bump `hono` (4.12.18 → 4.12.30), `js-yaml` (3.14.2 → 3.15.0), and `qs` (2.0.2 → 2.0.4) to close pre-existing advisories flagged by `npm audit --audit-level=high`. Within-semver, no API changes.
- **Signatures now cover the frontmatter, not just the body.** Previously `risk_level`, `requires_approval`, `destructive_operations`, and `external_references` sat outside the signed payload, so they could be rewritten — downgrading the risk warning or removing the approval gate — while `verify` still reported "Verified signature from trusted source". New signatures carry `covers: "frontmatter+body"`; signatures without the field are treated as the legacy body-only scheme and still verify, so nothing already published breaks. The scheme name is inside the signed bytes, so a v2 signature cannot be replayed as v1.
- **Ed25519 public keys are emitted as raw 32-byte base64 again.** Since `ee09e81` (2025-11-18, "Replace minisign with Node.js crypto Ed25519") the signer emitted SPKI PEM while `dossier keys generate` printed — and `trusted-keys.txt` stored — raw base64. The trust check is a string comparison, so **no locally signed dossier could ever match a trusted key**, and every signed dossier verified as "valid but untrusted". Keys are now normalized before comparison; PEM and legacy minisign `RWT...` keys are still accepted on the read path.
- `dossier-schema.json`: the Ed25519 `public_key` pattern required minisign `^RWT...`, which nothing has produced since 2025-11-18 — so **every signed dossier failed `dossier lint`**. The pattern now accepts raw base64, SPKI PEM, and legacy minisign. Added `covers` and `signed_at` (the signer has always written `signed_at`; the schema documented only `timestamp`).
- **Public-key parsing is strict, closing a key-substitution primitive.** Node's base64 decoder silently discards characters it does not recognize and stops at the first `=` padding, and every raw Ed25519 key is 44 base64 characters ending in `=` — so `<any trusted key><arbitrary trailing text>` decoded to that key and normalized to it. A PEM was equally loose: OpenSSL ignores bytes before `-----BEGIN` and after `-----END`, so padded blobs parsed as the key inside. Decoding now requires a byte-exact round trip and a PEM must be one block and nothing else, so each string denotes at most one key and the key a trust check matches is provably the key `verify` runs against.
- **Trust is now decided on the key the signature is actually verified against**, chosen by algorithm: `public_key` for Ed25519, and `key_id` — the key ARN — for KMS, which asks KMS to verify and never reads the public key a KMS signature also carries. Previously either field could confer trust. The trust list is keyed by public key and public keys are public, so a dossier could name a trusted signer's public key in `key_id`, verify under an attacker's `public_key`, and still be reported as "Verified signature from trusted source: \<victim\>". Key normalization was a second substitution primitive: Node's base64 decoder stops at the first `=` padding and OpenSSL skips anything before `-----BEGIN`, so `<victim raw key>\n<attacker PEM>` normalized to the victim while `crypto.verify` used the attacker's key. Public keys now resolve through a single parse — one string denotes at most one key — and the PEM handed to `verify` is rebuilt from that same parse, so the key trusted and the key verified cannot drift apart.
- **The `dossier keys add` command `verify` prints is no longer built from unsanitized dossier bytes.** `signed_by` is free-form and attacker-controlled, and quotes, `$`, or backticks in it spliced arbitrary text into a command the user is invited to paste into a shell. The identifier is now reduced to `[a-z0-9._-]` and capped, and no command is offered at all unless the key is one `keys add` would accept. `keys add` also rejects multi-line identifiers, which would otherwise append a second, unapproved entry to the trust file.

### Added
- **New `ai-dossier runstate stats` — per-phase durations, derived rather than recorded (#451).** Every milestone already stamps `at=`, so a run's timings are latent in the trail the moment it is written; reading them meant hand-parsing issue comments, pairing consecutive milestones, and doing date arithmetic by eye. `runstate stats --issue <n>` prints a per-phase table (phase, status, started, ended, duration), one table per `run=` id so a resumed issue never has one run's wait charged to another's phase, and reports the gap between ship's two milestones as its own **`merge-wait`** row — the one span that measures waiting rather than working. `--issues 1,2,5..8` takes a fleet-style selection (capped at 200, since each issue costs a `gh` call) and reports per-phase median/min/max, per-run totals, and a breakdown by the `model=` the gate milestone records. Real trails are imperfect, so degraded reads are reported rather than guessed at: a milestone whose `at=` is an unexpanded `$(date …)` is skipped **and breaks the chain**, so the next phase reports `-` instead of a duration silently spanning two phases; a backwards span from disagreeing clocks is reported as negative and marks the aggregate rows it lands in; a run with one usable milestone has no total rather than a fabricated `0s`; and an unreadable issue is named and left out while the rest of the selection still reports. Read-only (`gh issue view` only) and exits 0 on any degraded read. Documented in [cli/README.md](./cli/README.md#stats).
- **New `ai-dossier runstate` command — `runstate:v1` workflow milestones are now a command, not a heredoc (#440).** Issue-workflow dossiers (`imboard-ai/git/full-cycle-issue` and friends) record each phase by appending a `<!-- runstate:v1 -->` comment to the GitHub issue; that trail is the only run state that survives a session, so a missing or mangled milestone makes a run unresumable. Reproducing the markdown template by hand failed in practice — agents skipped milestones entirely, or pasted the template's `$(date …)` into the comment verbatim. `runstate post` fills in the timestamp itself and validates phase, status, run id, and the per-phase required keys **before** anything is posted (`--dry-run` prints the body instead); `runstate last` and `runstate verify` are read-only and need no write access — `verify` implements `imboard-ai/git/gate-issue`'s resume table, checking every claim in the milestone against reality before reporting `resume_from`; `runstate mint` prints a fresh run id. Documented in [cli/README.md](./cli/README.md#runstate--workflow-milestones). Swapping the dossiers' heredocs for these commands is a separate change.
- `install-skill` now gates on dossier **identity** rather than mere existence. Reinstalling or upgrading the same dossier no longer needs `--force`; installing a *different* dossier over an existing skill directory is refused and names both. Two registry paths sharing a basename (e.g. `imboard-ai/idea-to-prd` and `imboard-ai/pm/idea-to-prd`) resolve to the same directory, and the old "already installed, use --force" message never said which one was there — so `--force` became reflexive, which is what made a real collision dangerous. Installed skills now record `x_source` (the full registry path) so identity can be compared.
- `sign.yml` runs weekly. It was dispatch-only, so when the repo was renamed the OIDC trust policy silently stopped matching and KMS signing was broken from 2025-11-06 to 2026-07-28 with nothing to notice. The scheduled run signs a throwaway artifact and turns a silent credential failure into a red check within days.

### Fixed
- **`dossier keys add` and the trust check now agree on one key encoding** (#426). `Ed25519Signer` writes `public_key` as a multi-line SPKI PEM while `keys generate` printed — and `trusted-keys.txt` stored — raw 32-byte base64, and the trust check compared the two as strings, so no Ed25519-signed dossier could ever be trusted through the documented `keys generate` → `keys add` → `verify` flow. `verify`'s own suggested fix made it worse: it printed the PEM, `keys add` appended it verbatim, and the line-oriented parser then shredded it into four entries matching nothing. `keys add` now stores the canonical raw base64 whatever form it is given, and PEM blocks already sitting in `trusted-keys.txt` are rejoined and honoured, so no file needs hand-editing. Because a PEM starts with `-`, pass it after `--`: `dossier keys add -- "$(cat key.pub)" "my-key"`.
- `dossier keys add` refuses input it cannot read as a key. A typo, a truncated key, or a path to a `.pub` file used to be written into the trust file under a ✅, and the only symptom was `dossier verify` saying "not trusted" forever after. Entries that still cannot be read are now named with their line number by `keys list` and by every `verify` — including an unterminated PEM block, which silently swallowed every entry after it.
- `toSkillFrontmatter` copies the parsed frontmatter before mutating it. `parseDossierContent` can return a shared object for identical input, so writing to it leaked fields between calls — an install without a source picked up the `x_source` of a previous one, and the `description`/`objective` fallback had the same flaw.
- Installed skills now carry standard `---` YAML frontmatter with `name` and `description` first, so agent runtimes can read them. Previously `install-skill` wrote the raw `---dossier` JSON block, and Claude Code surfaced the literal string `---dossier` as the skill's description — every authored trigger phrase was inert and skills could only be matched by name. Verifiability is unaffected: a v2 signature covers the parsed frontmatter, not its serialization, so checksum and signature still validate after conversion.
- `risk-level-consistency` now warns when `risk_factors` declares `merges_code`, `deletes_files`, or `modifies_cloud_resources` while `risk_level` is below `high`. It says nothing about `requires_approval` — running a high-consequence dossier autonomously is a policy choice, not an inconsistency.
- Schema vocabulary widened to match the registry. `category` gains `git`, `review`, `skills`, `workflow`, `orchestration` (24 usages across the corpus were failing lint). `risk_factors` gains `modifies_directory_structure`, `creates_pull_request`, `merges_code`, `incurs_cost` — consequences the original eight could not express, and which matter for the approval gate.
- **opencode integration for `install-skill`**: when `~/.config/opencode/` exists, dossier skills now dual-write a YAML-frontmatter wrapper to `~/.config/opencode/skills/<name>/SKILL.md` so [opencode](https://opencode.ai) can discover and trigger them. The signed source in `~/.claude/skills/` is never modified. Wrappers of delegating skills (body invokes `ai-dossier run`) include `allowedTools: [Bash(ai-dossier run *)]` so opencode auto-approves the delegation. Override with `--for claude|opencode|both`.
- New `ai-dossier sync-skills` command — retroactively generates opencode wrappers for skills already installed in `~/.claude/skills/` and prunes orphaned wrappers. Idempotent. Supports `--dry-run`, `--no-prune`, and `--json`.
- `install-skill --list` now badges each skill with the tools it's installed in (`[claude, opencode]` or `[claude]`); `install-skill --remove` cleans both locations.
- TTL-based version resolution for versionless dossier references (`run`, `create`, `install-skill`): stale versionless requests auto-update silently within a configurable window (default 300s). Resolution metadata lives under `~/.dossier/cache/.resolution/<name>.json`.
- New `--max-age <seconds>` flag on `run`, `create`, and `install-skill` (default 300, `0` = always re-check the registry).
- `--fresh` flag on `create` (already supported on `run` and `install-skill`) to bypass the resolution cache for one call.
- New config key `cache.resolutionTtlSeconds` (default `300`) in `~/.dossier/config.json`.
- New subcommand `ai-dossier cache resolutions` (with `--json`) to inspect cached versionless → version mappings.
- Stale-cache fallback: when the registry is unreachable and a cached version exists, the CLI uses the highest-semver cached copy and prints a loud stderr warning rather than failing.

### Removed
- Cosmetic "Update available: ...@X (run --pull to update)" warning at the end of `run`. Versionless requests now auto-update within the TTL window, so the warning is no longer needed.

## [v1.3.0 / v0.8.0] - 2026-03-07

### Fixed
- **Security**: Add Zod validation for MCP prompt handlers (was using `as string` casts)
- **Security**: Replace `execSync` with `execFileSync` in CLI helpers
- Fix 30+ broken relative links across documentation
- Fix all remaining stale Node 18 references (architecture overview, workflows, validation, examples, issue template)
- Fix stale `@dossier` scope references → `@ai-dossier`
- Purge all "GitHub Packages" references from active docs (workflows.md, getting-started)
- Remove all "coming soon" stubs (docs.dossier.sh, security-scan, newsletter)
- Fix outdated GitHub Actions v3 → v4 in validation README
- Remove phantom guide entries from docs/guides/README.md

### Changed
- Use `npm ci` in publish workflow and CI lint job (was `npm install`)
- Add coverage thresholds to worktree-pool vitest config
- Rewrite docs/getting-started/README.md with clear 5-step learning path
- Clarify README status: separate protocol v1.0 from CLI version
- Update CLI roadmap with v0.6.0, v0.7.0, and v0.8.0 sections
- Update CHANGELOG release process: "GitHub Packages" → "npm"
- Add `.nvmrc` for auto Node version switching

### Package Versions
- `@ai-dossier/core` 1.3.0
- `@ai-dossier/cli` 0.8.0
- `@ai-dossier/mcp-server` 1.3.0
- `@ai-dossier/worktree-pool` 0.4.0

## [v1.2.0 / v0.7.0] - 2026-03-07

### Fixed
- **Security**: Replace `execSync` shell interpolation with `execFileSync` in worktree-pool (command injection prevention)
- **Security**: Add Zod validation for MCP tool call arguments (replace unsafe `as unknown as` casts)
- Fix Node engine requirement to `>=20.0.0` across all packages (aligns with vitest v4 / vite v7)
- Fix broken doc links in CONTRIBUTING.md and installation guide (`.md` → `.ds.md`)
- Fix "Node.js 18+" references across docs and examples to "Node.js 20+"
- Fix "No Dependencies" claim in CLI README
- Align vitest to v4 in mcp-server (was v3)
- Fix Makefile `verify` target to use correct binary path

### Changed
- Use `npm ci` in CI for deterministic builds
- Move academic references from README to REFERENCES.md
- Remove internal PLANNING-*.md files from repo root
- Remove deprecated `preferGlobal` from CLI package.json
- Add CODEOWNERS file
- Add coverage thresholds to mcp-server and registry vitest configs
- Update `actions/checkout@v3` → `@v4` in adopter playbooks

### Package Versions
- `@ai-dossier/core` 1.2.0
- `@ai-dossier/cli` 0.7.0
- `@ai-dossier/mcp-server` 1.2.0
- `@ai-dossier/worktree-pool` 0.3.0

## [@ai-dossier/cli@0.5.0 – 0.6.0] - 2026-02-28

### Added
- `@ai-dossier/worktree-pool` package for pre-warmed git worktree management (#354)
- Pool-aware setup-issue-workflow and full-cycle-issue dossiers (#361)
- Unified dossier+skill creation template (#360)
- Plugin marketplace install as primary path in READMEs
- npm publish pipeline for `@ai-dossier/worktree-pool` (#362)

### Changed
- Improved package READMEs for npm publishing (#364)

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
6. GitHub Actions will publish to npm

For detailed publishing instructions, see [docs/guides/publishing-packages.md](docs/guides/publishing-packages.md).

[Unreleased]: https://github.com/imboard-ai/ai-dossier/compare/v1.3.0...HEAD
[v1.3.0 / v0.8.0]: https://github.com/imboard-ai/ai-dossier/compare/v1.2.0...v1.3.0
[v1.2.0 / v0.7.0]: https://github.com/imboard-ai/ai-dossier/compare/v0.6.0...v1.2.0
[@ai-dossier/cli@0.5.0 – 0.6.0]: https://github.com/imboard-ai/ai-dossier/compare/v0.4.1...v0.6.0
[@ai-dossier/cli@0.4.1]: https://github.com/imboard-ai/ai-dossier/compare/v0.4.0...v0.4.1
[@ai-dossier/cli@0.4.0]: https://github.com/imboard-ai/ai-dossier/compare/v0.3.0...v0.4.0
[@ai-dossier/cli@0.3.0]: https://github.com/imboard-ai/ai-dossier/compare/v0.2.1...v0.3.0
[@dossier/core@1.0.0]: https://github.com/imboard-ai/ai-dossier/releases/tag/v1.0.0
[@dossier/cli@0.1.0]: https://github.com/imboard-ai/ai-dossier/releases/tag/v0.1.0
[@dossier/mcp-server@1.0.0]: https://github.com/imboard-ai/ai-dossier/releases/tag/v1.0.0
