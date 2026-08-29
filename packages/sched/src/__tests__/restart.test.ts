import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  abandonIssue,
  computeAssignments,
  createEmptyState,
  enqueueEntries,
  type SchedState,
  SchedStore,
  setPaused,
  transitionBatch,
  transitionIssue,
  transitionSlot,
} from '../index';

/**
 * AC6 — Restart test: kill mid-state, restart, state machine resumes
 * identically from state.json.
 *
 * Two runs perform the same operation script:
 *  - CONTINUOUS: one in-memory state, saved once at the end.
 *  - RESTARTING: after every step the process "dies" — a brand-new SchedStore
 *    (and thus a fresh load from disk) carries the state forward.
 * The runs must converge on identical states.
 */

const T0 = new Date('2026-08-29T12:00:00Z');
const T1 = new Date('2026-08-29T12:05:00Z');
const T2 = new Date('2026-08-29T12:10:00Z');
const T3 = new Date('2026-08-29T12:15:00Z');
const T4 = new Date('2026-08-29T12:20:00Z');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-restart-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Step {
  name: string;
  run: (state: SchedState) => SchedState;
}

/** The operation script: enqueue → assign → run → verify → free, twice, plus a batch. */
function steps(): Step[] {
  return [
    {
      name: 'enqueue',
      run: (s) =>
        enqueueEntries(
          s,
          [
            { issue: 101, mode: 'full' },
            { issue: 102, mode: 'full', deps: [101] },
            { issue: 201, mode: 'slot', batch: 'b1' },
            { issue: 202, mode: 'slot', batch: 'b1', deps: [201] },
          ],
          T0
        ),
    },
    { name: 'assign', run: (s) => computeAssignments(s, { max_slots: 2 }, T1).state },
    {
      name: 'slot-1 lifecycle',
      run: (s) => {
        let x = transitionSlot(s, 1, 'running', { pid: 111, phase: 'implement' }, T1);
        x = transitionSlot(x, 1, 'exited', {}, T2);
        x = transitionSlot(x, 1, 'verifying', {}, T2);
        return transitionSlot(x, 1, 'complete', {}, T2);
      },
    },
    { name: 'issue-101 progress', run: (s) => transitionIssue(s, 101, 'classified', {}, T2) },
    { name: 'pause + resume', run: (s) => setPaused(setPaused(s, true), false) },
    {
      name: 'kill mid-write: stale tmp + state.json at last commit',
      run: (s) => {
        fs.writeFileSync(`${new SchedStore(dir).statePath}.tmp`, '{"partial":');
        return s;
      },
    },
    { name: 'free slot 1', run: (s) => transitionSlot(s, 1, 'idle', {}, T3) },
    { name: 'batch seals', run: (s) => transitionBatch(s, 'b1', 'ready', {}, T3) },
    { name: 'reassign', run: (s) => computeAssignments(s, { max_slots: 2 }, T3).state },
    { name: 'abandon 102', run: (s) => abandonIssue(s, 102, 'restart-test', T4).state },
    {
      name: '101 ships',
      run: (s) => {
        const x = transitionIssue(s, 101, 'dispatched', {}, T4);
        return transitionIssue(x, 101, 'shipped', {}, T4);
      },
    },
  ];
}

describe('restart resumption (AC6)', () => {
  it('a restarting process reaches the identical state as a continuous one', () => {
    // CONTINUOUS — never reloads from disk
    let continuous = createEmptyState(T0);
    for (const step of steps()) {
      continuous = step.run(continuous);
    }

    // RESTARTING — a fresh store (simulating a new process) after every step
    const bootStore = new SchedStore(dir);
    bootStore.save(createEmptyState(T0));
    for (const step of steps()) {
      const processA = new SchedStore(dir); // "old process" reads current truth
      const current = processA.load();
      const next = step.run(current);
      const processB = new SchedStore(dir); // "new process" persists and takes over
      processB.save(next);
    }

    const afterRestart = new SchedStore(dir).load();
    expect(afterRestart).toEqual(continuous);

    // and the semantics resume identically: the next assignment decision matches
    const r1 = computeAssignments(continuous, { max_slots: 2 }, T4);
    const r2 = computeAssignments(afterRestart, { max_slots: 2 }, T4);
    expect(r2.assignments).toEqual(r1.assignments);
    expect(r2.state).toEqual(r1.state);
    // state.json is present, valid, and reloadable — no crash residue
    expect(fs.existsSync(bootStore.statePath)).toBe(true);
    expect(() => new SchedStore(dir).load()).not.toThrow();
  });

  it('every intermediate state on disk is valid and reloadable', () => {
    const store = new SchedStore(dir);
    let state = createEmptyState(T0);
    store.save(state);
    for (const step of steps()) {
      state = step.run(store.load());
      store.save(state);
      // a restart right here loads this exact state
      expect(new SchedStore(dir).load()).toEqual(state);
    }
  });
});
