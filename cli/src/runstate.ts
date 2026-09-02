/**
 * Runstate protocol (`runstate:v1`) — the milestone comments issue-workflow dossiers
 * append to a GitHub issue after every phase.
 *
 * This module is the executable copy of the "Runstate Milestones" table in
 * `imboard-ai/git/full-cycle-issue@3.8.0`, extended by the classify/batch-phase
 * vocabulary of RFC-0001 Batch Cycles (#461; see epic #474 — the RFC itself is
 * `rfcs/0001-batch-cycles.md`, pending merge at the time of writing). Dossiers used to
 * ask agents to reproduce a markdown heredoc by hand; smaller models skipped it or
 * pasted `$(date …)` literally. Everything here is pure and dependency-free so it can
 * be unit tested without touching `gh`, the network, or the filesystem.
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

/** The one mode value that marks a slot-cycle trail; shared by the grammar and resume. */
export const SLOT_MODE = 'slot';

/**
 * The fence status (#504) — the takeover record the stall-recovery ladder writes BEFORE
 * the replacement agent starts.
 *
 * A `superseded` milestone says "generation N now owns this run"; every earlier
 * generation is fenced out of the trail. It is universally valid — a takeover can happen
 * at any phase — so it is deliberately absent from every {@link PhaseSpec.statuses} and
 * allowed by {@link statusAllowed} instead of being listed thirteen times.
 */
export const FENCE_STATUS = 'superseded' as const;

