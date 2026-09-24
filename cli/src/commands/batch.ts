/**
 * `ai-dossier batch compose` (#773, #770 P3) — preview which issues may share a batch PR, with
 * zero model tokens. Runs prescreen:v4 + the deterministic readiness screen over the operator's
 * picks and/or the backlog and proposes a composition honouring the scheduler's batch invariants
 * (≤ `max_full_review_members` review=full members, one base branch, 3–6 members), listing ranked
 * backfill candidates when the picks fall short.
 *
 * I/O only: `gh` (issue reads), and a READ-ONLY look at the local sched queue/config. Never a
 * model call, never a write (no labels, comments, or queue changes) — composing is a preview;
 * batch-issues-preparation (or the operator) acts on it. Exits 0 once arguments validate; the
 * `status` field is the payload, not a pass/fail gate (same contract as `classify prescreen`).
 */

import {
  MAX_FULL_REVIEW_MEMBERS,
  resolveProjectSlug,
  SAFE_REF_RE,
  SATISFIED_ISSUE_STATUSES,
  type SchedConfig,
  type SchedState,
  SchedStore,
  sanitizeSlug,
  defaultExec as schedExec,
  schedStateDir,
  TERMINAL_ISSUE_STATUSES,
} from '@ai-dossier/sched';
import type { Command } from 'commander';
import {
  type AssessedIssue,
  applyPickDependencies,
  assessIssue,
  COMPOSE_SCHEMA,
  type ComposeIssueInput,
  type ComposeRules,
  type CompositionResult,
  composeBatch,
  DEFAULT_MAX_MEMBERS,
  DEFAULT_MIN_MEMBERS,
} from '../batch-compose';
import {
  asString,
  exec,
  fail,
  ghFailure,
  parseGhJson,
  repoArgs,
  requireRepoSlug,
  tryFetchIssueState,
} from '../gh';
import { collectRepeatable } from '../helpers';
import { MAX_ISSUE_SELECTION, parseIssueSelection } from '../issue-selection';
import { findLatestPlan } from '../plan-artifact';
import { extractDependencyRefs } from '../prescreen';
import { parseMilestones } from '../runstate';

interface ComposeCliOptions {
  issues?: string;
  backlog?: boolean;
  backfill?: boolean;
  label?: string[];
  search?: string;
  limit: string;
  repo?: string;
  project?: string;
  base: string;
  minMembers: string;
  maxMembers: string;
  maxFullReview?: string;
  rules: string;
  json?: boolean;
}

/** Default backlog page — one `gh issue list` call, bodies and comments included. */
const DEFAULT_BACKLOG_LIMIT = 100;
/** Hard ceiling on the backlog page (each issue's comments ride along in the one call). */
const MAX_BACKLOG_LIMIT = 500;
/** stdout ceiling for the backlog page — bodies and comments of up to MAX_BACKLOG_LIMIT issues. */
const BACKLOG_MAX_BUFFER = 256 * 1024 * 1024;
/** Fields every issue read requests — `comments` carries plan:v1 artifacts and runstate milestones. */
const ISSUE_FIELDS = 'number,title,body,labels,assignees,state,comments';

interface RawIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  assignees?: unknown;
  state?: unknown;
  comments?: unknown;
}

function names(value: unknown, key: 'name' | 'login'): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined))
    .filter((v): v is string => typeof v === 'string');
}

function commentBodies(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((c) =>
    c && typeof c === 'object' && typeof (c as { body?: unknown }).body === 'string'
      ? (c as { body: string }).body
      : ''
  );
}

/** A `gh` issue object → the core's input (dependencies and sched status filled in later). */
function toInput(raw: RawIssue, source: ComposeIssueInput['source']): ComposeIssueInput {
  const bodies = commentBodies(raw.comments);
  const plan = findLatestPlan(bodies);
  const milestones = parseMilestones(bodies);
  return {
    issue: Number(raw.number),
    source,
    title: asString(raw.title),
    body: asString(raw.body),
    labels: names(raw.labels, 'name'),
    state: asString(raw.state),
    assignees: names(raw.assignees, 'login'),
    predictedFiles: plan?.artifact.predictedFiles,
    latestPhase: milestones.length > 0 ? milestones[milestones.length - 1].phase : null,
  };
}

