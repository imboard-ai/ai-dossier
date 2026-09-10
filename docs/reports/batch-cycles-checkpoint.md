# Batch Cycles — programme checkpoint

**State: HALTED.** Both scheduler projects are `PAUSED` and the tick cron is uninstalled.
Nothing is running; nothing will start on its own.

| | |
|---|---|
| Programme | [RFC-0001 Batch Cycles](../../rfcs/0001-batch-cycles.md), epic [#474](https://github.com/imboard-ai/ai-dossier/issues/474) |
| Halted at | 2026-09-03 10:42Z — owner out of subscription tokens; the work is not urgent (*Verify:* `ls -l ~/.dossier/reset-fleet/engine-*.log` — both stamped 10:42. `tick.log` is **not** the witness: it stops at 2026-09-02 20:00 for an unrelated reason, the exec-bit incident below) |
| Hand-off issue | [#598](https://github.com/imboard-ai/ai-dossier/issues/598) (this document is its durable form) |
| Facts below verified | 2026-09-06, against `ai-dossier sched status`, `gh`, `git log`, `ps`, `crontab -l`, `~/.dossier/reset-fleet/` |
| Host | hcc2 |

This is the document to read first when picking the programme back up. It exists because the
checkpoint previously lived only in a GitHub issue body, where nothing in this repo reads it —
every other artefact of this programme is a document here (see [`README.md`](./README.md)).

> **Claims here are dated, and every claim carrying a *Verify:* line names the command that
> re-derives it.** The rest are dated judgements, not facts to act on blind. This matters: the
> programme moved four times in the three days between the halt and this document being written,
> and a checkpoint that rots silently is worse than no checkpoint.

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
(the runbook, and the home of the executable restart procedure) and
[`docs/agent-traps.md`](../agent-traps.md) (the grep-first trap index that `AGENTS.md` makes
mandatory reading before planning).

## 3. Pilot history

Full execution records: [`batch-pilot.md`](./batch-pilot.md) and
[`batch-pilot-2-execution.md`](./batch-pilot-2-execution.md) Parts I–IV.

| Attempt | Outcome | Defects it isolated |
|---|---|---|
| 1 (#473) | NO-GO — the engine never dispatched a batch unit at all | #523, #525 |
| 2 run 1 | 0 batches — seal/anchor bugs; backlog yield was 3 slot issues | #535, #536, #537, #538 |
| 2 run 2 | 3 batches executed, all dissolved. **First controlled economy signal: batch member work $2.56 vs $5.06 (−49%) — a mean over n=2 issues with both arms measured — and 34 vs 86 min across the 3 members.** A ceiling either way, since the batch tail never ran | #561 (env-cold), #562 (suite runner), #563 (dissolve fraction), #564 (stats), #565 (priority) |
| 3 (#526) | 1 batch; both evictions were infrastructure, not code | #579 (`plan validate` exit-128 misread), imboard-monorepo#3982 + #583 (`test.focused`), #575/#582/#586 (re-enqueue rails), #591 (`--disallowedTools Monitor`) |
| 4 (#590) | Full backlog sweep 111 → 68 → 33 classified → **7 slot (6.3%)**; 3 concurrent batches in warm worktrees, all dissolved | The single blocking defect (§4.1), plus #594, #595, #596 |

**Attempt 4's real outcome, reconciled 2026-09-06 — the fallback delivered, the batches did not.**
The supervisor pre-registered that only imboard-monorepo#3985 was truly implementable; the other
six carried readiness blockers that classification §E.2 has no rule for. That prediction held for
imboard-monorepo#47 (misclassified — a marketing issue) and imboard-monorepo#1512 (unrefinable
plan), but **not** for imboard-monorepo#3393, which was evicted `spec-not-met` and then shipped
the same day.

Every batch dissolved, and **zero batch PRs have ever merged**. But the full-cycle fallback that
picked up the dissolved members shipped **four of the seven** within hours:

| Issue | PR | Merged |
|---|---|---|
| imboard-monorepo#3985 | imboard-monorepo#3999 | 2026-09-03T07:19:58Z |
| imboard-monorepo#3416 | imboard-monorepo#4001 | 2026-09-03T10:20:41Z |
| imboard-monorepo#340 | imboard-monorepo#4003 | 2026-09-03T11:43:47Z |
| imboard-monorepo#3393 | imboard-monorepo#4004 | 2026-09-03T13:08:59Z |

imboard-monorepo#47 also closed (`COMPLETED`, 06:02:26Z) without a PR. Only
imboard-monorepo#826 and #1512 are still open.

*Verify:* `gh pr view <n> --repo imboard-ai/imboard-monorepo --json state,mergedAt` ·
`gh issue view <n> --repo imboard-ai/imboard-monorepo --json state,stateReason`

This is the single most important correction to the attempt-4 record, because §4.2's argument
rests on it: the cohort was **not** mostly unimplementable. Five of seven reached a terminal
state within a day. What failed was the batch path, not the issue selection.

## 4. Open findings

Priority order, each with its status as of 2026-09-06.

### 4.1 Why `test.focused` evicted every batch member — **RESOLVED**

*Was #598's open question 1 and its stated gate on attempt 5.*

`scripts/cap-test-focused.sh` pipes through `tee /dev/stderr`. The gate runs that script through
`ai-dossier cap run`, which captures the child's output with `spawnSync` (`cli/src/capability.ts`)
— and Node/libuv implements a captured stdio stream as a **socketpair**, not a pipe or a file. So
`/dev/stderr` (i.e. `/proc/self/fd/2`) points at a socket, and reopening a socket that way returns
`ENXIO` — `tee: /dev/stderr: No such device or address`. Under `set -uo pipefail` that (a)
fabricates a non-zero exit from a `pnpm` run that exited **0**, and (b) leaves the capture buffer
empty, so the `No projects matched the filters` guard added by imboard-monorepo#3982 never matches
and its name-filter retry never runs. Three members in three different batches produced 765-byte
gate logs differing only in the batch id inside one path — the gate was a constant function,
evicting every member regardless of its diff (5 members for 5, attempts 2–4).

**Reproducing it needs a socket, not a file.** `cmd 2>somefile` passes; so does a plain pipe. Only
a captured (socketpair) stderr fails:

```bash
# fails — this is what `cap run` does
node -e 'require("child_process").spawnSync("bash",["-c","echo hi | tee /dev/stderr"],{encoding:"utf8"})'
# passes — do NOT use this to check whether the trap applies
bash -c 'echo hi | tee /dev/stderr' 2>/tmp/x
```

Recorded in [`docs/agent-traps.md`](../agent-traps.md) (`tee: /dev/stderr` row) and
[`batch-pilot-2-execution.md`](./batch-pilot-2-execution.md), landed in `81b14fb` (#597).

Fixes were split in two. **imboard-monorepo#3996** (the script half) is **CLOSED** — the
`tee`/`pipefail` construct is gone. **#594** (the sched half: the gate must read `task-failed`
with an empty result body as *capability broken*, taking #585's block-the-batch path rather than
evicting) is **now CLOSED too** (`@ai-dossier/sched` >= 0.22.0). `hasEarnedFailureEvidence`
(`packages/sched/src/attribution.ts`) requires the capability to have EARNED its `task-failed` —
failing-test output for a `test.*` capability, compiler errors for the others — before the gate
evicts; an empty or framing-only capture takes the block path on the live gate and on the
`sched resume --batch` recheck alike, and the journal detail names which branch fired. Caveat for
whoever reads this next: the bar is a marker match over the capture, so it rejects a wrapper's own
prose about a failure (the recorded 765-byte body ends `... exited 1 — real test failure.`, which
an unanchored `/fail/i` accepted — the first cut of #594 shipped exactly that hole) but would not
catch a script that fabricates a `FAIL` line.

*Verify:* `gh issue view 594 --repo imboard-ai/ai-dossier --json state` ·
`gh issue view 3996 --repo imboard-ai/imboard-monorepo --json state`

### 4.2 Readiness floor for classification (RFC §E.2) — **OPEN, unstarted**

The classifier finds "small", not "ready". Deterministic rules are wanted (body mentions a product
decision · depends on an open issue · the named deliverable file does not exist) so that `slot`
requires readiness, not just size.

**Size the expected gain honestly against §3's corrected record.** The pre-registered claim was
that six of attempt 4's seven carried a readiness blocker; the outcome was that five of seven
reached a terminal state within a day and four shipped merged PRs. A readiness floor is still
worth having — imboard-monorepo#47 was a genuine misclassification and #1512 a genuinely
unrefinable plan — but it should be justified by *those two*, not by a 1-in-7 yield figure the
data does not support.

This is a feature with its own design and tests, not a documentation change.

### 4.3 Attempt 5 — **NOT FILED** (deliberate)

Cohort: the attempt-4 survivors (imboard-monorepo#826, #1512) plus fresh candidates, after 4.1 and
4.2 land. Success condition: **≥1 batch PR merged** — the one thing four attempts have never
produced.

File it as a **fresh issue**. Never re-enqueue a completed ops issue: #575/#582/#586 fixed the
re-enqueue rails, but a trail carrying three completed runs still misleads a fresh agent into
resuming at `report`.

### 4.4 #529 — 7-day regression report — **UNARMED, by design**

Armed **manually** after the first batch PR merges; the tick's close-triggered arming step is
superseded and must not be relied on. No batch PR has merged, so it stays unarmed.

```bash
ai-dossier sched enqueue --project imboard-ai-ai-dossier --repo imboard-ai/ai-dossier \
  --issues 529 --tier strong
```

`--repo` is not optional here: `--project` selects the state directory, it does not change repo
context, so run from an imboard-monorepo checkout without it and the label pre-screen queries the
wrong repository.

### 4.5 #592 — live two-arm model validation — **GATED** (owner spend decision)

claude vs open-weights, ~$600 ceiling, gated on the first clean batch. Owner decision 2026-09-02:
option 3.

**Dispatch assertion gate (added by #680, blocking for any arm).** A run intended as EITHER arm
must assert its dispatch config BEFORE it starts, not after: the scheduler dispatches what its
config says, and nothing else — driving the batch from opencode/GLM does not make it run ON
GLM (`#680`: every tier silently dispatched the default claude template at Claude prices). The
assertion is now one glance: the `Dispatch: tier=agent/model` line in `sched status` (or the
`▶ sched dispatch: …` banner `sched start` prints at startup) must show the arm's intended
agent/model per tier — `opencode/glm-*` for the open-weights arm (set via `dispatch.tiers`,
README has the worked example), `claude/*` for the Claude arm — before any unit is enqueued.
An arm discovered to have run the wrong config after the fact invalidates the experiment (#592's
two-arm comparison cannot use it for either side).

### 4.6 Ship guard for `Closes #N` — **OPEN**

The PRs that closed imboard-monorepo#3958 and #3982 merged without the trailer, leaving their sched
units parked for 8 h each. Wanted: a check in `ship-issue` or the auto-merge watcher.

### 4.7 Pager threshold — **OPEN**

The scheduled-controls sweep paged on a single blind (exit-2) CI Health run on 2026-09-02, which
self-resolved. Consider ignoring exit-2 unless repeated.

### 4.8 Eviction bookkeeping (#595, #613) — **dissolve rule was right; duplicate fixed (#595); mis-attribution fixed (#613)**

#598 carried, from the pre-existing trap row, the claim that `b-20260903-01` "dissolved at `N=4
evictions=3 threshold=2` where two of the three were the same issue — by distinct member it was AT
the threshold, not past it, so a batch that should have survived died instead." **That is false at
HEAD**, and it is worth correcting carefully because it is the kind of error that gets a correct
mechanism 'fixed'.

The dissolve trigger already de-duplicates, and has since #572 (`cfdc2bf`, 2026-09-02):

```ts
// packages/sched/src/recovery.ts — checkDissolveTrigger
return evictedMemberIds(batch).size > threshold;   // evictedMemberIds = new Set(evictions.map(e => e.issue))
```

It is the only dissolve trigger, `evictions.length` appears nowhere in `packages/sched/src/`, and
the journal's `evictions=` field is that same de-duplicated count (`evictedCount:
evictedMemberIds(batch).size`). hcc2's deployed `@ai-dossier/sched` was 0.21.0, published
2026-09-02T21:32:25Z — before the 05:58 dissolve — and its `dist/recovery.js` carries the
de-duplicating form.

So `evictions=3` meant **three distinct members** — imboard-monorepo#47 (misclassified), #826
(gate-failed), #1512 (unrefinable-plan) — against `threshold=2`. Three exceeds two. The batch was
past the threshold and the dissolve was correct under the intended rule.

One related reading also does not hold: the raw array does not grow after the decision — #1512's
eviction is stamped `05:58:09.027Z`, the same millisecond as the `batch-dissolved` event.

**But a second member WAS lost, and this document previously dismissed that too quickly.** The
earlier text argued that #340 appearing in `requeued=47,826,340,1512` without an eviction record
proves nothing, because `requeued` is built from `batch.members` and `strategy=full` requeues every
unshipped member, evicted or not. That is a true statement about how `requeued=` is constructed,
and it is an answer to the wrong question. Whether #340 was evicted is settled by the **journal**,
not by `requeued=`, and the journal is unambiguous:

```
05:50:09.352  spawned        issue=340    member 3/4
05:53:28.334  unit-failed    issue=826                 <- #826 fails and advances
05:53:28.350  member-advanced issue=826
05:54:28.176  unit-failed    issue=826                 <- names #826 again, but #340 was in flight
05:54:28.189  member-advanced issue=826
05:52:11.467  spawned        issue=1512   member 4/4
```

#340 appears in exactly two lines of the whole journal — its own `spawned`, and the `requeued=`
list. It ran as member 3/4, it ended (the batch advanced past it), and **no event anywhere names
it as failing**. The 05:54:28 pair is credited to #826, which had already failed and advanced a
minute earlier. So the eviction was not merely duplicated; it was **mis-attributed**, and #340's
actual failure mode is unrecoverable from the record — which matters more than the count, because
a real defect in that member's path would be invisible. This was first established from the spawn
sequence in the [2026-09-03 analysis on
#595](https://github.com/imboard-ai/ai-dossier/issues/595#issuecomment-5521881175).

**#595's fix did not close this half; #613 does.** `appendEvictions` skips a record whose `issue`
is already present, so the mis-attributed 05:54:28 record was dropped rather than corrected — #340
still ended with no eviction record naming it. De-duplicating an append cannot make a record name
the right member. **Fixed in #613** (`@ai-dossier/sched` >= 0.22.2): resolving a member is now a
one-shot claim — `advanceMemberOrValidate` advances only while `executing_member` still equals the
member the caller resolved, and `evictMemberDirectly` reports `duplicate: true` to a caller that
lost the race, which then journals no `unit-failed` and does not advance. A second resolution of
#826 can therefore no longer consume #340's place in the sequence, and a lost claim journals
`member-advance-skipped` rather than returning silently. The regression test asserts on **which**
members the records name, since a count-only test passes on exactly this failure.

**What is still true.** The stored `evictions` array does retain the duplicate — `[47, 826, 826,
1512]`, four entries over three members — because #826 was evicted twice, ~2 min apart. That no
longer moves the dissolve trigger, but any eviction-**rate** metric computed from raw event counts
(RFC-0001 §E.5 reads one, to decide whether the 4-member cap can be raised) is still inflated by
it — the last residual defect of this batch's bookkeeping, the mis-attribution above having been
fixed in #613.

**#595 was re-scoped on exactly this basis and shipped** (`@ai-dossier/sched` >= 0.22.0): it
fixed the record and display layers, and left the dissolve rule alone. `appendEvictions`
(`packages/sched/src/state.ts`) is the single `evictions[]` append and is a no-op for a member
already recorded — as is the repeat requeue that used to run with it, which could otherwise
overwrite the first eviction's `failure_evidence` or kill a live re-dispatch — journaling
`eviction-duplicate` instead; `buildStatusReport` de-dups on read so a `state.json` written before
the fix reports one row per member in `sched status` and `--json`. A legacy stored array is left as
written, so the `jq` recipe below still shows the historical duplicates.

*Verify:*

```bash
jq '.batches[] | select(.id=="b-20260903-01") | .evictions | group_by(.issue)
    | map({issue: .[0].issue, n: length})' ~/.dossier/sched/imboard-ai-imboard-monorepo/state.json
grep batch-dissolved ~/.dossier/sched/imboard-ai-imboard-monorepo/events.jsonl
grep -n 'evictedMemberIds(batch).size > threshold' packages/sched/src/recovery.ts
```

Note `.batches` is an **array**: `.batches["<id>"]` errors with `Cannot index array with string`.

### 4.9 Host hygiene — **OPEN**

- **Two broken pool entries** — `pool-1788415097038-3141172` and `pool-1788417983326-3354528`,
  both `broken_step=verify` ("post-return self-check failed: … is not clean"), left by the
  2026-09-03 batch worktree returns. There is no pool entry for imboard-monorepo#3958.
- **One leftover batch worktree** — `worktrees/batch-b-20260903-01-20260903`. The `-02` and `-03`
  trees are already gone.
- **Three open batch anchors** — imboard-monorepo#3993, #3994 and #3995, all still `OPEN` with
  their batches dissolved. Close them before the next backlog sweep or the classifier re-ingests
  them.

`@ai-dossier/worktree-pool`'s `gc` / `refresh` must **never** be run by an agent (ai-dossier#438);
pool maintenance is a human task.

*Verify:* `jq '[.worktrees[]|select(.status=="broken")|.id]' <imboard-repo>/worktrees/.pool-state.json` ·
`ls -d <imboard-repo>/worktrees/batch-*` · `gh issue view 3993 --repo imboard-ai/imboard-monorepo --json state`

### 4.10 Cross-project dependencies — **OPEN (by design, for now)**

sched dependencies are per project. An ai-dossier issue that depends on an imboard-monorepo PR
(e.g. #590 on imboard-monorepo#3982) has to be sequenced by hand at enqueue time.

### 4.11 Near-miss backlog

Each blocked on a one-line owner decision: imboard-monorepo#2711, #1021, #1022, #2567, and
ai-dossier#18 (all verified `OPEN` 2026-09-06). imboard-monorepo#3416 and #340 have since shipped
(PRs imboard-monorepo#4001 and #4003) and are no longer on this list.

*Verify:* `gh issue view <n> --repo imboard-ai/imboard-monorepo --json state`

## 5. Halt state on hcc2

Verified 2026-09-06. What #598 recorded at the halt is marked where it has moved since.

| Fact | State | Verify |
|---|---|---|
| `imboard-ai-ai-dossier` | `PAUSED`, 0/3 slots live | `ai-dossier sched status --project imboard-ai-ai-dossier` |
| `imboard-ai-imboard-monorepo` | `PAUSED`, **2/3 slots still marked live — both stale** (see below) | `ai-dossier sched status --project imboard-ai-imboard-monorepo` |
| Tick cron | Removed. The line is saved verbatim at `~/.dossier/reset-fleet/tick.cron.saved` | `crontab -l` — only the weekly scorecard job should remain |
| Weekly model scorecard cron | Installed (Mondays 05:00) but has **never fired** — it was installed 2026-09-02 and its append-target `~/.dossier/reset-fleet/scorecard-weekly.log` does not exist. First due 2026-09-07 | `crontab -l && ls -l ~/.dossier/reset-fleet/scorecard-weekly.log` |
| Tracked-issue list | `~/.dossier/reset-fleet/issues.txt` — 31 entries, of which only `imboard-ai/ai-dossier#590` is still open | `wc -l ~/.dossier/reset-fleet/issues.txt` |
| Telegram | The fleet bot → owner DM; token and chat id in `~/.dossier/reset-fleet/telegram.env` | `ls ~/.dossier/reset-fleet/telegram.env` |
| Model routing | mechanical=haiku, mid=sonnet, strong=opus on both projects | `~/.dossier/sched/<project>/config.json` |
| Dispatch command | ends with `--disallowedTools Monitor` (#591) | same file |
| ai-dossier `phase_stall_timeout_ms.implement` | 4 h — supervisor issues sit idle while polling | same file |

### The stale slots — read this before restarting

`imboard-ai-imboard-monorepo` shows slots 2 and 3 `running`, on `issue:3393` (pid 3675888) and
`issue:340` (pid 3442401), phase `implement`, `last-progress 3d ago`. #598 recorded these as "two
full-cycle fallbacks left running to finish on their own."

**They finished. Both processes are dead, both issues are CLOSED, and both shipped** (PRs
imboard-monorepo#4004 and #4003). The scheduler has not noticed because it is paused and the tick
cron is gone, so no reconcile pass has run since the halt.

*Verify:* `ps -p 3675888 -o pid=` and `ps -p 3442401 -o pid=` print nothing;
`gh issue view 340 --repo imboard-ai/imboard-monorepo --json state` → `CLOSED` (same for #3393).

Clearing them is a reconcile pass, not a state-file edit — see
[Restarting after a halt](../how-to/autonomous-pipeline.md#restarting-after-a-halt), which also
explains why that pass must run *before* un-pausing. Never edit `state.json` by hand.

### Failed units carried into the halt

`imboard-ai-imboard-monorepo`: #3631, #826, #1512, #3985 — all
`unverified-exit-at-strongest-tier`. `imboard-ai-ai-dossier`: #528, same reason.

Note that #3985's PR merged anyway. The engine is meant to verify against `runstate` and GitHub
rather than against agent exit; here it failed the unit regardless, which is part of what #596 is
about — the mitigation (`--disallowedTools Monitor`) narrowed this failure mode but did not close
it, and the surviving correlation is unit **duration**, not the tool. Always `gh pr view` before
writing off a failed unit's output.

## 6. Resuming

**The executable procedure lives in one place:**
[Restarting after a halt](../how-to/autonomous-pipeline.md#restarting-after-a-halt) in the operator
runbook — reconcile while still paused, verify, un-pause, refresh the tracked-issue list, then
restore the cron and prove it actually runs. Follow it there rather than a second copy here; the
two copies of this recipe had already diverged once.

What belongs to *this programme*, once the fleet is running again, in order:

1. ~~Land **#594**~~ — **done** (§4.1; shipped with #595 in the `b-20260906-03` batch). Still
   re-run one batch before trusting the gate end-to-end: the script fix removed the
   constant-function behaviour on imboard and the sched fix stops the *next* broken capability from
   evicting members the same way, but neither has been exercised against a real broken capability
   since.
2. Land **§4.2**'s readiness floor, sized against §3's corrected record rather than the
   pre-registered prediction.
3. Close the three open batch anchors and clear the broken pool entries (§4.9) so the next backlog
   sweep is clean.
4. File **attempt 5** as a fresh issue (§4.3) and enqueue it at `strong`. Do **not** re-enqueue
   #526, #528 or #590.
5. On the first merged batch PR: arm #529 (§4.4), then #592 (§4.5).

**When the fleet is running again, retire the halt banners in the same commit** — delete the HALTED
note at the top of [`docs/how-to/autonomous-pipeline.md`](../how-to/autonomous-pipeline.md) and
flip `State:` at the top of this file. Two documents an operator is told to read first must not
keep asserting the fleet is stopped while it dispatches.

## 7. Traps

Everything this programme has learned the hard way is in
[`docs/agent-traps.md`](../agent-traps.md), the grep-first index `AGENTS.md` requires every
planning run to read. The ops traps from the halt week are, by their literal symptom text:

- `no crontab for`
- `cron` job stopped firing after a script was rewritten
- `sched abandon` returned success but the agent is still running
- your ssh session dies the instant you run `pkill -f <pattern>` on a remote host
- no `claude` / agent process visible in `ps`
- a `sched status` queue row reads `done` but the issue is still OPEN

Append there, not here.
