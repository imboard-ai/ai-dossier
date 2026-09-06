# Batch Cycles — programme checkpoint

**State: HALTED.** Both scheduler projects are `PAUSED` and the tick cron is uninstalled.
Nothing is running; nothing will start on its own.

| | |
|---|---|
| Programme | [RFC-0001 Batch Cycles](../../rfcs/0001-batch-cycles.md), epic [#474](https://github.com/imboard-ai/ai-dossier/issues/474) |
| Halted at | 2026-09-03 10:42Z — owner out of subscription tokens; the work is not urgent |
| Hand-off issue | [#598](https://github.com/imboard-ai/ai-dossier/issues/598) (this document is its durable form) |
| Facts below verified | 2026-09-06, against `ai-dossier sched status`, `gh`, `git log`, `ps`, `crontab -l`, `~/.dossier/reset-fleet/` |
| Host | hcc2 |

This is the document to read first when picking the programme back up. It exists because the
checkpoint previously lived only in a GitHub issue body, where nothing in this repo reads it —
every other artefact of this programme is a document here (see [`README.md`](./README.md)).

> **Every claim in this file is date-stamped and names the command that re-derives it.** A
> checkpoint that rots silently is worse than no checkpoint. Before acting on anything below,
> re-run the command in the "Verify" column; the programme moved four times in the three days
> between the halt and this document being written.

## 1. Motivation — why Batch Cycles exists

Autonomous issue execution ran as **fleet-cycle → full-cycle-issue**: one LLM supervisor
babysitting N serial full-cycle runs, each doing gate → setup → plan → implement → review → ship
→ report in its own worktree, with its own environment warm-up, test suite, CI wait and PR.
Measured cost was **≈$16 and ~86 min per issue**, with known slot-idle failures in the LLM
supervisor itself.

Two owner briefs asked for something cheaper and more durable:

- **Batch Cycles** — a *deterministic* scheduler (no LLM supervision) that classifies issues
  `full` vs `slot`, groups small `slot` issues into batches sharing one worktree, branch, test
  suite and PR, and falls back to full-cycle on any doubt.
- **Progressive determinism** — repo-owned capability manifests (`.dossier/automation`) so
  mechanical steps (tests, warm-up, ship) run as scripts with a four-way outcome
  (`ok` / `task-failed` / `automation-broken` / `capability-unavailable`) instead of tokens.

Target: roughly halve per-issue cost and wall-clock for the small-issue tail **without lowering
the trust anchor** — per-issue blind conformance review is never batched.

## 2. What landed

All merged and published to npm.

**Scheduler** (`packages/sched`, `ai-dossier sched …`) — deterministic queue, slots, tiers→models,
phase-aware stall ladder, PR watch, tails, fencing on redispatch (#504), label pre-screen (#507),
batch units with seal / anchor / eviction / dissolve, `abandon`, `stats`. Parity against
fleet-cycle: **Conditional GO** ([`sched-parity.md`](./sched-parity.md), occupancy 99–100%). It
runs unattended on hcc2 from a 2-minute cron tick (`~/.dossier/reset-fleet/tick.sh`) reporting to
Telegram, self-upgrading the CLI and its nested sched package from npm.

**Dossiers** — `issue-cycle-classifier`, `batch-issues-preparation`, `slot-cycle` published;
`issue-workflows-guide` 1.5.x; deterministic classify pre-screen (#538). Capability layer:
`ai-dossier cap list|run`, with the imboard manifest seeded (imboard-monorepo#3958 — `test.focused`,
`test.full`, `worktree.prepare`, `worktree.cleanup`).

**Telemetry and reports** — token telemetry via agent `modelUsage` (#524), `runstate stats`
per-model buckets (#546), model×class axis plus escalation/conformance guardrail metrics (#587),
a weekly model scorecard cron (#566/#577), and the model-agnostic retrospective (glm 86% vs
sonnet 86% delivery, n=14/21 — [`model-agnostic-fleet.md`](./model-agnostic-fleet.md)).

**Operator documentation** — [`docs/how-to/autonomous-pipeline.md`](../how-to/autonomous-pipeline.md)
(the runbook) and [`docs/agent-traps.md`](../agent-traps.md) (the grep-first trap index that
`AGENTS.md` makes mandatory reading before planning).

## 3. Pilot history

Full execution records: [`batch-pilot.md`](./batch-pilot.md) and
[`batch-pilot-2-execution.md`](./batch-pilot-2-execution.md) Parts I–IV.

| Attempt | Outcome | Defects it isolated |
|---|---|---|
| 1 (#473) | NO-GO — the engine never dispatched a batch unit at all | #523, #525 |
| 2 run 1 | 0 batches — seal/anchor bugs; backlog yield was 3 slot issues | #535, #536, #537, #538 |
| 2 run 2 | 3 batches executed, all dissolved. **First controlled economy signal: batch member work $2.56 vs $5.06 (−49%), 34 vs 86 min for the same 3 issues** — a ceiling, since the batch tail never ran | #561 (env-cold), #562 (suite runner), #563 (dissolve fraction), #564 (stats), #565 (priority) |
| 3 (#526) | 1 batch; both evictions were infrastructure, not code | #579 (`plan validate` exit-128 misread), imboard-monorepo#3982 + #583 (`test.focused`), #575/#582/#586 (re-enqueue rails), #591 (`--disallowedTools Monitor`) |
| 4 (#590) | Full backlog sweep 111 → 68 → 33 classified → **7 slot (6.3%)**; 3 concurrent batches in warm worktrees, all dissolved | The single blocking defect (below), plus #594, #595, #596 |

**Attempt 4's real outcome, reconciled 2026-09-06.** The supervisor pre-registered that only
imboard-monorepo#3985 was truly implementable; the other six carried readiness blockers that
classification §E.2 has no rule for. The readiness prediction held (#47 misclassified, #1512
unrefinable plan, #3393 spec-not-met). But **one of the seven did ship**: imboard-monorepo#3416
landed via PR imboard-monorepo#4001 on the full-cycle fallback after its batch dissolved, and
imboard-monorepo#3985 landed via PR imboard-monorepo#3999 (merged 2026-09-03T07:19:58Z) even
though its sched unit failed `unverified-exit-at-strongest-tier`. **Zero batch PRs have merged.
The fallback, not the batch, is what delivered.**

## 4. Open findings

Priority order, each with its status as of 2026-09-06.

### 4.1 Why `test.focused` evicted every batch member — **RESOLVED**

*Was #598's open question 1 and its stated gate on attempt 5.*

`scripts/cap-test-focused.sh` pipes through `tee /dev/stderr`. Under `sched` dispatch, stderr is a
redirected log file, not a device `tee` can reopen, so `tee` fails; with `set -uo pipefail` that
(a) fabricates a non-zero exit from a `pnpm` run that exited **0**, and (b) leaves the capture
buffer empty, so the `No projects matched the filters` guard added by imboard-monorepo#3982 never
matches and its name-filter retry never runs. Three members in three different batches produced
**byte-identical 765-byte gate logs** — the gate was a constant function, evicting every member
regardless of its diff (5 members for 5, attempts 2–4).

Recorded in [`docs/agent-traps.md`](../agent-traps.md) (`tee: /dev/stderr` row) and
[`batch-pilot-2-execution.md`](./batch-pilot-2-execution.md), landed in `81b14fb` (#597).
Fixes were split in two. **imboard-monorepo#3996** (the script half) is **CLOSED** — the
`tee`/`pipefail` construct is gone. **#594** (the sched half: the gate must read `task-failed` with
an empty result body as *capability broken*, taking #585's block-the-batch path rather than
evicting) is **still OPEN**. Until #594 lands, any capability that reports a definite failure it
did not earn still evicts the member, so the class of defect survives its first instance.

*Verify:* `gh issue view 594 --json state` · `gh issue view 3996 --repo imboard-ai/imboard-monorepo --json state`

### 4.2 Readiness floor for classification (RFC §E.2) — **OPEN, unstarted**

The classifier finds "small", not "ready". Six of attempt 4's seven `slot` issues carried a
readiness blocker — an open product decision, a gated dependency, an absent deliverable file —
that no classification rule looks for. Deterministic rules are wanted (body mentions a product
decision · depends on an open issue · the named deliverable file does not exist) so that `slot`
requires readiness, not just size. Expected to raise true slot yield above the observed 1/7.

This is a feature with its own design and tests, not a documentation change.

### 4.3 Attempt 5 — **NOT FILED** (deliberate)

Cohort: the attempt-4 survivors, after 4.1 and 4.2 land. Success condition: **≥1 batch PR merged**
— the one thing four attempts have never produced. Then arm #529 by hand and enqueue #592.

File it as a **fresh issue**. Never re-enqueue a completed ops issue: #575/#582/#586 fixed the
re-enqueue rails, but a trail carrying three completed runs still misleads a fresh agent into
resuming at `report`. Do not re-enqueue #526, #528 or #590.

### 4.4 #529 — 7-day regression report — **UNARMED, by design**

Armed **manually** after the first batch PR merges; the tick's close-triggered arming step is
superseded and must not be relied on (see the runbook). No batch PR has merged, so it stays
unarmed. Command: `ai-dossier sched enqueue --project imboard-ai-ai-dossier --issues 529 --tier strong`.

### 4.5 #592 — live two-arm model validation — **GATED** (owner spend decision)

claude vs open-weights, ~$600 ceiling, gated on the first clean batch. Owner decision 2026-09-02:
option 3.

### 4.6 Ship guard for `Closes #N` — **OPEN**

Two PRs (imboard-monorepo#3958 and #3982) merged without the trailer, leaving their sched units
parked for 8 h each. Wanted: a check in `ship-issue` or the auto-merge watcher.

### 4.7 Pager threshold — **OPEN**

The scheduled-controls sweep paged on a single blind (exit-2) CI Health run on 2026-09-02, which
self-resolved. Consider ignoring exit-2 unless repeated.

### 4.8 Eviction double-count — **OPEN (#595), reproducible right now**

`sched` can evict the same member twice and the dissolve decision counts eviction *events*, not
distinct members. Live on this host: `b-20260903-01` records `#826` twice, so `evictions=3` over
**two** distinct members against `threshold=2` — a batch that was *at* the threshold died as
though it were past it.

*Verify:* `ai-dossier sched status --project imboard-ai-imboard-monorepo` — read the `evictions`
column of the Batches table, not the `batch-dissolved` event (whose `requeued=` list is already
de-duplicated, which is why the bug is invisible where you would naturally look).

### 4.9 Host hygiene — **OPEN**

One broken pool entry and a leftover worktree from imboard-monorepo#3958's failed return, plus the
three dissolved batch worktrees `b-20260903-0[1-3]`. Note that
`@ai-dossier/worktree-pool`'s `gc` / `refresh` must **never** be run by an agent (ai-dossier#438).

### 4.10 Cross-project dependencies — **OPEN (by design, for now)**

sched dependencies are per project. An ai-dossier issue that depends on an imboard-monorepo PR
(e.g. #590 on imboard-monorepo#3982) has to be sequenced by hand at enqueue time.

### 4.11 Near-miss backlog

Each blocked on a one-line owner decision: imboard-monorepo#340, #2711, #1021, #1022, #2567, and
ai-dossier#18. **imboard-monorepo#3416 has since shipped** (PR imboard-monorepo#4001) and is no
longer on this list.

## 5. Halt state on hcc2

Verified 2026-09-06. What #598 recorded at the halt is marked where it has moved since.

| Fact | State | Verify |
|---|---|---|
| `imboard-ai-ai-dossier` | `PAUSED`, 0/3 slots live | `ai-dossier sched status --project imboard-ai-ai-dossier` |
| `imboard-ai-imboard-monorepo` | `PAUSED`, **2/3 slots still marked live — both stale** (see below) | `ai-dossier sched status --project imboard-ai-imboard-monorepo` |
| Tick cron | Removed. The line is saved verbatim at `~/.dossier/reset-fleet/tick.cron.saved` | `crontab -l` — only the weekly scorecard job should remain |
| Weekly model scorecard cron | Still installed and firing (Mondays 05:00) | `crontab -l` |
| Tracked-issue list | `~/.dossier/reset-fleet/issues.txt` (31 entries) | `wc -l ~/.dossier/reset-fleet/issues.txt` |
| Telegram | `@ImboardBot` → owner DM; token in `~/.dossier/reset-fleet/telegram.env` | `ls ~/.dossier/reset-fleet/telegram.env` |
| Model routing | mechanical=haiku, mid=sonnet, strong=opus on both projects | `~/.dossier/sched/<project>/config.json` |
| Dispatch command | ends with `--disallowedTools Monitor` (#591) | same file |
| ai-dossier `phase_stall_timeout_ms.implement` | 4 h — supervisor issues sit idle while polling | same file |

### The stale slots — read this before `sched resume`

`imboard-ai-imboard-monorepo` shows slots 2 and 3 `running`, on `issue:3393` (pid 3675888) and
`issue:340` (pid 3442401), phase `implement`, `last-progress 3d ago`. #598 recorded these as "two
full-cycle fallbacks left running to finish on their own."

**They finished. Both processes are dead and both issues are CLOSED.** The scheduler has not
noticed because it is paused and the tick cron is gone, so no reconcile pass has run since the
halt. An operator who follows the resume recipe verbatim resumes into a project that appears to
have only one free slot.

*Verify:* `ps -p 3675888 -o pid=` and `ps -p 3442401 -o pid=` print nothing;
`gh issue view 340 --repo imboard-ai/imboard-monorepo --json state` → `CLOSED` (same for #3393).

The reconcile pass in `sched start --once` re-detects running slots by pid (with a hybrid
pid-identity check, so a reused pid post-reboot is never mistaken for the old agent) and should
free both. Confirm it did before enqueueing anything — see step 4 of the recipe.

### Failed units carried into the halt

`imboard-ai-imboard-monorepo`: #3631, #826, #1512, #3985 — all
`unverified-exit-at-strongest-tier`. `imboard-ai-ai-dossier`: #528, same reason. Note that #3985's
PR merged anyway; a failed unit does not imply unshipped work, which is exactly why the engine
verifies against `runstate` and GitHub rather than against agent exit. See #596 — the
`--disallowedTools Monitor` mitigation narrowed this failure mode but did not close it, and the
surviving correlation is unit **duration**, not the tool.

## 6. Resume recipe

Run on hcc2, from inside the target repo (`--project` selects the state directory; it does not
change repo context).

```bash
# 1. Un-pause both projects
ai-dossier sched resume --project imboard-ai-ai-dossier
ai-dossier sched resume --project imboard-ai-imboard-monorepo

# 2. Reconcile ONCE by hand, before restoring the cron — this is what clears the stale slots
ai-dossier sched start --once --project imboard-ai-imboard-monorepo

# 3. Confirm the reconcile freed slots 2 and 3 and that nothing else is live
ai-dossier sched status --project imboard-ai-imboard-monorepo
ai-dossier sched status --project imboard-ai-ai-dossier

# 4. Only then restore the tick cron
(crontab -l 2>/dev/null; cat ~/.dossier/reset-fleet/tick.cron.saved) | crontab -
crontab -l    # verify BOTH the tick line and the weekly scorecard line are present
```

Step 4's `crontab -l 2>/dev/null` guard is not optional: under `set -e`, `crontab -l` on a host
with no crontab exits non-zero and the pipeline installs an *empty* crontab, silently dropping
every existing job. That is a real outage this programme has already paid for once — see the
`no crontab for` row in [`docs/agent-traps.md`](../agent-traps.md).

Then, in order:

1. Land **#594** (4.1's remaining half — imboard-monorepo#3996 is already in). Re-run one batch
   before trusting the gate: the script fix removes the constant-function behaviour on imboard, but
   nothing yet stops the *next* broken capability from evicting members the same way.
2. Land **4.2**'s readiness floor, or accept a ~1/7 true-slot yield.
3. File **attempt 5** as a fresh issue (4.3) and enqueue it at `strong`.
4. On the first merged batch PR: arm #529 (4.4), then #592 (4.5).

Do **not** re-enqueue #526, #528 or #590.

## 7. Traps

Everything this programme has learned the hard way is in
[`docs/agent-traps.md`](../agent-traps.md), which is the grep-first index `AGENTS.md` requires
every planning run to read. The ops traps from the halt week are the `no crontab for`,
`os.replace` / exec bit, `sched abandon`, `pkill -f` over ssh, `no visible process`, and
`sched done row + OPEN issue` rows. Append there, not here.
