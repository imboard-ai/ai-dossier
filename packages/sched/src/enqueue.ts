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
import { createBatch, findBatch } from './state';
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
 * The `reason` prefix a hard-block-labelled entry carries (#507), and the one
 * place that builds it — the CLI's journal event and the entry's `reason`
 * must read identically, so both call this rather than templating the string
 * twice.
 */
export const LABEL_BLOCK_REASON_PREFIX = 'label:';

/** `reason`/journal-`reason` value for an entry blocked by GitHub label `label`. */
export function labelBlockReason(label: string): string {
  return `${LABEL_BLOCK_REASON_PREFIX}${label}`;
}

/** One unit of work as provided by flags or a manifest (defaults applied by `enqueueEntries`). */
export interface EnqueueInput {
  issue: number;
  mode?: CycleMode;
  batch?: string | null;
  deps?: number[];
  tier?: ModelTier;
  base_branch?: string;
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
  existing: { anchor: number | null; run_id: string | null; eviction_groups: number[][] },
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
    if (input.batch !== undefined && input.batch !== null && input.batch.length === 0) {
      throw new EnqueueError(`Issue ${input.issue}: batch must be a non-empty string`);
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
        input.eviction_groups !== undefined)
    ) {
      throw new EnqueueError(
        `Issue ${input.issue}: anchor/run_id/eviction_groups describe a batch — they cannot be set on a full-cycle entry`
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
  for (const input of inputs) {
    const batchId = input.batch;
    if (batchId === null || batchId === undefined) continue;
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

  return combined;
}
