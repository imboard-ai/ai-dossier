/**
 * Pure state machines for the scheduler core — RFC-0001 §D as explicit typed
 * transitions. Every function here is pure: it takes a state and returns a new
 * state (immutable spreads, like `packages/worktree-pool/src/pool-state.ts`),
 * and every edge NOT in the tables throws `IllegalTransitionError` (AC3).
 *
 * Failure edges: RFC-0001 §D.1 states "any → blocked(dep-failed) |
 * decision-pending | failed(escalation-cap)" — encoded generically for every
 * non-terminal issue status rather than repeated per row.
 */

import {
  type BatchEntry,
  type BatchStatus,
  IllegalTransitionError,
  type IssueStatus,
  LEGACY_SCHEMA_VERSIONS,
  type QueueEntry,
  SCHEMA_VERSION,
  SchedNotFoundError,
  type SchedState,
  type SlotEntry,
  type SlotStatus,
  TERMINAL_ISSUE_STATUSES,
} from './types';

// --- Transition tables ---

const ISSUE_BASE_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  queued: ['classified'],
  classified: ['dispatched', 'batched'],
  dispatched: ['shipped'],
  shipped: ['done'],
  // batched/waiting/validated also carry `evicted`: RFC-0001 §D.2 dissolving
  // requeues members at ANY batch stage, not just mid-member (F.8).
  batched: ['waiting', 'evicted'],
  waiting: ['in-work', 'evicted'],
  'in-work': ['committed', 'evicted'],
  committed: ['validated', 'evicted'],
  validated: ['shipped-in-batch', 'evicted'],
  'shipped-in-batch': ['done'],
  evicted: ['requeued'],
  requeued: ['dispatched'],
  blocked: ['queued', 'waiting', 'evicted'],
  'decision-pending': ['queued'],
  done: [],
  failed: [],
};

/** Failure edges RFC-0001 §D.1 attaches to ANY state (blocked / decision-pending / failed). */
const ISSUE_UNIVERSAL_FAILURE_EDGES: readonly IssueStatus[] = [
  'blocked',
  'decision-pending',
  'failed',
];

function allowedIssueTransitions(from: IssueStatus): IssueStatus[] {
  const base = ISSUE_BASE_TRANSITIONS[from];
  if (TERMINAL_ISSUE_STATUSES.has(from)) return base; // no failure edges out of terminal states
  return [...base, ...ISSUE_UNIVERSAL_FAILURE_EDGES];
}

const BATCH_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  forming: ['ready', 'dissolving'],
  ready: ['executing', 'dissolving'],
  // executing → executing advances the member pointer (i/N); the ⟲ in RFC-0001 §D.2.
  executing: ['executing', 'validating', 'dissolving'],
  validating: ['attributing', 'reviewing', 'dissolving'],
  attributing: ['fixing', 'evicting'],
  fixing: ['validating', 'dissolving'],
  evicting: ['validating', 'dissolving'],
  reviewing: ['shipping', 'dissolving'],
  shipping: ['awaiting-merge', 'dissolving'],
  'awaiting-merge': ['rebasing', 'merged'],
  rebasing: ['re-validating', 'dissolving'],
  're-validating': ['shipping', 'dissolving'],
  merged: ['deployed'],
  deployed: ['reported'],
  reported: ['done'],
  done: [],
  dissolving: ['dissolved'],
  dissolved: [],
};

const SLOT_BASE_TRANSITIONS: Record<SlotStatus, SlotStatus[]> = {
  idle: ['assigned'],
  // assigned → idle releases a unit that was claimed but never spawned.
  assigned: ['running', 'idle'],
  running: ['exited', 'recovering'],
  exited: ['verifying'],
  // #464: verifying → recovering is the verify-fail rail — an agent that
  // exited WITHOUT a verified completion is redispatched stronger, exactly
  // like a stall (RFC-0001 §D.3's diagram predates AC2's "an agent exiting
  // is never proof of completion"; this edge is its redispatch path).
  verifying: ['complete', 'recovering'],
  complete: ['idle'],
  recovering: ['running', 'failed'],
  failed: ['idle'],
};

/**
 * Operator-abort rail (`sched abandon`, RFC-0001 §D.3 extension): any slot
 * holding a unit that has not completed verification may be forced to
 * `failed` → `idle`. `complete` is excluded — verification passed and the
 * slot is already releasing.
 */
