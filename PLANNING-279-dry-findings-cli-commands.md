# Issue #279: Review: DRY findings — repeated patterns in CLI commands

## Type
refactor

## Problem Statement
DRY violations found during review of #276:

1. Registry error logging pattern (repeated in 4+ files) — search.ts, list.ts, export.ts, pull.ts, get.ts all use identical `for (const e of result.errors)` pattern → Extract `logRegistryErrors()` utility
2. Dossier metadata field extraction (repeated in 3+ files) — search.ts, list.ts, get.ts extract name/version/title/category identically → Extract `formatDossierFields()` utility
3. Pagination display logic (repeated in 2 files) — search.ts and list.ts have identical pagination calculation and display → Extract `logPaginationInfo()` utility
4. SHA256 checksum reimplemented in pull.ts — `packages/core/src/utils/crypto.ts` already exports `sha256Hex()`, pull.ts reimplements it inline → Import from `@ai-dossier/core`

## Implementation Checklist
- [ ] Identify all DRY violations in the CLI commands
- [ ] Extract `logRegistryErrors()` utility
- [ ] Extract `formatDossierFields()` utility
- [ ] Extract `logPaginationInfo()` utility
- [ ] Replace inline SHA256 in pull.ts with import from @ai-dossier/core
- [ ] Update all affected files to use the new utilities
- [ ] Run tests
- [ ] Self-review

## Files to Modify
- cli/src/commands/search.ts
- cli/src/commands/list.ts
- cli/src/commands/export.ts
- cli/src/commands/pull.ts
- cli/src/commands/get.ts
- cli/src/utils/ (new utility file or add to existing)

## Testing Strategy
- [ ] Run existing tests to establish baseline
- [ ] Verify all CLI commands still work after refactoring
- [ ] Add unit tests for extracted utilities
