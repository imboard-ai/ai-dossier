/**
 * Enqueue: accept queue entries from CLI flags or a batch-prep manifest
 * (RFC-0001 §C.1 — "queue entries (issue → mode, batch membership, deps, tier)
 * written by batch-prep"). Pure validation + state mutation: rejects duplicate
 * active issues, mode/batch mismatches, self-dependencies, and dependency
 * cycles at enqueue time rather than at assignment time.
 *
 * `blocked_label` (#507) lands an entry as `blocked` instead of `queued` — the
 * CLI resolves it from the issue's actual GitHub labels before calling in
 * here; this module stays I/O-free and only honors the value it is handed.
 */

import { SAFE_REF_RE } from './attribution';
import { unwrapList } from './json';
import { labelBlockReason } from './labels';
import { createBatch, findBatch, transitionBatch } from './state';
import type { CycleMode, ModelTier, QueueEntry, SchedState } from './types';
import { TERMINAL_ISSUE_STATUSES } from './types';

export class EnqueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnqueueError';
  }
}

/**
 * Run-id grammar, kept identical to `RUN_ID_RE` in `cli/src/runstate.ts` — the
 * CLI is the validating authority for milestones, and this package cannot
 * import from it (the dependency runs the other way).
 */
const RUN_ID_RE = /^r-\d+-[0-9a-f]{4,}$/;

/** GitHub label-name grammar: what `blocked_label` (and `EnqueueInput.blocked_label`) may contain. */
const LABEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,49}$/;

/**
 * Batch id grammar — deliberately stricter than `SAFE_REF_RE` (which permits
 * `/` and `..`, both legal in a git ref but not in a filesystem path
 * component): batch-dispatch.ts (#523) builds a worktree directory name
 * DIRECTLY from this id (`worktrees/batch-<id>-<date>`), so an id containing
 * `..` or `/` could otherwise walk the resulting path outside the repo
 * (CWE-22) before `isSafeWorktree`'s containment check ever runs. No legal
 * batch id needs either character.
 */
const BATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The `label:<name>` reason vocabulary moved to `labels.ts` (#544) so the
 * engine's per-tick re-check and this enqueue-time screen share one
 * definition. Re-exported here because `LABEL_BLOCK_REASON_PREFIX` /
 * `labelBlockReason` were part of this module's public surface first.
 */
export { LABEL_BLOCK_REASON_PREFIX, labelBlockReason } from './labels';

/** One unit of work as provided by flags or a manifest (defaults applied by `enqueueEntries`). */
export interface EnqueueInput {
  issue: number;
  mode?: CycleMode;
  batch?: string | null;
  deps?: number[];
  tier?: ModelTier;
  /**
   * Assignment weight for a full-cycle entry (#565, default 0). Ignored for
   * a slot-mode member — see `batch_priority` for the BATCH's own weight.
   */
  priority?: number;
  base_branch?: string;
  /**
   * Assignment weight for the BATCH this entry joins/creates (#565), a
   * batch-level fact like `anchor`/`run_id`: every member of one batch must
   * supply the same value, or none. Resolved to `DEFAULT_BATCH_PRIORITY` (or
   * `SchedConfig.default_batch_priority`) by the caller when omitted — this
   * module stays config-free, same as `blocked_label`'s resolution one field
   * over.
   */
  batch_priority?: number;
  /**
   * Batch-level facts batch-prep knows at composition time (#472). They
   * describe the BATCH, not the entry, so every member of one batch must
   * supply the same values — a conflicting re-supply is rejected rather than
   * silently re-pointing the batch's milestones or eviction grouping.
   */
  anchor?: number;
  run_id?: string;
  eviction_groups?: number[][];
  /**
   * Declares that MORE members for this entry's batch will land in a LATER
   * `enqueue` call — set by a caller who knows composition isn't finished yet
   * (e.g. an oversized manifest split across several `--from-manifest` calls,
   * or a batch composed incrementally via repeated `--issues --batch`). Any
   * entry in a call carrying `true` withholds that call's seal for its batch
   * even though the call touched it (#535 AC1's "partial batch" clause); omit
   * it, or set `false`, on the call that lands the last declared member so it
   * seals normally. Unlike `anchor`/`run_id`/`eviction_groups`, this is a
   * per-call signal, not a batch identity fact — it is never checked for
   * cross-call agreement.
   */
  more_members_expected?: boolean;
  /**
   * Name of a hard-block GitHub label found on this issue (#507, e.g.
   * `decision-pending`), resolved by the CLI's pre-screen before calling
   * `enqueueEntries` — never parsed from a manifest. When set, the entry
   * lands as `blocked` with `reason: 'label:<name>'` instead of `queued`.
   */
  blocked_label?: string | null;
}

function asPositiveInt(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new EnqueueError(`${label} must be a positive integer, got ${String(value)}`);
  }
  return value as number;
}

