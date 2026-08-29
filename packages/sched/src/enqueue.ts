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
      enqueued_at: timestamp,
      updated_at: timestamp,
    };
  });

  // Create batches for unseen slot batch ids; reject joining a batch that has
  // already left `forming` (composition is frozen when the batch seals).
  const batches = state.batches.map((b) => ({ ...b, updated_at: timestamp }));
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
        created_at: timestamp,
        updated_at: timestamp,
      });
    }
  }

  return { ...state, entries: [...state.entries, ...entries], batches };
}
