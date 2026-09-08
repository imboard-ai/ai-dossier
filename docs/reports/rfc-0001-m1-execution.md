# RFC-0001 §J — M1 execution record (2026-09-07/08)

First execution of the §J integration-branch model, run by hand on imboard-monorepo with the
supervisor standing in for the parent orchestrator (#648, unbuilt). Purpose: test §J's
assumptions against a real batch BEFORE building the dossier, since the programme had already
paid once for building-before-proving.

**Cohort:** imboard-monorepo #3415 (backend, `cycle:full`), #4062 (backend ontology), #3893
(frontend e2e). Batch `proof-20260907`. Shipped as imboard-monorepo#4113.

**Total cost $63.91** — 3 members ($62.14) + 1 bounded escalation ($1.77) + 2 parent repairs (free).

## Scorecard
| assumption | verdict |
|---|---|
| members skip the expensive suite when told | **CONFIRMED** — 0/3 ran ci-parity |
| big issues can be batch members | **CONFIRMED** — 605-line and 46-file members |
| parallel members on one branch conflict | **REFUTED** — 3/3 merged clean, 3,761 lines |
| 3 x ci-parity collapses to 1 | **CONFIRMED** — 81m26s vs 157-267m = **1.9x-3.3x** |
| token saving is 2-4x (RFC exec summary) | **REFUTED** — ~20% |
| parent repairs from handovers | **CONFIRMED for mechanical**, bounded by semantics |
| §F.2 bounded escalation | **CONFIRMED** — $1.77, 8 min, measured evidence |
| p (member break rate) | **UNMEASURED** — N=3. This is what M2 buys |

---


## Setup
- integration branch `batch/proof-20260907` @ d2f6813fb from origin/main
- 3 worktrees, parallel, each branched from the integration branch
- warmed by `cp -al main/node_modules` — 3 warm trees in seconds vs 3 installs (#561 stopgap)
- dispatch: `claude -p --output-format json --model {opus|opus|sonnet} --disallowedTools Monitor`

## Contract compliance
- **ci-parity runs by members: 0 / 3.** The "do not run the repo-wide suite" clause held on
  all three. This is the clause the whole economics depends on.

## Sizes
- #3415: 8 files, 605 insertions, 16 deletions. Wrote its own integration test.
  **Would have been rejected by E.2 rule 5 (>8 files OR >400 lines).** The change §J exists
  to admit. Landed on the integration branch inside a batch.

## Member #3415 — completed
- success, **$9.25, 95 turns**. Full-cycle baseline is $16 + ~86 min per issue (#598 §1);
  this is the implementation half only (no ship, report, full suite, or ci-parity).
- 8 files / 605 insertions. Wrote a 23-case integration test and **proved it red pre-fix**
  by neutering the middleware, then restored and re-verified green.
- Relevance-scoped test run: 7 integration suites, 4 tsx --test files, 2 unit specs,
  typecheck, eslint+prettier over the 8 changed files. No repo-wide sweep.

### Handover quality — the design's strongest signal so far
The `handover:v1` contract produced more than was asked for. Three behaviours worth
encoding into #648's spec as REQUIRED, because they are what make parent-fixes-first work:

1. **Pre-existing failures identified AND proved pre-existing.** It found
   `scripts/audit-authz-surface.test.ts` red, reproduced the identical failure on a clean
   tree with its own changes reverted, established it is out-of-band (not in CI's
   `test-runner --list`), and declined to fix it with a reason: the fix is a security
   judgment belonging to whoever added the route. Without this the parent burns time
   attributing a failure to a member that did not cause it.
2. **A pre-loaded repair option.** "If the parent wants a cheap hedge, raising `strict` to
   120 is a one-line change in RATE_LIMIT_TIER_BUDGETS; the drift test asserts
   `strict.max < standard.max`, not literals, so tuning does not break it." The member
   anticipating the parent's most likely edit and confirming it is safe.
3. **Blast radius named, not implied.** Redis/multi-machine (MemoryStore per Fly machine,
   effective cap = budget x machines), 429 body shape on 6 newly-limited routes, SSE
   reconnect storms against a 12/min strict budget with the frontend retry policy untraced.

### Cost note
Handover is long (~2.5k words). Rich enough to be worth it, but #648 should expect to read
several of these and budget context accordingly.

## Member #3893 — completed
- success, **$17.16, 39 turns**, sonnet. 4 files / 238 insertions.
- `test(e2e): fix WebKit cursor-affordance false-positives + overlay enter-animation race`

### Finding: diff size does not predict implementation cost
| member | model | diff | turns | cost |
|---|---|---|---|---|
| #3415 backend | opus | 8 files / 605 ins | 95 | **$9.25** |
| #3893 e2e | sonnet | 4 files / 238 ins | 39 | **$17.16** |

The "small" member on the cheaper model cost **1.9x** the big one, in 41% of the turns —
so its per-turn context was far larger. E2E work is token-expensive by nature (Playwright
traces, screenshots, verbose runner output), independent of how much code changes.

Consequences:
- RFC-0001 E.2's size proxies (`predicted files > 8`, `diff > 400`) do not track cost either.
  They were already rejected as a *membership* rule by §J.2; this says they are a poor
  signal for `impl_tier` budgeting too.
- A batch's cost cannot be estimated from its combined predicted diff (§E.4's
  "combined predicted diff <= ~1,200 lines" packing constraint prices the wrong thing).
- #648 should not assume the expensive member is the big one.

## Member #4062 — completed
- success, **$35.73, 238 turns**, opus. ~45 files (combined batch is 57).

## Cost totals (three members, implementation half only)
| member | model | turns | cost |
|---|---|---|---|
| #3415 | opus | 95 | $9.25 |
| #3893 | sonnet | 39 | $17.16 |
| #4062 | opus | 238 | $35.73 |
| **total** | | **372** | **$62.14** |

Full-cycle baseline is $16 + ~86 min per issue (#598 §1) => ~$48 for three. The members
alone cost **$62.14**, MORE than the baseline for three whole full-cycles, despite skipping
ship, report, the full suite and ci-parity.

NOT apples-to-apples: all three here are `cycle:full`-class (the baseline is a general
population), and #4062 is a substantial feature. But the honest reading is that **§J's
saving is wall-clock, not tokens.** §J.0 frames the prize as amortizing the ci-parity hour,
which is still supported; any implied token saving is not.

## Assumption 2 — RESOLVED, parallel members do NOT conflict
All three member branches merged onto the integration branch with **zero conflicts**:
`m1/3415` (backend api/v1/registry), `m1/4062` (ontology/KPI), `m1/3893` (frontend e2e).
Combined: **57 files, 3,761 insertions, 260 deletions**.

§E.4 chose the serial shared worktree specifically to eliminate merge conflicts, and §J.3
accepted their return as a worthwhile trade. On this run there was nothing to trade — the
file-disjointness the packer prefers was sufficient on its own.

Also: the combined diff is **3,761 lines against §E.4's "combined predicted diff <= ~1,200
lines" packing ceiling** — 3x over, merged clean. Another sign that constraint prices the
wrong thing (cf. the cost-inversion finding above).

## Cost baseline — CORRECTED from scheduler telemetry (no control run needed)
`~/.dossier/sched/imboard-ai-imboard-monorepo/runs/issue-*.log` carry the final
`--output-format json` record with `total_cost_usd`/`num_turns`. 24 runs found.

**Same methodology trap as §J.12 recurred**: the naive median over all 24 is **$0.14**,
because 18 are fast failures (env-cold, spawn-error; 1-24 turns, <3 min). Split by outcome:

Real imboard full-cycle runs: $48.97/278t, $28.34/136t, $26.37/135t, $25.65/90t,
$11.75/69t, $1.67/19t  =>  **median ~$26**.

| | cost |
|---|---|
| 3 x real full-cycle (median $26) | ~$78 |
| M1: 3 batch members | **$62.14** |
| saving | **~20%** |

This CORRECTS the earlier note above, which compared against #598's summary figure of
$16/issue and concluded batching cost MORE. Per-run telemetry is the better source; the
$16 was a summary across a different population.

**But the RFC's headline claim does not survive.** The executive summary promises
"~2-4x token reduction" and Q2's table assumes non-implementation overhead dominates.
It does not: implementation is the bulk (#4062 = 238 turns) and is irreducible — a batch
member does exactly the same implementation work a full-cycle does. What batching removes
is review fan-out N->1, ship/report ceremony N->1, runbook loading, and the ci-parity hour
N->1. That is worth ~20% on tokens, not 2-4x.

**Recommendation for §J:** restate the prize as wall-clock, not tokens. ~20% token saving
is real but secondary; the ci-parity hour is the case.

## Scaling: larger batches are better, and the size caps are backwards (owner insight)

Batch cost = FIXED (ci-parity ~52-89 min + aggregate review + ship + parent integration)
+ VARIABLE (implementation, irreducible, per member). Amortized fixed cost per issue is
`fixed/N`, monotonically decreasing. Given members that work "well enough, not perfect":

    separate:  N x 75 min
    batched:   75 + (N x p x repair_time)

N=20, p=0.30, repair=20m  =>  75+120 = 195m  vs  20x75 = 1500m. **7.7x better.**
Batching only loses when `p x repair` approaches 75 min per member.

### Two RFC rules this inverts
1. **§E.4 "members <= 6 (start 4)"** was sized for §C.4's serial shared worktree, where a
   large member stalls everyone behind it. §J.3 removed that cause; the cap outlived its reason.
2. **§F.2 "> 1/3 evicted => dissolve"** is a FRACTION, so it is *safer* at scale:
   - N=3, one bad member = 33% — on the dissolve threshold
   - N=20, one bad member = 5% — absorbed
   Small batches are fragile to a single bad member; large batches absorb them. The
   "start small for safety" instinct is exactly backwards under §J.

### What actually bounds N
- **deploy blast radius** — one deploy carries N issues; an incident reverts N at once (§Q19).
  Real, and about consequence rather than efficiency.
- **parent repair capacity** — expected repairs ~ N x p.
- **available parallelism** — members run concurrently; N beyond slot count just queues.

NOT bounds: wall-clock (batch duration tracks the SLOWEST member, not N, because members are
parallel), base drift (bounded by slowest member, not N), combined diff size.

### The measurement this needs
M1 gives **no value for p** — N=3, zero failures. The model says go bigger; measuring p is
what a larger second run buys. Until then this is reasoning, not evidence.

## Parent phase, run 1 — RED at hygiene in 6m18s, 0 integration suites
Started 16:00:12Z, log last written 16:06:30Z. Failed: `✗ ci-parity: gate 'hygiene' failed`
=> `✗ Prettier check failed` in packages/frontend. TypeScript PASSED, ESLint PASSED.

Four files, all #4062's:
  src/app/dashboard/components/kpi-metrics-cards.config.ts
  src/app/dashboard/components/kpi-metrics-cards.vertical.test.ts
  src/components/ai/widgets/budget-months-grid.widget.tsx
  src/lib/golden-layouts/budget-statement.test.ts

### Assumption 3 (parent repairs) — FIRST EVIDENCE, positive
Fixed by `prettier --write` + one batch-level commit, attributable to no member, seconds of
work. Under §F.2's ladder this is attribute -> bisect -> bounded fix -> possible eviction of
a **$35.73 member and revert of ~45 files of good work over whitespace**. §J.6 is vindicated
on exactly the failure class it was written for. (A formatting nit is the EASY case; a real
logic failure is still untested.)

### Member-contract gap found
#3415's handover recorded "eslint + prettier --check over all 8 changed files | pass".
#4062's evidently did not cover its frontend files. The member prompt says "typecheck and
lint over your changed surface" but does not make it checkable. **Fix for M2: require the
member to name the exact lint/format command it ran and over which paths**, so an omission
is visible in the handover rather than discovered by the parent 6 minutes into ci-parity.

## Monitor bugs (mine) — cost a wrong report to the owner
Reported "78 minutes" twice; actual runtime 6m18s. Two compounding defects:
1. Filter was `[FAIL] gate`; ci-parity emits `✗ ci-parity: gate '<name>' failed`. The monitor
   stayed SILENT through a real failure — "silence is not success".
2. Completion check `pgrep -f "ci-parity.sh"` **matches the monitor's own command line**, so
   it could never fire. Same self-match trap docs/agent-traps.md records for `pkill -f`,
   reproduced in a pgrep guard. Elapsed-since-start was then misread as runtime.
Run 2's monitor matches both spellings and detects completion by log-file staleness.

## Recurring shape — THIRD instance today
A fast failure masquerading as something else:
- ci-parity median 7.4m (early failures hid the real 52.5m) — §J.12
- full-cycle median $0.14 (18 fast failures hid the real ~$26)
- a 6m18s run read as 78m (dead process + broken liveness check)
Every gate/cost/duration statistic in this programme must be split by outcome before it is
quoted, and liveness must be proven, never inferred from a matching pattern.

## Monitor bug #3 — false GREEN. Same error class, fourth instance today.
Run 2's monitor inferred completion from **log staleness** (no write for 150s) and reported
"ENDED GREEN — runtime 72m58s". It was still running: `Progress: 1/4 (25%)`, mid
`integration:meeting`, which runs jest `--silent` and emits nothing for minutes. Proven by
`ps`: pid 2101492 alive at 76m, log written 3s earlier.

I had written "liveness must be proven, never inferred from a matching pattern" into this
file ~20 minutes before building a monitor that inferred death from silence.

The four instances today, all one shape — **a terminal state inferred from absence of signal**:
1. ci-parity median 7.4m — early failures counted as fast successes (§J.12)
2. full-cycle median $0.14 — 18 fast failures counted as cheap runs
3. 6m18s run reported as 78m — dead process, liveness inferred from a self-matching pgrep
4. a live run reported GREEN — completion inferred from a quiet log

### Design requirement this generates for #648 (parent orchestrator dossier)
The parent's core loop is "run the expensive suite, decide whether it finished and how".
Both errors are expensive: a false DONE ships or repairs against a partial result; a false
RUNNING hangs the batch. The parent MUST determine suite state from **process identity plus
an explicit terminal marker emitted by the runner** — never from output silence, never from
a pattern that can match the observer's own command line. This is not a nice-to-have; it is
the one thing the parent does that nothing else can recover from.

## Amortization — partial numbers, run still in flight at 76m+
At 76 min the batch run is already ABOVE the single-issue green median (52.5m) and nearing
p90 (89m), still only 25% through the backend test groups. It named **117** integration
suites vs 107-112 historically for single-issue diffs.

So the integration stage is **not perfectly fixed** — it scales with the combined diff, but
strongly SUBLINEARLY: ~3x the work for (so far) ~1.5x the time. §J.12's "fixed cost" claim
was too strong; "sublinear, dominated by a large fixed floor" is the accurate statement.
The amortization case survives comfortably either way, but §J.12 needs the correction.

## Parent run 2 — RED at 81m26s, but the failure is INFRA, not code
Reached the full expensive stage: **117 integration suites, Progress 4/4**, then the `test`
gate failed with 11 red suites:
  bet-historical-createdat, demo-cedar-hollow-year, invite, meeting-materials-link,
  meeting-proposed-slot-unregistered-vote, org-bats, org-portfolio,
  postmeeting-minutes-lock, public-api-v1, report-repository-visibility,
  sanitizer-idempotence

**All eleven fail identically**: `MongoOperationTimeoutError`, `errorCategory: "infra"`,
every one dying at `signuplogin` with a 500 against the pooled Atlas test DB. No assertion
failed. No member's code is implicated.

A hypothesis worth recording as REJECTED: I expected #3415's new per-tier rate limiter to
be 429-ing test traffic (its handover noted the production limiters are neutered under
NODE_ENV=test). Checked the code — `max: isTestMode ? 10_000 : budget.max`, line 200. It
IS neutered. Verified rather than assumed; the assumption would have been wrong.

## GAP IN §J.6 — the parent needs a third branch, and §J does not give it one
§J.6 gave the parent **fix-vs-evict**. This failure is neither. A parent holding only those
two options would either burn hours "repairing" a Mongo timeout or evict three members'
work ($62 and a day) over a flaky database.

RFC-0001 already solved this one level down: F.11's four-way capability outcome, where
`automation-broken`/`capability-unavailable` must NEVER be read as `task-failed`, and #583
/#594 exist because a gate that cannot stand behind its verdict must BLOCK rather than
evict. §J.6 lifted the fix-vs-evict decision to the aggregate suite without lifting that
discipline with it.

**Required for #648:** the parent's verdict is four-way, not binary —
  ok | task-failed (repair, then evict on budget exhaustion) | automation-broken (BLOCK,
  change nothing, retry or surface) | capability-unavailable.
Infra-category failures (`errorCategory: "infra"`, connection timeouts, pool lease
failures, runner crashes) are `automation-broken`. The parent must never revert a commit on
a signal the suite cannot stand behind. This would have shipped into #648's spec unnoticed
had this run gone green.

## Timing — the amortization number, finally
Run 2 reached the full stage in **81m26s** (117 suites, 4/4 groups) before the infra
failure. Single-issue green runs reaching the same stage: median 52.5m, p90 89m, max 120.5m
(§J.12, n=40), and those execute the SAME floor — verified: two historical single-issue runs
executed 107/107 and 106/106 suites at Progress 4/4.

    3 issues separately:  3 x 52.5-89m  =  157-267 min
    3 issues batched:     81.4 min
    realized saving:      ~1.9x - 3.3x

The floor is real and the amortization holds. §J.12's "fixed cost" is very slightly strong
(117 suites vs 107-112, 81m vs 52.5m median) — accurate wording is "sublinear, dominated by
a large fixed floor". Do NOT extrapolate group progress linearly: groups are wildly uneven
(2/4 at 78m, 3/4 at 79m, 4/4 at 81m — one group took ~73 min, another ~1 min).

## Root cause of the 11 failures: shared test-pool contention
`pnpm run test:pool:status` during triage:

    imboard_pool_01  leased  demo-knowledge-graph.test.ts@feature/4096-demo-knowledge-graph-layer-2@hcc
    imboard_pool_02  free    imboard_pool_03  free    imboard_pool_04  free

A DIFFERENT workload on this machine held a pool lease while the batch ran. imboard has
exactly **four** pool databases; the batch's 4 concurrent integration groups plus a
neighbour's suite exhausted them, and Atlas connections timed out. Hence
`MongoOperationTimeoutError` across 11 unrelated suites.

### New bound for §J.13
§J.13 lists "available parallelism" as a bound on N and I framed it as agent slots. The
binding limit here is **test infrastructure**, not agents: two concurrent batches — or one
batch plus any other test workload on the same machine — contend for 4 databases. Batch
concurrency must be bounded by pool capacity, not slot count.

### Why this sharpens the §J.6 gap
On shared infra, `automation-broken` is not a rare edge case, it is ROUTINE. A parent whose
verdict is binary (repair | evict) will hit this regularly and destroy good work each time.
The four-way verdict is load-bearing, not defensive programming.

## ASSUMPTION 3 — parent repairs from handover + stack. VALIDATED (pending verify run).
The retry separated infra from code exactly as the four-way verdict predicts:
- **9 of 11 suites passed on retry** — transient pool contention, `automation-broken`.
- **`invite.test.ts`: 100% infra** — all 57 failures `signuplogin ... MongoOperationTimeoutError`,
  zero assertions. Would have been evicted by a binary repair/evict parent.
- **`demo-cedar-hollow-year`: REAL.** Re-run alone against a free pool: **0 mongo timeouts,
  still 5 failed.** Infra ruled out by isolation, not by assumption.

### Attribution chain (what a parent must actually do)
1. All 5 failures collapse to ONE root: `composes the board in under two minutes` throws at
   `spawnFinanceStatements (composeBoardDeps.ts:592)`. Every `Received: 0` / `[]` is downstream.
2. #4062 **directly modifies** `composeBoardDeps.ts`, `seed-finance-dashboards.ts`,
   `cedarHollowSpec.ts`, `cedarHollowStatementValues.ts`, `composeBoard.ts` (46 files total).
3. `demo-cedar-hollow-year.test.ts` is **pre-existing on origin/main and modified by NO member** —
   so it is a regression detector, not a member's own test.
=> attributed to #4062 without bisect. Overlap alone was sufficient (`attribution.ts` stage 1).

### The repair — one line, from the stack trace alone
    MongooseError: Cannot call `create()` with a session and multiple documents
    unless `ordered: true` is set
    seed-finance-dashboards.ts:133

    - create(toCreate, session ? { session } : undefined)
    + create(toCreate, session ? { session, ordered: true } : undefined)

No member context needed beyond the diff and the trace. A batch-level repair commit,
attributable to no member, exactly §J.6's shape.

### What this says about member scoping
#4062 changed `composeBoardDeps.ts`/`seed-finance-dashboards.ts` and did NOT run
`demo-cedar-hollow-year.test.ts`, which is the integration test that exercises them — squarely
"tests for direct consumers, one hop out" under §J.4's relevance contract. The member's
relevance scoping was too narrow. **M2 must make the member name the tests it ran AND the
consumers it considered**, so an omission is visible in the handover rather than costing the
parent an 81-minute gate run.

### Control-run note (a trap for #648)
Attempting the clean-main control failed for an ENV reason: a `cp -al` hardlinked node_modules
does not carry that worktree's workspace links — `Cannot find module '@imboard/shared-types'`,
`Tests: 0 total`. **`Tests: 0 total` is not "passed" and not "pre-existing"** — it is a suite
that never ran. A parent comparing against a control MUST check the control actually executed
tests, or it will read an env failure as evidence of anything it likes. Fifth instance today
of a non-result being mistakable for a result.

### Repair verified: 5 failed -> 1 failed (6 passed), 0 mongo timeouts
The one-line `ordered: true` fix resolved 4 of 5. The board composes.

### The survivor is SEMANTIC, and marks the parent's true boundary
`eight closed quarters each materialised Cash HistoricalMetrics` — **Expected 8, Received 9**
at `demo-cedar-hollow-year.test.ts:278` (`CEDAR_HOLLOW_QUARTERS`). #4062 produces one extra
quarterly HistoricalMetrics row.

Answering it requires deciding whether the 9th row is correct (test is stale) or wrong (code
is buggy) — a question about what #4062's feature SHOULD do. The parent has the diff and the
trace but not the issue's intent.

**This is the real fix-vs-evict boundary, and it is not about difficulty — it is about
authority.** The parent repairs MECHANICAL failures (formatting, a mongoose call signature,
a missing flag) cheaply and correctly. A SEMANTIC failure belongs to whoever owns the issue's
acceptance criteria. A parent that repairs its way to green through a semantic failure is
doing exactly what §J.4 warns of: making tests pass over a change that may not do what the
issue asked.

**Required for #648:** the parent's repair authority must be scoped by KIND, not by budget
alone. Mechanical => repair. Semantic (an assertion about the feature's own behaviour, in the
member's own area) => hand back to a member-tier agent with the evidence, or evict. §F.2's
"1 bounded fix attempt by a mid-tier agent" is the right escalation and should be retained
under §J.6 rather than replaced by the parent.

## M1 FINAL SCORECARD
| assumption | verdict |
|---|---|
| members skip the expensive suite when told | **CONFIRMED** 0/3 ran ci-parity |
| big issues can be batch members | **CONFIRMED** 605-line and 46-file members |
| parallel members on one branch conflict | **REFUTED** 3/3 merged clean, 3,761 lines |
| 3 x ci-parity collapses to 1 | **CONFIRMED** 81m26s vs 157-267m => **1.9x-3.3x** |
| token saving is 2-4x (RFC claim) | **REFUTED** ~20% ($62.14 vs ~$78) |
| parent repairs from handover alone | **CONFIRMED for mechanical**, bounded by semantics |
| p (member break rate) | **UNMEASURED** — N=3 too small; this is what M2 buys |

## §F.2 bounded escalation — VALIDATED, and it outperformed the parent
Bounded fix agent (opus): **$1.77, 26 turns, 8 minutes.** Decision (b) — code right, test's
query stale.

**It measured instead of reasoning.** Instrumented the assertion to dump each matching row's
dashboard/anchor/value, then reverted the instrumentation. Nine rows = eight `cash` +
one `board-summary`, same anchor, same 149000 value.

Evidence it gave, all checkable:
1. Not a duplicate — different dashboard; `recordUniformMetricsForVersion` keys rows by
   `uniform:<dashboardId>`, one per dashboard (pre-existing #2125, untouched by #4062).
2. Not a mis-slice — all 8 quarters present exactly once as Cash rows; index 7 is the latest
   closed quarter, which `cedarHollowSpec.ts:388` gives `financeStatements` to.
3. Intended by #4062 — `board-summary.ts` adds `NONPROFIT_METRIC_META` carrying net burn as a
   nonprofit headline row ("Monthly Outflow"), and `historicalMetricsUniform.ts:78` maps that
   rogueId to `netBurnRate`.

### It refused the lazy fix, and its reason was better than mine
It did NOT bump 8 -> 9, giving two concrete objections:
- 9 stops detecting a missing quarter (any nine rows pass).
- 9 lets two rows share the latest `dataAnchorDate`, making the NEXT assertion
  (`burns[last] === CEDAR_HOLLOW_LEDGER.cash.monthlyOperatingOutflow`) depend on an
  unspecified Mongo sort tie-break — passing today only because both rows hold 149000.
i.e. the obvious fix would have planted a latent flake. Instead it scoped the query to the
Cash dashboards by id and documented the nine inline, citing #4062.

### Design consequence for #648
This is the strongest argument for KEEPING §F.2's bounded member-tier escalation under §J.6
rather than folding it into the parent. The parent correctly refused the semantic call
(authority), and a cheap $1.77 specialist resolved it in 8 minutes with measured evidence.
Escalation is not a fallback for parent failure — it is the right actor for a different
QUESTION. Two distinct roles:
  parent      -> mechanical, cross-member, integration-level
  member-tier -> semantic, single-issue, requires the issue's intent