/** Unlike `asPositiveInt`: a priority may legitimately be 0 or negative (deprioritized below the default). */
function asInt(value: unknown, label: string): number {
  if (!Number.isInteger(value)) {
    throw new EnqueueError(`${label} must be an integer, got ${String(value)}`);
  }
  return value as number;
}

/**
 * Parse a `--from-manifest` payload. Accepts either a bare array of entries or
 * `{ "project": "...", "entries": [...] }` (the batch-prep output shape;
 * `project` is accepted and ignored — the CLI resolves the project itself).
 */
export function parseManifest(raw: unknown): EnqueueInput[] {
  const list = unwrapList(raw, 'entries');
  if (list === null) {
    throw new EnqueueError('Manifest must be a JSON array of entries or { "entries": [...] }');
  }
  return list.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new EnqueueError(`Manifest entry [${i}] must be an object`);
    }
    const obj = item as Record<string, unknown>;
    const input: EnqueueInput = {
      issue: asPositiveInt(obj.issue, `Manifest entry [${i}]: issue`),
    };
    if (obj.mode !== undefined) {
      if (obj.mode !== 'full' && obj.mode !== 'slot') {
        throw new EnqueueError(`Manifest entry [${i}]: mode must be 'full' or 'slot'`);
      }
      input.mode = obj.mode;
    }
    if (obj.batch !== undefined && obj.batch !== null) {
      if (typeof obj.batch !== 'string' || obj.batch.length === 0) {
        throw new EnqueueError(`Manifest entry [${i}]: batch must be a non-empty string`);
      }
      input.batch = obj.batch;
    }
    if (obj.deps !== undefined) {
      if (!Array.isArray(obj.deps)) {
        throw new EnqueueError(`Manifest entry [${i}]: deps must be an array`);
      }
      input.deps = obj.deps.map((d, j) => asPositiveInt(d, `Manifest entry [${i}]: deps[${j}]`));
    }
    if (obj.tier !== undefined) {
      if (obj.tier !== 'mechanical' && obj.tier !== 'mid' && obj.tier !== 'strong') {
        throw new EnqueueError(`Manifest entry [${i}]: tier must be mechanical | mid | strong`);
      }
      input.tier = obj.tier;
    }
    if (obj.priority !== undefined) {
      input.priority = asInt(obj.priority, `Manifest entry [${i}]: priority`);
    }
    if (obj.batch_priority !== undefined) {
      input.batch_priority = asInt(obj.batch_priority, `Manifest entry [${i}]: batch_priority`);
    }
    if (obj.base_branch !== undefined) {
      // A ref name, not merely a non-empty string: this value ends up in
      // `git fetch`/`git rebase` argv during batch recovery, and rejecting it
      // there costs a dissolved batch instead of a rejected manifest.
      if (typeof obj.base_branch !== 'string' || !SAFE_REF_RE.test(obj.base_branch)) {
        throw new EnqueueError(`Manifest entry [${i}]: base_branch must be a valid git ref name`);
      }
      input.base_branch = obj.base_branch;
    }
    if (obj.anchor !== undefined) {
      input.anchor = asPositiveInt(obj.anchor, `Manifest entry [${i}]: anchor`);
    }
    if (obj.run_id !== undefined) {
      // The runstate grammar, checked here rather than discovered at recovery
      // time: `ai-dossier runstate post` rejects anything else, so a run id the
      // CLI dislikes makes every batch milestone un-postable — a failure that
      // surfaces far from the manifest that caused it.
      if (typeof obj.run_id !== 'string' || !RUN_ID_RE.test(obj.run_id)) {
        throw new EnqueueError(
          `Manifest entry [${i}]: run_id must match r-<issue>-<hex>, e.g. r-900-ab56 (mint one with: ai-dossier runstate mint --issue <n>)`
        );
      }
      input.run_id = obj.run_id;
    }
    if (obj.eviction_groups !== undefined) {
      if (!Array.isArray(obj.eviction_groups)) {
        throw new EnqueueError(`Manifest entry [${i}]: eviction_groups must be an array`);
      }
      input.eviction_groups = obj.eviction_groups.map((group, j) => {
        if (!Array.isArray(group)) {
          throw new EnqueueError(
            `Manifest entry [${i}]: eviction_groups[${j}] must be an array of issue numbers`
          );
        }
        return group.map((m, k) =>
          asPositiveInt(m, `Manifest entry [${i}]: eviction_groups[${j}][${k}]`)
        );
      });
    }
    if (obj.more_members_expected !== undefined) {
      if (typeof obj.more_members_expected !== 'boolean') {
        throw new EnqueueError(`Manifest entry [${i}]: more_members_expected must be a boolean`);
      }
      input.more_members_expected = obj.more_members_expected;
    }
    return input;
  });
}

