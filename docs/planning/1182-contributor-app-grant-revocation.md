# Issue #1182: contributor App grant cannot be revoked after cancel

## Problem
Normal broker endRun revokes individual run tokens, not the contributor's App authorization. Once those tokens are dead, deleting the grant with them returns 404. Current terminal status omits the manual revocation action documented in the live acceptance runbook. The issue explicitly permits manual cancel/status guidance as the fix.

## Acceptance Criteria
- [ ] AC1 Cancelled and completed terminal status tells the contributor to revoke the App under Settings → Applications → Authorized GitHub Apps.
- [ ] AC2 Cleanup-blocked status retains its cleanup instruction and adds the same manual grant guidance; human and JSON output agree, including status with tracker instructions.
- [ ] AC3 Guidance distinguishes run-token cleanup from App authorization and does not claim a grant was deleted or initiate OAuth/network writes.

## Approach
1. Define fixed manual App authorization guidance in the pure controller status module.
2. Append it to terminal and cleanup-blocked nextPermittedAction after existing precedence selection so tracker/handoff instructions remain intact.
3. Exercise cancelled, merged/completed, cleanup-blocked, and active status through both real renderers.
4. Clarify normal endRun versus incident grant deletion in README and acceptance runbook.

## Reachability Evidence
N/A — copy/status defect on existing lifecycle states, not a new state or data-driven flow. Issue #1182 records the live acceptance cancellation case. Broker endRun's current token-first path and runbook section 7 confirm the underlying limitation.

## Predicted Files
- `packages/zero-trust/src/controller/status.ts` — append fixed manual guidance.
- `packages/zero-trust/src/controller/status.test.ts` — output and precedence regression.
- `packages/zero-trust/README.md` — normal cleanup versus grant revocation.
- `docs/features/zero-trust-full-cycle/acceptance-runbook.md` — explain status guidance.

## Reusable Code
- assembleStatus, TERMINAL_STATES, renderHuman and renderJson retain the existing safe status schema.
- Broker endRun and killAll already distinguish per-run cleanup and grant deletion; preserve their authority boundaries.

## Risk Areas
- Do not imply token revocation proves App authorization was removed; guidance is conditional on the App still appearing in settings.
- Keep cleanup-blocked and tracker instructions visible rather than replacing them.
- Concurrent #1181 owns wiring/evidence persistence; #1191 owns Controller.step notices; #1202 owns uncertain expiry. No edits to those surfaces.
- Read AGENTS.md and full agent-traps.md; follow safe worktree, no-stash, native CI and release mechanism rules. Planning uses docs/planning because PLANNING files are ignored.

## Test Scope
- Focused status regression red on isolated base and green on HEAD.
- Existing controller status and CLI renderer/dispatch tests; zero-trust workspace suite, build and repo lint.

## Open Questions
None. Choose the explicitly authorized manual-guidance alternative; no new full-revocation consent setting.

## Visual Review
- [x] Not required (CLI/backend status text only)

## Base Branch
`main`
