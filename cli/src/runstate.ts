/**
 * Runstate protocol (`runstate:v1`) — the milestone comments issue-workflow dossiers
 * append to a GitHub issue after every phase.
 *
 * This module is the executable copy of the "Runstate Milestones" table in
 * `imboard-ai/git/full-cycle-issue@3.8.0`. Dossiers used to ask agents to reproduce a
 * markdown heredoc by hand; smaller models skipped it or pasted `$(date …)` literally.
 * Everything here is pure and dependency-free so it can be unit tested without touching
 * `gh`, the network, or the filesystem.
 */

import { randomBytes } from 'node:crypto';

/** Marker that opens every runstate comment. Readers filter on this exact prefix. */
export const RUNSTATE_MARKER = '<!-- runstate:v1 -->';

/** Workflow phases, in execution order. */
export const PHASES = ['gate', 'setup', 'plan', 'implement', 'review', 'ship', 'report'] as const;
export type Phase = (typeof PHASES)[number];

/**
 * The classifier phase (RFC-0001 C.2, ai-dossier#461). Posted by
 * `issue-cycle-classifier` before any cycle is dispatched, so it is NOT a station on the
 * full-cycle line — `PHASES` deliberately excludes it, and everything that keys off
 * `PHASES` (resume semantics, `defaultNext`'s linear walk) keeps its current meaning.
 */
export const CLASSIFY_PHASE = 'classify';
export type ClassifyPhase = typeof CLASSIFY_PHASE;

/**
 * Batch phases (RFC-0001 D.2), in execution order. Posted on batch ANCHOR issues by the
 * batch scheduler — a member issue never carries them — which is why they too stay out
 * of `PHASES`: `runstate verify` on a member issue must not try to resume them.
 */
export const BATCH_PHASES = [
  'batch-setup',
  'batch-validate',
  'batch-review',
  'batch-ship',
  'batch-report',
] as const;
export type BatchPhase = (typeof BATCH_PHASES)[number];

/** Every phase name `post` accepts: the full-cycle line plus classify and the batch line. */
export type KnownPhase = Phase | ClassifyPhase | BatchPhase;

/** All accepted phases, classify first and the batch line after the full-cycle one. */
export const ALL_PHASES: readonly KnownPhase[] = [CLASSIFY_PHASE, ...PHASES, ...BATCH_PHASES];

/** Milestone statuses. */
export const STATUSES = ['done', 'partial', 'blocked', 'awaiting-merge'] as const;
export type Status = (typeof STATUSES)[number];

/**
 * Keys whose values are paths and must therefore be absolute — the dossier rule is
 * "paths are absolute", and a relative worktree path makes a resume unresolvable from
 * a different working directory.
 */
export const PATH_KEYS = ['worktree', 'planning'] as const;

/**
 * Per-phase specification, transcribed from full-cycle-issue@3.8.0.
 *
 * `statuses` is the closed set a phase may report. `required` maps each status to the
 * keys that must accompany it. `status=blocked` additionally requires `reason` for every
 * phase (see {@link BLOCKED_REQUIRED}) — the dossier rule is "If a phase aborts, post
 * `status=blocked` with `reason=<short-slug>` before stopping".
 */
export interface PhaseSpec {
  statuses: readonly Status[];
  required: Partial<Record<Status, readonly string[]>>;
}

/** Keys required whenever a phase reports `status=blocked`. */
export const BLOCKED_REQUIRED = ['reason'] as const;

/**
 * Caps that keep a milestone postable. GitHub rejects an issue comment over 65536
 * characters with an opaque 422, and `execFileSync` hits E2BIG well before that on some
 * platforms — both surface as "gh failed" with no hint that size was the cause. Checking
 * here turns those into a named key and a number.
 */
export const MAX_VALUE_LENGTH = 4000;
export const MAX_BODY_LENGTH = 60000;

/**
 * `review` reports the same keys whether it finished or still has agents pending, so the
 * list lives once — a key added to one status must never drift from the other.
 */
const REVIEW_KEYS = ['head', 'fixed', 'escalated', 'agents_done', 'agents_pending'] as const;