/**
 * Dependency-cycle detection over the combined graph (existing entries +
 * inputs). Deps pointing at issues not in the graph are allowed — they stay
 * permanently unsatisfied and surface in `sched status`'s blocked set.
 */
export function assertNoDependencyCycle(state: SchedState, inputs: EnqueueInput[]): void {
  const edges = new Map<number, number[]>();
  // A re-enqueued issue's fresh deps REPLACE its old entry's deps below (the
  // entry actually built at ~line 334 carries only `input.deps`, never a
  // merge) — mirror that here rather than appending, or a stale dep from a
  // now-terminal entry can produce a cycle error for a manifest that, read on
  // its own, has none.
  const reenqueued = new Set(inputs.map((input) => input.issue));
  for (const entry of state.entries) {
    if (reenqueued.has(entry.issue)) continue;
    edges.set(entry.issue, [...entry.deps]);
  }
  for (const input of inputs) {
    edges.set(input.issue, [...(input.deps ?? [])]);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<number, number>();

  const visit = (node: number, stack: number[]): void => {
    const c = color.get(node) ?? WHITE;
    if (c === BLACK) return;
    if (c === GRAY) {
      const cycleStart = stack.indexOf(node);
      const cycle = [...stack.slice(cycleStart), node].join(' → ');
      throw new EnqueueError(`Dependency cycle detected: ${cycle}`);
    }
    color.set(node, GRAY);
    for (const dep of edges.get(node) ?? []) {
      if (edges.has(dep)) visit(dep, [...stack, node]);
    }
    color.set(node, BLACK);
  };

  for (const node of edges.keys()) {
    visit(node, []);
  }
}

/**
 * A batch-level fact supplied twice must be supplied identically (#472). The
 * anchor is where every batch milestone posts and the eviction groups decide
 * which members revert together — silently keeping the first value while a
 * later manifest says something else would post the batch's failure report to
 * the wrong issue, or evict half a coupled group.
 */
function assertBatchFactsAgree(
  batchId: string,
  existing: {
    anchor: number | null;
    run_id: string | null;
    eviction_groups: number[][];
    priority: number;
  },
  input: EnqueueInput
): void {
  if (input.anchor !== undefined && existing.anchor !== null && existing.anchor !== input.anchor) {
    throw new EnqueueError(
      `Batch ${batchId} was enqueued with anchor #${existing.anchor} — refusing to re-point it to #${input.anchor}`
    );
  }
  if (input.run_id !== undefined && existing.run_id !== null && existing.run_id !== input.run_id) {
    throw new EnqueueError(
      `Batch ${batchId} was enqueued with run_id '${existing.run_id}' — refusing to re-point it to '${input.run_id}'`
    );
  }
  // Unlike anchor/run_id, `priority` is never left unset once a batch exists
  // (createBatch always resolves it) — so agreement is the only check
  // needed, never a fill-in-if-absent.
  if (input.batch_priority !== undefined && existing.priority !== input.batch_priority) {
    throw new EnqueueError(
      `Batch ${batchId} was enqueued with priority ${existing.priority} — refusing to re-point it to ${input.batch_priority}`
    );
  }
  if (input.eviction_groups !== undefined && existing.eviction_groups.length > 0) {
    const supplied = JSON.stringify(input.eviction_groups);
    if (JSON.stringify(existing.eviction_groups) !== supplied) {
      throw new EnqueueError(
        `Batch ${batchId} already has eviction groups ${JSON.stringify(existing.eviction_groups)} — refusing to replace them with ${supplied}`
      );
    }
  }
}

/**
 * Append validated entries to the queue (AC1). Returns the new state; throws
 * `EnqueueError` on any rejection — the caller saves nothing when it throws.
 * Also seals any batch this call completes (created or joined, still
 * `forming`, and not held open via `more_members_expected`) to `ready` in the
 * same transaction (#535) — see `sealCompletedBatches`.
 */
export function enqueueEntries(
  state: SchedState,
  inputs: EnqueueInput[],
  now: Date = new Date()
): SchedState {
  if (inputs.length === 0) {
    throw new EnqueueError('No entries to enqueue');
  }

  const seen = new Set<number>();
  for (const input of inputs) {
    asPositiveInt(input.issue, 'issue');
    if (input.deps?.includes(input.issue)) {
      throw new EnqueueError(`Issue ${input.issue} cannot depend on itself`);
    }
    if (seen.has(input.issue)) {
      throw new EnqueueError(`Duplicate issue in enqueue input: ${input.issue}`);
    }
    // The persistence boundary: enqueue must only ever produce state that
    // validateState (and therefore the next load) accepts.
    if (input.batch !== undefined && input.batch !== null) {
      if (input.batch.length === 0) {
        throw new EnqueueError(`Issue ${input.issue}: batch must be a non-empty string`);
      }
      if (!BATCH_ID_RE.test(input.batch)) {
        throw new EnqueueError(
          `Issue ${input.issue}: batch id '${input.batch}' must match ${BATCH_ID_RE} (used to build a worktree path — no '/' or leading '.')`
        );
      }
    }
    if (input.mode !== undefined && input.mode !== 'full' && input.mode !== 'slot') {
      throw new EnqueueError(`Issue ${input.issue}: mode must be 'full' or 'slot'`);
    }
    if (
      input.tier !== undefined &&
      input.tier !== 'mechanical' &&
      input.tier !== 'mid' &&
      input.tier !== 'strong'
    ) {
      throw new EnqueueError(`Issue ${input.issue}: tier must be mechanical | mid | strong`);
    }
    if (input.priority !== undefined && !Number.isInteger(input.priority)) {
      throw new EnqueueError(`Issue ${input.issue}: priority must be an integer`);
    }
    if (input.batch_priority !== undefined && !Number.isInteger(input.batch_priority)) {
      throw new EnqueueError(`Issue ${input.issue}: batch_priority must be an integer`);
    }
    if (input.blocked_label !== undefined && input.blocked_label !== null) {
      if (typeof input.blocked_label !== 'string' || !LABEL_NAME_RE.test(input.blocked_label)) {
        throw new EnqueueError(`Issue ${input.issue}: blocked_label must be a GitHub label name`);
      }
      // A blocked slot-mode member still joins its batch's `members` list
      // (below) and batch dispatch never consults member status — so it
      // would ride the batch into work anyway, defeating the pre-screen
      // entirely (#507). Reject the combination rather than half-apply it.
      if ((input.mode ?? 'full') === 'slot') {
        throw new EnqueueError(
          `Issue ${input.issue}: carries hard-block label '${input.blocked_label}' and cannot be enqueued as a batch member — remove the label, or enqueue it with mode 'full'`
        );
      }
    }
    seen.add(input.issue);
  }

  for (const input of inputs) {
    const existing = state.entries.find((e) => e.issue === input.issue);
    if (existing && !TERMINAL_ISSUE_STATUSES.has(existing.status)) {
      throw new EnqueueError(
        `Issue ${input.issue} is already in the queue (status: ${existing.status})`
      );
    }
  }

  assertNoDependencyCycle(state, inputs);

  const timestamp = now.toISOString();
  const entries: QueueEntry[] = inputs.map((input) => {
    const mode = input.mode ?? 'full';
    const batch = input.batch ?? null;
    if (mode === 'slot' && batch === null) {
      throw new EnqueueError(`Issue ${input.issue}: slot mode requires a batch id`);
    }
    if (mode === 'full' && batch !== null) {
      throw new EnqueueError(`Issue ${input.issue}: full mode cannot carry a batch id`);
    }
    // Batch-level facts on a batch-less entry would be parsed, validated and
    // then silently dropped — the same class of quiet misconfiguration that
    // `assertBatchFactsAgree` exists to prevent one field over.
    if (
      batch === null &&
      (input.anchor !== undefined ||
        input.run_id !== undefined ||
        input.eviction_groups !== undefined ||
        input.more_members_expected !== undefined)
    ) {
      throw new EnqueueError(
        `Issue ${input.issue}: anchor/run_id/eviction_groups/more_members_expected describe a batch — they cannot be set on a full-cycle entry`
      );
    }
    // A `decision-pending` GITHUB LABEL (one of the four hard-block labels
    // this entry may carry) is deliberately mapped to `status: 'blocked'`
    // here, NOT to the `decision-pending` IssueStatus of the same name —
    // that status means a runtime hand-off mid-run; this is an enqueue-time
    // screen with its own `label:<name>` reason vocabulary, and reusing
    // `blocked` keeps all four hard-block labels on one uniform path (#507).
    return {
      issue: input.issue,
      mode,
      batch,
      deps: input.deps ? [...input.deps] : [],
      priority: input.priority ?? 0,
      tier: input.tier ?? 'mid',
      status: input.blocked_label ? 'blocked' : 'queued',
      reason: input.blocked_label ? labelBlockReason(input.blocked_label) : null,
      pr: null,
      cleanup: null,
      failure_evidence: null,
      enqueued_at: timestamp,
      updated_at: timestamp,
    };
  });

  // Create batches for unseen slot batch ids; reject joining a batch that has
  // already left `forming` (composition is frozen when the batch seals). Only
  // batches actually joined get `updated_at` bumped — a blanket rewrite would
  // churn the audit signal on every enqueue.
  const batches = state.batches.map((b) => ({ ...b }));
  // Collected alongside the loop below (not re-derived from `inputs` after
  // the fact) so the two can never drift: every batch id this call touches,
  // and which of those it was told to leave open (#535 AC1's "partial batch"
  // clause — see `sealCompletedBatches`).
  const touchedBatchIds = new Set<string>();
  const heldBatchIds = new Set<string>();
  for (const input of inputs) {
    const batchId = input.batch;
    if (batchId === null || batchId === undefined) continue;
    touchedBatchIds.add(batchId);
    if (input.more_members_expected) heldBatchIds.add(batchId);
    const existing = findBatch({ ...state, batches }, batchId);
    if (existing) {
      if (existing.status !== 'forming') {
        throw new EnqueueError(
          `Batch ${batchId} is ${existing.status} — members can only join while forming`
        );
      }
      if (input.base_branch !== undefined && input.base_branch !== existing.base_branch) {
        throw new EnqueueError(
          `Batch ${batchId} was enqueued with base '${existing.base_branch}' — refusing to silently rebase it to '${input.base_branch}'`
        );
      }
      assertBatchFactsAgree(batchId, existing, input);
      // The first member to carry a batch-level fact sets it; later members
      // must agree (assertBatchFactsAgree) or say nothing.
      existing.anchor = existing.anchor ?? input.anchor ?? null;
      existing.run_id = existing.run_id ?? input.run_id ?? null;
      if (existing.eviction_groups.length === 0 && input.eviction_groups !== undefined) {
        existing.eviction_groups = input.eviction_groups.map((g) => [...g]);
      }
      if (existing.members.includes(input.issue)) continue;
      existing.members = [...existing.members, input.issue];
      existing.updated_at = timestamp;
    } else {
      batches.push(
        createBatch(batchId, [input.issue], now, {
          base_branch: input.base_branch,
          anchor: input.anchor,
          run_id: input.run_id,
          eviction_groups: input.eviction_groups,
          priority: input.batch_priority,
        })
      );
    }
  }

  // Re-enqueueing a terminal issue (allowed above) must REPLACE its old entry,
  // not sit alongside it — validateState enforces one entry per issue on load,
  // so appending here would write a state the very next command can't read
  // back (#502). Any surviving old entry whose issue matches a fresh one is
  // guaranteed terminal: the guard above already threw for any active match.
  const survivingEntries = state.entries.filter((e) => !seen.has(e.issue));

  // A terminal member re-enqueued into a different batch (or dropped to
  // full-cycle, batch null) leaves its OLD batch's `members` still naming the
  // issue. validateState only checks entry.batch -> batch.members, never the
  // reverse, so that stray membership sails through validation — then
  // dissolveBatch/abandonBatch (which trust batch.members blindly) and
  // batchOf (which returns the first batch whose members include the issue)
  // would act on the OLD batch for an issue that has actually moved on
  // (#502). Drop the issue from any batch its fresh entry no longer points at.
  const freshBatchOf = new Map(entries.map((e) => [e.issue, e.batch]));
  for (const batch of batches) {
    const stillMembers = batch.members.filter((issue) => {
      const target = freshBatchOf.get(issue);
      return target === undefined || target === batch.id;
    });
    if (stillMembers.length !== batch.members.length) {
      batch.members = stillMembers;
      batch.eviction_groups = batch.eviction_groups
        .map((group) => group.filter((issue) => stillMembers.includes(issue)))
        .filter((group) => group.length > 1);
      batch.updated_at = timestamp;
    }
  }

  // Eviction groups must name members of their own batch: a stray issue number
  // would expand an eviction to a non-member and count against the batch size
  // in the dissolve trigger, dissolving the batch below its real threshold.
  const combined = { ...state, entries: [...survivingEntries, ...entries], batches };
  for (const batch of batches) {
    for (const group of batch.eviction_groups) {
      const strays = group.filter((issue) => !batch.members.includes(issue));
      if (strays.length > 0) {
        throw new EnqueueError(
          `Batch ${batch.id}: eviction group [${group.join(',')}] names issues that are not batch members: [${strays.join(',')}]`
        );
      }
    }
  }

  return sealCompletedBatches(combined, touchedBatchIds, heldBatchIds, now);
}

/**
 * Seal every batch this call touched (created or joined) and was not told to
 * hold open: composition is frozen the moment a batch seals (this file's own
 * long-standing promise at the top of the batch-join loop, previously
 * unenforced — #535). A caller declares a batch complete simply by NOT
 * setting `more_members_expected` on any of this call's entries for it — the
 * common case, since a manifest normally declares a batch's full membership
 * in one `enqueue` call (batch-prep composes the batch before writing it) —
 * so by the time this transaction commits, whatever such a batch received
 * here is everything it is ever getting; the `status !== 'forming'` check
 * earlier in this function already refuses a later call from adding more. A
 * batch held open (AC1's "partial batch… seals when the last declared member
 * lands") stays `forming` until a later call touches it again without the
 * hold. Sealing here, not at dispatch time, is what makes `forming` batches
 * show up under `sched status`'s Runnable units at all.
 */
function sealCompletedBatches(
  state: SchedState,
  touchedBatchIds: ReadonlySet<string>,
  heldBatchIds: ReadonlySet<string>,
  now: Date
): SchedState {
  let sealed = state;
  for (const batchId of touchedBatchIds) {
    if (heldBatchIds.has(batchId)) continue;
    const batch = findBatch(sealed, batchId);
    if (batch && batch.status === 'forming') {
      sealed = transitionBatch(sealed, batchId, 'ready', {}, now);
    }
  }
  return sealed;
}
