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
   * Anchor issue number — recorded on the batch when this input CREATES it
   * (#472; batch milestones post there). Conflict with an existing batch's
   * anchor is an EnqueueError, like base_branch.
   */
  anchor?: number;
  /**
   * Batch runstate run id — recorded on the batch when this input CREATES it
   * (#472; recovery milestones post with it).
   */
  run_id?: string;
  /**
   * Eviction groups for the batch (RFC-0001 §E.4) — recorded when this input
   * CREATES the batch. Members whose predicted paths overlap revert together.
   */
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
    if (obj.anchor !== undefined && obj.anchor !== null) {
      input.anchor = asPositiveInt(obj.anchor, `Manifest entry [${i}]: anchor`);
    }
    if (obj.run_id !== undefined && obj.run_id !== null) {
      if (typeof obj.run_id !== 'string' || obj.run_id.length === 0) {
        throw new EnqueueError(`Manifest entry [${i}]: run_id must be a non-empty string`);
      }
      input.run_id = obj.run_id;
    }
    if (obj.eviction_groups !== undefined) {
      if (
        !Array.isArray(obj.eviction_groups) ||
        obj.eviction_groups.some(
          (g: unknown) =>
            !Array.isArray(g) ||
            (g as unknown[]).length === 0 ||
            (g as unknown[]).some((m) => !Number.isInteger(m) || (m as number) <= 0)
        )
      ) {
        throw new EnqueueError(
          `Manifest entry [${i}]: eviction_groups must be an array of non-empty member-number arrays`
        );
      }
      input.eviction_groups = obj.eviction_groups as number[][];
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
    if (input.anchor !== undefined) {
      asPositiveInt(input.anchor, `Issue ${input.issue}: anchor`);
    }
    if (
      input.run_id !== undefined &&
      (typeof input.run_id !== 'string' || input.run_id.length === 0)
    ) {
      throw new EnqueueError(`Issue ${input.issue}: run_id must be a non-empty string`);
    }
    if (
      input.eviction_groups !== undefined &&
      (!Array.isArray(input.eviction_groups) ||
        input.eviction_groups.some(
          (g) =>
            !Array.isArray(g) || g.length === 0 || g.some((m) => !Number.isInteger(m) || m <= 0)
        ))
    ) {
      throw new EnqueueError(
        `Issue ${input.issue}: eviction_groups must be an array of non-empty member-number arrays`
      );
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
      // #472: batch-creation metadata is join-consistent or rejected — an
      // anchor that changes mid-formation would post milestones to two issues.
      // Null fields fill from the joining input (metadata supplied late).
      if (
        input.anchor !== undefined &&
        existing.anchor !== null &&
        input.anchor !== existing.anchor
      ) {
        throw new EnqueueError(
          `Batch ${batchId} was enqueued with anchor #${existing.anchor} — refusing to change it to #${input.anchor}`
        );
      }
      if (
        input.run_id !== undefined &&
        existing.run_id !== null &&
        input.run_id !== existing.run_id
      ) {
        throw new EnqueueError(
          `Batch ${batchId} was enqueued with run_id '${existing.run_id}' — refusing to change it to '${input.run_id}'`
        );
      }
      if (input.anchor !== undefined && existing.anchor === null) {
        existing.anchor = input.anchor;
      }
      if (input.run_id !== undefined && existing.run_id === null) {
        existing.run_id = input.run_id;
      }
      if (
        input.eviction_groups !== undefined &&
        existing.eviction_groups.length > 0 &&
        !groupsEqual(input.eviction_groups, existing.eviction_groups)
      ) {
        throw new EnqueueError(`Batch ${batchId} was enqueued with different eviction_groups`);
      }
      if (input.eviction_groups !== undefined && existing.eviction_groups.length === 0) {
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
        eviction_groups: input.eviction_groups ? input.eviction_groups.map((g) => [...g]) : [],
        evictions: [],
        fix_attempts: [],
        rebase_attempts: 0,
        created_at: timestamp,
        updated_at: timestamp,
      });
    }
  }

  // Boundary invariant: eviction groups may reference members joining in the
  // same call (batch-prep sends the whole batch at once), but by the end of
  // the call every group member must be a batch member — otherwise the
  // produced state would fail validateState on load.
  for (const batch of batches) {
    for (const group of batch.eviction_groups) {
      for (const member of group) {
        if (!batch.members.includes(member)) {
          throw new EnqueueError(
            `Batch ${batch.id}: eviction group member ${member} is not a batch member`
          );
        }
      }
    }
  }

  return { ...state, entries: [...state.entries, ...entries], batches };
}

function groupsEqual(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  return a.every((g, i) => g.length === b[i].length && g.every((m, j) => m === b[i][j]));
}
