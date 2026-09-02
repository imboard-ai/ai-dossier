/**
 * The hard-block label policy, re-exported from `@ai-dossier/sched` (#544).
 *
 * The canonical list moved into the scheduler package because a THIRD screen
 * now reads it — the engine's per-tick re-check (`reconcileLabelBlocks`) —
 * and the engine cannot import from the CLI (the dependency runs the other
 * way). This module stays as the CLI's import site so the enqueue-time
 * pre-screen (`commands/sched.ts`, #507) and the classify-time pre-screen
 * (`prescreen.ts`, #538) are unchanged, and so all three screens can only
 * ever agree about which labels block.
 *
 * `decision-pending` here is the GitHub LABEL, not the `IssueStatus` value of
 * the same name.
 */

export { HARD_BLOCK_LABELS, pickHardBlockLabel } from '@ai-dossier/sched';
