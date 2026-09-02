/**
 * The hard-block label vocabulary — one list, shared by every screen that
 * asks "may this issue be dispatched?".
 *
 * Three consumers now read it, which is why it lives here rather than in the
 * CLI: the enqueue-time pre-screen (`cli/src/commands/sched.ts`, #507), the
 * classify-time pre-screen (`cli/src/prescreen.ts`, #538), and the engine's
 * per-tick re-check (`engine.ts`'s `reconcileLabelBlocks`, #544). The engine
 * is inside this package and cannot import from `cli` — the dependency runs
 * the other way — so the canonical copy is here and
 * `cli/src/hard-block-labels.ts` re-exports it. A second copy is exactly how
 * an enqueue screen and a tick screen would silently disagree about which
 * labels block.
 *
 * I/O-free by design: callers hand in label names they read themselves
 * (`gh issue view --json labels`), the same discipline `enqueue.ts` follows.
 */

/**
 * Labels that mean an issue was already determined undispatchable — by a
 * prior full-cycle hand-off (`decision-pending`, applied by the Guiding
 * Principle hand-off) or by triage (`needs-clarification`, `epic`,
 * `decomposed`, the same three gate-issue Step 2 hard-blocks on). This is
 * NOT gate-issue's list verbatim: gate-issue additionally hard-blocks
 * `batch-epic`, a batch-ANCHOR concern with no equivalent for a per-issue
 * screen, so it is deliberately left out here.
 *
 * Order is significant: when an issue carries more than one of these
 * labels, the FIRST match in this array is the one recorded in `reason` —
 * reordering the array changes which reason gets recorded.
 *
 * `decision-pending` here is the GitHub LABEL, not the `IssueStatus` value
 * of the same name (`types.ts`).
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

/**
 * The `reason` prefix a hard-block-labelled entry carries (#507), and the one
 * place that builds it — the CLI's journal event and the entry's `reason`
 * must read identically, so both call this rather than templating the string
 * twice.
 */
export const LABEL_BLOCK_REASON_PREFIX = 'label:';

/** `reason`/journal-`reason` value for an entry blocked by GitHub label `label`. */
export function labelBlockReason(label: string): string {
  return `${LABEL_BLOCK_REASON_PREFIX}${label}`;
}

/**
 * The inverse of {@link labelBlockReason} (#544): the label name inside a
 * `label:<name>` block reason, or `null` for any other reason — a
 * dependency block, an eviction, `auto-merge-blocked`. The engine's per-tick
 * re-check uses this to pick out exactly the entries #507's enqueue screen
 * blocked, so a `blocked` entry parked for an unrelated reason is never
 * unblocked by a clean label read.
 *
 * An empty name (`'label:'`) is not a label block — no GitHub label has an
 * empty name, so a bare prefix is malformed, not a match.
 */
export function labelOfBlockReason(reason: string | null): string | null {
  if (reason === null || !reason.startsWith(LABEL_BLOCK_REASON_PREFIX)) return null;
  const name = reason.slice(LABEL_BLOCK_REASON_PREFIX.length);
  return name.length > 0 ? name : null;
}