function fetchPick(issue: number, repo: string | undefined): ComposeIssueInput {
  const res = exec('gh', [
    'issue',
    'view',
    String(issue),
    '--json',
    ISSUE_FIELDS,
    ...repoArgs(repo),
  ]);
  const unreadable = (error: string): ComposeIssueInput => ({
    issue,
    source: 'pick',
    error,
    title: '',
    body: '',
    labels: [],
    state: '',
    assignees: [],
  });
  if (!res.ok) return unreadable(ghFailure(`Could not read issue #${issue}`, res.error, repo));
  const parsed = parseGhJson<RawIssue>(res.stdout);
  if (parsed === null) return unreadable(`Could not read issue #${issue}: gh did not print JSON.`);
  return toInput({ ...parsed, number: issue }, 'pick');
}

function fetchBacklog(
  opts: { limit: number; labels: string[]; search?: string },
  repo: string | undefined,
  warnings: string[]
): ComposeIssueInput[] {
  const args = ['issue', 'list', '--state', 'open', '--limit', String(opts.limit)];
  for (const label of opts.labels) args.push(`--label=${label}`);
  if (opts.search !== undefined) args.push(`--search=${opts.search}`);
  args.push('--json', ISSUE_FIELDS, ...repoArgs(repo));
  const res = exec('gh', args, { maxBuffer: BACKLOG_MAX_BUFFER });
  if (!res.ok) {
    warnings.push(ghFailure('Could not list the backlog — no backfill proposed', res.error, repo));
    return [];
  }
  const parsed = parseGhJson<RawIssue[]>(res.stdout);
  if (!Array.isArray(parsed)) {
    warnings.push(
      'Could not list the backlog: gh did not print a JSON array — no backfill proposed.'
    );
    return [];
  }
  return parsed
    .filter((r) => Number.isSafeInteger(Number(r.number)) && Number(r.number) > 0)
    .map((r) => toInput(r, 'backlog'));
}

/** The sched project slug: explicit `--project`, else `--repo` as `owner-name`, else the cwd's repo. */
function resolveProject(opts: ComposeCliOptions): string {
  if (opts.project) return opts.project;
  if (opts.repo) return sanitizeSlug(opts.repo.replace('/', '-'));
  return resolveProjectSlug(schedExec);
}

/** Read-only sched queue + config. A missing state is an empty queue; an unreadable one is a warning. */
function readSched(
  project: string,
  warnings: string[]
): { state: SchedState | null; config: SchedConfig | null } {
  const store = new SchedStore(schedStateDir(project));
  let state: SchedState | null = null;
  let config: SchedConfig | null = null;
  try {
    state = store.load();
  } catch (err) {
    warnings.push(
      `Could not read the sched queue for '${project}' — the sched-active check was skipped: ${(err as Error).message}`
    );
  }
  try {
    config = store.loadConfig();
  } catch (err) {
    warnings.push(
      `Could not read the sched config for '${project}' — using the default review=full cap: ${(err as Error).message}`
    );
  }
  return { state, config };
}

/** Status of the issue's live queue entry (not terminal, not already merged), or null. */
function activeSchedStatus(state: SchedState | null, issue: number): string | null {
  const entry = state?.entries.find(
    (e) =>
      e.issue === issue &&
      !TERMINAL_ISSUE_STATUSES.has(e.status) &&
      !SATISFIED_ISSUE_STATUSES.has(e.status)
  );
  return entry ? entry.status : null;
}

function positiveInt(raw: string, flag: string, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < min || n > max) {
    fail([`${flag} must be an integer between ${min} and ${max}, got '${raw}'.`]);
  }
  return n;
}

