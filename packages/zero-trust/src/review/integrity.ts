import {
  comparePaths,
  type SourceEntry,
  type SourceManifest,
  validateManifest,
} from '../canonical/export';
import type { JunitSummary } from '../ecosystem/report';
import { assertNoSecrets } from '../redaction';

export type IntegrityCode =
  | 'test_deleted'
  | 'test_disabled'
  | 'assertions_reduced'
  | 'discovery_reduced'
  | 'discovery_unknown'
  | 'config_changed'
  | 'generated_or_binary'
  | 'patch_too_large'
  | 'promotional'
  | 'invalid_input';
export interface IntegrityFinding {
  readonly code: IntegrityCode;
  readonly path?: string;
  /** Fixed controller text, never repository contents or exception messages. */
  readonly detail: string;
}
export interface IntegrityReview {
  readonly verdict: 'pass' | 'hand_off';
  readonly findings: readonly IntegrityFinding[];
}
export interface IntegrityLimits {
  readonly maxFiles: number;
  readonly maxChangedLines: number;
}
export interface ReviewCandidateInput {
  readonly baseManifest: SourceManifest;
  readonly candidateManifest: SourceManifest;
  /** Caller binds both summaries to the same full-suite command. */
  readonly baseDiscovery: JunitSummary | null;
  readonly candidateDiscovery: JunitSummary | null;
  readonly limits?: Partial<IntegrityLimits>;
}

const TEST =
  /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[^/]*$|(?:^|\/)test_[^/]*\.py$|_test\.py$/u;
const CONFIG =
  /(?:^|\/)(?:package\.json|package-lock\.json|pyproject\.toml|uv\.lock|requirements[^/]*\.txt|setup\.py|setup\.cfg|tox\.ini|pytest\.ini|conftest\.py|jest\.config\.[^/]*|vitest\.config\.[^/]*|\.mocharc[^/]*|Makefile|Dockerfile|\.gitattributes)$|(?:^|\/)(?:\.github|\.devcontainer)(?:\/|$)/u;
const GENERATED = /(?:^|\/)(?:dist|build)(?:\/|$)|\.min\.js$|\.map$/u;
// Python explicit line continuations are lexical gaps too. Match raw source so
// coordinates still correspond to the line diff rather than a normalized copy.
const GAP = String.raw`(?:\s|\\\r?\n)*`;
const DISABLED = new RegExp(
  String.raw`\b(?:it|describe|test)${GAP}\.${GAP}skip${GAP}\(|\b(?:xit|xdescribe)${GAP}\(|\.${GAP}only${GAP}\(|\bit${GAP}\.${GAP}todo${GAP}\(|@${GAP}pytest${GAP}\.${GAP}mark${GAP}\.${GAP}(?:skip(?:if)?|xfail)\b|\bpytest${GAP}\.${GAP}skip${GAP}\(|@${GAP}unittest${GAP}\.${GAP}skip\b|\bunittest${GAP}\.${GAP}(?:skipIf|skipUnless)\b`,
  'u'
);
const ASSERTION = new RegExp(
  String.raw`\bexpect${GAP}\(|\bself${GAP}\.${GAP}assert\w*\b|\bassert\b`,
  'gu'
);
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DIFF_CELLS = 1_000_000;

function summary(raw: JunitSummary | null): JunitSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { suites, tests, failures, skipped } = raw;
  if (
    ![suites, tests, failures, skipped].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    suites > tests ||
    failures > tests - skipped ||
    (tests > 0 && suites === 0)
  )
    return null;
  return { suites, tests, failures, skipped };
}
function text(entry: SourceEntry | undefined): string | null {
  if (!entry || entry.mode === '040000') return '';
  const bytes = Buffer.from(entry.bytes, 'base64');
  if (bytes.length > MAX_TEXT_BYTES) return null;
  const decoded = bytes.toString('utf8');
  return Buffer.from(decoded).equals(bytes) ? decoded : null;
}
/** Preserve line terminators: changing only the final newline still changes a line. */
function lines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}
interface LineDiff {
  count: number;
  added: string;
  ranges: readonly (readonly [number, number])[];
  junctions: readonly number[];
}
function diff(before: string, after: string): LineDiff {
  const a = lines(before);
  const b = lines(after);
  const offsets = [0];
  for (const line of b) offsets.push(offsets[offsets.length - 1] + line.length);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const old = a.slice(start, endA);
  const next = b.slice(start, endB);
  // Bounded conservative fallback is a line-based delete/add diff, never a lower bound.
  if ((old.length + 1) * (next.length + 1) > MAX_DIFF_CELLS)
    return {
      count: old.length + next.length,
      added: next.join(''),
      ranges: [[offsets[start], offsets[endB]]],
      junctions: [],
    };
  const width = next.length + 1;
  const table = new Uint32Array((old.length + 1) * width);
  for (let i = old.length - 1; i >= 0; i--)
    for (let j = next.length - 1; j >= 0; j--)
      table[i * width + j] =
        old[i] === next[j]
          ? 1 + table[(i + 1) * width + j + 1]
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const added: string[] = [];
  const ranges: [number, number][] = [];
  const junctions: number[] = [];
  let i = 0;
  let j = 0;
  while (j < next.length) {
    if (i < old.length && old[i] === next[j]) {
      i++;
      j++;
    } else if (i < old.length && table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      junctions.push(offsets[start + j]);
      i++;
    } else {
      ranges.push([offsets[start + j], offsets[start + j + 1]]);
      added.push(next[j++]);
    }
  }
  // Trimmed equal suffixes can begin the second half of a newly joined marker.
  if (i < old.length) junctions.push(offsets[endB]);
  return {
    count: old.length + next.length - 2 * table[0],
    added: added.join(''),
    ranges,
    junctions,
  };
}
/** Scan full candidate context, including markers split across unchanged/added lines. */
function addedDisableMarker(after: string, changes: LineDiff): boolean {
  let range = 0;
  let junction = 0;
  for (const match of after.matchAll(new RegExp(DISABLED.source, 'gu'))) {
    while (range < changes.ranges.length && changes.ranges[range][1] <= match.index) range++;
    if (range < changes.ranges.length && changes.ranges[range][0] < match.index + match[0].length)
      return true;
    while (junction < changes.junctions.length && changes.junctions[junction] <= match.index)
      junction++;
    if (
      junction < changes.junctions.length &&
      changes.junctions[junction] < match.index + match[0].length
    )
      return true;
  }
  return false;
}
function assertions(value: string): number {
  return [...value.matchAll(ASSERTION)].length;
}
function result(findings: IntegrityFinding[]): IntegrityReview {
  return Object.freeze({
    verdict: findings.length ? 'hand_off' : 'pass',
    findings: Object.freeze(findings.map((finding) => Object.freeze(finding))),
  });
}