export const PHASE_SPECS: Record<Phase, PhaseSpec> = {
  gate: {
    statuses: ['done', 'blocked'],
    required: { done: ['base_branch', 'warnings'] },
  },
  setup: {
    statuses: ['done', 'blocked'],
    required: { done: ['branch', 'worktree', 'pool_claimed', 'base_branch'] },
  },
  plan: {
    statuses: ['done', 'blocked'],
    required: { done: ['planning', 'head', 'open_questions', 'visual_review'] },
  },
  implement: {
    statuses: ['done', 'blocked'],
    required: { done: ['head', 'files', 'tests_added', 'tests_run', 'ci_parity'] },
  },
  review: {
    statuses: ['done', 'partial', 'blocked'],
    required: { done: REVIEW_KEYS, partial: REVIEW_KEYS },
  },
  ship: {
    statuses: ['awaiting-merge', 'done', 'blocked'],
    required: {
      'awaiting-merge': ['pr', 'head', 'ci_fix_attempts'],
      done: ['pr', 'merge_commit', 'ci_fix_attempts', 'cleanup'],
    },
  },
  report: {
    statuses: ['done'],
    required: { done: ['pr', 'traps_added'] },
  },
};

/**
 * The classify verdict (RFC-0001 C.2 / E): `mode`, `risk`, `est_files`, `est_diff`,
 * `areas`, `test_scope`, `deps`, `confidence`. The classifier dossier also posts a
 * `rationale_comment=<link>` and applies a `cycle:*` label; those live outside the
 * milestone contract (#465 consumes "keys per #461", so this table is the contract).
 */
export const CLASSIFY_SPEC: PhaseSpec = {
  statuses: ['done', 'blocked'],
  required: {
    done: ['mode', 'risk', 'est_files', 'est_diff', 'areas', 'test_scope', 'deps', 'confidence'],
  },
};

/**
 * The batch line (RFC-0001 D.2). Deliberately no phase-specific required keys (beyond
 * the universal blocked→reason): the batch scheduler dossier owns what its milestones
 * carry, and this table only fixes the phase names and their status sets so the
 * vocabulary is stable underneath it.
 */
export const BATCH_SPECS: Record<BatchPhase, PhaseSpec> = {
  'batch-setup': { statuses: ['done', 'blocked'], required: {} },
  'batch-validate': { statuses: ['done', 'blocked'], required: {} },
  'batch-review': { statuses: ['done', 'blocked'], required: {} },
  'batch-ship': { statuses: ['awaiting-merge', 'done', 'blocked'], required: {} },
  'batch-report': { statuses: ['done'], required: {} },
};

/** The spec of every accepted phase — validation's single lookup table. */
const ALL_PHASE_SPECS: Record<KnownPhase, PhaseSpec> = {
  classify: CLASSIFY_SPEC,
  ...PHASE_SPECS,
  ...BATCH_SPECS,
};

/**
 * `r-<issue>-<hex>`, minted once per run by the gate phase. Accepts four or more hex
 * chars so a longer id from another minter still reads back as valid.
 */
const RUN_ID_RE = /^r-\d+-[0-9a-f]{4,}$/;

/** Random bytes in a minted run id; 2 bytes renders as the 4 hex chars in `r-440-ab56`. */
const RUN_ID_RANDOM_BYTES = 2;

/** Characters in the abbreviated SHA `git rev-parse --short HEAD` prints. */
const SHORT_SHA_LENGTH = 7;

/** Consecutive `blocked` milestones on one phase that mean the run is looping. */
export const RESUME_LOOP_CAP = 3;

/** Suffix `implement` milestones add to `head=` when the worktree had uncommitted changes. */
const DIRTY_HEAD_SUFFIX_RE = /-dirty$/;

/**
 * Every value `next=` may legally carry: a phase to re-enter, or `done`. Includes
 * classify and the batch line, because `defaultNext` can now return them and `--next`
 * may point at them.
 */
export const NEXT_VALUES: readonly string[] = [...ALL_PHASES, 'done'];

