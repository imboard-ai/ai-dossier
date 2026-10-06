/** Reads the junit report a supervised test command wrote (#1010). The bytes come
 * from inside the VM and are untrusted: the parse is bounded, counts elements only,
 * and anything it cannot read is `null`, which classification treats as inconclusive. */
import { MAX_REPORT_BYTES } from '../vm/adapter';

export interface JunitSummary {
  /** Suites with at least one test case. Node's junit reporter may put top-level
   * test cases directly under `<testsuites>`; those count as one suite. */
  readonly suites: number;
  readonly tests: number;
  /** Test cases with a `<failure>` or `<error>` child. */
  readonly failures: number;
  readonly skipped: number;
}

/** Element tags in document order, found by one forward scan: each match starts after
 * the previous one, so the work is linear in the report size whatever it contains. */
const TAG = /<(\/?)(testsuites|testsuite|testcase|failure|error|skipped)\b[^<>]*?(\/?)>/g;

type CaseOutcome = 'passed' | 'failed' | 'skipped';

/** Counts suites, cases and outcomes without an XML parser: junit is flat enough, and
 * a single linear scan over a capped, DTD-free document cannot be made to expand. */
export function parseJunitReport(bytes: Buffer | null | undefined): JunitSummary | null {
  if (!bytes || bytes.length === 0 || bytes.length > MAX_REPORT_BYTES) return null;
  const text = bytes.toString('utf8');
  // A DTD could define entities; junit never needs one.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null;
  let sawRoot = false;
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  let suites = 0;
  let topLevelCases = 0;
  /** Open suites, innermost last: whether each has held a test case yet. */
  const openSuites: boolean[] = [];
  /** Outcome of the open test case, or null outside one. */
  let openCase: CaseOutcome | null = null;
  const closeCase = () => {
    if (openCase === 'failed') failures++;
    else if (openCase === 'skipped') skipped++;
    openCase = null;
  };
  for (const [, closing, name, selfClosing] of text.matchAll(TAG)) {
    if (name === 'testsuites') sawRoot = true;
    else if (name === 'testsuite') {
      sawRoot = true;
      if (!closing && !selfClosing) openSuites.push(false);
      else if (closing && openSuites.pop()) suites++;
    } else if (name === 'testcase') {
      if (closing || openCase !== null) closeCase();
      if (closing) continue;
      tests++;
      if (openSuites.length) openSuites[openSuites.length - 1] = true;
      else topLevelCases++;
      openCase = 'passed';
      if (selfClosing) closeCase();
    } else if (!closing && openCase !== null)
      // A failure or error outranks a skip within one case.
      openCase = name === 'skipped' && openCase !== 'failed' ? 'skipped' : 'failed';
  }
  closeCase();
  if (!sawRoot) return null;
  return Object.freeze({
    suites: suites + (topLevelCases > 0 ? 1 : 0),
    tests,
    failures,
    skipped,
  });
}
