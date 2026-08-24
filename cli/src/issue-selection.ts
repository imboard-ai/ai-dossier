/**
 * Fleet-style issue selections — `1,2,3`, `1..9`, or mixed `1,2,5..8`.
 *
 * The grammar is `imboard-ai/git/fleet-cycle`'s, so an operator can paste the selection
 * they dispatched a fleet with straight into a command that measures it.
 */

import { isIssueNumber } from './runstate';

/**
 * Most issues a single selection may expand to.
 *
 * Each issue costs a `gh` round trip, so a mistyped range (`1..10000`, or `1..99` written
 * `1..999`) would sit there firing thousands of requests before anyone noticed. The cap
 * turns that into an immediate, named error.
 */
export const MAX_ISSUE_SELECTION = 200;

/**
 * Digits an issue number may have before it stops surviving a `Number()` round trip.
 *
 * A caller that parses the selection and prints the numbers back gets `1e+23` from a
 * 23-digit string, and `Infinity` from a long enough one — so an absurd number would reach
 * the API as a value nobody typed. `Number.MAX_SAFE_INTEGER` is 16 digits.
 */
const MAX_ISSUE_DIGITS = 15;

/** Every error here carries its own fix line, so a caller can print it unmodified. */
function selectionError(cause: string, fix: string): Error {
  return new Error(`${cause}\nFix: ${fix}`);
}

/**
 * Expand an issue selection into a sorted, de-duplicated list.
 *
 * @throws Error naming the offending token, so a typo in one of nine terms is not reported
 * as a failure of the whole selection. The message carries its own `Fix:` line.
 */
export function parseIssueSelection(raw: string): number[] {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw selectionError(
      `Empty issue selection.`,
      `pass a list or range of issue numbers, e.g. --issues 1,2,5..8.`
    );
  }

  const issues = new Set<number>();
  for (const token of trimmed.split(',')) {
    const term = token.trim();
    if (term === '') {
      throw selectionError(
        `Empty term in issue selection '${raw}'.`,
        `remove the stray comma — a selection looks like 1,2,5..8.`
      );
    }
    for (const issue of expandTerm(term, raw)) issues.add(issue);
    // Checked inside the loop so an enormous FIRST range fails before the rest expands.
    if (issues.size > MAX_ISSUE_SELECTION) {
      throw selectionError(
        `Issue selection '${raw}' expands past ${MAX_ISSUE_SELECTION} issues, and each one costs a gh call.`,
        `narrow the selection to at most ${MAX_ISSUE_SELECTION} issues, or run it in batches.`
      );
    }
  }

  return [...issues].sort((a, b) => a - b);
}

/** One comma-separated term: a single issue, or an inclusive `a..b` range. */
function expandTerm(term: string, raw: string): number[] {
  const range = term.split('..');
  if (range.length === 1) return [requireIssue(term, raw)];
  if (range.length !== 2) {
    throw selectionError(
      `Malformed range '${term}' in '${raw}'.`,
      `write a range as <from>..<to>, e.g. 5..8.`
    );
  }

  const from = requireIssue(range[0], raw);
  const to = requireIssue(range[1], raw);
  if (to < from) {
    throw selectionError(`Descending range '${term}' in '${raw}'.`, `write it as ${to}..${from}.`);
  }
  // Bounded before materialising: `1..1000000` must not allocate a million-entry array on
  // its way to the selection cap.
  if (to - from + 1 > MAX_ISSUE_SELECTION) {
    throw selectionError(
      `Range '${term}' covers ${to - from + 1} issues, past the ${MAX_ISSUE_SELECTION} cap, and each one costs a gh call.`,
      `narrow the range to at most ${MAX_ISSUE_SELECTION} issues, or run it in batches.`
    );
  }

  const out: number[] = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

function requireIssue(value: string, raw: string): number {
  const term = value.trim();
  if (!isIssueNumber(term) || term.length > MAX_ISSUE_DIGITS) {
    throw selectionError(
      `Invalid issue '${term}' in '${raw}'.`,
      `expected a positive issue number of at most ${MAX_ISSUE_DIGITS} digits, e.g. --issues 1,2,5..8.`
    );
  }
  return Number(term);
}
