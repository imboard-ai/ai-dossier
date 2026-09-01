/**
 * Shared table-cell formatters for `runs.jsonl`-derived numbers (#524) —
 * `ai-dossier history` and `ai-dossier sched stats` both render token/cost
 * columns from the same nullable-number convention (null = not reported,
 * never a fabricated 0), so the formatting exists once. Same story as
 * `cli/src/duration.ts`: "each grew its own formatter... these are the
 * shared ones."
 */

/** Cost display precision: agent-run costs are small, so keep four decimals. */
export const COST_DECIMALS = 4;

export const isCount = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function formatCost(usd: number | null | undefined): string {
  return isCount(usd) ? `$${usd.toFixed(COST_DECIMALS)}` : '-';
}

/** A single count cell; '-' when not reported. */
export function formatCount(value: number | null | undefined): string {
  return isCount(value) ? String(value) : '-';
}

/** Token cell as "in/out"; '-' when neither side was reported (old entries). */
export function formatTokenPair(
  input: number | null | undefined,
  output: number | null | undefined
): string {
  if (!isCount(input) && !isCount(output)) return '-';
  return `${isCount(input) ? input : '-'}/${isCount(output) ? output : '-'}`;
}
