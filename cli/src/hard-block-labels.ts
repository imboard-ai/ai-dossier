/**
 * Labels that mean an issue was already determined undispatchable — by a
 * prior full-cycle hand-off (`decision-pending`, applied by the Guiding
 * Principle hand-off) or by triage (`needs-clarification`, `epic`,
 * `decomposed`, the same three gate-issue Step 2 hard-blocks on). This is
 * NOT gate-issue's list verbatim: gate-issue additionally hard-blocks
 * `batch-epic`, a batch-ANCHOR concern with no equivalent for a per-issue
 * screen, so it is deliberately left out here.
 *
 * Shared by the enqueue-time pre-screen (`commands/sched.ts`, #507) and the
 * classify-time pre-screen (`prescreen.ts`, #538) — one label policy, two
 * consumers, so the list never drifts between them.
 *
 * Order is significant: when an issue carries more than one of these
 * labels, the FIRST match in this array is the one recorded in `reason` —
 * reordering the array changes which reason gets recorded.
 *
 * `decision-pending` here is the GitHub LABEL, not the `IssueStatus` value
 * of the same name (`packages/sched/src/types.ts`).
 */
export const HARD_BLOCK_LABELS = [
  'decision-pending',
  'needs-clarification',
  'epic',
  'decomposed',
] as const;

/** The first hard-block label `labels` carries (case-insensitive), or `null`. */
export function pickHardBlockLabel(labels: readonly string[]): string | null {
  const normalized = labels.map((label) => label.toLowerCase());
  return HARD_BLOCK_LABELS.find((label) => normalized.includes(label)) ?? null;
}