/** Pure, deterministic, fail-closed scope/test-integrity evidence; does not authorize shipping. */
export function reviewCandidate(input: ReviewCandidateInput): IntegrityReview {
  try {
    const { baseManifest, candidateManifest, baseDiscovery, candidateDiscovery, limits } = input;
    if (limits !== undefined && (!limits || typeof limits !== 'object' || Array.isArray(limits)))
      return result([{ code: 'invalid_input', detail: 'Invalid review limits.' }]);
    const { maxFiles = 20, maxChangedLines = 1000 } = limits ?? {};
    if (![maxFiles, maxChangedLines].every((n) => Number.isSafeInteger(n) && n >= 0))
      return result([{ code: 'invalid_input', detail: 'Invalid review limits.' }]);
    const base = validateManifest(baseManifest);
    const candidate = validateManifest(candidateManifest);
    for (const entry of [...base.entries, ...candidate.entries]) assertNoSecrets(entry.path);
    const findings: IntegrityFinding[] = [];
    const add = (code: IntegrityCode, detail: string, path?: string) => {
      findings.push(path === undefined ? { code, detail } : { code, path, detail });
    };
    const baseCounts = summary(baseDiscovery);
    const candidateCounts = summary(candidateDiscovery);
    if (!baseCounts || !candidateCounts)
      add('discovery_unknown', 'Full-suite discovery is unknown or malformed.');
    else if (candidateCounts.suites < baseCounts.suites || candidateCounts.tests < baseCounts.tests)
      add('discovery_reduced', 'Full-suite suite or test count decreased.');
    const old = new Map(base.entries.map((entry) => [entry.path, entry]));
    const next = new Map(candidate.entries.map((entry) => [entry.path, entry]));
    let changedFiles = 0;
    let changedLines = 0;
    for (const path of [...new Set([...old.keys(), ...next.keys()])].sort(comparePaths)) {
      const a = old.get(path);
      const b = next.get(path);
      if (a?.mode === b?.mode && a?.sha256 === b?.sha256) continue;
      const wasFile = a !== undefined && a.mode !== '040000';
      const isFile = b !== undefined && b.mode !== '040000';
      if (wasFile || isFile) changedFiles++;
      if (wasFile && !isFile && TEST.test(path))
        add('test_deleted', 'Original test file removed or renamed.', path);
      if (CONFIG.test(path))
        add('config_changed', 'Build, dependency or test configuration changed.', path);
      const before = text(a);
      const after = text(b);
      if (GENERATED.test(path) || before === null || after === null)
        add('generated_or_binary', 'Generated, non-UTF-8 or oversized file changed.', path);
      if (before === null || after === null) continue; // Already refuses; do not analyze incomplete bytes.
      const changes = diff(before, after);
      changedLines += changes.count;
      if (isFile && TEST.test(path)) {
        if (addedDisableMarker(after, changes))
          add('test_disabled', 'Test disabling, focus or todo marker added.', path);
        if (wasFile && assertions(after) < assertions(before))
          add('assertions_reduced', 'Test assertion count decreased.', path);
      } else if (isFile && /ai-dossier|imboard/u.test(changes.added))
        add('promotional', 'Promotional string added outside tests.', path);
    }
    if (changedFiles > maxFiles || changedLines > maxChangedLines)
      add('patch_too_large', 'Changed file or line limit exceeded.');
    return result(findings);
  } catch {
    // Validation/getter failures are untrusted diagnostics; never echo or retry them.
    return result([{ code: 'invalid_input', detail: 'Review evidence is invalid or unreadable.' }]);
  }
}