export interface ComposeReport extends CompositionResult {
  schema: typeof COMPOSE_SCHEMA;
  repo: string | null;
  project: string;
  base_branch: string;
  rules: ComposeRules;
  params: {
    min_members: number;
    max_members: number;
    max_full_review: number;
    picks: number[];
    backlog: { queried: boolean; labels: string[]; search: string | null; limit: number };
  };
  /** Draft `sched enqueue --from-manifest` entries — batch-issues-preparation adds batch/anchor/run_id/tier/deps. */
  manifest_entries: Array<{
    issue: number;
    mode: 'slot';
    review: 'light' | 'full';
    base_branch: string;
  }>;
  excluded: Array<{
    issue: number;
    title: string;
    source: 'pick' | 'backlog';
    reasons: AssessedIssue['excluded'];
  }>;
  counts: { assessed: number; admissible: number; excluded: number };
  /** Always 0 — the whole point of this command (#773 AC2). */
  model_calls: 0;
  degraded: boolean;
  warnings: string[];
}

/** Terminal control characters — issue titles and label names are untrusted, network-sourced text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching (and stripping) control characters is exactly this regex's job
const TERMINAL_CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

function renderText(r: ComposeReport): void {
  // Every text line goes through one strip, so an ANSI/OSC escape in an issue title can never
  // reach the operator's terminal raw. (JSON mode is safe: JSON.stringify escapes them.)
  const line = (s = '') => console.log(s.replace(TERMINAL_CONTROL_RE, ''));
  line(`batch compose — ${r.repo ?? r.project} (base ${r.base_branch}, rules ${r.rules})`);
  line(
    `status: ${r.status} — ${r.members.length} member(s), ${r.members.filter((m) => m.review === 'full').length}/${r.params.max_full_review} review=full, min ${r.params.min_members}, max ${r.params.max_members}`
  );
  line(`→ ${r.recommendation}`);
  line();
  line('Members:');
  if (r.members.length === 0) line('  (none)');
  for (const m of r.members) {
    const pk = m.packages.length > 0 ? ` [${m.packages.join(', ')}]` : '';
    line(`  #${m.issue}  review=${m.review}  (${m.source})${pk}  ${m.title}`);
    for (const why of m.review_reasons) line(`      full because: ${why}`);
  }
  if (r.shared_packages.length > 0) line(`  shared packages: ${r.shared_packages.join(', ')}`);
  if (r.held.length > 0) {
    line();
    line('Admissible but held out:');
    for (const h of r.held) line(`  #${h.issue}  review=${h.review}  ${h.reason}  ${h.title}`);
  }
  if (r.excluded.length > 0) {
    line();
    line('Excluded:');
    for (const e of r.excluded) {
      line(`  #${e.issue}  ${e.reasons.map((x) => x.code).join(', ')}  ${e.title}`);
      for (const x of e.reasons) line(`      ${x.message}`);
    }
  }
  if (r.backfill.length > 0) {
    line();
    line('Backfill candidates (ranked):');
    for (const b of r.backfill.slice(0, 10)) {
      const sh = b.shared_packages.length > 0 ? ` shares ${b.shared_packages.join(', ')}` : '';
      line(
        `  ${b.rank}. #${b.issue}  review=${b.review}${b.selected ? '  ← selected' : ''}${sh}  ${b.title}`
      );
    }
    if (r.backfill.length > 10) line(`  … ${r.backfill.length - 10} more (see --json)`);
  }
  for (const w of r.warnings) console.error(`⚠ ${w.replace(TERMINAL_CONTROL_RE, '')}`);
}

function runCompose(opts: ComposeCliOptions): void {
  if (opts.repo) requireRepoSlug(opts.repo);
  if (!SAFE_REF_RE.test(opts.base))
    fail([`--base must be a valid git ref name, got '${opts.base}'.`]);
  if (opts.rules !== 'v2' && opts.rules !== 'legacy') {
    fail([`--rules must be 'v2' or 'legacy', got '${opts.rules}'.`]);
  }
  const rules = opts.rules as ComposeRules;
  if (!opts.issues && !opts.backlog) {
    fail([
      'Nothing to compose.',
      'Fix: pass --issues <selection> (e.g. 4,5,9..12) and/or --backlog.',
    ]);
  }
  let picks: number[] = [];
  if (opts.issues) {
    try {
      picks = parseIssueSelection(opts.issues);
    } catch (err) {
      fail([`--issues: ${(err as Error).message}`]);
    }
  }
  const limit = positiveInt(opts.limit, '--limit', { max: MAX_BACKLOG_LIMIT });
  const minMembers = positiveInt(opts.minMembers, '--min-members', { max: DEFAULT_MAX_MEMBERS });
  const maxMembers = positiveInt(opts.maxMembers, '--max-members', { max: DEFAULT_MAX_MEMBERS });
  if (minMembers > maxMembers) fail(['--min-members may not exceed --max-members.']);

  const warnings: string[] = [];
  const project = resolveProject(opts);
  const sched = readSched(project, warnings);
  const maxFullReview =
    opts.maxFullReview !== undefined
      ? positiveInt(opts.maxFullReview, '--max-full-review', { min: 0, max: DEFAULT_MAX_MEMBERS })
      : (sched.config?.max_full_review_members ?? MAX_FULL_REVIEW_MEMBERS);

  const inputs: ComposeIssueInput[] = picks.map((n) => fetchPick(n, opts.repo));
  const pickSet = new Set(picks);

  // Backlog: explicitly requested, or automatic backfill when the picks fall short.
  const labels = opts.label ?? [];
  let backlogQueried = false;
  // Dependency state lookups, cached across issues (backlog issues are known OPEN for free).
  const knownState = new Map<number, string>();
  const unresolved = new Set<number>();
  const depCache = new Map<number, ComposeIssueInput>();
  /** Pick → the other picks it depends on (checked after assessment, see applyPickDependencies). */
  const pickDeps = new Map<number, number[]>();
  function withDeps(input: ComposeIssueInput): ComposeIssueInput {
    const cached = depCache.get(input.issue);
    if (cached) return cached;
    if (input.error !== undefined) return input;
    const open: number[] = [];
    const unknown: number[] = [];
    const onPicks: number[] = [];
    for (const dep of extractDependencyRefs(`${input.title}\n${input.body}`)) {
      if (dep === input.issue) continue;
      if (pickSet.has(dep)) {
        onPicks.push(dep);
        continue;
      }
      let state = knownState.get(dep);
      if (state === undefined) {
        const res = tryFetchIssueState(String(dep), opts.repo);
        if (!res.ok) {
          unresolved.add(dep);
          unknown.push(dep);
          continue;
        }
        state = res.state;
        knownState.set(dep, state);
      }
      if (state.toUpperCase() === 'OPEN') open.push(dep);
    }
    if (onPicks.length > 0) pickDeps.set(input.issue, onPicks);
    const full = {
      ...input,
      openDependencies: open,
      unknownDependencies: unknown,
      schedStatus: activeSchedStatus(sched.state, input.issue),
    };
    depCache.set(input.issue, full);
    return full;
  }
  const isOpen = (issue: number) => (knownState.get(issue) ?? 'OPEN').toUpperCase() === 'OPEN';
  const assessAll = (list: ComposeIssueInput[]) =>
    applyPickDependencies(
      list.map((i) => assessIssue(withDeps(i), rules)),
      pickDeps,
      isOpen
    );
  const composeOpts = {
    rules,
    baseBranch: opts.base,
    minMembers,
    maxMembers,
    maxFullReview,
    picksMode: picks.length > 0,
  };

  // Backlog: explicitly requested, or automatic backfill when the picks alone cannot compose
  // min_members (counted after the caps — five admissible review=full picks compose only two).
  const wantBacklog = (): boolean => {
    if (opts.backlog) return true;
    if (opts.backfill === false) return false;
    return composeBatch(assessAll(inputs), composeOpts).members.length < minMembers;
  };

  for (const i of inputs) if (i.error === undefined) knownState.set(i.issue, i.state);

  if (wantBacklog()) {
    backlogQueried = true;
    const backlog = fetchBacklog({ limit, labels, search: opts.search }, opts.repo, warnings);
    for (const b of backlog) knownState.set(b.issue, b.state);
    for (const b of backlog) if (!pickSet.has(b.issue)) inputs.push(b);
  }

  const assessed = assessAll(inputs);
  for (const a of assessed) {
    const input = inputs.find((i) => i.issue === a.issue);
    if (input?.error !== undefined) warnings.push(input.error);
  }
  if (unresolved.size > 0) {
    warnings.push(
      `Could not resolve open/closed state for dependency issue(s) ${[...unresolved].map((n) => `#${n}`).join(', ')} — those issues were excluded as open-dependency (fail closed).`
    );
  }

  const composition = composeBatch(assessed, composeOpts);

  const excluded = assessed
    .filter((a) => !a.admissible)
    .map((a) => ({ issue: a.issue, title: a.title, source: a.source, reasons: a.excluded }));

  const report: ComposeReport = {
    schema: COMPOSE_SCHEMA,
    repo: opts.repo ?? null,
    project,
    base_branch: opts.base,
    rules,
    params: {
      min_members: minMembers,
      max_members: maxMembers,
      max_full_review: maxFullReview,
      picks,
      backlog: { queried: backlogQueried, labels, search: opts.search ?? null, limit },
    },
    ...composition,
    manifest_entries: composition.members.map((m) => ({
      issue: m.issue,
      mode: 'slot' as const,
      review: m.review,
      base_branch: opts.base,
    })),
    excluded,
    counts: {
      assessed: assessed.length,
      admissible: assessed.length - excluded.length,
      excluded: excluded.length,
    },
    model_calls: 0,
    degraded: warnings.length > 0,
    warnings,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderText(report);
  }
}

