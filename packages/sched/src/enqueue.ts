/**
 * Enqueue: accept queue entries from CLI flags or a batch-prep manifest
 * (RFC-0001 §C.1 — "queue entries (issue → mode, batch membership, deps, tier)
 * written by batch-prep"). Pure validation + state mutation: rejects duplicate
 * active issues, mode/batch mismatches, self-dependencies, and dependency
 * cycles at enqueue time rather than at assignment time.
 */

import { findBatch } from './state';
import type { CycleMode, ModelTier, QueueEntry, SchedState } from './types';
import { TERMINAL_ISSUE_STATUSES } from './types';

export class EnqueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnqueueError';
  }
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
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries)
      ? ((raw as { entries: unknown[] }).entries as unknown[])
      : null;
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
      if (typeof obj.base_branch !== 'string' || obj.base_branch.length === 0) {
        throw new EnqueueError(`Manifest entry [${i}]: base_branch must be a non-empty string`);
      }
      input.base_branch = obj.base_branch;
    }
    if (obj.anchor !== undefined) {
      input.anchor = asPositiveInt(obj.anchor, `Manifest entry [${i}]: anchor`);
    }
    if (obj.run_id !== undefined) {
      if (typeof obj.run_id !== 'string' || obj.run_id.length === 0) {
        throw new EnqueueError(`Manifest entry [${i}]: run_id must be a non-empty string`);
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
  for (const entry of state.entries) {
    edges.set(entry.issue, [...entry.deps]);
  }
  for (const input of inputs) {
    const existing = edges.get(input.issue) ?? [];
    edges.set(input.issue, [...existing, ...(input.deps ?? [])]);
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
    return {
      issue: input.issue,
      mode,
      batch,
      deps: input.deps ? [...input.deps] : [],
      tier: input.tier ?? 'mid',
      status: 'queued',
      reason: null,
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
      batches.push({
        id: batchId,
        status: 'forming',
        members: [input.issue],
        base_branch: input.base_branch ?? 'main',
        executing_member: 0,
        anchor: input.anchor ?? null,
        branch: null,
        run_id: input.run_id ?? null,
        eviction_groups: input.eviction_groups?.map((g) => [...g]) ?? [],
        evictions: [],
        fix_attempts: [],
        rebase_attempts: 0,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }
  }

  return { ...state, entries: [...state.entries, ...entries], batches };
}
