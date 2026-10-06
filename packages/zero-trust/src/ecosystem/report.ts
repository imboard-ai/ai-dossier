/** Reads the junit report a supervised test command wrote (#1010). The bytes come
 * from inside the VM and are untrusted: the parse is bounded, counts elements only,
 * and anything it cannot read is `null`, which classification treats as inconclusive. */
import { MAX_REPORT_BYTES } from '../vm/broker';

export interface JunitSummary {
  /** Suites with at least one test case. Node's junit reporter may put top-level
   * test cases directly under `<testsuites>`; those count as one suite. */
  readonly suites: number;
  readonly tests: number;
  /** Test cases with a `<failure>` or `<error>` child. */
  readonly failures: number;
  readonly skipped: number;
}

/** Splits the document into test-case bodies without an XML parser: junit is flat
 * enough, and a regex over a capped, entity-free scan cannot be made to expand. */
export function parseJunitReport(bytes: Buffer | null | undefined): JunitSummary | null {
  if (!bytes || bytes.length === 0 || bytes.length > MAX_REPORT_BYTES) return null;
  const text = bytes.toString('utf8');
  // A DTD could define entities; junit never needs one.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return null;
  if (!/<testsuites[\s>]|<testsuite[\s>]/.test(text)) return null;
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  const caseRe = /<testcase\b[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of text.matchAll(caseRe)) {
    tests++;
    const body = match[2] ?? '';
    if (/<(failure|error)\b/.test(body)) failures++;
    else if (/<skipped\b/.test(body)) skipped++;
  }
  // A suite counts only when it holds test cases directly.
  let suites = 0;
  let topLevel = false;
  const suiteRe = /<testsuite\b[^>]*?(\/>|>([\s\S]*?)<\/testsuite>)/g;
  for (const match of text.matchAll(suiteRe)) if (/<testcase\b/.test(match[2] ?? '')) suites++;
  if (suites === 0 && tests > 0) topLevel = true;
  return Object.freeze({ suites: topLevel ? 1 : suites, tests, failures, skipped });
}