/** GitHub issue numbers are positive integers; anything else is a caller mistake. */
export function isIssueNumber(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

/**
 * Keys exempt from the no-spaces rule: acceptance-criterion lines are prose by nature.
 * Matches `ac`, `ac1`, `ac_results`, `ac2_note`, …
 */
const AC_KEY_RE = /^ac(\d+)?(_[a-z0-9_]+)?$/;

/** True when `key` may carry spaces in its value. */
export function isAcKey(key: string): boolean {
  return AC_KEY_RE.test(key);
}

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

/** True for any phase `post` accepts — the full-cycle line, classify, and the batch line. */
export function isKnownPhase(value: string): value is KnownPhase {
  return (ALL_PHASES as readonly string[]).includes(value);
}

/** True for the batch line only (RFC-0001 D.2). */
export function isBatchPhase(value: string): value is BatchPhase {
  return (BATCH_PHASES as readonly string[]).includes(value);
}

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

/**
 * The grammar a classify/slot-mode value must follow (ai-dossier#461). Checked wherever
 * the key appears — a key's value grammar is global, so a `mode=slot` typo is caught on
 * `implement` exactly as it would be on `classify`.
 *
 * Each rule names what a valid value looks like, so a rejection is actionable in one
 * line, in the style of the rest of this module.
 */
interface KeyValueRule {
  test: (value: string) => boolean;
  expects: string;
}

/** `est_files`/`est_diff`: a count or a size, never signed, fractional, or descriptive. */
const NON_NEGATIVE_INT_RE = /^\d+$/;

/** `confidence`: the RFC-0001 E.2 floor compares it to 0.6, so it is a 0–1 decimal. */
const CONFIDENCE_RE = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/;

/** `areas`: one or more lowercase slugs, comma-separated (`cli,docs`). */
const AREA_SLUGS_RE = /^[a-z0-9][a-z0-9-]*(?:,[a-z0-9][a-z0-9-]*)*$/;

/** `deps`: literally `none`, or comma-separated issue numbers (`474,480`). */
const DEPS_RE = /^(?:none|\d+(?:,\d+)*)$/;

/** `batch`: a batch id slug — no spaces, slashes, or `#`. */
const BATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One rule per enum-valued key; the message lists the closed set verbatim. */
function enumRule(values: readonly string[]): KeyValueRule {
  return {
    test: (value) => (values as readonly string[]).includes(value),
    expects: `expected one of: ${values.join(', ')}`,
  };
}

export const KEY_VALUE_RULES: Record<string, KeyValueRule> = {
  mode: enumRule(['full', 'slot']),
  risk: enumRule(['low', 'med', 'high']),
  test_scope: enumRule(['focused', 'broad', 'unknown']),
  est_files: {
    test: (v) => NON_NEGATIVE_INT_RE.test(v),
    expects: 'expected a non-negative integer file count, e.g. 3',
  },
  est_diff: {
    test: (v) => NON_NEGATIVE_INT_RE.test(v),
    expects: 'expected a non-negative integer diff size (lines), e.g. 400',
  },
  confidence: {
    test: (v) => CONFIDENCE_RE.test(v),
    expects: 'expected a decimal between 0 and 1, e.g. 0.85 (RFC-0001 E.2 compares it to 0.6)',
  },
  areas: {
    test: (v) => AREA_SLUGS_RE.test(v),
    expects: "expected comma-separated lowercase slugs, e.g. cli,docs — use '-' inside a slug",
  },
  deps: {
    test: (v) => DEPS_RE.test(v),
    expects: "expected 'none' or comma-separated issue numbers, e.g. 474,480",
  },
  batch: {
    test: (v) => BATCH_ID_RE.test(v),
    expects: "expected a batch id slug (letters, digits, '.', '_', '-'), e.g. b-2026-08-29-01",
  },
};

/**
 * The phase that follows `phase`, for the milestone's `next=` line.
 *
 * - `blocked` ends the run, so `next=done`.
 * - the two non-terminal statuses keep the run inside the same phase: ship's and
 *   batch-ship's `awaiting-merge` are the FIRST of two milestones (CI wait, then
 *   teardown), and a `partial` review still has agents left to run — which is exactly
 *   how gate-issue's resume table reads them back.
 * - otherwise the linear order gate → setup → plan → implement → review → ship →
 *   report → done.
 * - `classify` is a standalone pre-cycle record: the cycle it dispatches mints its own
 *   run, so classification ends its own trail (`next=done`).
 * - the batch line walks its own order: batch-setup → batch-validate → batch-review →
 *   batch-ship → batch-report → done.
 */
const BATCH_NEXT: Record<BatchPhase, KnownPhase | 'done'> = {
  'batch-setup': 'batch-validate',
  'batch-validate': 'batch-review',
  'batch-review': 'batch-ship',
  'batch-ship': 'batch-report',
  'batch-report': 'done',
};

export function defaultNext(phase: KnownPhase, status: Status): KnownPhase | 'done' {
  if (status === 'blocked') return 'done';
  if (status === 'awaiting-merge' || status === 'partial') return phase;
  if (phase === CLASSIFY_PHASE) return 'done';
  if (isBatchPhase(phase)) return BATCH_NEXT[phase];
  const idx = PHASES.indexOf(phase);
  return idx === PHASES.length - 1 ? 'done' : PHASES[idx + 1];
}

/** The keys `phase` must carry when reporting `status`. */
export function requiredKeys(phase: KnownPhase, status: Status): readonly string[] {
  const spec = ALL_PHASE_SPECS[phase];
  const base = spec.required[status] ?? [];
  return status === 'blocked' ? [...base, ...BLOCKED_REQUIRED] : base;
}

export interface MilestoneInput {
  phase: string;
  status: string;
  run: string;
  /** Phase-specific `key=value` pairs, in the order they should be emitted. */
  keys?: Array<[string, string]>;
  /** Override the computed `next=` value. */
  next?: string;
  /** Override the timestamp (tests); defaults to now. */
  at?: string;
}

/**
 * The single most important thing wrong with one `key=value` pair, or null when it is
 * well-formed. Checked in the order an author would want to hear about them.
 */
function firstKeyProblem(key: string, value: string): string | null {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    return `Invalid key '${key}' — use lower_snake_case, e.g. base_branch`;
  }
  if (value === '') {
    return `Key '${key}' has an empty value — omit the key or give it a value`;
  }
  if (value.includes('$')) {
    return `Key '${key}' contains '$' — values must be literal; shell expansions like $(date …) end up pasted verbatim`;
  }
  // Checked before the ac* whitespace exemption: one milestone line is one key, so a
  // newline in ANY value silently splits into extra `key=` lines that readers would
  // parse as real state. Not exempt for ac* keys.
  if (/[\r\n]/.test(value)) {
    return `Key '${key}' contains a newline — every value must be a single line, or it splits into extra key= lines in the posted comment; collapse it (use ' / ' or ',') and retry`;
  }
  if (value.length > MAX_VALUE_LENGTH) {
    return `Key '${key}' is ${value.length} characters — the maximum is ${MAX_VALUE_LENGTH}; summarise it (e.g. a count, or a path to the full text) instead of inlining it`;
  }
  if (/\s/.test(value) && !isAcKey(key)) {
    return `Key '${key}' contains whitespace — values must not contain spaces (use '-' or ','); only ac* keys are exempt`;
  }
  if ((PATH_KEYS as readonly string[]).includes(key) && !value.startsWith('/')) {
    return `Key '${key}' must be an absolute path, got '${value}'`;
  }
  const rule = KEY_VALUE_RULES[key];
  if (rule && !rule.test(value)) {
    return `Key '${key}' has an invalid value '${value}' — ${rule.expects}`;
  }
  return null;
}

