# @ai-dossier/sched

[![npm](https://img.shields.io/npm/v/@ai-dossier/sched.svg)](https://www.npmjs.com/package/@ai-dossier/sched)

Deterministic scheduler core for dossier batch cycles — queue, worker slots, typed state
machines, and crash-safe persistence. **Zero LLM/agent invocations**: the package makes
every mechanical orchestration decision a pure function of state; agent dispatching,
completion verification, and stall handling live in follow-up work (#464, #468).

Design: RFC-0001 *Batch Cycles* §B/C.1/D (the RFC lives on branch `docs/batch-cycles-rfc`,
not yet merged to `main`; the §D state machines are frozen verbatim into the types below).
This package is the deterministic replacement for fleet-cycle's LLM-prose supervision,
whose named failure — slots sitting idle after a subagent finished — is a scheduling bug
this state machine makes impossible to forget.

## CLI surface

Consumed through the monorepo CLI (`@ai-dossier/cli` ≥ 0.14.0):

```bash
ai-dossier sched enqueue --issues 101,105..109 --deps 100 --tier strong   # flags
ai-dossier sched enqueue --from-manifest batch-prep.json                  # batch-prep output
ai-dossier sched status            # queue, slots, batches, runnable, blocked/failed
ai-dossier sched pause             # stop NEW assignments; live units keep running
ai-dossier sched resume
ai-dossier sched abandon --issue 42 --reason "operator abort"
ai-dossier sched abandon --batch b1   # dissolve; members requeue as full-cycle
```

Every subcommand takes `--project <slug>` (default: `owner-repo` of the current directory,
falling back to the repo basename — fleet-cycle's convention) and `--json`.

## API surface

```ts
import {
  SchedStore,            // persistence: load/save/withLock per project dir
  enqueueEntries,        // validated queue appends (cycles, dupes, mode/batch rules)
  parseManifest,         // batch-prep JSON → EnqueueInput[]
  computeAssignments,    // pure: fill idle slots with runnable units, bounded by max_slots
  runnableUnits,         // pure: which units may run right now (dep-gated)
  transitionIssue, transitionBatch, transitionSlot,  // typed §D transitions
  TRANSITIONS,           // the transition tables themselves (for previews)
  buildStatusReport,     // machine-readable status incl. blocked/failed sets
  validateState,         // strict persisted-state validation
  IllegalTransitionError, EnqueueError, CorruptStateError, LockTimeoutError,
  SchedNotFoundError,
} from '@ai-dossier/sched';
```

All state functions are pure (state in, new state out — the worktree-pool pattern);
`SchedStore` is the only I/O boundary and every mutation runs under its lock.

## State layout

```
~/.dossier/sched/<project>/
├── state.json     # hot operational truth — atomic tmp+fsync+rename writes;
├── config.json    # durable intent: { "max_slots": 3 } (default 3, bounds 1–64)
└── .sched-lock/   # cross-process directory mutex (pid; stolen from dead holders)
```

- **Crash safety**: a process killed between writes leaves the previous complete state,
  never a partial file; restart resumes identically (proved by `restart.test.ts`).
- **Corrupt state is loud**: `load()` throws `CorruptStateError` naming the file —
  never a silent queue reset. `state.json` is deletable and rebuildable from GitHub,
  which remains the system of record.
- **`max_slots`** bounds live units (`assigned | running | recovering`); dependency
  edges gate readiness — an issue with an unmerged dependency, and a batch behind an
  unmerged batch, are never runnable.
- **Pause** stops new assignments only; abandon routes through the typed failure rails
  (`evicted → requeued{full}` for batch members — nothing green is discarded).

## Development

```bash
cd packages/sched
npm run build    # tsc → dist/
npm test         # vitest — state machines, persistence, crash/restart, scheduler
```

No network, no GitHub in tests — persistence tests run on temp directories.