const SLOT_ABORTABLE_STATUSES: ReadonlySet<SlotStatus> = new Set([
  'assigned',
  'running',
  'exited',
  'verifying',
  'recovering',
]);

function allowedSlotTransitions(from: SlotStatus): SlotStatus[] {
  const base = SLOT_BASE_TRANSITIONS[from];
  if (SLOT_ABORTABLE_STATUSES.has(from)) return [...base, 'failed'];
  return base;
}

// --- Construction and validation ---

/** An empty state carries no timestamps — nothing exists yet to stamp. */
export function createEmptyState(): SchedState {
  return {
    schema_version: SCHEMA_VERSION,
    paused: false,
    entries: [],
    batches: [],
    slots: [],
    next_slot_id: 1,
  };
}

const ISSUE_STATUSES = new Set<string>(Object.keys(ISSUE_BASE_TRANSITIONS));
const BATCH_STATUSES = new Set<string>(Object.keys(BATCH_TRANSITIONS));
const SLOT_STATUSES = new Set<string>(Object.keys(SLOT_BASE_TRANSITIONS));
const CYCLE_MODES = new Set(['full', 'slot']);
const MODEL_TIERS = new Set(['mechanical', 'mid', 'strong']);

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validateQueueEntry(data: unknown, where: (n: number) => string): void {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${where(0)}: entry must be an object`);
  }
  const entry = data as Record<string, unknown>;
  if (!Number.isInteger(entry.issue) || (entry.issue as number) <= 0) {
    throw new Error(`${where(entry.issue as number)}: issue must be a positive integer`);
  }
  const label = where(entry.issue as number);
  if (!CYCLE_MODES.has(String(entry.mode))) {
    throw new Error(`${label}: mode must be 'full' or 'slot'`);
  }
  if (entry.mode === 'full' ? entry.batch !== null : typeof entry.batch !== 'string') {
    throw new Error(`${label}: batch must be a string for slot mode, null for full mode`);
  }
  if (
    !Array.isArray(entry.deps) ||
    entry.deps.some((d) => !Number.isInteger(d) || (d as number) <= 0)
  ) {
    throw new Error(`${label}: deps must be an array of positive issue numbers`);
  }
  if (!MODEL_TIERS.has(String(entry.tier))) {
    throw new Error(`${label}: tier must be mechanical | mid | strong`);
  }
  if (!ISSUE_STATUSES.has(String(entry.status))) {
    throw new Error(`${label}: unknown issue status ${String(entry.status)}`);
  }
  if (entry.reason !== null && typeof entry.reason !== 'string') {
    throw new Error(`${label}: reason must be a string or null`);
  }
  if (!isIsoDateString(entry.enqueued_at) || !isIsoDateString(entry.updated_at)) {
    throw new Error(`${label}: enqueued_at/updated_at must be ISO date strings`);
  }
}

/**
 * Strict validation of persisted state (mirrors pool-state's `validateState`):
 * wrong schema version or malformed shape throws instead of being coerced, so
 * a corrupt file is a loud failure, never a silent queue reset.
 *
 * Legacy schema versions (1.0.0, pre-#464) are accepted and migrated: slot
 * `branch`/`last_head` backfill to null and the state upgrades to the current
 * schema on the next save.
 */
export function validateState(data: unknown): SchedState {
  if (!data || typeof data !== 'object') {
    throw new Error('Scheduler state must be an object');
  }
  const obj = data as Record<string, unknown>;
  const version = String(obj.schema_version);
  if (version !== SCHEMA_VERSION && !LEGACY_SCHEMA_VERSIONS.includes(version)) {
    throw new Error(`Unsupported schema version: ${version} (expected ${SCHEMA_VERSION})`);
  }
  if (typeof obj.paused !== 'boolean') {
    throw new Error('Scheduler state must have a paused boolean');
  }
  if (!Array.isArray(obj.entries)) {
    throw new Error('Scheduler state must have an entries array');
  }
  (obj.entries as unknown[]).forEach((entry, i) => {
    validateQueueEntry(entry, (n) => `entries[${i}] (issue ${n})`);
  });

  const seenIssues = new Set<number>();
  for (const entry of obj.entries as QueueEntry[]) {
    if (seenIssues.has(entry.issue)) {
      throw new Error(`Duplicate queue entry for issue ${entry.issue}`);
    }
    seenIssues.add(entry.issue);
  }

  if (!Array.isArray(obj.batches)) {
    throw new Error('Scheduler state must have a batches array');
  }
  const seenBatches = new Set<string>();
  for (const batch of obj.batches as BatchEntry[]) {
    if (typeof batch.id !== 'string' || batch.id.length === 0) {
      throw new Error('Batch id must be a non-empty string');
    }
    if (seenBatches.has(batch.id)) {
      throw new Error(`Duplicate batch id ${batch.id}`);
    }
    seenBatches.add(batch.id);
    if (!BATCH_STATUSES.has(String(batch.status))) {
      throw new Error(`Batch ${batch.id}: unknown batch status ${String(batch.status)}`);
    }
    if (
      !Array.isArray(batch.members) ||
      batch.members.some((m) => !Number.isInteger(m) || (m as number) <= 0)
    ) {
      throw new Error(`Batch ${batch.id}: members must be positive issue numbers`);
    }
    if (typeof batch.base_branch !== 'string' || batch.base_branch.length === 0) {
      throw new Error(`Batch ${batch.id}: base_branch must be a non-empty string`);
    }
    if (!Number.isInteger(batch.executing_member) || batch.executing_member < 0) {
      throw new Error(`Batch ${batch.id}: executing_member must be a non-negative integer`);
    }
    if (!isIsoDateString(batch.created_at) || !isIsoDateString(batch.updated_at)) {
      throw new Error(`Batch ${batch.id}: created_at/updated_at must be ISO date strings`);
    }
  }
  for (const entry of obj.entries as QueueEntry[]) {
    if (entry.batch !== null && !seenBatches.has(entry.batch)) {
      throw new Error(`Issue ${entry.issue}: batch ${entry.batch} does not exist`);
    }
    if (entry.batch !== null) {
      const batch = (obj.batches as BatchEntry[]).find((b) => b.id === entry.batch);
      if (batch && !batch.members.includes(entry.issue)) {
        throw new Error(`Issue ${entry.issue}: not listed in batch ${entry.batch} members`);
      }
    }
  }

  if (!Array.isArray(obj.slots)) {
    throw new Error('Scheduler state must have a slots array');
  }
  const seenSlots = new Set<number>();
  for (const slot of obj.slots as SlotEntry[]) {
    if (!Number.isInteger(slot.id) || slot.id <= 0) {
      throw new Error('Slot id must be a positive integer');
    }
    if (seenSlots.has(slot.id)) {
      throw new Error(`Duplicate slot id ${slot.id}`);
    }
    seenSlots.add(slot.id);
    if (!SLOT_STATUSES.has(String(slot.status))) {
      throw new Error(`Slot ${slot.id}: unknown slot status ${String(slot.status)}`);
    }
    if (slot.unit !== null && typeof slot.unit !== 'string') {
      throw new Error(`Slot ${slot.id}: unit must be a string or null`);
    }
    if (slot.pid !== null && !Number.isInteger(slot.pid)) {
      throw new Error(`Slot ${slot.id}: pid must be an integer or null`);
    }
    if (slot.phase !== null && typeof slot.phase !== 'string') {
      throw new Error(`Slot ${slot.id}: phase must be a string or null`);
    }
    if (slot.last_progress_at !== null && !isIsoDateString(slot.last_progress_at)) {
      throw new Error(`Slot ${slot.id}: last_progress_at must be an ISO string or null`);
    }
    if (slot.branch !== null && slot.branch !== undefined && typeof slot.branch !== 'string') {
      throw new Error(`Slot ${slot.id}: branch must be a string or null`);
    }
    if (
      slot.last_head !== null &&
      slot.last_head !== undefined &&
      typeof slot.last_head !== 'string'
    ) {
      throw new Error(`Slot ${slot.id}: last_head must be a string or null`);
    }
    if (!Number.isInteger(slot.recoveries) || slot.recoveries < 0) {
      throw new Error(`Slot ${slot.id}: recoveries must be a non-negative integer`);
    }
    if (!isIsoDateString(slot.updated_at)) {
      throw new Error(`Slot ${slot.id}: updated_at must be an ISO date string`);
    }
    if (slot.status === 'idle' && slot.unit !== null) {
      throw new Error(`Slot ${slot.id}: idle slot must not hold a unit`);
    }
    if (slot.status !== 'idle' && slot.unit === null) {
      throw new Error(`Slot ${slot.id}: non-idle slot must hold a unit`);
    }
  }
  if (!Number.isInteger(obj.next_slot_id) || (obj.next_slot_id as number) < 1) {
    throw new Error('next_slot_id must be a positive integer');
  }

  // Migration: pre-#464 (1.0.0) slots carry no branch/last_head — backfill
  // null so the returned state always has the current shape.
  const slots = (obj.slots as SlotEntry[]).map((slot) => ({
    ...slot,
    branch: slot.branch ?? null,
    last_head: slot.last_head ?? null,
  }));

  return { ...(data as SchedState), schema_version: SCHEMA_VERSION, slots };
}

// --- Generic transition machinery ---

interface Transitionable {
  status: string;
  updated_at: string;
}

function transition<T extends Transitionable>(
  kind: 'issue' | 'batch' | 'slot',
  allowed: (from: string) => string[],
  current: T,
  to: string,
  patch: Partial<T>,
  now: Date
): T {
  const from = current.status;
  if (!allowed(from).includes(to)) {
    throw new IllegalTransitionError(kind, from, to);
  }
  return { ...current, ...patch, status: to as T['status'], updated_at: now.toISOString() };
}

// --- Issue transitions ---

export function transitionIssue(
  state: SchedState,
  issue: number,
  to: IssueStatus,
  patch: Partial<QueueEntry> = {},
  now: Date = new Date()
): SchedState {
  const idx = state.entries.findIndex((e) => e.issue === issue);
  if (idx === -1) {
    throw new SchedNotFoundError(`Queue entry not found: ${issue}`);
  }
  const entries = [...state.entries];
  entries[idx] = transition(
    'issue',
    (from) => allowedIssueTransitions(from as IssueStatus),
    entries[idx],
    to,
    patch,
    now
  );
  return { ...state, entries };
}

// --- Batch transitions ---

export function transitionBatch(
  state: SchedState,
  batchId: string,
  to: BatchStatus,
  patch: Partial<BatchEntry> = {},
  now: Date = new Date()
): SchedState {
  const idx = state.batches.findIndex((b) => b.id === batchId);
  if (idx === -1) {
    throw new SchedNotFoundError(`Batch not found: ${batchId}`);
  }
  const batches = [...state.batches];
  batches[idx] = transition(
    'batch',
    (from) => BATCH_TRANSITIONS[from as BatchStatus],
    batches[idx],
    to,
    patch,
    now
  );
  return { ...state, batches };
}

// --- Slot transitions ---

export function transitionSlot(
  state: SchedState,
  slotId: number,
  to: SlotStatus,
  patch: Partial<SlotEntry> = {},
  now: Date = new Date()
): SchedState {
  const idx = state.slots.findIndex((s) => s.id === slotId);
  if (idx === -1) {
    throw new SchedNotFoundError(`Slot not found: ${slotId}`);
  }
  const slots = [...state.slots];
  const clearing =
    to === 'idle' ? { unit: null, pid: null, phase: null, branch: null, last_head: null } : {};
  const resetting = to === 'idle' ? { recoveries: 0 } : {};
  slots[idx] = transition(
    'slot',
    (from) => allowedSlotTransitions(from as SlotStatus),
    slots[idx],
    to,
    { ...clearing, ...resetting, ...patch },
    now
  );
  return { ...state, slots };
}

// --- Lookups ---

export function findEntry(state: SchedState, issue: number): QueueEntry | undefined {
  return state.entries.find((e) => e.issue === issue);
}

export function findBatch(state: SchedState, batchId: string): BatchEntry | undefined {
  return state.batches.find((b) => b.id === batchId);
}

/**
 * All transition tables, exposed as public API — future consumers (#464's
 * dispatcher, status previews) render next-state choices from here instead of
 * re-deriving the RFC tables.
 */
export const TRANSITIONS = {
  issue: (from: IssueStatus) => allowedIssueTransitions(from),
  batch: (from: BatchStatus) => BATCH_TRANSITIONS[from],
  slot: (from: SlotStatus) => allowedSlotTransitions(from),
};