/**
 * Validate a milestone against the protocol.
 *
 * @returns one actionable line per problem; an empty array means valid.
 */
export function validateMilestone(input: MilestoneInput): string[] {
  const errors: string[] = [];
  const { phase, status, run } = input;
  const keys = input.keys ?? [];

  if (!isKnownPhase(phase)) {
    errors.push(`Unknown phase '${phase}' — expected one of: ${ALL_PHASES.join(', ')}`);
  }

  if (!isStatus(status)) {
    errors.push(`Unknown status '${status}' — expected one of: ${STATUSES.join(', ')}`);
  } else if (isKnownPhase(phase)) {
    const allowed = ALL_PHASE_SPECS[phase].statuses;
    if (!allowed.includes(status)) {
      errors.push(
        `Status '${status}' is not valid for phase '${phase}' — expected one of: ${allowed.join(', ')}`
      );
    }
  }

  if (!RUN_ID_RE.test(run)) {
    errors.push(
      `Invalid run id '${run}' — expected r-<issue>-<hex>, e.g. r-440-ab56 (mint one with: ai-dossier runstate mint --issue <n>)`
    );
  }

  // An unchecked --next lands verbatim in the comment: a typo sends the next resume to a
  // phase that does not exist, and whitespace/newlines corrupt the line outright.
  if (input.next !== undefined && !NEXT_VALUES.includes(input.next)) {
    errors.push(
      `Invalid --next '${input.next}' — expected one of: ${NEXT_VALUES.join(', ')} (omit --next to use the default for this phase and status)`
    );
  }

  // One line per offending key — an agent fixes the first problem with a value and
  // re-runs, so listing every way the same value is wrong is noise, not help.
  const seen = new Map<string, string>();
  for (const [key, value] of keys) {
    if (seen.has(key)) {
      errors.push(`Duplicate key '${key}' — each key may appear at most once`);
      continue;
    }
    seen.set(key, value);

    const problem = firstKeyProblem(key, value);
    if (problem) errors.push(problem);
  }

  if (isKnownPhase(phase) && isStatus(status) && ALL_PHASE_SPECS[phase].statuses.includes(status)) {
    const missing = requiredKeys(phase, status).filter((k) => !seen.has(k));
    if (missing.length > 0) {
      errors.push(
        `Phase '${phase}' with status '${status}' requires ${missing.map((k) => `${k}=`).join(' ')} — add with --kv ${missing.map((k) => `${k}=<value>`).join(' --kv ')}`
      );
    }
  }

  return errors;
}

