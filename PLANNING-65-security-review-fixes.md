# Issue #65: Security review: 2 critical, 3 high, 4 medium vulnerabilities found

## Type
bug

## Problem Statement

Comprehensive security review found 2 critical, 3 high, and 4 medium vulnerabilities in the dossier codebase.

## Implementation Checklist

### P0 - Critical
- [ ] **#1** Replace `exec()` with `execFile()` in `openBrowser()` (`cli/src/oauth.ts:47-61`)
- [ ] **#2** Replace `execSync()` with `spawnSync()` in `buildLlmCommand` and callers (`cli/src/helpers.ts:174-198`, `cli/src/commands/run.ts:209-220`, `cli/src/commands/create.ts:73-84`)

### P1 - High
- [ ] **#3** Validate dossier names to prevent path traversal (`commands/run.ts`, `commands/pull.ts`, `commands/install-skill.ts`, `commands/cache.ts`)
- [ ] **#4** Implement JWT signature verification in OAuth flow (`cli/src/oauth.ts:84-130`)
- [ ] **#5** Add path validation to MCP server tools (`mcp-server/src/tools/readDossier.ts`, `mcp-server/src/tools/listDossiers.ts`)

### P2 - Medium
- [ ] **#9** Add integrity verification to `install-skill` (`cli/src/commands/install-skill.ts:118-129`)
- [ ] **#7** Verify credential file permissions on read (`cli/src/credentials.ts:45-64`)
- [ ] **#8** Set explicit `mode: 0o600` on config writes (`cli/src/config.ts:61`)

### P3 - Low/Informational
- [ ] **#10** Replace false "PASSED" with "NOT IMPLEMENTED" in no-op verification stages (`cli/src/helpers.ts:231-281`)
- [ ] **#6** Generate test keys dynamically instead of committing private key

### Final
- [ ] Add/update tests for all changes
- [ ] Self-review the changes
- [ ] Create pull request

## Files to Modify

### Critical
- `cli/src/oauth.ts` - Fix command injection in `openBrowser()`
- `cli/src/helpers.ts` - Fix `buildLlmCommand()` to use arg arrays
- `cli/src/commands/run.ts` - Use `spawnSync()` instead of `execSync()`
- `cli/src/commands/create.ts` - Use `spawnSync()` instead of `execSync()`

### High
- `cli/src/commands/run.ts` - Add path traversal validation
- `cli/src/commands/pull.ts` - Add path traversal validation
- `cli/src/commands/install-skill.ts` - Add path traversal validation
- `cli/src/commands/cache.ts` - Add path traversal validation
- `cli/src/oauth.ts` - Add JWT signature verification
- `mcp-server/src/tools/readDossier.ts` - Add path validation
- `mcp-server/src/tools/listDossiers.ts` - Add path validation

### Medium
- `cli/src/commands/install-skill.ts` - Add integrity verification
- `cli/src/credentials.ts` - Check file permissions on read
- `cli/src/config.ts` - Set `mode: 0o600` on writes
- `cli/src/helpers.ts` - Fix no-op verification stage labels

## Testing Strategy
- [ ] Unit tests for each fix
- [ ] Integration tests for command injection fixes
- [ ] Manual testing of OAuth flow
- [ ] Path traversal exploit testing

## Notes
- Prioritized by severity: P0 > P1 > P2 > P3
- Each fix should be a separate, reviewable commit
- JWT verification (P1 #4) may require coordination with registry backend

## Related Issues/PRs
- Issue: #65