/** Milestone statuses. */
export const STATUSES = ['done', 'partial', 'blocked', 'awaiting-merge', FENCE_STATUS] as const;
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
 * Keys required on a {@link FENCE_STATUS} milestone, for every phase.
 *
 * `gen` is what actually fences — the escalation ladder deliberately REUSES the run id
 * across a redispatch (gate-issue Step 1.5 reads the trail's `run=` back), so a run id
 * alone cannot tell the takeover apart from the run it replaced. `takeover` names who
 * took over, so a fenced agent's abort message can say what superseded it.
 */
export const FENCE_REQUIRED = ['gen', 'takeover'] as const;

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

/** Consecutive `blocked` milestones on one phase that mean the run is looping. */
export const RESUME_LOOP_CAP = 3;

/** Suffix `implement` milestones add to `head=` when the worktree had uncommitted changes. */
const DIRTY_HEAD_SUFFIX_RE = /-dirty$/;

/**
 * Every value `next=` may legally carry: a phase to re-enter, or `done`. The batch line
 * is included because `defaultNext` returns it; `classify` is deliberately absent —
 * nothing transitions INTO classify (it is always a trail's first milestone), so a
 * `next=classify` pointer would name a transition no state machine makes.
 */
export const NEXT_VALUES: readonly string[] = [...PHASES, ...BATCH_PHASES, 'done'];

// `isIssueNumber` moved to `gh.ts` next to the other CLI-input validators when that
// module became the shared subprocess plumbing; import it from there.

/**
 * Keys exempt from the no-spaces rule: acceptance-criterion lines are prose by nature.
 * Matches `ac`, `ac1`, `ac_results`, `ac2_note`, …
 */
const AC_KEY_RE = /^ac(\d+)?(_[a-z0-9_]+)?$/;

/** True when `key` may carry spaces in its value. */
export function isAcKey(key: string): boolean {
  return AC_KEY_RE.test(key);
}

/** True for the full-cycle line ONLY — classify and the batch line are not phases here; see {@link isKnownPhase}. */
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

/**
 * `est_files`/`est_diff`: a count or a size, never signed, fractional, or descriptive.
 *
 * Exported because the READ side needs the same grammar. `parseMilestone` is tolerant by
 * design, so a count key reaching a reader can be `''`, `0x1f`, `1e3` or `+7` — all of which
 * `Number()` happily accepts, and the first of which silently turns "never reported" into a
 * measured zero. Readers test against this before coercing.
 */
export const NON_NEGATIVE_INT_RE = /^\d+$/;

/** `confidence`: the RFC-0001 E.2 floor compares it to 0.6, so it is a 0–1 decimal. */
const CONFIDENCE_RE = /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/;

/** `areas`: one or more lowercase slugs, comma-separated (`cli,docs`). */
const AREA_SLUGS_RE = /^[a-z0-9][a-z0-9-]*(?:,[a-z0-9][a-z0-9-]*)*$/;

/** `deps`: literally `none`, or comma-separated issue numbers (`474,480`). */
const DEPS_RE = /^(?:none|\d+(?:,\d+)*)$/;

/** `batch`: a batch id slug — no spaces, slashes, or `#`. */
const BATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `takeover`: a label naming what took the run over (#504) — a run id, a slot id, an
 * agent name. Loose on purpose (the ladder has no single naming scheme) but still a
 * single flag-safe token, since it is read back out of a comment and shown to an agent.
 */
export const TAKEOVER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

/** Longest label echoed back out of a comment; a forged one is not a budget. */
const MAX_LABEL_LENGTH = 120;

/**
 * A `takeover=` label read OFF the trail, made safe to display.
 *
 * `TAKEOVER_RE` is enforced when a milestone is WRITTEN, but a milestone is an issue
 * comment: anyone who can comment can author one, and the tolerant reader
 * ({@link parseMilestone}) does not split non-header lines on whitespace, so a
 * hand-posted `takeover=` can carry spaces, ANSI escapes, and anything else short of a
 * newline. That string is printed into output an LLM agent with commit rights is
 * instructed to read and act on, and into an operator's terminal. So a label that does
 * not match the write-path grammar is DROPPED rather than quoted — the same discipline
 * as `gh.ts`'s `snippet`/`isSafeArg` and `dispatch.ts`'s prompt flattening.
 */
export function safeLabel(raw: string | undefined): string {
  return raw !== undefined && raw.length <= MAX_LABEL_LENGTH && TAKEOVER_RE.test(raw)
    ? raw
    : 'unknown';
}

/** One rule per enum-valued key; the message lists the closed set verbatim. */
function enumRule(values: readonly string[]): KeyValueRule {
  return {
    test: (value) => (values as readonly string[]).includes(value),
    expects: `expected one of: ${values.join(', ')}`,
  };
}

/**
 * The classifier's closed risk set, ordered least- to most-severe.
 *
 * Exported so the write-path rule below and every reader bucket on the SAME list. A reader
 * that hard-codes its own copy silently disagrees the day a fourth level is added here.
 */
export const RISK_LEVELS = ['low', 'med', 'high'] as const;

/** The classifier's closed mode set — which cycle shape the issue was routed to. */
export const CLASSIFY_MODES = ['full', SLOT_MODE] as const;

export const KEY_VALUE_RULES: Record<string, KeyValueRule> = {
  mode: enumRule(CLASSIFY_MODES),
  risk: enumRule(RISK_LEVELS),
  test_scope: enumRule(['focused', 'broad', 'unknown']),
  est_files: {
    test: (v) => NON_NEGATIVE_INT_RE.test(v),
    expects: 'expected a non-negative integer file count, e.g. 3',
  },
  est_diff: {
    test: (v) => NON_NEGATIVE_INT_RE.test(v),
    expects: 'expected a non-negative integer diff size (lines), e.g. 400',
  },
  // `review` reports blind conformance as met-of-judged. Declared here so the write path
  // validates them and `PHASE_SPECS` is not the only place the contract is discoverable —
  // `runstate stats`' conformance columns are read straight off these two keys.
  ac_met: {
    test: (v) => NON_NEGATIVE_INT_RE.test(v),
    expects: 'expected a non-negative integer count of acceptance criteria met, e.g. 4',
  },
  ac_total: {
    test: (v) => NON_NEGATIVE_INT_RE.test(v),
    expects: 'expected a non-negative integer count of acceptance criteria judged, e.g. 6',
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
  gen: {
    test: (v) => NON_NEGATIVE_INT_RE.test(v),
    expects:
      'expected a non-negative integer run generation, e.g. 1 (mint one with: runstate fence)',
  },
  takeover: {
    test: (v) => TAKEOVER_RE.test(v),
    expects: 'expected a single token naming what took the run over, e.g. slot-2 or r-504-fc02',
  },
};

/** The batch line's successor order, for `defaultNext`. */
const BATCH_NEXT: Record<BatchPhase, KnownPhase | 'done'> = {
  'batch-setup': 'batch-validate',
  'batch-validate': 'batch-review',
  'batch-review': 'batch-ship',
  'batch-ship': 'batch-report',
  'batch-report': 'done',
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
export function defaultNext(phase: KnownPhase, status: Status): KnownPhase | 'done' {
  if (status === 'blocked') return 'done';
  // A fence hands the SAME phase to the takeover, so the trail still points at work to
  // be done — that is what makes a fence whose takeover died resumable rather than
  // terminal (#504). `classify` is exempt only because it is not a `next=` value.
  if (status === FENCE_STATUS) return phase === CLASSIFY_PHASE ? 'done' : phase;
  if (status === 'awaiting-merge' || status === 'partial') return phase;
  if (phase === CLASSIFY_PHASE) return 'done';
  if (isBatchPhase(phase)) return BATCH_NEXT[phase];
  const idx = PHASES.indexOf(phase);
  return idx === PHASES.length - 1 ? 'done' : PHASES[idx + 1];
}

/**
 * Every status `phase` may report, including the universally-valid fence status (#504).
 *
 * One definition, so the predicate below and the error message in
 * {@link validateMilestone} can never disagree about the rule — a diagnostic that lists
 * a status the validator rejects (or omits one it accepts) is the hardest kind of bug to
 * notice, because the code is right and only the explanation is wrong.
 */
export function allowedStatuses(phase: KnownPhase): readonly Status[] {
  return [...ALL_PHASE_SPECS[phase].statuses, FENCE_STATUS];
}

/** Whether `phase` may report `status` — the fence status is valid on every phase (#504). */
export function statusAllowed(phase: KnownPhase, status: Status): boolean {
  return allowedStatuses(phase).includes(status);
}

/** The keys `phase` must carry when reporting `status`. */
export function requiredKeys(phase: KnownPhase, status: Status): readonly string[] {
  if (status === FENCE_STATUS) return FENCE_REQUIRED;
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
  // Checked before the generic whitespace rule: for a grammar-carrying key, the
  // key-specific message shows the correct form ('cli,docs'), which is the more
  // actionable answer for the same mistake.
  const rule = KEY_VALUE_RULES[key];
  if (rule && !rule.test(value)) {
    return `Key '${key}' has an invalid value '${value}' — ${rule.expects}`;
  }
  if (/\s/.test(value) && !isAcKey(key)) {
    return `Key '${key}' contains whitespace — values must not contain spaces (use '-' or ','); only ac* keys are exempt`;
  }
  if ((PATH_KEYS as readonly string[]).includes(key) && !value.startsWith('/')) {
    return `Key '${key}' must be an absolute path, got '${value}'`;
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
  } else if (isKnownPhase(phase) && !statusAllowed(phase, status)) {
    // The message lists the phase's OWN statuses and mentions the fence separately: an
    // author who mistyped a status must not read `superseded` as an ordinary choice and
    // hand-post a fence, bypassing the generation arithmetic `runstate fence` owns.
    errors.push(
      `Status '${status}' is not valid for phase '${phase}' — expected one of: ${ALL_PHASE_SPECS[phase].statuses.join(', ')} ('${FENCE_STATUS}' is valid on every phase, but is written by 'runstate fence', never by hand)`
    );
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

  if (isKnownPhase(phase) && isStatus(status) && statusAllowed(phase, status)) {
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

// --- Fencing (#504) ---

/**
 * The generation of a run that has never been fenced, and the generation a caller that
 * knows nothing about fencing implicitly posts at.
 *
 * Zero is deliberately the default rather than an error: an agent running an older
 * dossier — or the zombie this whole mechanism exists to stop — passes no generation at
 * all, so it lands at 0 and is fenced out the moment generation 1 exists. Nothing has to
 * be upgraded for the fence to take effect on the runs that matter.
 */
export const DEFAULT_GENERATION = 0;

/**
 * Ceiling on a run generation.
 *
 * The ladder caps recoveries at two per run, so a real generation is a single digit;
 * anything near this ceiling is forged or corrupt. The cap exists because generations
 * are arithmetic on network data: without it a fence claiming `gen=9007199254740991`
 * makes the NEXT generation unrepresentable, and every downstream parse of it fails —
 * which would disable fencing on that issue permanently.
 */
export const MAX_GENERATION = 1000;

/**
 * The `gen=` of a milestone, or null when it does not carry a usable one.
 *
 * Null rather than {@link DEFAULT_GENERATION}: a milestone whose `gen=` is missing,
 * unparseable, or past {@link MAX_GENERATION} is MALFORMED, and reading a malformed
 * fence as "generation 0" would silently downgrade it to "never fenced" — the one answer
 * that must never be inferred from bad data.
 */
export function generationOf(milestone: ParsedMilestone): number | null {
  const raw = milestone.keys.gen;
  if (raw === undefined) return null;
  const parsed = parseGeneration(raw);
  return parsed === null || parsed > MAX_GENERATION ? null : parsed;
}

/** Read a generation off a flag or a comment value; null when it is not one. */
export function parseGeneration(raw: string): number | null {
  if (!NON_NEGATIVE_INT_RE.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * An ISO-8601 date-time with an explicit zone — `Date.parse` alone is too permissive
 * (it also accepts locale-dependent forms like `"Aug 24 2026"`, and reads a
 * zone-less value as LOCAL time while every milestone `at=` is UTC, which would shift
 * the #582 staleness fence by the host's UTC offset).
 */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Read a `--dispatched-at` flag value; null when it is not an ISO-8601 instant with an
 * explicit zone. Normalizes to a canonical `Date#toISOString()` form so it compares
 * cleanly against milestone `at=` values regardless of the offset it was given in.
 */
export function parseDispatchedAt(raw: string): string | null {
  if (!ISO_INSTANT_RE.test(raw)) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * The highest-generation fence on `run`'s trail, or null when the run was never fenced.
 *
 * Scanned by highest generation rather than by position because milestones are only
 * append-ordered, not generation-ordered: a zombie can post AFTER the fence that
 * superseded it, and taking the last fence by position would then read back the older
 * one and un-fence the trail.
 */
export function latestFence(
  milestones: readonly ParsedMilestone[],
  run: string
): ParsedMilestone | null {
  if (run === '') return null;
  let best: ParsedMilestone | null = null;
  let bestGen = -1;
  for (const milestone of milestones) {
    if (milestone.status !== FENCE_STATUS || milestone.run !== run) continue;
    // A malformed fence is SKIPPED, never counted as generation 0: `FENCE_REQUIRED`
    // mandates a well-formed `gen=` on the write path, so one without it did not come
    // from `runstate fence`, and treating it as generation 0 would let it mask a real
    // fence behind it.
    const gen = generationOf(milestone);
    if (gen === null) continue;
    if (gen > bestGen) {
      bestGen = gen;
      best = milestone;
    }
  }
  return best;
}

/** The generation that currently owns `run` — 0 when it was never fenced. */
export function fenceGeneration(milestones: readonly ParsedMilestone[], run: string): number {
  const fence = latestFence(milestones, run);
  // `latestFence` already skipped every fence without a usable generation, so the
  // fallback here only covers "no fence at all".
  return fence === null ? DEFAULT_GENERATION : (generationOf(fence) ?? DEFAULT_GENERATION);
}

/**
 * Whether a run at `gen` has been superseded: some fence installed a HIGHER generation.
 *
 * Equal generations are live — the takeover posts at exactly the generation its own
 * fence installed, so `>` (not `>=`) is what lets the replacement work while every
 * earlier generation is locked out.
 */
export function isFenced(
  milestones: readonly ParsedMilestone[],
  run: string,
  gen: number
): boolean {
  return fenceGeneration(milestones, run) > gen;
}

/**
 * The generation the next fence on `run` should install, or null at {@link MAX_GENERATION}.
 *
 * Null rather than an unbounded increment: emitting a generation nobody can parse back
 * would break the fence for every later reader, so refusing to fence — loudly — is the
 * safer end of that trade.
 */
export function nextFenceGeneration(
  milestones: readonly ParsedMilestone[],
  run: string
): number | null {
  const next = fenceGeneration(milestones, run) + 1;
  return next > MAX_GENERATION ? null : next;
}

/**
 * The world-facing checks the resume table needs. Injected so {@link computeResume}
 * stays pure and testable — the command layer supplies the `git`/`gh`/`fs` versions.
 *
 * Remote-first: origin/<branch> is the durable copy of the work (WIP sync rule), so every
 * check that gates a resume decision runs against the remote. A local worktree is a bonus
 * signal ({@link dirExists}, surfaced as `local_worktree=` — informational only) never a
 * requirement — a resume verified purely from origin must succeed even when this machine
 * has never seen the worktree.
 */
export interface ResumeProbe {
  /** `git ls-remote --exit-code origin <branch>` succeeds. */
  branchOnRemote(branch: string): boolean;
  /**
   * `head` is present on `origin/<branch>`: equal to its current tip, or an ancestor of it
   * (`git fetch origin <branch>` then `git merge-base --is-ancestor <head> FETCH_HEAD`).
   */
  headOnRemote(branch: string, head: string): boolean;
  /** The worktree directory exists on this machine. Informational only — never gates resume. */
  dirExists(path: string): boolean;
  /** `gh pr view <pr> --json state,mergedAt,mergeable`, or null if it fails. */
  prState(pr: string): { state: string; mergedAt: string | null; mergeable: string } | null;
  /**
   * The issue's state is CLOSED, or null if it could not be determined (a failed or
   * non-JSON `gh` read). Callers that only care about "definitely closed" can treat
   * `null` the same as `false` (`!issueClosed()` is truthy for both) — but
   * {@link reportTrailVerdict} distinguishes them, since minting a fresh run on an
   * unknown-state issue risks a duplicate PR for one that was actually already merged.
   */
  issueClosed(): boolean | null;
}

export interface ResumeResult {
  /** Phase to resume from: a phase name, `ship-wait`, `ship-teardown`, `done`, or `none`. */
  resume_from: string;
  /**
   * The run id to reuse, or null on an empty trail. Exception: on a stale `report/done`
   * trail (#582) this is a freshly minted id for a fresh entry — it must NOT be reused;
   * the prior run's id is carried separately in {@link prior_run}.
   */
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
   * True when the freshest milestone marks the trail as slot-mode — a full-cycle-line
   * milestone (plan/implement/review) carrying `mode=slot` or a `batch=` id, or a
   * `classify` verdict with `mode=slot` (RFC-0001 C.4). Full-cycle re-enters such an
   * issue FRESH: a slot trail has no full-cycle phases to resume (the batch worktree is
   * machine-local, and an evicted member is requeued as `full` from scratch), so the
   * signal exists to make "fresh because slot" distinguishable from "fresh because
   * there was no trail". A trail whose latest milestone is a BATCH phase (an anchor
   * issue) sets no slot_trail — it reports its own note instead.
   */
  slot_trail?: boolean;
  /** Human-readable note, e.g. "already complete". */
  note?: string;
  /**
   * Set only for a stale `report/done` trail (#582): the OLD run id, carried forward so
   * the caller (gate-issue's milestone) can record where this fresh attempt's
   * predecessor left off. `run_id` on this same result is a newly minted id, not this
   * one — see {@link reportTrailVerdict}.
   */
  prior_run?: string;
  /**
   * The generation that owns this run (#504) — 0 for a run that was never fenced. A
   * resuming agent passes it to `runstate post --gen`; posting below it is rejected,
   * which is what stops a superseded run from extending the trail.
   */
  generation: number;
  /**
   * Whether the `worktree=` path carried in `resume_context` exists on this machine —
   * `n/a` when no milestone recorded one. Bonus signal only: it never changes
   * `resume_from`, which is decided purely from the remote-first checks above.
   */
  local_worktree: 'present' | 'absent' | 'n/a';
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
  /** The branch named in the recorded setup claims is still on the remote. */
  setupOk(): boolean;
  /**
   * `claimedHead` (the last milestone's own `head=`, `-dirty`-stripped) is present on
   * `origin/<branch>`. Shared by every phase whose milestone carries a `head=`, so the
   * remote-first ancestry check has one implementation.
   */
  headOk(): boolean;
}

/**
 * Where each phase's run re-enters, given that its own milestone is the latest one.
 *
 * Every phase downstream of `setup` re-checks the setup claims first: a branch deleted on
 * the remote invalidates everything recorded after it, so the run has to rebuild the
 * workspace before it can trust its own later milestones. Nothing here requires a local
 * worktree to exist on this machine — every check runs against origin (WIP sync rule).
 */
const PHASE_RESUMERS: Record<Phase, (scan: ResumeScan) => ResumeDecision> = {
  gate: () => ({ resume_from: 'setup' }),

  setup: (scan) => ({ resume_from: scan.setupOk() ? 'plan' : 'setup' }),

  plan: (scan) => {
    if (!scan.setupOk()) return { resume_from: 'setup' };
    if (!scan.headOk()) return { resume_from: 'plan' };
    scan.pass('head');
    return { resume_from: 'implement' };
  },

  implement: (scan) => {
    if (!scan.setupOk()) return { resume_from: 'setup' };
    if (!scan.headOk()) return { resume_from: 'implement' };
    scan.pass('head');
    return { resume_from: 'review' };
  },

  review: (scan) => {
    if (!scan.setupOk()) return { resume_from: 'setup' };
    if (!scan.headOk()) return { resume_from: 'review' };
    scan.pass('head');
    // A `partial` review still has agents left to run, even once its own head verifies.
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
 * The fresh-entry verdicts for a last milestone the full-cycle cannot resume from —
 * classify, a batch phase, slot-mode, or a phase this CLI does not know at all.
 *
 * Checked ABOVE the blocked rule on purpose: a slot-mode or batch milestone that
 * reports `blocked` still re-enters full-cycle fresh (the state machine that posted it
 * is not the one resuming); only the resume loop cap outranks them.
 */
function freshEntry(last: ParsedMilestone): { note: string; slot_trail?: boolean } | null {
  if (last.phase === CLASSIFY_PHASE) {
    return {
      note: 'classify record — full-cycle enters fresh',
      ...(last.keys.mode === SLOT_MODE ? { slot_trail: true } : {}),
    };
  }
  if (isBatchPhase(last.phase)) {
    return { note: 'batch anchor trail — not a full-cycle run' };
  }
  if (last.keys.mode === SLOT_MODE || last.keys.batch !== undefined) {
    return { note: 'slot-mode trail — full-cycle re-enters fresh', slot_trail: true };
  }
  if (!isPhase(last.phase)) {
    return {
      note: `unknown phase '${last.phase}' — not a full-cycle phase this CLI knows; entering fresh`,
    };
  }
  return null;
}

/**
 * A milestone predates a dispatch if it is more than this much before `dispatchedAt` —
 * a small clock-skew tolerance, not a meaningful staleness window. Mirrors
 * `packages/sched/src/groundtruth.ts`'s `DISPATCH_FENCE_TOLERANCE_MS` (#575/#576) exactly;
 * kept as a local copy rather than an import because this module is dependency-free by
 * design (see the module docstring).
 */
const DISPATCH_FENCE_TOLERANCE_MS = 60_000;

/**
 * True when `milestoneAt` is at-or-after `dispatchedAt` (within the clock-skew
 * tolerance) — i.e. the milestone could belong to THIS dispatch. Fails open (`true`,
 * "not stale") when there is no dispatch time to compare against, or either timestamp
 * is unparseable: an unanswerable check must never manufacture staleness that was never
 * there. Same shape as `groundtruth.ts`'s `postdatesDispatch` (#575/#576) — the engine
 * rail's precedent for this exact check, applied here to the gate/CLI rail (#582).
 */
function postdatesDispatch(milestoneAt: string, dispatchedAt: string | null): boolean {
  if (dispatchedAt === null) return true;
  const parsedMilestoneAt = Date.parse(milestoneAt);
  const parsedDispatchedAt = Date.parse(dispatchedAt);
  if (Number.isNaN(parsedMilestoneAt) || Number.isNaN(parsedDispatchedAt)) return true;
  return parsedMilestoneAt >= parsedDispatchedAt - DISPATCH_FENCE_TOLERANCE_MS;
}

/**
 * A `report/done` milestone on a still-OPEN issue is ambiguous without knowing when
 * THIS run was dispatched: it might be this run's own report (crashed between reporting
 * and closing — resume into `report` as today), or a completed PRIOR attempt that a
 * deliberate re-enqueue (pilot re-run, `sched abandon` + re-enqueue, ACs left unmet on
 * purpose) now needs full-cycle to redo (#582 — the gate/CLI twin of #575/#576's engine
 * check). The CLOSED case is left to {@link PHASE_RESUMERS}'s `report` resolver, which
 * already handles it correctly regardless of age (#576's closed-at-merge carve-out) —
 * this function only ever returns non-null for an OPEN issue.
 *
 * Returns:
 * - `null` — issue closed (definitely — see the `issueClosed()` tri-state note below), or
 *   the milestone postdates the dispatch (or no dispatch time was supplied): defer to the
 *   normal `report` resolver, unchanged.
 * - `{ note }` only — staleness could not be determined (no `--dispatched-at`, the issue's
 *   open/closed state could not be read, or the milestone's own `at=` does not parse):
 *   still resumes into `report` (the safe default — never mint a fresh run, and never
 *   redo the whole pipeline, on an unanswerable check), but flags why rather than
 *   silently asserting it.
 * - `{ run_id, prior_run, note }` — the milestone predates the dispatch: a stale prior
 *   attempt. Mint a fresh run id (the old one belongs to a finished run) and carry the
 *   old one forward as `prior_run` for the caller's milestone.
 */
function reportTrailVerdict(
  last: ParsedMilestone,
  probe: ResumeProbe,
  dispatchedAt: string | null
): { run_id: string; prior_run: string; note: string } | { note: string } | null {
  if (last.phase !== 'report' || last.status !== 'done') return null;

  // Tri-state on purpose: `true` (confirmed closed) defers to the resolver below, which
  // already handles it correctly. `null` (gh failed / unreadable) must NOT fall through
  // to the staleness check below — treating "unknown" as "open" here would mint a fresh
  // run, and potentially a duplicate PR, for an issue that might already be closed and
  // merged. Only a confirmed `false` (genuinely open) proceeds.
  const closed = probe.issueClosed();
  if (closed === true) return null;
  if (closed === null) {
    return {
      note: 'issue open/closed state could not be read — cannot tell whether this report/done milestone is stale; resuming at report',
    };
  }

  if (dispatchedAt === null) {
    return {
      note: 'report/done on an open issue with no --dispatched-at supplied — cannot tell whether this is a stale prior attempt; pass --dispatched-at to disambiguate (defaulting to resume_from=report)',
    };
  }

  if (Number.isNaN(Date.parse(last.at))) {
    return {
      note: `report/done milestone has no parseable at= ('${last.at}') — cannot compare it to --dispatched-at; resuming at report`,
    };
  }

  if (postdatesDispatch(last.at, dispatchedAt)) return null;

  const runMatch = RUN_ID_RE.test(last.run) ? /^r-(\d+)-/.exec(last.run) : null;
  if (runMatch === null) {
    return {
      note: `report/done milestone carries an unusable run id ('${last.run}') — cannot mint a successor; resuming at report`,
    };
  }
  return { run_id: mintRunId(runMatch[1]), prior_run: last.run, note: 'stale-report-trail' };
}

/**
 * Whether the `worktree=` path recorded in `context` exists on this machine — `n/a` when
 * no milestone recorded one. Informational only; see {@link ResumeResult.local_worktree}.
 */
function resolveLocalWorktree(
  context: Record<string, string>,
  probe: ResumeProbe
): ResumeResult['local_worktree'] {
  if (!context.worktree) return 'n/a';
  return probe.dirExists(context.worktree) ? 'present' : 'absent';
}

/**
 * Resolve where a run should resume from, implementing the resume verification table in
 * `imboard-ai/git/gate-issue`. Never trusts the milestone alone — every claim is checked
 * against reality through `probe`, and {@link PHASE_RESUMERS} holds the per-phase rules.
 *
 * `dispatchedAt` — the ISO time THIS run was dispatched — is what lets a `report/done`
 * milestone left by a prior attempt be told apart from this run's own
 * ({@link reportTrailVerdict}, #582). Omitting it (the default `null`) degrades to the
 * old, unfenced answer (`resume_from=report`), with the ambiguity reported in `note`.
 */
export function computeResume(
  milestones: ParsedMilestone[],
  probe: ResumeProbe,
  dispatchedAt: string | null = null
): ResumeResult {
  if (milestones.length === 0) {
    return {
      resume_from: 'none',
      run_id: null,
      verified: [],
      resume_context: {},
      last: null,
      local_worktree: 'n/a',
      generation: DEFAULT_GENERATION,
    };
  }

  const context: Record<string, string> = {};
  for (const m of milestones) Object.assign(context, m.keys);

  const last = milestones[milestones.length - 1];
  const verified: string[] = [];
  const local_worktree = resolveLocalWorktree(context, probe);
  const base = {
    run_id: last.run || null,
    verified,
    resume_context: context,
    last,
    local_worktree,
    generation: fenceGeneration(milestones, last.run),
  };

  if (hitLoopCap(milestones)) {
    return { ...base, resume_from: last.phase, hard_block: 'resume-loop' };
  }

  const fresh = freshEntry(last);
  if (fresh) {
    return { ...base, resume_from: 'none', ...fresh };
  }

  const reportVerdict = reportTrailVerdict(last, probe, dispatchedAt);
  if (reportVerdict && 'run_id' in reportVerdict) {
    // `base.generation` was computed from the OLD run's fence trail (`fenceGeneration`
    // above) — but `run_id` here is a brand-new, never-fenced id, so the generation must
    // reset to match it. Without this a fenced prior run (e.g. `generation=2`) would
    // hand a fresh, unfenced run a stale generation number to post under.
    return { ...base, resume_from: 'none', generation: DEFAULT_GENERATION, ...reportVerdict };
  }
  const ambiguousReportNote = reportVerdict?.note;

  // A fence is the last thing on the trail: the takeover was announced but has not
  // posted yet (#504). It may never post — the takeover can die too — so this is a
  // resumable state, at the fenced phase and at the generation the fence installed,
  // rather than a terminal one or an unknown status falling through to a fresh entry.
  if (last.status === FENCE_STATUS) {
    return {
      ...base,
      resume_from: last.phase || 'none',
      // Deliberately NOT "resume as that generation": `post` accepts an equal
      // generation, so telling every reader to adopt the takeover's number would invite
      // a second writer alongside a takeover that is alive and working — the exact race
      // this mechanism exists to prevent. Only a resumer that installs its own fence has
      // established that it, and not the takeover, owns the run.
      note: `fenced by '${safeLabel(last.keys.takeover)}' at generation ${base.generation} — if you are not that takeover, run 'ai-dossier runstate fence' to install generation ${base.generation + 1} before posting`,
    };
  }

  // Any blocked milestone resumes at that same phase.
  if (last.status === 'blocked') {
    return { ...base, resume_from: last.phase || 'none' };
  }

  // freshEntry has already returned for every non-full-cycle phase, so this only
  // narrows the type for the resolver lookup below.
  if (!isPhase(last.phase)) {
    return { ...base, resume_from: 'none' };
  }

  const pass = (check: string): void => {
    if (!verified.includes(check)) verified.push(check);
  };
  const setupOk = (): boolean => {
    // Remote-first (WIP sync rule): origin/<branch> is the durable copy of the work, so a
    // resume is valid purely from the remote — the worktree directory (`local_worktree`
    // above) is a bonus signal, never a requirement.
    const { branch } = context;
    if (!branch) return false;
    if (!probe.branchOnRemote(branch)) return false;
    pass('branch');
    return true;
  };
  const headOk = (): boolean => {
    const { branch } = context;
    const claimed = (last.keys.head ?? '').replace(DIRTY_HEAD_SUFFIX_RE, '');
    if (!branch || !claimed) return false;
    return probe.headOnRemote(branch, claimed);
  };

  const { resume_from, note } = PHASE_RESUMERS[last.phase]({
    last,
    context,
    probe,
    pass,
    setupOk,
    headOk,
  });
  const finalNote = note ?? ambiguousReportNote;
  return { ...base, resume_from, ...(finalNote ? { note: finalNote } : {}) };
}