/** Current time as `YYYY-MM-DDTHH:MM:SSZ` (the dossier template's `date -u` format). */
export function nowStamp(date: Date = new Date()): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * Build the milestone comment body. Does not validate — call
 * {@link validateMilestone} first.
 */
export function buildMilestone(input: MilestoneInput): string {
  const at = input.at ?? nowStamp();
  const next =
    input.next ??
    (isKnownPhase(input.phase) && isStatus(input.status)
      ? defaultNext(input.phase, input.status)
      : 'done');

  const lines = [
    RUNSTATE_MARKER,
    `phase=${input.phase} status=${input.status} run=${input.run} at=${at}`,
    ...(input.keys ?? []).map(([k, v]) => `${k}=${v}`),
    `next=${next}`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Split one `key=value` token at its FIRST `=`, so a value may itself contain `=`.
 * Returns null when nothing precedes the separator.
 *
 * The single definition of the pair grammar: {@link parseMilestone} reads it back off an
 * issue comment and the `--kv` flag parser reads it off argv, and the two must agree.
 */
export function splitPair(token: string): [string, string] | null {
  const eq = token.indexOf('=');
  if (eq <= 0) return null;
  return [token.slice(0, eq), token.slice(eq + 1)];
}

export interface ParsedMilestone {
  phase: string;
  status: string;
  run: string;
  at: string;
  next: string;
  /** Every `key=value` line, including the ones from the header line. */
  keys: Record<string, string>;
}

/**
 * Parse a runstate comment body. Returns `null` when `body` is not a runstate comment.
 *
 * Tolerant by design: a milestone posted by an older dossier (or a hand-written one)
 * should still be readable by `runstate last` even if it would not pass validation.
 */
export function parseMilestone(body: string): ParsedMilestone | null {
  if (!body.startsWith(RUNSTATE_MARKER)) return null;

  const keys: Record<string, string> = {};
  const lines = body.split('\n').slice(1);

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('<!--')) continue;
    // The header line packs several pairs; later lines carry exactly one each, and
    // their values may contain spaces (ac* keys), so only the header is split on space.
    const isHeader = line.startsWith('phase=');
    const pairs = isHeader ? line.split(/\s+/) : [line];
    for (const pair of pairs) {
      const kv = splitPair(pair);
      if (!kv) continue;
      const [key, value] = kv;
      if (!(key in keys)) keys[key] = value;
    }
  }

  return {
    phase: keys.phase ?? '',
    status: keys.status ?? '',
    run: keys.run ?? '',
    at: keys.at ?? '',
    next: keys.next ?? '',
    keys,
  };
}