/** Registers the `batch` command tree (currently just `compose`). */
export function registerBatchCommand(program: Command): void {
  const batch = program
    .command('batch')
    .description('Batch-cycle helpers — deterministic, zero-token batch composition');

  batch
    .command('compose')
    .description(
      'Preview an admissible batch composition from operator picks and/or the backlog (prescreen + readiness, no model call)'
    )
    .option(
      '--issues <selection>',
      `Operator picks, fleet grammar (e.g. "4114,4178" or "10..14"; at most ${MAX_ISSUE_SELECTION})`
    )
    .option(
      '--backlog',
      'Also draw candidates from the open backlog (implied for backfill when picks fall short)'
    )
    .option('--no-backfill', 'Never query the backlog to backfill short picks')
    .option(
      '--label <name>',
      'Backlog filter: only issues with this label (repeatable)',
      collectRepeatable
    )
    .option('--search <query>', 'Backlog filter: GitHub search query (gh issue list --search)')
    .option(
      '--limit <n>',
      `Backlog issues to read (max ${MAX_BACKLOG_LIMIT})`,
      String(DEFAULT_BACKLOG_LIMIT)
    )
    .option('--repo <owner/name>', 'Target repository (defaults to the current one)')
    .option(
      '--project <slug>',
      'sched project whose queue/config to read (defaults to the repo slug)'
    )
    .option('--base <branch>', 'Base branch every member shares', 'main')
    .option(
      '--min-members <n>',
      'Minimum viable batch; fewer ⇒ backfill proposed',
      String(DEFAULT_MIN_MEMBERS)
    )
    .option('--max-members <n>', 'Member ceiling', String(DEFAULT_MAX_MEMBERS))
    .option(
      '--max-full-review <n>',
      `Per-batch review=full cap (default: sched config max_full_review_members, else ${MAX_FULL_REVIEW_MEMBERS})`
    )
    .option(
      '--rules <rules>',
      "Admission rules: 'v2' (current #770 rules: risk-floor, deploy-pipeline and >8-file issues join as review=full members) or 'legacy' (pre-#770: any risk keyword, plan:v1 risk-floor path or >8 predicted files excludes)",
      'v2'
    )
    .option('--json', `Machine-readable output (schema ${COMPOSE_SCHEMA})`)
    .action((opts: ComposeCliOptions) => runCompose(opts));
}
