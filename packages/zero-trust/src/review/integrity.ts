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
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DIFF_CELLS = 1_000_000;

interface Screening {
  markers: [number, number, boolean][];
  assertions: number;
}
/** Cached lexical-gap jumps avoid rescanning long comments at each token. */
function screen(value: string): Screening {
  const gap = new Uint32Array(value.length + 1);
  const callGap = new Uint32Array(value.length + 1);
  gap[value.length] = callGap[value.length] = value.length;
  let lineEnd = value.length;
  let blockEnd = value.length;
  for (let i = value.length - 1; i >= 0; i--) {
    if (value.startsWith('*/', i)) blockEnd = i + 2;
    let end = i;
    if (/\s/u.test(value[i]) || value[i] === ')') end = i + 1;
    else if (value[i] === '#' || value.startsWith('//', i)) end = lineEnd;
    else if (value.startsWith('/*', i)) end = blockEnd;
    else if (value[i] === '\\' && /[\r\n]/u.test(value[i + 1] ?? ''))
      end = i + (value.startsWith('\r\n', i + 1) ? 3 : 2);
    callGap[i] = end === i ? i : callGap[end];
    gap[i] = value[i] === '(' ? gap[i + 1] : end === i ? i : gap[end];
    if (value[i] === '\r' || value[i] === '\n') lineEnd = i + 1;
  }
  const token = (at: number, name: string): number | null =>
    value.startsWith(name, at) &&
    (!/\w/u.test(name[name.length - 1]) || !/\w/u.test(value[at + name.length] ?? ''))
      ? at + name.length
      : null;
  const chain = (at: number, names: readonly string[]): number | null => {
    for (const name of names) {
      const end = token(gap[at], name);
      if (end === null) return null;
      at = end;
    }
    return at;
  };
  const call = (at: number | null): number | null =>
    at !== null && value[callGap[at]] === '(' ? callGap[at] + 1 : null;
  const markers: [number, number, boolean][] = [];
  let assertions = 0;
  for (const match of value.matchAll(
    /\b(?:it|describe|test|xit|xdescribe|pytest|unittest|expect|self|assert)\b|@|\./gu
  )) {
    const name = match[0];
    const at = match.index + name.length;
    let end: number | null = null;
    if (name === 'it' || name === 'describe' || name === 'test') {
      end = call(chain(at, ['.', 'skip']));
      end ??= call(chain(at, ['.', 'only']));
      if (end === null && name === 'it') end = call(chain(at, ['.', 'todo']));
    } else if (name === 'xit' || name === 'xdescribe') end = call(at);
    else if (name === '.') end = call(chain(at, ['only']));
    else if (name === 'pytest') end = call(chain(at, ['.', 'skip']));
    else if (name === 'unittest')
      end = chain(at, ['.', 'skipIf']) ?? chain(at, ['.', 'skipUnless']);
    else if (name === '@') {
      end = chain(at, ['unittest', '.', 'skip']);
      for (const marker of ['skip', 'skipif', 'xfail'])
        end ??= chain(at, ['pytest', '.', 'mark', '.', marker]);
    }
    if (end !== null) markers.push([match.index, end, name === '.']);
    if (name === 'assert' || (name === 'expect' && call(at) !== null)) assertions++;
    if (name === 'self') {
      const dot = chain(at, ['.']);
      if (dot !== null && /^assert\w*\b/u.test(value.slice(gap[dot], gap[dot] + 64))) assertions++;
    }
  }
  return { markers, assertions };
}

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
  cells: number;
}
function diff(before: string, after: string, remainingCells: number): LineDiff {
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
  const cells = (old.length + 1) * (next.length + 1);
  if (cells > remainingCells)
    return {
      count: old.length + next.length,
      added: next.join(''),
      ranges: [[offsets[start], offsets[endB]]],
      junctions: [],
      cells: 0,
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
    cells,
  };
}
/** Scan full candidate context, including markers split across unchanged/added lines. */
function addedDisableMarker(markers: Screening['markers'], changes: LineDiff): boolean {
  let range = 0;
  let junction = 0;
  for (const [start, end, receiverOutsideSpan] of markers) {
    while (range < changes.ranges.length && changes.ranges[range][1] <= start) range++;
    if (range < changes.ranges.length && changes.ranges[range][0] < end) return true;
    // Generic .only spans exclude the receiver; their start junction can
    // activate a focused call, so retain that boundary as ambiguous evidence.
    while (
      junction < changes.junctions.length &&
      (changes.junctions[junction] < start ||
        (changes.junctions[junction] === start && !receiverOutsideSpan))
    )
      junction++;
    if (junction < changes.junctions.length && changes.junctions[junction] < end) return true;
  }
  return false;
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
    // Bound quadratic work across the whole candidate, not separately per file.
    let remainingDiffCells = MAX_DIFF_CELLS;
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
      const changes = diff(before, after, remainingDiffCells);
      remainingDiffCells -= changes.cells;
      changedLines += changes.count;
      if (isFile && TEST.test(path)) {
        const candidateScreen = screen(after);
        if (addedDisableMarker(candidateScreen.markers, changes))
          add('test_disabled', 'Test disabling, focus or todo marker added.', path);
        if (wasFile && candidateScreen.assertions < screen(before).assertions)
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