/** Extract every runstate milestone from a list of comment bodies, oldest first. */
export function parseMilestones(bodies: string[]): ParsedMilestone[] {
  const out: ParsedMilestone[] = [];
  for (const body of bodies) {
    const parsed = parseMilestone(body);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Mint a fresh run id: `r-<issue>-<4 hex>`. */
export function mintRunId(issue: number | string): string {
  return `r-${issue}-${randomBytes(RUN_ID_RANDOM_BYTES).toString('hex')}`;
}

/**
 * The world-facing checks the resume table needs. Injected so {@link computeResume}
 * stays pure and testable — the command layer supplies the `git`/`gh`/`fs` versions.
 */
export interface ResumeProbe {
  /** `git ls-remote --exit-code origin <branch>` succeeds. */
  branchOnRemote(branch: string): boolean;
  /** The worktree directory exists. */
  dirExists(path: string): boolean;
  /** The planning file exists. */
  fileExists(path: string): boolean;
  /** `git -C <worktree> rev-parse --short HEAD`, or null if it fails. */
  headOf(worktree: string): string | null;
  /** `gh pr view <pr> --json state,mergedAt,mergeable`, or null if it fails. */
  prState(pr: string): { state: string; mergedAt: string | null; mergeable: string } | null;
  /** The issue's state is CLOSED. */
  issueClosed(): boolean;
}

export interface ResumeResult {
  /** Phase to resume from: a phase name, `ship-wait`, `ship-teardown`, `done`, or `none`. */
  resume_from: string;
  /** The run id to reuse, or null on a fresh run. */
  run_id: string | null;
  /** Checks that passed, for the gate milestone's `verified=` key. */
  verified: string[];
  /**
   * Merged `key=value` state for the run: every milestone's keys, later milestones
   * winning. Merged rather than last-only because a resume at `plan` still needs
   * `branch`/`worktree` from the `setup` milestone.
   */
  resume_context: Record<string, string>;
  /** The last milestone, or null on a fresh run. */
  last: ParsedMilestone | null;
  /** Set when the run must hard-block instead of resuming (currently `resume-loop`). */
  hard_block?: string;
  /**
   * True when the freshest milestone on the trail is slot-mode — it carries
   * `mode=slot` or a `batch=` id (RFC-0001 C.4), or is a `classify` verdict with
   * `mode=slot`. Full-cycle re-enters such an issue FRESH: a slot trail has no
   * full-cycle phases to resume (the batch worktree is machine-local, and an evicted
   * member is requeued as `full` from scratch), so the signal exists to make "fresh
   * because slot" distinguishable from "fresh because there was no trail".
   */
  slot_trail?: boolean;
  /** Human-readable note, e.g. "already complete". */
  note?: string;
}

/**
 * True when the last {@link RESUME_LOOP_CAP} milestones are all `blocked` on the same
 * phase — the run is retrying the same wall and needs a human, not another resume.
 */
export function hitLoopCap(milestones: ParsedMilestone[]): boolean {
  if (milestones.length < RESUME_LOOP_CAP) return false;
  const streak = milestones.slice(-RESUME_LOOP_CAP);
  return (
    streak.every((m) => m.status === 'blocked') &&
    streak.every((m) => m.phase === streak[0].phase) &&
    streak[0].phase !== ''
  );
}

/** One phase's answer to "where does the run re-enter, and why?". */
interface ResumeDecision {
  resume_from: string;
  note?: string;
}

/**
 * Everything a per-phase resolver may look at: the milestone being resumed from, the
 * merged run context, the world probe, and a way to record checks that passed.
 */
interface ResumeScan {
  last: ParsedMilestone;
  context: Record<string, string>;
  probe: ResumeProbe;
  /** Record a check that passed. Idempotent, so a resolver may re-check freely. */
  pass(check: string): void;
  /** The branch is still on the remote and the worktree directory still exists. */
  setupOk(): boolean;
}

/**
 * Where each phase's run re-enters, given that its own milestone is the latest one.
 *
 * Every phase downstream of `setup` re-checks the setup claims first: a branch deleted on
 * the remote or a reaped worktree invalidates everything recorded after it, so the run
 * has to rebuild the workspace before it can trust its own later milestones.
 */
const PHASE_RESUMERS: Record<Phase, (scan: ResumeScan) => ResumeDecision> = {
  gate: () => ({ resume_from: 'setup' }),

  setup: (scan) => ({ resume_from: scan.setupOk() ? 'plan' : 'setup' }),

  plan: (scan) => {
    if (!scan.setupOk()) return { resume_from: 'setup' };
    const planning = scan.context.planning;
    if (!planning || !scan.probe.fileExists(planning)) return { resume_from: 'plan' };
    scan.pass('planning');
    return { resume_from: 'implement' };
  },

  implement: (scan) => {
    if (!scan.setupOk()) return { resume_from: 'setup' };
    const head = scan.probe.headOf(scan.context.worktree);
    const claimed = (scan.last.keys.head ?? '').replace(DIRTY_HEAD_SUFFIX_RE, '');
    // The milestone may record a longer or shorter abbreviation than `--short` prints,
    // so compare on the short-SHA prefix rather than for equality.
    if (!head || !claimed || !head.startsWith(claimed.slice(0, SHORT_SHA_LENGTH))) {
      return { resume_from: 'implement' };
    }
    scan.pass('head');
    return { resume_from: 'review' };
  },

  review: (scan) => {
    if (!scan.setupOk()) return { resume_from: 'setup' };
    // A `partial` review still has agents left to run.
    return { resume_from: scan.last.status === 'partial' ? 'review' : 'ship' };
  },

  ship: (scan) => {
    if (scan.last.status === 'done') return { resume_from: 'report' };
    // awaiting-merge: the PR itself decides where to re-enter ship.
    const pr = scan.last.keys.pr;
    const state = pr ? scan.probe.prState(pr) : null;
    if (!state) return { resume_from: 'ship' };
    scan.pass('pr');
    if (state.mergedAt) return { resume_from: 'ship-teardown' };
    if (state.state === 'OPEN' && state.mergeable === 'MERGEABLE') {
      return { resume_from: 'ship-wait' };
    }
    return { resume_from: 'ship' };
  },

  report: (scan) => {
    if (!scan.probe.issueClosed()) return { resume_from: 'report' };
    scan.pass('issue-closed');
    return { resume_from: 'done', note: 'already complete' };
  },
};

/**
 * Resolve where a run should resume from, implementing the resume verification table in
 * `imboard-ai/git/gate-issue`. Never trusts the milestone alone — every claim is checked
 * against reality through `probe`, and {@link PHASE_RESUMERS} holds the per-phase rules.
 */
export function computeResume(milestones: ParsedMilestone[], probe: ResumeProbe): ResumeResult {
  if (milestones.length === 0) {
    return { resume_from: 'none', run_id: null, verified: [], resume_context: {}, last: null };
  }

  const context: Record<string, string> = {};
  for (const m of milestones) Object.assign(context, m.keys);

  const last = milestones[milestones.length - 1];
  const verified: string[] = [];
  const base = { run_id: last.run || null, verified, resume_context: context, last };

  if (hitLoopCap(milestones)) {
    return { ...base, resume_from: last.phase, hard_block: 'resume-loop' };
  }

  // Classify and the batch line are known to `post` but are not stations on the
  // full-cycle line, so a trail ending on them has nothing for full-cycle to resume.
  // The checks sit ABOVE the blocked rule on purpose: a slot-mode or batch milestone
  // that reports `blocked` still re-enters full-cycle fresh (the state machine that
  // posted it is not the one resuming), and only the resume loop cap outranks them.
  if (last.phase === CLASSIFY_PHASE) {
    const slot = last.keys.mode === 'slot';
    return {
      ...base,
      resume_from: 'none',
      note: 'classify record — full-cycle enters fresh',
      ...(slot ? { slot_trail: true } : {}),
    };
  }
  if (isBatchPhase(last.phase)) {
    return { ...base, resume_from: 'none', note: 'batch anchor trail — not a full-cycle run' };
  }
  if (last.keys.mode === 'slot' || last.keys.batch !== undefined) {
    return {
      ...base,
      resume_from: 'none',
      slot_trail: true,
      note: 'slot-mode trail — full-cycle re-enters fresh',
    };
  }

  // Any blocked milestone resumes at that same phase.
  if (last.status === 'blocked') {
    return { ...base, resume_from: last.phase || 'none' };
  }

  // A phase this version does not know — a hand-written comment, or one written by a
  // newer dossier — is not resumable, so the caller starts over.
  if (!isPhase(last.phase)) {
    return { ...base, resume_from: 'none' };
  }

  const pass = (check: string): void => {
    if (!verified.includes(check)) verified.push(check);
  };
  const setupOk = (): boolean => {
    const { branch, worktree } = context;
    if (!branch || !worktree) return false;
    let ok = true;
    if (probe.branchOnRemote(branch)) pass('branch');
    else ok = false;
    if (probe.dirExists(worktree)) pass('worktree');
    else ok = false;
    return ok;
  };

  const { resume_from, note } = PHASE_RESUMERS[last.phase]({ last, context, probe, pass, setupOk });
  return { ...base, resume_from, ...(note ? { note } : {}) };
}
