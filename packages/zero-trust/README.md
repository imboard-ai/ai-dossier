# @ai-dossier/zero-trust

Private, provider-independent foundation for [PRD-ZTFC-001](../../docs/features/zero-trust-full-cycle/prd.md)
§5.1, §5.5 and §5.6 (gate 2), §5.7, §5.8 and §5.9. Controller-side model calls; the only
GitHub calls are the controller-only broker/push modules and credential-free reads in
`src/github/` and `src/policy/`, and the VM adapter and proxy scripts are described below. Receipts use
core's Ed25519 signer abstraction and Ajv schema validation.
This provides lifecycle/status, durable intent/budget, canonical Git and receipt primitives,
plus ecosystem detection, runtime profiles, command plans and package-proxy policy
(see the gate 2 section below).
Publication remains gated on S1 feasibility.

## Credential-free shipping context (#1105)

`controller/shipping.ts` exports the trusted composition APIs below. It has no
credential-module imports; the composition root supplies authenticated adapters.

- `shippingIntent(bindings): IntentInput` builds the exact `push_branch` target
  with `forkTarget` and candidate SHA. `idempotencyKey(intent)` is the grant's
  `operationKey`; `IntentDriver` journals attempts before the pusher authorizes.
- `buildReceiptContext(deps): Promise<ReceiptContext>` revalidates the locked
  `RunStore`, binds its contribution/run/contributor/upstream identity to the
  authenticated `ForkReady`, and reads all persisted boundary artifacts under
  the store fence to recompute this run's `runBoundaryVerdict`. It refuses missing,
  malformed or breached evidence and states other than `shipping`/`revising`.
  Required commands come exclusively from the trusted `CommandPlan`'s required
  report-capturing verification commands, with `argv.join(' ')` display text.
  The allowlist contains exactly one push target and the supplied push-ledger
  `expectedRemoteSha` (null initially). Every call probes `policyFresh()`;
  false, unknown or throwing results refuse. Inputs are detached and rechecked
  across asynchronous work.
- `issueShippingReceipt(deps, verification, bindings, now)` reloads the immutable
  per-SHA verification record with its controller-held digest, checks the supplied
  record is identical and calls `assertShippableVerification`. It checks profile,
  run, candidate, base/parent and command-plan bindings before signing a v2 receipt
  with exactly one push grant, a fresh nonce and the standard 15-minute expiry.
- `makeAuthorize(deps)` returns the structural `ForkPusher` callback yielding
  `{ receipt, context, candidate }`. Dependencies include the held manifest,
  canonical record/authority and baseline pack. It loads immutable verification,
  calls `reconstructCandidate`, checks the requested intent and authenticated
  author, then issues a fresh receipt and context for every attempt. Missing or
  changed evidence, candidate inputs or identity refuse before authorization.
  Actual nonce/attempt consumption remains in `authorizeShipping` in the pusher.
  Source snapshots use `validateManifest` and its canonical source limits, rather
  than the smaller receipt JSON limits; post-await comparisons revalidate the digest.
- `makeHandoffAdmission(deps): HandoffAdmission` supplies fresh policy, contributor
  login and exact fork-readiness checks, authenticated `verifyReceipt` plus digest
  and verification binding checks, and the injected verified remote read-back.
  `HandoffAdmission.prBindingVerified(binding)` is required before PR issuance
  (absence also refuses at runtime). Requested PR head/base bindings must match the held upstream, contributor,
  branch and default branch. The receipt check reserves a digest once per admission
  instance (concurrent repeats refuse); `HandoffDriver` releases the reservation
  when issuance fails before a durable link and reconciles successfully issued links.
  This factory is shipping/PR-only (`shipping`/`revising` states); gating engagement
  comments require separate contact-permission and authenticated-contributor admission.
  Factory authority callbacks, store and trusted-key references are captured;
  held store validation/directory method identities are also checked across awaits.
  the returned admission is frozen. Changing callback properties after construction
  cannot replace the held authorization. Signing and probe failures have fixed,
  non-echoing refusal codes.
  `HandoffAdmission.commitPr(candidateSha, digest)` is mandatory and rechecks fresh
   authenticated contributor, fork readiness and verified remote SHA, followed by
   run/boundary/policy/verification/receipt admission after PR reconciliation and
   before durable link publication. Reservations commit only after the enclosing
   authority check and atomic replay check; refused final admission rolls back only
   its own reservation. The driver binds admission methods once at construction and
   detaches and recursively freezes the PR request before queueing; admission,
   rendering and persistence use that same snapshot.
  `HandoffAdmission.finalizePr(candidateSha, digest)` is the mandatory synchronous
  publication fence. After asynchronous `commitPr` resolves, it rechecks run,
  boundary, verification, receipt identity and expiry, then the driver records the
  link without yielding. A cancellation/pause in the final promise continuations
  refuses with `admission_commit` and releases the reservation. Missing binding or
  commit callbacks also refuse with `admission_pr_binding` or `admission_commit`.
  Supply `ForkPusher.handoffReadBack`, rather than an ordinary remote read, as
  `remoteBranchSha` so a matching but unverified branch cannot admit a PR.
- `prContentInput(input): PrContentInput` binds model `candidateReady` title/cause/
  scope as untrusted prose, automated regression evidence from the verification
  record, receipt/template policy flags and permitted baseline failures. It
  preserves the upstream template and adds “Verified on base `<sha>`; upstream is
  now at `<sha>`; the merge result was not verified” when the current base differs.

`ShippingBindings` carries controller-held contribution/fork/branch/candidate/
base/parent/session/default-branch/policy/verification-digest facts and the last
verified remote SHA. `ReceiptContextDeps`, `ShippingReceiptDeps`,
`ShippingAuthorizeDeps`, `ShippingHandoffDeps`, `ShippingPrContentDeps` and
`ShippingAuthorization` describe these public dependency and result shapes.
Verification checkpoints point to `artifacts/verification/<candidateSha>.json`.

The controller threat model trusts its own in-process modules and constructed
adapters. External responses/timing, VM/model/repository/policy output, run-store
filesystem contents and concurrent legitimate cancellation/pause/kill-switch
changes remain untrusted. Hostile in-process method substitution is out-of-scope
hardening, not an admission guarantee; captured callbacks are cheap bind-once hygiene.
`loadPinnedVerification(artifactsDescriptorPath, candidateSha, options)` is the
descriptor-rooted immutable loader for callers inside `RunStore.withStoreDirectory`.
The descriptor must remain live for the synchronous call; its private verification
child is pinned independently and the usual canonical-byte/evidence checks apply.
`sameRequiredCommands(commands, expected)` compares required evidence against the
trusted plan by ID and command text without mutating either list.
Offline integration tests use a real local bare-repository push and real durable
nonce/intents/handoff stores, with fake GitHub adapters and no live network.

## Injected run controller core (#1106)

`new RunController(deps)` supplies `start(config)`, `resume(runId)`,
`snapshot(): RunRecord`, and `incidentStop(reason): Promise<RunRecord>`.
Dependencies contain the controller-owned storage `root`, `PhaseSteps`,
`RecoveryHooks`, all `ObservingDriver`s, the VM adapter's `create`/`destroy`/
`listByRun`, `estimateVm(spec, purpose)`, `observeVm(hold, vm)` and a trusted
`now(): Date` clock. This core never constructs a credential broker or upstream
write adapter. There are no scheduled tasks, timers or polling loops.

`PhaseSteps` has `gate`, `acquire`, `plan`, `implement`, `review`, `verify`,
`drift`, `ship`, `resumeHandoff`, and `track`. Each receives a `PhaseContext`:
the locked store, current immutable run, ledger, session ID, an `AbortSignal`,
and reserved `createVm(spec)` (run ID and limits come from the held store).
Allocation capabilities are bound to the current launch, run, abort signal and
phase lease; retaining a callback cannot retarget it to a later phase or run.
Already-admitted allocations are joined before phase completion/stop persistence
and lock release, even if an injected step forgot to await its allocation.
Production wiring must use this allocation path, honor cancellation, and keep
effects journaled/idempotent through the existing drivers. Steps return facts;
they must not persist lifecycle transitions themselves. The controller maps
typed outcomes to `ReasonCode` and uses `transitionRun`; an illegal edge throws,
never silently changes phase. Unknown/malformed results refuse progress with
fixed `ControllerError` diagnostics (no provider/guest error text).
`ControllerError` covers orchestration refusals and normalized injected failures.
Lifecycle, checkpoint, verification-record, configuration and durable-storage
validation can retain their respective fixed typed errors; callers must not
assume every start/resume rejection has the same error class.

Success outcomes are `proceed`, `acquired`, `planned { bindings }`,
`candidate { bindings }`, `approved`, `verified { record }`,
`unchanged` / `advanced { bindings }`, and `submitted`. Gate also accepts
`request_permission`, `terminate`, `ineligible`; shipping accepts
`contributor_handoff`, `fork_missing`, `installation_missing`. Explicit hand-off
resume accepts `waiting`, `invited`, `engagement_observed`, `submitted`,
`resume_gating`, `resume_shipping`, `declined`. Tracking accepts `waiting`,
`awaiting_review`, `accepted`, `merged`, `declined`, `revision`.
All phases accept `hand_off`, `blocked`, `unsupported`, `failed`, `cancelled`.
A gating hand-off stops in gating; other active hand-offs pause. Hand-offs from
an existing durable wait/submission/tracker state preserve that state. Wait outcomes
do not poll. Start stops at any durable wait, user pause, submission, review wait,
accepted/terminal state or cleanup block. Explicit resume invokes the applicable
recovery hook first and then at most one corresponding wait/tracker phase step
if the resulting state still calls for it. Recovery hooks replay/reconcile
existing durable effects; fresh upstream checks belong to phase steps, so wiring
must not perform the same fresh observation in both layers.

After **each** legal transition the core calls `RunStore.persistRun`, then
`observeRun` on **every** registered driver, in order. Recovery snapshots that
contain several transitions are persisted and fanned out individually. One
observer failure does not prevent the others from seeing the fence, but refuses
further progress. The current snapshot is also delivered at open/start. Successful
phase results are journaled under `control/controller/events.jsonl` before applying
their transitions: review/drift completion and checkpoint content survive crashes
without repeating completed effects. Acquisition metadata survives, but its VM
does not: recovered planning/implementation/verification/shipping/revision invokes `acquire`
again with `context.replayingAcquisition=true` after all recovery barriers. This
step must reuse durable sanitized source/artifacts and reconcile write-once effects
while provisioning fresh ephemeral resources needed by that phase. A cached
`acquired` result never establishes that a VM survived recovery.
This applies when a contributor/maintainer observation resumes an active phase
as well as when the stored snapshot was already active.
A step interrupted before it
returns must reconcile its own effects through recovery; a phase-result cache
alone is not a write-once network adapter. Recovered/truncated or invalid
controller journals refuse admission. Checkpoint approval reuses the completed
phase result; no new plan/patch write is required.

Resume order is store open/lifetime lock → budget open and old-hold reconciliation
→ VM reconciliation (`listByRun` plus `teardownVm`) → credential recovery hook
(`broker.recover` in wiring) → intent resume → state-specific hand-off/tracker
resume → next phase. Every item is injected in `RecoveryHooks`; VM reconciliation
also runs directly so an injected wrapper cannot skip actual teardown. Recovery
hooks may return a forward run snapshot to be persisted/fanned out; they do not
admit new execution. They must reconcile and return observations, never create
VMs or introduce new upstream writes. They execute under the run lock. Unknown
old budget holds use `settle(id, null)`, retain their entire reservation, and fence
new work. Credentials and write reconciliation still precede phase admission.
An initial observer refusal cannot suppress VM or credential recovery, or incident
revocation: these obligations are attempted under the run lock before the error
is reported, and no phase is admitted. Explicit invalid phase output similarly
aborts, tears down and persists a policy/cleanup block before releasing the lock;
a thrown next-step crash remains a recoverable interruption rather than a pass.

Start initializes the ledger and starts `<runId>-s1` with the persisted ceiling,
protected cleanup allowance, token limit and active-minutes limit. Resume never
resets a session or spend. VM allocation reserves an injected priced estimate
**before** create; `observeVm` returns an actual observation or null (unknown).
Teardown reserves with purpose `teardown` under the [budget admission ledger](#budget-admission-ledger)
rules below. If cleanup cannot reserve, it still destroys guests and records a
durable unfunded-cleanup barrier. Every reopen refuses new work until the optional
`RecoveryHooks.reconcileCleanup(vmId, context)` returns bounded, secret-free
accounting/no-charge evidence; null or an absent hook retains the barrier.
Wiring reconciles actual charges in the ledger before returning that evidence.
Accounting or observer failures are collected while every remaining guest is
attempted, then reported after teardown. Financial denial never leaves execution
running. Active elapsed time is derived
from `assembleStatus` history and checked before every new step; replaying a
completed phase result does not repeat its effect. Reaching a work ceiling pauses
without scheduling anything.

The three configured checkpoints use `checkpointDue` / `pauseAtCheckpoint`:
plan before approval, patch before review/verification, verification before drift
and shipping. Steps write their private artifacts and return controller-held
bindings; verification records are reloaded from
`artifacts/verification/<candidateSha>.json` with run/digest/boundary/log validation,
bound to the current candidate, then passed to `applyVerification`. A boundary
failure blocks regardless of verdict; the existing two-repair cap applies.
An `advanced` drift result supplies the new candidate's bindings and requires
fresh verification. Shipping still owns receipt issuance/authorization and
contributor-confirmed publication through its injected drivers.
Bindings are always validated before journaling, independently of checkpoint
selection. `planned` requires `policyDigest`, the current `budgetSessionId` and
`planDigest`; `candidate`/`advanced` require policy/session plus `candidateSha`.
Digests and fields use the existing point-specific checkpoint validators;
unknown fields and a different session are refused. `verified` must return the
complete record with its digest, equal to the canonical reloaded record.

Every hand-off/terminal stop destroys all run VMs with the shared three-attempt
`teardownVm`. Terminal rows have no `CleanupFailed` edge, so cleanup completes
before committing a new terminal transition; a failure instead persists
`blocked_cleanup`, fans out the fence and denies later execution/publication.
Other durable waits are persisted before teardown. Remaining VMs are attempted
even after one fails. Reconciliation of an already terminal/cleanup-blocked run
retains its existing lifecycle history and records the cleanup result rather
than inventing an illegal edge. This uses `teardownVm`'s explicit
`reconcileStopped: true` option; ordinary callers still throw on an illegal
`CleanupFailed` edge. Reconciliation never reopens execution.

`incidentStop` durably records the bounded, secret-free reason, closes admission,
aborts the current step, calls `killAll`, joins the active operation, tears down,
then records cancellation or cleanup block. An already completed publication
remains in history even when cancellation races its return. The incident journal
fences subsequent resumes, including after a crash. `snapshot` is available after
completion/error; start/resume own and release their handles, reject concurrent
entry, and do not hold idle locks at durable stops. Scripted test steps and hooks
live in `src/controller/__tests__/fake-steps.ts`.
`resume(runId)` recovers but does not itself authorize leaving `paused_user`.
Approve/reject a configured checkpoint's exact open record before resuming.
For a non-checkpoint pause, trusted orchestration first reconciles the stopping
condition and persists or supplies a legal continuation to the interrupted phase
(for example via `resumeIntents`). There is no general unpause or replacement
budget-session method in this core.

## Local outcome metrics (#1103)

`contributionOutcome(store, now?)` reads the locked `RunStore` history, the existing
`budget/ledger.json` through `BudgetLedger.readOnlySnapshot()` / `budgetTotals`, and the
hand-off/tracker journals through their existing replay APIs. The controller's
local replay adapter never constructs a network driver or model adapter. Metrics
imports neither `src/github/` nor `src/model/`; no reporting call contacts a service
or initializes/repairs a missing or truncated journal. Missing, corrupt, recovered
or wrong-identity hand-off/tracker evidence yields field-specific `unknown` values,
never zero or an inferred success. Reporting does not repair control evidence.
`unknownEvidence` retains only fixed source
and reason codes, never raw errors or journal contents. A tracker prefix may lag
external execution but cannot omit a tracker-owned transition in durable history.
Submission comes from the durable publication transition, not acceptance. Only a
tracker-observed outcome with its recorded SHA counts as merged/declined. This includes
a structurally recorded `observedMergeSha` when upstream merges during revision:
the tracker remains execution-blocked, while metrics count the observed merge. Legacy
revision blocks without that SHA remain unknown, never inferred from reason text. Revisions
count tracker-recorded revision requests, including the currently active revision.
Gate passage is eligible; a pre-passage policy block is ineligible; a gating
permission/contributor wait is hand-off; an undecided gate is unknown.

The result includes contribution/contributor/upstream/issue identity, gate,
submission/PR URL/outcome/revisions, `activeMs`, four `waitMs` families (maintainer,
contributor, review, paused), per-currency cost and an optional voluntary adoption
note. `identity: 'known' | 'unknown'` distinguishes availability from the identity
text (the login `unknown` remains a valid known contributor). Active states are
gating/planning/implementing/verifying/shipping/revising; status and metrics share
one lifecycle interval calculator.
Submitted, awaiting-review and accepted intervals are review wait. Terminal time
is neither active nor wait. `now` defaults to the last durable transition; pass a
canonical UTC timestamp or Date to include the current interval.

Cost is in accounting-currency minor units after recorded ledger FX; currencies
are never combined. Estimated amounts include non-released reservations;
provider observations stay separate, and unobserved spend is unknown. Model/VM
components each expose estimated and observed amounts. Token/model-resource rates
identify model rows; `vm_increment` identifies VM rows. Mixed or unattributable
reservations yield unknown components rather than an invented allocation.

`aggregate(outcomes)` accepts one result per distinct contribution (duplicates
are refused). It returns eligible→submitted, accepted (including merged), merged,
declined and rework-per-submitted rates with numerator, denominator, unknown count
and value; empty/uncertain denominators give unknown values. Eligible→submitted is
submitted eligible contributions / eligible contributions. Accepted/merged/declined
use submitted contributions as denominator; accepted includes merged. Rework is
total revision requests / submitted contributions, and can exceed one.
It also returns median
active time, per-currency average cost per submitted/accepted contribution and
case-insensitive contributions-per-contributor (`repeatUsage`). Unknown evidence
is retained rather than silently dropped from statistical results. A known absent
currency contributes zero to that currency's average across the selected cohort.

`recordAdoption(store, note, now)` records only explicitly supplied voluntary text
in private `artifacts/adoption.json` (atomic replacement). `ADOPTION_MAX_LENGTH`
is 2,000 UTF-16 code units; empty, malformed or secret-shaped notes are refused.
A missing note is omitted; a corrupt note is unknown. Reporting never infers
adoption. `renderMetricsHuman` / `renderMetricsJson` contain identical facts;
human values are JSON-quoted to prevent line spoofing. Both renderers and aggregation
validate public facts, refuse extra keys and invalid numeric values, and preserve
the same facts in both formats. Per-contribution reports retain fixed source/reason
diagnostics; aggregates retain uncertainty counts and unknown statistics, not source
diagnostics. Only `contributionOutcome(store, now?)` rereads durable evidence; regenerate
outcomes before aggregation or rendering when fresh facts are needed. Aggregation and
renderers validate the supplied snapshots, not storage. Derivation validates the current
strict config and its digest as well as the complete durable control journal and snapshot
against the cached run under the held fence using `RunStore.validateEvidence()`;
missing, corrupt, recovered or mismatched evidence cannot yield cached success.
Evidence JSON is decoded with fatal UTF-8 validation. Budget reporting uses
`BudgetLedger.readOnlySnapshot(file, contributionId)` through the pinned directory
without resolving it back to a mutable pathname. RunStore's synchronous `withStoreDirectory(name,
callback)` pins a private child directory under its held descriptor/fence and closes
it after the callback; Promise-like returns are refused by types and thenables
are refused at runtime. Descriptor paths must never escape that callback. Adoption
reads/writes refuse symlink directory replacement. `RunStore.replaceArtifact(name, bytes)`
publishes a basename atomically under the held descriptor and retains the lifetime fence
on uncertain persistence; reporting and subsequent writes then refuse until process-death
reconciliation. Native async callbacks are rejected before invocation; returned thenables
are refused and their rejections consumed. Snapshot validation refuses accessor properties
and non-plain containers before copying; snapshot failures expose only fixed errors.
`RunStore.validateConfigEvidence()` checks fresh strict config/digest against the cached
configuration without writes or reopening the signing key. `RunStore.validateOutcomeEvidence()`
returns one freshly validated `{ config, run }` pair with fixed source/reason errors;
`validateEvidence()` retains its fixed RunStore error boundary. Execution admission still
requires the signing key. `validateStoredRunConfig(raw)` performs only schema/semantic
validation; `validateRunConfig(raw)` also checks execution signing readiness. The combined
evidence API throws `RunEvidenceError` with `source: 'run' | 'config'` and one fixed
`code: 'missing' | 'corrupt' | 'incomplete' | 'recovered'`, never raw evidence or causes.
Closed/poisoned handle checks in `validateConfigEvidence()` and `validateOutcomeEvidence()`
retain `RunStoreError('store_closed' | 'persistence_uncertain')`; `validateEvidence()`
translates all refusals to `RunStoreError('invalid_store')`.
Budget reporting acquires the existing transaction guard read-only
and refuses an unresolved owner, never initializing or reclaiming it; uncertain publication
yields unknown costs until ledger reconciliation. `parseJournalEvents(bytes)` is
the shared pure complete-JSONL decoder, including strict UTF-8 validation; it never
opens or repairs storage. These APIs do not add CLI
commands or external telemetry.

## Upstream drift before shipping (#1107)

`checkBase(read, upstream, verifiedBaseSha)` uses credential-free `resolveBase` and
returns `{ kind: 'unchanged' }`, `{ kind: 'advanced', newSha }` or `{ kind: 'unknown' }`.
The upstream includes `owner`, `repo`, `defaultBranch`; unreadable/malformed facts
never admit shipping and errors are not echoed.

`WorkspaceOverlay.manifest()` returns a validated immutable source snapshot without
filesystem or VM reads. `WorkspaceOverlay.writtenEntries()` exposes a frozen, byte-sorted admitted delta,
including byte-identical writes. `rebaseCandidate({ overlay, oldBaseManifest,
newBase: { pack, manifest }, approval })` validates both manifests and binds the
new manifest to the pack's `approval.baseSha`. `approval` is `CommitInputs` with
the unchanged contributor-approved author/message, new parent and new recorded
committer timestamp. Every touched path compares old/new blob hashes **and modes**;
upstream additions, deletions and ancestor file collisions refuse with
`{ kind: 'conflict', paths }`. No text merging occurs. A success returns
`{ kind: 'rebased', candidate, manifest, overlay }`, preserving unrelated upstream
files and admitted writes; the returned overlay is based on the new source.
Canonical collisions/invalid input throw fixed `CanonicalError` codes.

`checkShippingBase(deps, input)` is the orchestration API for both initial shipping
and before `shipRevision`. Dependencies are `read`, `upstream`, `acquire(baseSha)`
(production: `acquireSource`), and controller `now(): Date`. Input holds the restored
`run`, cumulative admitted `overlay`, current candidate's recorded `CommitInputs` as `approval`,
`basePack` for that current verified upstream parent, persisted session-wide
`rebases` count (0–2), and boolean `pushIntentJournaled` for **this candidate**.
Only a `shipping` run before any push intent can return `unchanged` admission.
An advance constructs a new candidate, returns the run transitioned through
`BaseAdvanced` (`base_advanced`) to `verifying`, and increments `rebases`.
The new SHA/record binding invalidates the old VerificationRecord and receipt;
the caller must independently verify the new candidate, with new evidence and
authorization, never reusing the old SHA's verification.
Unchanged reads do not reset the counter; a third advance hands off `base_unstable`.
Conflicts hand off `rebase_conflict`; unknown reads defer pushing via
`base_unknown`; failed acquisition/reconstruction/clock validation hands off
`rebase_unavailable`, without a candidate or weaker fallback.

Only `shipping` and `awaiting_contributor` are accepted; other phases reject.
In `awaiting_contributor` regardless of intent status, and in `shipping` after
the candidate's push intent is journaled (even if execution failed or is uncertain),
every check returns only `recorded`:
unchanged `run`, and `observation: { verifiedBase, currentBase, limitation }`.
`currentBase` is null on unknown reads. The limitation names both known SHAs and
never claims verification of the current merge result; feed it to PR limitations.
No observation authorizes a new push or re-verification. The composition root
owns the run fence and must serialize this check with intent publication, persist
the new candidate/overlay/run/counter before verification, and persist observations
before rendering PR context. After each rebase use `result.candidate.record` as
the next check's `approval`, alongside the returned overlay/run/counter; only the
approved author/message remain unchanged. Inputs are detached before the base-read
await, so caller mutation cannot erase an already observed intent fence or alter
the candidate being checked. A new committer timestamp must advance at whole-second
precision or reconstruction hands off. Later submitted/review-phase observations
use `checkBase` with caller-owned recording rather than `checkShippingBase`.
Counts are session-wide across resumes and checks;
only an explicitly allocated new budget session gets a fresh allowance.
These APIs do not construct receipts, access credentials, publish, or poll.

The overlay must retain the **upstream** baseline and all admitted writes across
repairs. Before shipping, call `cumulativeOverlay.applyRepair(repairOverlay)` for
each repair returned from implementation: it requires the repair's workspace base
to equal the cumulative candidate manifest, then atomically composes repair writes
while retaining inherited and byte-identical touched paths. Wrong baselines refuse
with `tree_mismatch`. `checkShippingBase` binds the cumulative baseline to
`basePack` at the current approval parent before any read; passing an uncomposed
repair workspace fails closed rather than silently dropping the original fix.
After rebase, use the acquired new-parent pack (or the returned candidate pack,
which contains that parent) as `basePack` for the next check. Unknown/read/rebase
hand-offs apply only to pre-intent `shipping`; unknown contributor-wait observations
carry `currentBase: null`.
`snapshot()` detaches an overlay by copying its maps and sharing only frozen entries.
`onBase(baseManifest)` replays the held delta in bulk after the drift conflict check;
it does not itself decide conflicts. Rebase and repair composition validate the
combined manifest once per operation rather than rehashing the entire source once
per written file. Both preserve modes and touched paths and refuse canonical collisions.

## Independent verifier (#1102)

`verifyCandidate(deps, input)` (PRD §5.6 steps 6 to 8, §5.7, §5.9; scenarios 6, 7, 10
and 17) verifies one exact candidate commit in a **fresh** VM and persists a
controller-owned `VerificationRecord`. It signs nothing and imports nothing from
`src/github/`: receipts bind the fork repository ID and expire 15 minutes after
issuance, so shipping turns the record into a receipt just in time (#1105), through
`assertShippableVerification(record)`.

`deps` (`VerifierDeps`) holds the `VmAdapter`, `runId`, `limits`, the run's trusted
`profileRecord`, `proxyTarget`, `endpoints`, optional `planOptions`, the run store's
private `artifactsDir` (`RunStore.storeDirectory('artifacts')`), the `RunLifecycle` (the
run must be in `verifying` and carry the same `runId`; events go to its `journal`) and
an optional `boundaryTimeoutMs`. `input` (`VerifyInput`) holds the authorized
`candidateSha`, the controller's sanitized `manifest`, the persisted `CandidateRecord`,
the controller-owned `CandidateAuthority`, the base pack, the `regressionTargets` and
`regressionBase`, the regression targets' status on the base plus only the test files
(`regressionEvidence().base.status`, #1095).

Order of work, each step fail-closed:

1. Refused before anything runs, in this order: a run that is not `verifying`
   (`VerifierInputError` `run_not_verifying`), another run ID (`run_mismatch`), a
   `candidateSha` that is not 40 lowercase hex (`invalid_candidate`), a regression not
   reproduced on the base (`regression_not_reproduced`; only `failed` proves it), then
   the plan (`EvidencePlanError` `no_regression_targets` or `no_test_command`).
2. Records are write-once and a candidate is verified at most once
   (`verificationState`). A record that already exists for this run is **replayed**: it
   is loaded with `loadVerification` and its transition re-applied, with no VM
   (`{ kind: 'verified', replayed: true }`; a crash came after the record and before the
   run state was saved). A record that no longer loads, or a started attempt that left
   no record (its `.attempt` marker), gives `{ kind: 'interrupted', reason }` and moves
   the run to `blocked`: an interrupted verification is never silently re-run.
3. The manifest is validated once into a frozen copy, and `reconstructCandidate`
   rebuilds the commit from it. A `CanonicalError`, or a rebuilt SHA other than
   `candidateSha`, returns `{ kind: 'identity_mismatch', reason }` and moves the run to
   `blocked` (`policy_blocked`), before `prepareBoundary` and before any VM is created.
4. `beginVerification` claims the candidate (an exclusive marker; a concurrent claim is
   `already_verified`). `prepareBoundary(artifactsDir)`, then `runWorkspace` (#1095)
   creates a new VM and uploads exactly the files of that validated, reconstructed
   manifest. The implementation VM is never reused. `verificationPlan(profileRecord,
   endpoints, regressionTargets, planOptions?)` runs the suite's verification commands,
   then the regression targets' test command (id suffix `REGRESSION_COMMAND_SUFFIX`,
   `-regression`), all with `network: 'none'`. While the VM is still live,
   `probeBoundary` (a probe that throws leaves failed evidence in its closed session)
   and `await finishBoundary` with the same output collector; then the bounded teardown
   and `session.cleanup()`. From the claim on, any failure that has not already moved
   the run (`ProvisioningFailedError` to `unsupported`, `VmCleanupError` to
   `blocked_cleanup`) blocks it before the error propagates, and is journaled
   (`verification_aborted`, error class only).
5. If `finishBoundary` throws (secret-shaped guest output, collector truncation, an
   unpublishable artifact), its artifact cannot be read back, or the canaries cannot be
   removed, nothing authoritative exists: no record, the run goes to `blocked` and the
   outcome is `{ kind: 'boundary_unavailable', reason }` (`finalize_failed`,
   `artifact_unreadable`, `cleanup_failed`). The boundary artifact is read once; its
   digest and its verdict come from the same bytes.
6. `verificationVerdict(records, regression, commands)` is `passed` only when every
   verification command passed (`workspaceStatus`) and `receiptGrade(regression,
   commands)` holds: the regression proof (`classifyRegression(regressionBase, …)`) is
   `reproduced_and_fixed`, a passed regression command and a required suite command show
   it, and the evidence is receipt-grade (`evidenceVerified`). A failing command is
   `failed`; a timeout, a signal, an unreadable report, zero suites or a failed setup
   step is `inconclusive`, never a pass. The boundary is held only when
   `isCleanHeldVerdict(runBoundaryVerdict([input], runId))`.
7. The record is persisted (`verification_completed` is journaled), then the run moves:
   a boundary that did not hold goes to `blocked` whatever the verdict (no receipt may
   ever be issued for it; `assertShippableVerification` and `authorizeShipping` refuse
   it); otherwise `applyVerification` gives `shipping` on a pass, `implementing` while
   fewer than two repairs were used and `failed` after that (`assertRepairAllowed` then
   refuses another repair). The outcome is `{ kind: 'verified', verdict, record, run,
   replayed: false }`.

`VerificationRecord` (`src/controller/verification-record.ts`,
`VERIFICATION_RECORD_SCHEMA`, version `VERIFICATION_RECORD_VERSION`,
`ztfc-verification-v1`) is written once, mode 0600, as canonical JSON plus a final
newline at `artifacts/<VERIFICATION_DIRECTORY>/<candidateSha>.json` (`verification`):
`runId`, `candidateSha`, `baseSha`, `parentSha` (equal), `profileDigest` and `profile`
(`profileReceiptBinding(record, vm.accelerator)`), `networkPolicy` (`provisioning:
package_proxy`, `verification: none`), `commands` (receipt `CommandEvidence` for each
report-classified command, validated by the receipt's shared `COMMANDS_SCHEMA`),
`regression`, `verdict`, `boundaryHeld`, `boundaryInputRef` (`{ artifact, digest }`: the
boundary artifact's basename in the same directory and the SHA-256 of its bytes),
`logsDigests` (every command log in the VM, provisioning included), `verifiedAt` and
`recordDigest` (SHA-256 of the canonical JSON of every other field).
`publishVerification(artifactsDir, input)` returns the frozen record and throws
`invalid_record` for a record the schema or consistency rules refuse, `record_exists`
when one is already there (it is created by hard link, so not even a concurrent writer
replaces it; `createPrivateOnce` in `durable-fs`) and `unavailable` on a storage
failure.

`loadVerification(artifactsDir, candidateSha, { runId, expectedDigest? })` reads with
no-follow, single-link, private-mode checks under real (non-symlink) directories and
strict UTF-8, at most 1 MiB, and requires the exact canonical bytes (whitespace edits
and duplicate keys fail), the strict schema (unknown or missing fields fail), its own
digest, `parentSha` equal to `baseSha`, unique command ids, every command's log digest
among `logsDigests`, a `reproduced_and_fixed` claim backed by a passed regression
command, a `passed` verdict only with `receiptGrade`, the requested candidate and run,
the controller-held `expectedDigest` when given, the boundary artifact byte-identical to
its reference with a recomputed held verdict equal to `boundaryHeld`, and a persisted log
artifact (`logArtifactName(digest, truncated)`) for every log digest whose own digest and
truncation flag agree. Any deviation throws `VerificationRecordError` with a fixed code:
`unavailable` (the record cannot be read), `invalid_record` (bytes, schema or
consistency) or `evidence_mismatch` (candidate, run, digest, boundary or log artifacts).
`assertShippableVerification(record)` throws `not_shippable` unless the verdict is
`passed` and the boundary held.

`runWorkspace(options, manifest, plan, beforeRelease?)`, `regressionPlan`,
`assertHasTestCommand` and `logArtifactName` are the evidence runner's (#1095) shared
pieces the verifier reuses; `SCHEMA_TYPES`, `strictObject`, `PROFILE_SCHEMA` and
`COMMANDS_SCHEMA` are the receipt schema's.

## Admitted planning and implementation loop (#1101)

`runPlanning(ctx)` and `runImplementation(ctx, { plan, repairOf? })` drive the same
provider-neutral controller loop. `AgentLoopContext` supplies `adapter: VmAdapter`,
the exact live `vm: VmHandle` returned by `provisionWorkspace`, `model: ModelAdapter`,
`ledger: BudgetLedger`, `sessionId`, pinned `rates: BudgetRate[]`, `limits` with
`commandTimeoutMs` and `activeMinutes`, `binding: AuthorityBinding`, `issue: { title,
body }`, `baseManifest: SourceManifest`, `collector: OutputCollector`, `now: () =>
Date`, and an awaited controller-owned `persist(entry: string)` transcript sink.
`maxTurns?` is a trusted caller override. Optional `activeTime: ActiveTimeBudget`
provides explicit run-wide active accounting. `cleanupTimeoutMs?` bounds supervisory
deadline teardown (default `DEFAULT_LOOP_CLEANUP_TIMEOUT_MS = 5000`); timeout does
not claim guest quiescence. The loop calls `meteredComplete` internally:
pass the selected model adapter, with no worker-held model credentials or gateway.

Planning returns `AgentPlan` (`{ kind: 'plan', text, digest }`, SHA-256 of exact UTF-8
text). Implementation revalidates that plan and returns `{ kind: 'candidate',
overlay: WorkspaceOverlay, meta: CandidateMetadata }`. Either phase can return
`{ kind: 'hand_off', reason }`, `{ kind: 'budget_exhausted', reason: 'budget' |
'active_time' }`, or `{ kind: 'turns_exhausted' }`. Defaults are
`DEFAULT_PLANNING_TURNS = 15` and `DEFAULT_IMPLEMENTATION_TURNS = 60`. Each model
response counts one turn and must contain exactly one `propose_action` tool call;
text-only, malformed, empty or multiple-call answers hand off as
`model_invalid_response`. No model-specific branches or weaker adapter fallback exist.

`admitModelAction` adds `submit_plan { text }` (UTF-8 `MAX_PLAN_BYTES = 8192`) and
`candidate_ready { title, cause, scope, limitations }` (title ≤256 UTF-16 code units,
cause/scope ≤`MAX_CANDIDATE_TEXT_BYTES = 4096` UTF-8 bytes each, ≤10 limitations of ≤500 units).
Both reject extra fields, malformed values and credential patterns. Candidate
metadata is untrusted prose, not verification evidence; `buildPrContent` bounds it
again with independently verified receipt facts. Publication is controller-driven:
`request_publication` is an `unexpected_action` in both phases. Planning also
refuses writes/candidate declarations, and implementation refuses plan submission.
Authority rejection codes are returned to the model; five consecutive rejections
give `hand_off/model_noncompliant`, while a successfully executed admitted action
resets the streak. An operational failure never silently retries.

Each model call reserves through the real ledger before invoking the provider.
A denial gives `budget_exhausted/budget` without another call. The active wall-clock
ceiling is shared across planning, implementation and repairs. By default a
process-local account is keyed by ledger object and session ID. An explicit
`new ActiveTimeBudget(elapsedMs = 0)` account can be retained across fresh ledger/VM
instances and seeded from persisted run state on resume; persist its `elapsedMs`
after each phase. Only time inside loops is charged; idle hand-off time is excluded.
Accounts reject concurrent entry (`session_busy`), and the loop holds an exclusive
workspace lease. The caller retains the ledger and active account across repairs.
Re-entry on the same live VM retains its controller-held overlay, so previously
admitted writes do not disappear when a turn/budget stop is resumed. Its original
baseline digest must still match; a new baseline requires fresh provisioning.
The ceiling is checked before every turn/worker operation and bounds asynchronous
transcript writes too. Non-finite or backward clocks refuse progress. Model
calls are capped at 60 seconds or the remaining active time, whichever is smaller;
worker commands use `network: 'none'`, the admitted profile, an empty environment,
and at most `limits.commandTimeoutMs` or the remaining active time. Controller-only
`ExecRequest.wallTimeoutMs` caps the guest timeout after TCG scaling; the loop also
supervises the entire exec/put RPC, including queue and broker grace. Expiry
invalidates provisioning proof and awaits VM destruction to quiesce work. Active
expiry is `budget_exhausted/active_time`; a shorter command ceiling is
`hand_off/command_timeout`. Failed deadline teardown is `hand_off/cleanup_failed`,
and caller-owned cleanup must retry/persist the blocked lifecycle. Insufficient
time for the broker's one-second minimum stops with `active_time`. Model-profile
values and process environment variables are never forwarded into exec.

`assertProvisionedVm(adapter, vm)` refuses handles not produced by that adapter's
completed provisioning or released with `releaseWorkspace`; the loop calls it
before every model or worker operation, after awaited boundaries and before
successful terminal returns; it never creates a VM. `leaseProvisionedVm` acquires
exclusive loop ownership and returns its release function; evidence execution
refuses a leased handle. `releaseWorkspace` invalidates proof immediately so a
pending loop cannot continue after teardown. `abortProvisionedVm` invalidates
proof and awaits destruction on a supervisory worker deadline. The caller owns
teardown/retries at every stop/checkpoint.
The supported local-QEMU and fake adapters invalidate the shared lifecycle proof
before direct destruction begins, and `finishBoundary` does so before quiescence
for every adapter. A boundary-finalized VM cannot be reused by the model loop.
Provisioned-handle proof is process-local;
resume provisions a fresh workspace. `repairOf` is appended only as untrusted
failure-summary data. The caller must first enforce `assertRepairAllowed` and
provide the failed candidate as `baseManifest` in a freshly provisioned workspace.

`AGENT_SYSTEM`, `agentTools(phase: AgentPhase)` and `untrustedFrame(label, data)`
provide controller-authored prompts/schemas and JSON-framed untrusted issue, plan,
repair and worker-output data. Prompts require a minimal fix, regression coverage,
no stash, formatting/dependency churn or promotional artifacts; deterministic
admission is authoritative. Exec stdout/stderr go in full to `OutputCollector`
for boundary evaluation; only a UTF-8-safe combined tail of at most
`MAX_WORKER_REPLY_BYTES = 16384` is returned to the model, inside an explicit
untrusted frame with observed exit/timeout facts. Entire outputs are scanned before
excerpting, and secret-shaped output becomes `[redacted]`; raw collected evidence
is retained for boundary checks. Broker truncation or collector overflow hands
off as `output_truncated` rather than allowing partial evidence to pass.
`OutputCollector.markIncomplete()` permanently records broker-side capture loss
even below the collector's own cap, so boundary consumption refuses partial scans.
Truncation, malformed results and uncertain exec failures fence workspace reuse;
uncertain exec failures use bounded quiescence before returning, with
`cleanup_failed` when it cannot be established. A refused concurrent contender
does not acquire transcript or lifecycle authority and cannot invalidate its owner.

Transcript events include start data, detached model responses, admitted actions,
rejections, action replies and terminal stop events with controller-defined stage,
turn and stop outcome.
Successful plan/candidate persistence writes only a tentative `checkpoint` and
revalidates liveness before returning. **No transcript entry establishes success
authority**; the returned proposal and later verification/controller state own
that decision. Success-checkpoint persistence is bounded by remaining active time
and checked again before returning; the separate durability allowance applies only
to stop recording. Failed outcomes write `stop` events. A timed-out arbitrary sink
may append late, so entries carry a controller-assigned monotonic `sequence`;
read them in logical sequence order, never infer a verdict from the physical tail.
Persistence failure/timeout permanently invalidates workspace reuse, including
after a delayed append resolves. The lease/account remain held through terminal persistence.
Stop persistence has a separate
`TERMINAL_TRANSCRIPT_TIMEOUT_MS = 1000` durability allowance after active expiry;
a failed sink is not recursively asked to report itself.
Terminal persistence failure preserves an already-stopped outcome, but cannot
turn a candidate/plan into success. Diagnostic codes are controller-defined
(`broker_failure`, `provider_failure`, `controller_failure`), never exception text.
Every entry is scanned with `assertNoSecrets`
(including nested primitive strings); a secret-shaped entry is stored as literal
`[redacted]`. Secret proposals are rejected and omitted from subsequent requests.
Secret-bearing initial issue/repair data is recorded redacted and refuses the loop
before a provider call. A throwing/rejecting transcript sink gives
`hand_off/persistence_failed`, without further effects; a stalled sink is bounded
by remaining active time and late completion cannot resume the loop. Active-limited
model timeouts give `budget_exhausted/active_time`, while provider timeouts with
active allowance remaining retain `hand_off/model_timeout`. Non-model unexpected
failures return fixed `loop_failed`; provider failures retain only their bounded
`ModelError.code`. Provider/worker exception text never enters the result or sink.

### Controller-held source overlay

`new WorkspaceOverlay(baseManifest)` revalidates and freezes the exact baseline.
`write(path, content)` uses the shared `admitWorkspaceWrite(path, content)` authority
validator, including filename/content secret scans, bounded UTF-8 contents after
`assertWorkspacePath` and canonical combined-manifest validation. Rewrites replace
only that path; existing executable modes are preserved and new files are
non-executable. `executable(path)` reports the held mode for VM mirroring.
`testFiles()` returns byte-sorted written paths matching the shared
`isTestPath(path)` scope-review rules: `test/`, `tests/`, `__tests__/`, `*.test.*`,
`*.spec.*`, `test_*.py`, `*_test.py`. It does not include untouched baseline tests.
File/directory, case/Unicode collisions, canonical Git paths and source-size
limits are rejected before changing the overlay.

Each admitted loop write updates this overlay and mirrors those exact bytes with
`putFile` so later commands can see them. The loop never calls `getFile` to build
a candidate. Failed/uncertain mirroring invalidates workspace reuse; admitted
bytes remain privately recorded for controller recovery, requiring fresh provisioning.
An adapter-reported timeout is also an inconclusive stop with no further model
call; ambiguous null exits stop as `worker_inconclusive` and fence reuse.
Direct overlay/authority writes permit at most 1 MiB
of content, but the OpenAI-compatible model transport caps the **entire serialized
tool argument at 64 KiB**, including JSON envelope and escaping. Complete-file
rewrites exceeding that smaller transport bound give `model_invalid_response`;
they cannot be delivered through that transport. The larger overlay limit does
not widen transport admission. `overlay.materialize(directory)` requires an absent directory under
a controller-owned parent, creates it privately (0700), writes only base plus
overlay files (0600, or 0700 for executables), then returns `exportSource`'s
candidate manifest and checks its digest against the held source. Existing trees
and symlinks are refused; callers retain/remove their own private materialization
directories, including partial ones after I/O failure. Binary baseline blobs and
empty directories are preserved. Bytes created, deleted or changed by repository
processes in the VM never enter the candidate. **File deletion and executable-mode
changes are unsupported in MVP**; shell-produced generated files are not adopted.
A candidate still requires canonical reconstruction, fresh regression/full-suite
verification, scope review, boundary evidence and receipt admission before shipping.

## Durable user checkpoints (#1100)

`checkpointDue(config.checkpoints, point)` tests the user-selected subset; the
persisted RunStore config is authoritative, defaulting to `[]`. Repository and
model text never configure checkpoints. `pauseAtCheckpoint(store, run, point,
bindings, now)` returns the persisted run. Call it at `plan` in planning after
writing `artifacts/plan.txt` and before `PlanApproved`; `patch` in verifying after
`CandidateReady` and before verification, with `artifacts/candidate.diff`; and
`verification` in shipping after `VerificationPassed` and before any push intent,
with `artifacts/verification/<candidateSha>.json`; `verificationDigest` binds that
immutable per-candidate record. Paths are relative to the run store. The
controller owns these artifact names and writes the content before invoking the
checkpoint API. Engagement and publication always remain contributor hand-offs.

Bindings require canonical lowercase SHA-256 `policyDigest` and a run-owned
`budgetSessionId` (`<runId>-s<positive-safe-integer>`). Plan also requires
`planDigest`; patch requires a full lowercase Git `candidateSha` (SHA-1 or SHA-256);
verification requires `candidateSha` and SHA-256 `verificationDigest`. Other
point-specific fields and unknown keys are refused. The immutable `CheckpointRecord`
binds those facts, run identity, interrupted phase/history length and creation time
in its SHA-256 digest. It has `status: open | approved | rejected`, plus `resolvedAt`
and, on rejection, `rejectionReason`. Records live in the private, lifetime-guarded
RunStore control journal; `store.checkpoint(point)` reads the restored record.
The record is fsynced **before** `UserPaused`; reopening between these steps finds
the record and the pre-pause run. Retrying the pause reuses that exact record.
Each point pauses once per run; approval does not cause a second pause.

`approveCheckpoint(store, run, { point, digest }, now)` requires the exact open
record and resumes only its interrupted phase (`ResumePlanning`, `ResumeVerifying`
or `ResumeShipping`). The controller must call
`store.recordCheckpointBindings(point, bindings)` after every plan, candidate,
verification, policy or budget-session change, before any approval attempt. These
current bindings are durable and compared with the paused record: changed content
refuses the old approval with `checkpoint_stale`. A mismatch also gives
`checkpoint_stale`; repeat approval gives `checkpoint_closed`; an unrelated pause
or non-paused run gives `checkpoint_not_open`. Malformed inputs give
`checkpoint_invalid`, including uncloneable input, invalid dates and malformed
digest strings. Secret-bearing input retains the non-echoing `SecretRedactionError`.
Diagnostics never echo supplied data. Generic `persistRun` and journal replay
cannot bypass an open checkpoint boundary or resume its pause; approval must use
the checkpoint resolution event. Ordinary failure/cancellation remains permitted.

`rejectCheckpoint(store, run, { point, digest }, reason, now)` validates the exact
open record and paused phase, even if current content is stale, records a nonempty
secret-free reason (at most 500 characters), and
applies `UserCancelled`. Decision and lifecycle continuation are one journal event;
the existing snapshot-confirmation recovery completes publication after a crash,
so approval cannot become reusable between the decision and snapshot steps.
Store persistence failures retain the existing process-lifetime fence.

`checkpointStatus(record, currentBindings?)` returns `{ nextPermittedAction }`, naming the point,
the relevant plan/diff/verification artifact and candidate where applicable, and
the exact placeholder command `<zt-run> approve --run <runId> --point <point>
--digest <digest>`. Closed records instead state that no further approval is
permitted. Pass `store.currentCheckpointBindings(record.point)` for live status:
stale content instead shows the exact reject placeholder and permits cancellation,
never approval. Without current bindings, status describes the recorded content
only; the approval API always checks durable freshness. Both record validation
and status enforce the package's secret guard.
These are local infrastructure APIs for controller/CLI integration; they perform
no network, model, VM, upstream publication or receipt authorization operations.

## Community gate and explicit-resume invitation (#1098)

`decideGate(policy: PolicyAssessment, eligibility: Eligibility, contributor)` is
a synchronous effect-free composition. `GATE_ROWS` is its ordered decision table:
cited AI ban → `terminate` (`PolicyBlocked`); ineligible → `ineligible`
(`PolicyBlocked`); refused/unknown policy or eligibility, competing work, unclear
AI, or both unclear assignment and direct-PR policy → `hand_off`; AI approval,
unfulfilled required assignment, or discussion-first → `request_permission`
(`PermissionRequired`); otherwise → `proceed`. Contributor identity and assignment
compare case-insensitively. Missing ban evidence hands off. Required snapshot
fields and reason enums are validated; explicit competing-work reasons or open PR
facts cannot be erased by an inconsistent `eligible` discriminant. `bug_unlabeled`
remains advisory. These are suggestions,
not transitions. No ceremonial engagement is made on proceed; only the controller
may invoke `HandoffDriver.issueEngagement` after a permission decision. Its existing
marker reconciliation and journal ensure one request even across repeated resume.

`policy/engagement.ts:engagementBody({ testCommand? })`, exported from the package
as **`policyEngagementBody`**, renders a deterministic, non-promotional request for
welcome/assignment and a minimal fix with focused regression coverage. It always
discloses substantial LLM assistance through ai-dossier, with no product URL.
The optional command is a controller-detected primitive, never model prose.
It snapshots once, rejects secrets, controls/format characters and markup, and
throws fixed `EngagementError` for invalid facts or output above
`ENGAGEMENT_MAX_LENGTH` (1,500 UTF-16 code units), without truncating. Append the
driver's existing `handoffMarker(intent)` before passing the body to the driver.
The older `github/handoff.ts:engagementBody(intent, input)` export remains intact
for compatibility; new gate code uses the controller-facts renderer.

`checkInvitation(read, binding: IssueBinding, options)` is called **only on an
explicit resume** in `awaiting_maintainer`; it never polls, schedules nudges,
issues links, writes to GitHub or applies lifecycle transitions. Options contain
`engagementCommentUrl`, `engagementAt`, `contributor`, `issueAuthor`, `policy` and
injected `persist(evidence)`. `policy` has the controller's current policy `digest`
(canonical SHA-256) and explicit boolean `issueAuthorMayInvite`; authorship alone
does not grant authority. It reads bound issue comments and timeline pages,
100 entries/page, at most 10 pages per endpoint. Identity URLs are validated as
data, never followed; incomplete, malformed, duplicate, failed, secret-bearing or
truncated relevant reads give `unknown`. Non-assignment timeline event kinds are
ignored after checking record shape, truncation flags and string-valued `event`;
their other fields are not decoded or secret-scanned. Both endpoints must complete before persistence.
Page observations and caller facts are detached before subsequent awaits.
Supplied REST comment `url`/`issue_url` identity fields must agree with the bound
issue and comment ID. Authorized responses require valid `updated_at` metadata;
missing edit evidence is `unknown`.
Supplied assignment `issue_url` or nested `issue.number`/`url`/`html_url` must also
agree with the bound issue; the repository-wide event URL alone is not issue identity.
Supplied human account `type` must be `User`; App accounts require `Bot` and a
matching `[bot]` login/App URL. Missing human `type` remains compatible with the
existing minimal structural fixtures.
Supplied actor REST `url` must identify the same login (including percent-encoded
App-bot suffixes). The invitation permission allowlist is private immutable data,
independent of consumers mutating core's public trusted-association collection.
Valid GitHub App bot identities are supported
as data, including issue authors, but bot comments never grant invitation authority.

Only responses strictly after engagement are considered. The contributor's own
comment and engagement comment are excluded. Whole, unqualified affirmative
messages from OWNER/MEMBER/COLLABORATOR (or the issue author when the explicit
policy allows it) give `invited`; other associations confer no authority. An
`assigned` event for the contributor also invites, with `ASSIGNMENT_EVENT` as
association evidence of the assignment API's triage authorization. The evidence
is `{ actor, association, url, policyDigest, at }`, frozen, with canonical UTC time;
`persist` is awaited before returning `MaintainerInvited`. The controller stores
it in its run store. Persistence failure returns `unknown`, never permission.

`INVITATION_RULES` contains anchored affirmative/negative rules (e.g. “go ahead”,
“PR welcome”, “feel free”, “assigned you”; “not accepting”, “no AI”, “won't fix”).
Authorized negative messages give `declined` with `UpstreamDeclined`. Other
authorized prose, plan-first requests, caveats, quotes, edited comments,
unassignment and conflicting signals give `ambiguous` with the relevant URL and
no reason-code transition or new link. Only unambiguous invitation evidence is
persisted. With no authorized response, return `waiting`, recording nothing and
keeping `awaiting_maintainer`. There is no weaker permission fallback.

## Deterministic scope and test-integrity review (#1097)

`reviewCandidate({ baseManifest, candidateManifest, baseDiscovery,
candidateDiscovery, limits? })` is a pure, synchronous API returning
`{ verdict: 'pass' | 'hand_off', findings: { code, path?, detail }[] }`.
Both manifests are `SourceManifest` values and are revalidated into immutable
snapshots. Both discovery values must be `JunitSummary | null` from
`parseJunitReport` for the **same full-suite command**, bound by the caller to the
respective trees. Counts/outcomes must be nonnegative safe integers and consistent.
Missing, malformed or unreadable discovery produces `discovery_unknown`;
decreased suite or test counts produce `discovery_reduced`. Successful summaries
do not suppress patch findings or authorize shipping.

Every finding hands off. Codes are `test_deleted` (also renames/file-to-directory
replacements), `test_disabled`, `assertions_reduced`, `discovery_reduced`,
`discovery_unknown`, `config_changed`, `generated_or_binary`, `patch_too_large`,
`promotional`, and `invalid_input` (invalid/unreadable manifests, limits or
secret-shaped paths). Diagnostics are fixed text; file contents and thrown errors
are never returned. Findings use byte-sorted paths, fixed per-path check order,
discovery findings first and patch-size findings last. Returned results are frozen.

Test paths include any `test/`, `tests/`, `__tests__/` component, `*.test.*`,
`*.spec.*`, `test_*.py` and `*_test.py`. Added lines are scanned for
`it.skip`, `describe.skip`, `test.skip`, `xit`, `xdescribe`, `.only`, `it.todo`,
pytest skip/skipif/xfail decorators and skip calls, and unittest skip/skipIf/skipUnless.
Modified tests compare textual `expect(`, `assert` and `self.assert*` counts.
The scanner permits whitespace (including Python explicit line continuations)
between marker tokens and after decorator `@` (LF, CRLF and bare CR), and
conservatively admits Python grouping parentheses and implicit-continuation
comments, and JavaScript line/block comments. Cached lexical-gap jumps bound
screening work to linear source scanning rather than backtracking through the
same long comment for every token. The screening is conservative:
comments, literals and moved lines can produce findings. Marker matches use full
candidate context and must overlap an added line or cross a deletion-created
junction, including multiline markers assembled entirely from retained lines.
It is not semantic proof.
If added or deleted lines contain comment/string delimiters and candidate disabling
markers remain, screening conservatively refuses the ambiguous lexical-context
change: a retained marker may have become active without any added token.
Changes to short-circuit/conditional selector syntax around retained markers
likewise refuse ambiguous activation instead of interpreting repository code.
Non-test added lines containing `ai-dossier` or `imboard` are `promotional`.

Protected config includes `package.json`, `package-lock.json`, `pyproject.toml`,
`uv.lock`, `requirements*.txt`, `setup.py`, `setup.cfg`, `tox.ini`, `pytest.ini`,
`conftest.py`, `jest.config.*`, `vitest.config.*`, `.mocharc*`, `Makefile`,
`Dockerfile`, `.gitattributes`, and all `.github/` and `.devcontainer/` paths,
at any depth. Additions, deletions and mode changes all count; there is no
justification bypass. Changed `dist/`, `build/`, `*.min.js`, `*.map`, non-UTF-8
blobs and blobs above 1 MiB hand off, including removed blobs.

`IntegrityLimits` defaults to `maxFiles: 20`, `maxChangedLines: 1000`; explicit
limits must be nonnegative safe integers. Ordinary directory entries do not count
as files; file mode changes do. Lines count additions plus deletions, preserving
terminators (LF, CRLF, bare CR, and JavaScript Unicode line/paragraph separators,
including terminal-newline changes). A bounded LCS diff removes equal
prefix/suffix and examines up to 1,000,000 cells across the whole review; comparisons
exceeding the remaining work budget use
a conservative delete/add diff of the remaining lines. It can over-count, never
under-count; uncertain oversized/binary bytes already hand off. No I/O, network,
model review, credential access, lifecycle change or shipping grant is performed.

## Per-run boundary probe (#1096)

`prepareBoundary(artifactsDir?)` runs **before** `adapter.create`: it plants fresh
random host environment/file canaries and opens counting loopback/LAN listeners.
It returns an opaque, one-shot `BoundarySession` with `cleanup()` and a local
`artifactPath`. Pass `RunStore.storeDirectory('artifacts')` for run-owned durable
storage; without a directory, it allocates private temporary evidence storage.
The evidence directory survives session cleanup and is retained/deleted by the
controller's artifact-retention policy, never mounted in a guest.

After `endProvisioning`, call `probeBoundary(session, adapter, vm, profile)`.
It uploads the checked-in hostile npm lifecycle fixture, runs offline install/test
in the node container, and for `python` also runs the pip install/test witness.
Every command explicitly uses `network: 'none'`. It checks report file identities
and runs seven host-side broker-abuse checks.
Reports are untrusted; non-denied outcomes, malformed/missing reports, failed,
timed-out or truncated commands cannot produce a passing input. Probe exceptions
clean the session and throw a fixed, non-echoing error; there is no retry/fallback.

After the last guest operation on that VM, **await**
`finishBoundary(session, collector, runId, { timeoutMs? })` with its evidence-runner
`OutputCollector`. There is no synchronous finalization API. Finalization first
awaits `adapter.destroy(vm)` for the VM bound by `probeBoundary`, so the guest
cannot start another connection. It then crosses an event-loop poll phase with
two `setImmediate` yields, checks each listener's native `getConnections()` count,
and awaits both `server.close()` callbacks before snapshotting the counters.
Quiescence and drain each have a controller-selected deadline (default 5000 ms).
Errors or timeouts produce failed inputs with a fixed controller finalization
reason, never a clean verdict; emergency cleanup remains retryable. The adapter's
destroy contract must observe guest exit, rather than merely request termination.
It scans all probe output plus **every** collector chunk,
including consecutive chunks to detect split raw/hex/base64 canary encodings.
Marker reports in every output channel (stdout, stderr, report buffers, file
transfers and later collector output) can worsen the verdict; identical reports
are deduplicated without discarding conflicting outcomes.
It combines these bytes, reports, canaries, listener counts, broker checks and
the run identity into a `BoundaryInput`, publishes a private (0600) immutable
artifact, and returns the persisted snapshot. Secret-shaped data and collector
truncation throw rather than sanitize away evidence. Cleanup happens in `finally`,
including wrong IDs and failed artifact publication. Cleanup must succeed before
an authoritative artifact is published; failures retain explicit cleanup
retryability and throw `BoundaryOperationError('cleanup', 'resources_remaining')`.
An unfinished/early-cleaned
session returns a failed input; finishing twice is refused.

`runBoundaryVerdict(inputs, runId)` calls `evaluateBoundary` over the combined
inputs, with per-VM full-category checks so another VM cannot cover a missing
category. It also requires both distinct meaningful canaries, the complete unique
seven-check host measurement set, valid counters and matching run identity.
Controller-defined indexed failure records retain each VM's failed requirements
when another VM supplies its missing category coverage.
A breach, incomplete VM or wrong-run input fails the whole run. Read
each session's private artifact to recompute this verdict. Only this evaluator
creates `BoundaryEvidence`; shipping still requires the run's own clean held
verdict. Neither the probe nor its artifacts issue shipping authorization.

Always call `session.cleanup()` from the controller's outer `finally`, including
when VM creation fails, and independently destroy any created VM on failure.
Finalization itself destroys the successfully bound probe VM. Successful
probing leaves listeners active until finish, to measure subsequent guest work.
Cleanup closes listeners, unsets the unique environment variable and removes the
temporary canary home. Partial setup failures clean everything already allocated.

The gate harness re-exports `plantCanaries`, `listen`, `lanAddress`,
`rejectedByBroker`, `rootProbeArgv`, `HOST_ENFORCED` and `hex` from production.
`plantCanaries()` returns the canaries, target descriptor, both `Listener`s and
count/cleanup methods plus `await drain()`. Call drain only after observed guest
quiescence: it awaits both listener closes before authoritative measurement but
leaves the environment/file canaries in place, so `cleanup()` is still required.
The raw helper has no deadline; prefer deadline-controlled `finishBoundary` for
sessions. `listen(host)` counts and drops every accepted connection;
`lanAddress()` requires a non-internal IPv4 interface. `rejectedByBroker(work, expectedCode?)`
counts only controller-validation `BrokerError` codes as a rejection; session
checks require each attempt's exact expected code. Guest errors, transport and
readiness failures never prove host-side refusal. `boundaryBrokerChecks(adapter,
vm, capture?)` shares that seven-attempt sequence with the gate and optionally
captures unexpected returned data. `uploadBoundaryFixture(adapter, vm, fixture,
targets)` uploads only a fixture named in the shared `BOUNDARY_PHASES` table.
`boundaryCommands(profile)` returns fresh trusted fixture/profile/argv descriptors
shared by production and the gate, including the gate's independent timing labels.
`BoundaryOperationError` carries fixed controller-defined `stage`/`code` fields,
allowing upload, exec, report-read and cleanup failures to be diagnosed without
echoing guest text or OS paths. `rootProbeArgv(phase)` retains the fixed
assumed-container-escape gate command; production sessions require container scope.
The env-gated KVM suite additionally probes the production session after the real
provisioning-to-verification transition and recomputes its persisted verdict.

```ts
import { createRun, transitionRun, ReasonCode, serializeRun, deserializeRun } from '@ai-dossier/zero-trust';

const run = createRun({
  runId: 'contribution-1-session-1',
  upstreamIssue: 'https://github.com/owner/repo/issues/1',
  contributor: 'contributor',
}, '2026-10-05T00:00:00.000Z');
const planned = transitionRun(run, ReasonCode.GatePassed, '2026-10-05T00:01:00.000Z');
const restored = deserializeRun(serializeRun(planned));
```

`TRANSITIONS` (frozen rows) is the sole legal edge table. Every event is a
`ReasonCode`, every transition records canonical UTC time, and immutable records
contain replayable history. Restore validates the entire history; unknown schema,
illegal edges, inconsistent summaries and backwards timestamps fail closed.
Pure lifecycle callers own atomic storage, concurrency, retention and identity
validation. The controller can use the durable write journal described below;
neither JSON encoding nor this local journal is an authenticated receipt.

`BaseAdvanced` has exactly one legal edge: `shipping → verifying`. It cannot
leave a contributor wait or revision directly; verified revisions reach shipping
and use the same pre-intent drift guard before publication.

Negative terminal states and `merged` cannot transition. Explicit `createRun`
starts at `gating`; when given a previous run it rejects reuse of its ID. Only
`ObservedUpstreamMerge` can produce `merged`. The trusted caller must verify that
observation: event names are not upstream evidence or write authorization.

`blocked_cleanup` has just one exit, `CleanupCompleted → blocked`. It cannot
escape indirectly through gating or a pause into execution/publication. Cleanup
must be reconciled externally before explicitly creating another run. Checkpoint
resume events must return to the interrupted phase and represent trusted
controller decisions; that controller must bind
the checkpoint, candidate, receipts, policy and budget before emitting them.
Publication observations must be reconciled before pause/cancel if an API response
was lost; the lifecycle API performs no GitHub writes or resource teardown.

`StatusRecord` has all PRD status facts. `activeTimeMs` excludes waits. Money
estimates contain nonnegative finite `amount` and a matching three-letter
`currency`; these are estimates, not invoices. Controller-assembled amounts are
integer minor units (USD `45` means $0.45). Renderers preserve caller-supplied
numbers without conversion. `candidateSha` is omitted if absent.
`renderJson` and `renderHuman` render identical whitelisted facts; human values
use JSON quoting to neutralize line injection. Both use the exported, immutable
`SECRET_PATTERNS` policy shared with intent and receipt validation. Case-insensitive
rejection covers GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and `github_pat_`,
`sk-ant-`/`sk-proj-`, word-boundary or underscore-delimited `sk-` prefixes,
and embedded generic `sk-` keys with at least 32 alphanumeric/underscore/hyphen
payload characters. Prefix-only detection is intentionally conservative;
ordinary `task-validation`/`risk-assessment` text is allowed. `Bearer` followed
by whitespace and `Authorization: token` followed
by whitespace are rejected (spaces/tabs before the colon, whitespace after it).
Literal JSON/shell whitespace escapes (`\t`, `\n`, `\r`, `\v`, `\f`, and
ASCII whitespace in bounded octal, `\xHH`, `\uHHHH`, and `\UHHHHHHHH`
forms, including shell short forms) are scanned in a normalized view after
removing shell backslash-newline continuations;
the scan conservatively consumes complete backslash runs for nested serialization.
Escaped literal whitespace, printf's leading-zero octal forms and serialized
shell continuations are covered by detection-only normalized/collapsed views.
input is never executed. Rejection raises `SecretRedactionError` containing no
input. Other malformed facts raise
`InvalidStatusError`. Pattern detection is a defense-in-depth guard, not proof
that arbitrary input contains no secrets; the controller must supply sanitized
facts and never raw environment dumps.

```ts
import { renderHuman, renderJson, ReasonCode } from '@ai-dossier/zero-trust';

const status = {
  runId: restored.runId,
  phase: 'plan',
  state: restored.state,
  upstreamIssue: restored.upstreamIssue,
  contributor: restored.contributor,
  activeTimeMs: 60000,
  estimatedSpend: { amount: 25, currency: 'USD' },
  budgetRemaining: { amount: 475, currency: 'USD' },
  reasonCode: ReasonCode.GatePassed,
  nextPermittedAction: 'approve_plan',
};
console.log(renderHuman(status));
console.log(renderJson(status));
```

The values above are illustrative controller-supplied facts; the status renderer
does not calculate spend, elapsed time or shipping authorization. `assembleStatus`
derives active time and monetary facts from controller history and the budget ledger.

## Controller configuration, storage and status (#1090)

`validateRunConfig(raw)` accepts only the issue #1090 configuration fields and
returns a detached `RunConfig` with parsed `upstream: { owner, repo, issue }`.
The exact GitHub issue URL and contributor login are validated; unknown keys at
every configuration object level fail closed. Environment fields name variables
(`apiKeyEnv`, `privateKeyEnv`, `clientSecretEnv`), never their values. Every string,
including unknown keys, is scanned before serialization. `RunConfigError.code`
is a fixed, non-echoing reason such as `secret_detected`, `missing_rate`,
`invalid_limits` or `unsupported_environment`.

The input shape is:

| Field | Shape / units |
|---|---|
| `issueUrl`, `contributor` | Exact issue URL; GitHub login, at most 39 characters |
| `executionProfile` | `{ provider: 'local-qemu', profileDir, stateDir, accelerator, proxyEndpointsFile }` |
| `modelProfile` | `{ phases: { planning, implementing, repair? }, rates }`; each phase is exported `ModelPhase` |
| `budget` | `{ currency, ceilingMinor, cleanupAllowanceMinor, tokenLimit, activeMinutes }`; money in minor units, tokens in counts |
| `checkpoints` | Optional subset of `plan`, `patch`, `verification` |
| `limits` | Optional lowered `vcpus`, `memoryMiB`, `diskGiB`, `commandTimeoutMs`, `activeMinutes` |
| `signerKeyFile` | Ed25519 receipt-key path |
| `githubApp` | `{ appId, clientId, slug, privateKeyEnv, clientSecretEnv }`; positive numeric App ID, client ID and valid App slug; credentials are variable names |
| `retentionDays`, `resumeRunId` | Optional retention and supported `ztc-<16 hex>-run-1` resume ID |

Rates use exported `BudgetRate`: `resource`, `currency`, `unit`, `price`, `units`,
`source`, `fx: { currency, numerator, denominator, timestamp }`. `price` is
source-currency minor units per batch of `units`; FX is a positive rational
conversion to the budget currency. Missing prices are refused even for free models.
`runConfigInput(config)` removes derived `upstream` before revalidation or
persistence: `validateRunConfig(runConfigInput(config))`. The returned object
itself is not raw input. Exported `assertSecretFree(value)` recursively scans
strings and keys (including array metadata and Map/Set payloads), unlike
`assertNoSecrets(string)`. Unsupported opaque objects are refused; cycles
terminate. Configuration arrays may not have extra non-index properties.

The supported execution provider is `local-qemu` with explicit `profileDir`,
`stateDir`, `accelerator` and `proxyEndpointsFile`. Each planning/implementing
(and optional repair) model has adapter, model, endpoint and API-key variable
name; endpoints cannot contain user credentials, queries or fragments. HTTPS is
required except explicit localhost/loopback HTTP model endpoints. Paths are
resolved to absolute paths once at validation, avoiding cwd-dependent resume. Rates
are keyed by the phase's model name and must include even zero-price models,
with FX targeting the budget currency. Budget ceilings, cleanup allowance,
tokens and active minutes are positive safe integers. Cleanup allowance cannot
exceed the ceiling. Resource limits default to `DEFAULT_LIMITS` plus 120 active
minutes; overrides may only lower caps, including the 20-minute command cap.
The active budget cannot exceed the active limit. A smaller VM disk is still
subject to the adapter's baked-image minimum when execution starts.
Checkpoints default to `[]`; retention defaults to 30 days (1–3650).
`signerKeyFile` must be a single-link, current-user-owned, mode-0600 Ed25519
private key, verified and read on one no-follow descriptor. Only its path is
persisted; it must remain available on resume, and it is not fingerprinted.
No environment credential is read. `resumeRunId` marks a resume request and is
refused by `create`; use `open` instead. This foundation supports run 1 only;
revisions allocate numbered budget sessions.

`RunStore.create(root, config, now)` allocates a random `ztc-<16 hex>` contribution
and `<contributionId>-run-1`; `now` is a Date or canonical ISO timestamp.
`RunStore.open(root, runId)` restores it without initializing missing evidence.
Both return a lifetime-exclusive controller handle. `run`, `config`,
`contributionId`, `runId`, `directory`, `upstreamRepositoryId`,
`storeDirectory(name)` and `budgetSessionId(n)` expose safe metadata. Budget
session IDs are `<runId>-s<n>` (positive safe integer). Each store has 0700
directories and 0600 files, immutable `config.json` plus `config.sha256`, and
`run.json`. Dedicated directories are `intents`, `handoff`, `track`, `tokens`,
`push-ledger`, `nonces`, `budget`, `vm`, `profile`, `artifacts`, `bodies`,
and `control`. Individual primitives still initialize their own evidence only
on first creation; opening a RunStore does not initialize or reset them.

`persistRun(run)` admits only replay-valid exact continuations, journals them in
`control/events.jsonl`, then atomically rewrites the snapshot. Opening compares
the snapshot against this durable witness, rejecting rollback, divergence and
corruption. A snapshot confirmation event follows each durable snapshot write.
An interrupted, unconfirmed publication rolls forward only from the exact
previous confirmed checkpoint (or the exact pending snapshot); a rollback of
an already confirmed snapshot is refused. Unknown/divergent evidence yields
`run_diverged` or `invalid_store` without changing the lifecycle. A failed write
poisons the handle with `persistence_uncertain` and retains its kernel fence
until the process terminates. `close()` is otherwise idempotent and releases
the handle. A process crash releases the kernel lock; merely losing a JavaScript
reference in a live process does not. Linux-local storage and util-linux
`/usr/bin/flock` are required. Never unlink/replace `.controller.guard`, and
keep stores outside worker write access. This is not a distributed lease.
Snapshot reads/writes are anchored to a pinned directory descriptor; replacing
an ancestor cannot redirect publication. Lock contention/unavailable kernel
locking raises `StoreLockedError`. Other store refusals have non-echoing
`RunStoreError.code`: `invalid_store`, `invalid_run_id`, `run_diverged`,
`resume_identity_mismatch`, `snapshot_expired`, `persistence_uncertain`, `store_closed`. Stored
configuration failures preserve their typed `RunConfigError`, including an
unavailable signer key. Failed first creation preserves incomplete private
evidence rather than deleting it. `RUN_STORE_DIRECTORIES` exports the allowlist.

Record the authenticated upstream repository ID once with
`recordUpstreamRepositoryId(id)`. `assertResumeMatches(config)` compares
contributor, exact issue URL, execution provider and, once bound, the supplied
`upstreamRepositoryId`. A changed or omitted bound ID yields
`RunStoreError('resume_identity_mismatch')`. Changed identity or target requires
a new contribution. Stored config is immutable; `assertResumeMatches` only
checks identity and does not apply changed model/budget settings or reset history.
Retention policy is configuration only here; this API performs no expiry deletion.

`assembleStatus({ run, now, budget, sessionId, phase?, candidateSha?, handoff?,
tracker?, prerequisite? })` returns all `StatusRecord` facts and performs no
polling or network writes. Active time sums only gating, planning, implementing,
verifying, shipping and revising intervals, including the current active interval;
waits, pauses, submitted/outcome/terminal intervals are excluded. Estimated spend
is the selected budget session's conservative spent plus reserved **minor units**;
remaining is the ceiling less that total, floored at zero. It reports the latest
transition reason and prioritizes pending `handoffStatus`, credential-free
tracker status, `prerequisiteAction` (upstream binding and App slug), then
`DEFAULT_STATE_ACTIONS`. Driver facts must describe the current run/state.
Pending handoffs must have the exact current replay-valid history and contribution
binding, and their action includes the submission URL. `phase` defaults to state.
Exported `StatusParts` describes the input. Invalid/backwards `now`, absent
session, wrong contribution, overflow and stale driver facts are refused with
`InvalidStatusError`; clocks are never clamped. Use `renderJson` or `renderHuman`
for the same validated facts. Configuration,
RunStore and status helpers are exported from the package index; credential
modules remain isolated, including type-only imports.

## Contribution policy (#1091)

`discoverPolicy(read: GitHubRead, { owner, repo, ref })` performs credential-free
Contents GETs at a **40-character lowercase commit SHA**. Supply `anonymousReader()`
or an offline fake; no credential module is imported. `POLICY_PATHS` is the frozen
list of contributing files, AI policies, individual templates and README; one
`.github/PULL_REQUEST_TEMPLATE/` listing adds at most 20 immediate regular files.
Listing paths never supply a URL or change the target. `POLICY_FILE_LIMIT` is
256 KiB decoded bytes and `POLICY_TOTAL_LIMIT` is 1 MiB. Base64 must be canonical
(GitHub CR/LF wrapping is allowed), size must match, and UTF-8 decoding is strict.
The BOM is preserved. Explicit symlink/submodule responses or metadata, malformed responses, duplicate entries,
truncated/over-cap listings, blob mismatches and every non-404 failed read yield
`{ kind: 'unknown' }`, without partial files, retries or a weaker fallback. A listed
file disappearing also yields unknown. Complete absence is `{ kind: 'known', files: [] }`.
`PolicyDiscovery` and `PolicyFile` describe the result; each file has `path`, `sha`
(Git blob SHA) and `content` (untrusted text). The injected reader is responsible
for the GitHub protocol and complete response; GitHub's 1,000-entry directory
truncation is necessarily above the stricter 20-entry cap.
Contents can dereference an in-repository symlink and return a normal file response;
this API assesses that returned pinned content at its logical policy path, not Git
tree modes. No additional tree reads or repository-controlled URLs are followed.

Owner and repository names use the shared GitHub binding validators (1–39 total ASCII
login characters, alphanumeric with optional single hyphens between them, without
trailing/consecutive hyphens; repository at most 100 ASCII
letters/digits/underscore/dot/hyphen, excluding `.` and `..`). `POLICY_TEMPLATE_DIRECTORY`
and `POLICY_TEMPLATE_LIMIT` export the directory and 20-file cap. Template names
are 1–120 ASCII letters/digits/underscore/dot/space/hyphen, excluding `.` and `..`.
Both discovery and direct validation enforce at most 20 templates and 34 total
files, unique eligible paths, lowercase 40-hex SHAs, strict UTF-8, and byte caps.

`classifyPolicy(files)` returns a **deterministic restriction floor**, not prose
understanding or authorization. Its `PolicyAssessment` shape retains permissive
enum members for future typed-decision integration (#1120), but this function
**never emits `welcomed`, assignment `not_required`, or baseline permission**.
`ai` is `banned`, `requires_approval`, `disclosure_required`, `silent` or `unclear`;
`assignment` is `required` or `unclear`; `directPr` is `discussion_first` or `unclear`.
It also returns `draftRequired` (true if any draft topic exists),
`receiptBlockAllowed` (false if any template topic exists),
`baselineFailuresPermitted` (always false), and `citations` with original `path`,
1-based `line`, stable `ruleId` and at most 200-Unicode-code-point `excerpt`
(`PolicyCitation`).
Secret-bearing lines are replaced with `[redacted]` after `assertNoSecrets`, including
secrets outside the excerpt slice. Evidence retains the first occurrence of each
rule per file and is capped at 128 citations; every line still affects classification.
README contributes only ATX sections headed with `/contribut/i`, including nested
subsections. ATX headings have 0–3 leading spaces, 1–6 `#`, then a space or end of
line (tabs also separate heading content). A same/higher-level heading ends the
enclosing contribution region; in-region heading text itself remains policy evidence. Fences
in every policy file open with 3+ backticks/tildes (0–3 spaces), and close only on
the same marker with at least that length; fenced text is excluded. Backtick info
strings may contain no backticks. An unclosed fence excludes its remaining text.
Block structure is parsed with `markdown-it` in CommonMark mode (parse only,
no rendering/plugins/linkification or resource reads); controller code applies
the supported policy-region subset to source maps. This distinguishes HTML blocks
from incomplete tags/inline HTML and setext paragraphs from thematic breaks.
Source evidence includes all non-fenced lines, including link-reference definitions
that have no block-token map. Reaching the parser nesting boundary (token level
19 under its 20-level block cap) raises non-echoing `PolicyInputError` rather than
treating omitted content as silence. Unsupported non-space/tab whitespace after
an HTML opener line (including attributes or trailing text) is likewise refused,
as are lowercase declaration-like openers (`<!doctype`, `<!note`). These are
closed refusals for parser/CommonMark disagreements; excluded fenced text is not
examined. Guards inspect both original lines and container-stripped HTML openers.
Active HTML blocks cannot open Markdown fences or manufacture heading boundaries;
comments, raw tags, declarations, processing instructions and CDATA terminate
on their appropriate markers, other HTML blocks at a blank line. README setext
headings and HTML blocks inside a region taint every dimension touched anywhere
in that region as unclear, including preceding restrictions. Boolean dimensions
retain their restrictive topic-presence defaults. Outside-region prose does not
count. No full Markdown or prose parser is claimed. Direct inputs are bounded/validated by `validatePolicyFiles` and
invalid snapshots and ineligible paths raise non-echoing `PolicyInputError`;
otherwise eligible paths containing prohibited credential patterns raise
`SecretRedactionError`.

`POLICY_RULES` and `POLICY_TOPICS` are frozen case-insensitive **data**, with stable
IDs. `PolicyRule`, `PolicyCategory`, `PolicyTopic`, `PolicyDimension`,
`POLICY_AI_MENTION` and `POLICY_NEGATION` are exported. `POLICY_PERMISSION_CAVEAT`
is an inert compatibility alias of `POLICY_NEGATION`; no permission rules exist.
Matching lowercases, normalizes quotes/apostrophes, expands contractions (`n't` →
` not`, `won't` → `will not`, `can't` → `cannot`), protects `a.i.` as an AI alias,
then splits on `.`, `!`, `?`, `;`, newlines and list items. **Commas remain inside
the unit**. AI topics include ai, a.i., llm, large language model, chatgpt, copilot,
generated by, machine-generated and assistant. Other topic sets cover assignment,
PR/discussion, draft, template/extra sections and baseline failures.

Any negation/prohibition in a topical sentence is a restriction of that dimension,
even phrases such as "AI is not banned" or "No assignment required". Explicit
approval/disclosure, assignment, discussion-first, draft and template rules also
recognize restrictions. Only-restrictive AI units yield the strictest kind:
`banned > requires_approval > disclosure_required`. Several aliases in one unit
are fine. Any other topical unit makes its dimension `unclear` (even a welcome).
Assignment/direct-PR dimensions use the analogous restrictive/unclear rule. No AI
topic yields `silent`; assignment silence remains unclear because the legacy
exception requires `directPr=welcomed`, which the floor cannot produce. Booleans
need no prose interpretation: draft topic ⇒ true, template topic ⇒ receipt false,
baseline permission ⇒ always false. With no draft/template topics their defaults
are false/true. `unknown` is blocked; `unclear` needs a decision, not necessarily a
human. Typed decision wiring is provided by `assessPolicy` below, not invoked here. Repository text
is never executed or interpreted as controller instructions.

`policyDigest(assessment, files)` hashes canonical sorted-key JSON containing the
assessment (with sorted citations) and sorted `{ path, sha }` file identities using
SHA-256. The payload is `{ assessment: { ...assessment, citations }, files }`:
citations sort lexicographically by each citation's entire canonical JSON, files
sort lexicographically by path and contain only `{ path, sha }`. Hash input is
UTF-8 and output is 64 lowercase hex characters. Input order and object-key order cannot affect the digest; any blob SHA or
assessment change does. Content is bound by the supplied GitHub blob identity;
callers must use discovered snapshots, not fabricate SHA/content pairs. A digest
is a freshness binding, not authorization or proof that contributions are permitted.
Files are validated; assessment semantic validity remains caller-owned: use
`classifyPolicy` or `assessPolicy` output. Canonical serialization rejects unsupported JSON or secrets
with `ReceiptError('invalid_json')`/`SecretRedactionError`. Policy serialization uses
a 256-KiB escaped-JSON budget; receipt callers retain their 128-KiB default.
`canonicalJson(input, maxBytes?)` permits a positive safe-integer budget up to 1 MiB;
this does not alter receipt parsing or signing defaults.
An empty-snapshot test vector is
`3236ec6be3056ffe44c3667e516c6bcb8c51fa9b5511f30e1839090e8fad581f`.
Thirty-five synthetic fixtures in `fixtures/policy/` identify actor, expected outcome
and S2 ownership, and fake-read tests run offline.

```ts
const discovery = await discoverPolicy(anonymousReader(), { owner, repo, ref: pinnedSha });
if (discovery.kind === 'known') {
  const assessment = classifyPolicy(discovery.files);
  const digest = policyDigest(assessment, discovery.files);
  // Persist the binding; the controller still decides block/hand-off/permission.
}
```

### Typed policy assessment (#1120)

`await assessPolicy(files, decisionDeps?)` is the full controller-side policy
assessment API for gate/freshness consumers. `classifyPolicy` remains offline and
floor-only. Files are validated and detached before any await; admitted Markdown
regions are passed as data under their original path `sourceId`, with excluded
lines blank to retain original line coordinates. Inputs are sorted by path.
AI silence returns the floor without provider calls or budget effects.

`POLICY_QUESTIONS` contains frozen version-1 questions for all six dimensions.
AI strictness is `banned > requires_approval > disclosure_required > welcomed`;
assignment is `required > not_required`; direct PR is `discussion_first > welcomed`.
The three choice escalation values are `unclear`. Boolean true in the shared typed
decision API always means permission: the draft question asks whether a **non-draft**
PR is permitted, and its accepted answer is inverted into `draftRequired`.
Boolean escalation sentinels map to draft required, receipt forbidden and baseline
failures forbidden. Permissive thresholds are 0.95; restrictive boolean thresholds
are 0.6. Choice thresholds decrease by 0.1 per strictness rank.

Every decision uses the deterministic floor, intersected with any caller floor.
Uncapped restriction metadata from `analyzePolicyFloor` binds all dimensions even
when the displayed citations reach their cap or a dimension is unclear. A ban plus
unresolved AI prose always escalates (including a mixed ban/welcome); deterministic
negation rules remain conservative, so "AI is not banned" cannot yield permission.
A separate refusal-only contradiction detector splits restrictive units on commas,
colons, parentheses, em dashes and the word "but" for this check only. A topical
sub-clause without its own negation/restriction cue forces that dimension to
escalate, even if the full unit's floor enum is restrictive. Offline classification
units and permission inference are unchanged.
Any ambiguous Markdown region escalates all dimensions before dispatch. Boolean topic-presence floors
remain conservative: draft topics require drafts, template topics forbid the receipt,
and baseline failures stay forbidden even if a model proposes permission. Shared
decision validation enforces independent agreement, confidence and metered budgets;
missing/invalid provider configuration and every escalation are hand-offs, never a
weaker fallback. This API does not authorize publication or perform GitHub writes.

Budget refusal is assessment-wide and all-or-nothing. Any dimension's `budget`
escalation stops subsequent decision dispatch. After the last dimension, the API
rechecks eligibility read-only using the same `isBudgetSessionExhausted` predicate
as `decide`, including fully cached assessments. Exhaustion returns the exact
deterministic floor values and display citations for every dimension, with
`reason: 'budget'`; a failed final ledger read similarly returns the floor with
`reason: 'ledger'`. Retained decision records are marked escalated with that reason
and the floor value, while validated earlier citations remain audit evidence.
The reason and refused verdict metadata are bound in `policyDigest`, distinguishing
this fallback from a decided assessment. Silent inputs still make no model calls.

Accepted answers require at least one citation and literal source spans in admitted
lines, enforced by the shared decision's `citationMode: 'verbatim'` on both fresh
and cached verdicts. Quotes retain raw whitespace and file line coordinates split
on CR/LF; Unicode paragraph separators within a source line do not renumber it. Policy citations
use `decision:<questionId>@<version>`, original path/line, and the existing full-line
secret redaction and 200-code-point excerpt cap (`policyExcerpt`). The combined
evidence cap is 128 (`POLICY_CITATION_LIMIT`): up to 122 deterministic citations,
one reserved controlling citation per accepted dimension, then additional distinct
citations while space remains. Permission never
depends on this display cap. `PolicyDecisionDeps` describes the trusted dependencies;
`PolicyDecisionEvidence` describes the retained verdict metadata.
`PolicyAssessment.decisions` retains each dimension's status/reason/value, confidence
as a deterministic decimal string, provider/model IDs, question version, a hash of
the frozen question definition, input digest, and every distinct validated verdict
citation in canonical order. `policyDigest` binds a canonical SHA-256 hash of the
**complete** citation set per dimension along with verdict metadata, final values
and displayed citations. Full quotes do not consume the display serialization
budget; display truncation cannot erase citation-only digest changes.
changing a model or question version changes it, while reversing input order does
not. Confidence is a string because receipt canonical JSON accepts integer numbers
only. `canonicalPolicyDecisionCitations` deduplicates/freezes the complete evidence;
`policyDecisionCitationDigest` hashes its sorted-key JSON array incrementally.
Evidence `value` normally holds the question answer/sentinel, not the final boolean
field: `policy-non-draft=true` means `draftRequired=false`. Assessment-wide
budget/ledger refusal is the exception: escalated records hold deterministic
assessment-floor values, including the assessment's boolean polarity. Missing configuration is
`reason=configuration`, IDs `unconfigured` and an empty input digest; invalid
citations are `invalid_pass`. AI-topic absence returns the offline defaults for all
dimensions without semantic calls. Otherwise uncertain draft/receipt permission
uses restrictive escalation defaults, which may tighten the offline defaults.
Gate/freshness consumer wiring remains in their respective slices.

## Issue eligibility (#1092)

`assessIssue(read: GitHubRead, { owner, repo, issue }, contributor)` reads structured
repository, issue and timeline facts without credentials, writes or lifecycle
transitions. Supply `anonymousReader()` or an offline fake. This is deterministic
metadata assessment only: it does not judge issue/comment prose or invoke typed
decisions. The engagement gate owns any semantic judgment and run transition.

`Eligibility.kind` is `eligible`, `ineligible`, `hand_off` or `unknown`. Complete
results expose immutable `facts`, `reasons` and `evidenceDigest`. Facts include
authoritative `repositoryId`, `fullName`, `defaultBranch`, public/archive/disable
flags, issue number/URL/state/lock/PR marker, author (login/URL), author association,
labels, assignees (login/URL), creation time, normalized contributor, referenced
PRs (number/URL/repository/state/merged/author) and assignment/connection events
(nullable REST ID/time/actor and assignee or PR URL, plus update time when supplied).
Reference events also retain `identityFields`, an immutable path-to-value map of every
present identity field, preserving exact spelling for field-sensitive evidence digests.
Cross-references without REST IDs use their complete normalized event/PR identity
for duplicate detection; other retained events require numeric IDs. Ordinary accounts
and GitHub App bots (`<app>[bot]`, type `Bot`, matching GitHub App profile URL) are
recorded; contributor and repository-owner validation still requires ordinary logins.
Labels, assignees, PRs and events are sorted
by canonical JSON; the digest is lowercase SHA-256 over canonical JSON of exactly
`facts`, in UTF-8. It binds freshness inputs, not permission or authentication.

- Private, archived or disabled repositories, closed/locked issues and PR URLs are
  `ineligible`, with corresponding reasons (`private_repository`, `archived_repository`,
  `disabled_repository`, `closed_issue`, `locked_issue`, `pull_request`) and
  `reasonCode: ReasonCode.PolicyBlocked`; the module never applies that transition.
- Explicit enhancement/feature/question/discussion/documentation labels without
  bug/defect/regression yield `hand_off` / `not_a_bug`. Other labels do not infer a
  prose classification. Unlabelled eligible issues record `bug_unlabeled`.
- A current assignee other than the contributor yields `competing_assignee`.
  An open referenced PR by another author yields `competing_fix`; an open own PR
  yields `own_pr_exists` for reconciliation to own. Login comparison ignores case.
  Closed/merged PRs are recorded but do not compete.
- Every failed, malformed, ambiguous or truncated read yields only `{ kind: 'unknown' }`,
  with no partial evidence, retry or weaker fallback. The gate must hand off unknown
  and hand_off results. Missing accounts/URLs likewise cannot be treated as permission.

Timeline GETs use at most `ELIGIBILITY_PAGE_LIMIT` (10) pages of
`ELIGIBILITY_PAGE_SIZE` (100). A full tenth page is unknown even if it happens to
be the last page. Cross-referenced PRs and connected events are collected; ordinary
issue references and other event kinds do not judge prose. Current PR state is
hydrated once per distinct parsed public GitHub identity via a fixed `/repos/.../pulls/...`
path (including cross-repository references), never by fetching repository-provided
URLs. Connected events without a resolvable source issue or subject identity are
unknown. A single identity helper requires every present number and URL identity in
the event, source issue, subject and PR marker to agree on owner/repository/number
with each other and the hydrated PR. This includes `url`, `html_url`, `diff_url` and
`patch_url`; optional absent fields are fine, contradictory or malformed fields are
unknown. Repository identity comparison ignores case, but exact supplied values are
digest-bound. An invalid identity returns unknown without a digest or partial facts.
Ordinary issue references require consistent non-PR identity. Duplicate
relevant event identities and inconsistent merged/open state are unknown. Each page
is synchronously validated/detached before PR hydration; later reader mutations cannot
change pagination or admitted entries. PR repository identity is normalized so mixed-case
references cannot make the digest depend on reference order. Whole-second UTC timestamps
must round-trip exactly, rejecting impossible calendar dates.
The injected reader must deliver complete GitHub REST bodies; it owns transport
deadlines. The bounded snapshot permits at most 1,000 relevant events/PR reads,
100 labels and 100 assignees, bounded metadata strings and a 1-MiB canonical digest
input. Repository and issue response identities must match the supplied target;
renamed/redirected targets require explicit controller reconciliation.

```ts
const eligibility = await assessIssue(anonymousReader(), { owner, repo, issue: 7 }, contributor);
if (eligibility.kind === 'eligible') {
  // Persist eligibility.facts.repositoryId and eligibility.evidenceDigest.
  // The engagement gate still decides whether work is permitted.
}
```

## Credential-free source acquisition (#1093)

`resolveBase(read, { owner, repo, defaultBranch })` reads the encoded branch REST
path using a structural credential-free reader and returns a lowercase 40-hex head
SHA. Failed or malformed reads throw non-echoing `CanonicalError('unavailable')`.
`sourceUrl({ owner, repo })` builds only `https://github.com/<owner>/<repo>.git`;
both names accept 1–100 ASCII letters, digits, dots, underscores and hyphens,
excluding `.` and `..`. No repository-provided URL is followed.

`acquireSource({ owner, repo, baseSha }, options?)` returns `{ pack, manifest }`
after fetching into fresh trusted bare storage without credentials, tags, checkout
or submodule recursion. Its fetch-only `GitExecOptions.sourceFetch` option permits HTTPS
while all other protocols remain denied; redirects are disabled, credential helpers
empty and prompts disabled. This option refuses env, identity and config overrides.
All other callers retain `protocol.allow=never`. Hooks, attributes filters and
gitmodules are data, never executed. Temporary repositories are removed on all exits.

Production first fetches with `--depth=1`. A root commit's pack imports strictly as
is; commits with omitted parents fail `index-pack --strict` and trigger one fresh
fetch without depth. This is a complete-history fallback, not a weaker importer.
Both paths enforce a kernel receive-file bound using GNU `env` and util-linux
`prlimit` (required on the trusted Linux controller). Git is forced to retain the
received pack, never unpack it into loose files; `RLIMIT_FSIZE` inherited by
index-pack stops writes past 128 MiB during reception, with no auto-GC or commit
graph writes. This bounds each received pack/index file, not total controller
storage across concurrent runs. `sourcePackBytes` may only lower that limit.
Both paths also bound generated pack output to exported `MAX_PACK_BYTES` (128 MiB), refusing
overflow with `limit_exceeded` before returning any artifact for the run store.
The integrating controller must map this source-size refusal to `unsupported_environment` with
`source_too_large`. This primitive itself performs no run-store writes or transitions.

`baseManifest(pack, baseSha)` imports with the same strict path as `createCandidate`
and inspects raw trees. Unsupported modes (symlinks/gitlinks/special files), Git
path aliases, collisions and malformed objects throw `unsupported`; source/pack
limits remain `limit_exceeded`; unavailable Git inspection remains `unavailable`.
The shared internal `importPack(git, pack)` plumbing distinguishes strict rejection
from an unavailable subprocess; unavailable import never triggers another fetch.
Only positively identified fixed terminal Git pack/object rejection diagnostics
permit fallback. Completed disk/permission failures and unknown diagnostics remain
unavailable; raw diagnostic text is never returned.
No path or byte normalization occurs. The manifest
has the existing immutable `SourceManifest` shape. Both APIs are package exports.
Tests alone can pass `options.remoteUrlForTest`, a local `file:` URL accepted only
when `process.env.VITEST` is set; only then is file transport permitted. Tests use no
live network, and production must never set that option.

## Artifact retention and portable export (#1104)

These offline controller APIs are exported from the package index. No CLI or
upstream write is added. The caller must close live controllers before sweeping;
`RunStore.open` holds the same permanent lifetime flock used for execution.
`RunStore.open(root, runId, { readOnly: true })` is the maintenance open used by
sweep: it validates the complete confirmed control journal without running tail
recovery, repairing snapshots, changing journal permissions or writing lifecycle
events. Torn tails, pending recovery markers and unconfirmed snapshots require
explicit controller recovery before maintenance. Mutating controller methods on
a read-only handle refuse. Pinned maintenance access also rechecks the current
snapshot, config digest and confirmed control history, so cached live state cannot
hide corrupt or divergent selected files.

- `planSweep(root, now, retentionDays?)` is **dry-run only**. `root` contains only
  contribution directories (`ztc-<16 lowercase hex>`), not keys or other files.
  `now` is an injected Date or ISO timestamp. Omit the third argument to use each
  contribution's validated `config.retentionDays` (default **30**); a supplied
  positive safe integer overrides it for this explicit sweep, without editing config.
  Last activity is the maximum of lifecycle `updatedAt` and file modification
   times, excluding maintenance files and controller lock/guard metadata outside
   artifacts. Every artifact counts, including `.lock`/`.guard` names and quarantined
   leaves under their original artifact identity. The exact cutoff is
  retained; only strictly older contributions qualify. `blocked_cleanup` never
  qualifies. `SweepPlan.contributions[].files` lists exclusively regular,
  single-link files below `artifacts/`, with relative paths, inode identities,
  sizes, modification times and SHA-256 digests. Directories are kept.
- `applySweep(plan, fault?)` is the explicit destructive operation. It requires
  the unchanged original plan object issued in this process (serialized, cloned,
  forged or edited plans are refused). Replan after a process restart with the
   original batch policy for unfinished replay; completed historical overrides do
   not constrain the policy of a new batch. It reopens
  each store under the lifetime guard, pins directory descriptors, and revalidates
  contribution identity, activity, configuration, protected bytes, selected
  evidence and every remaining artifact before deleting. Symlinks, traversal,
   hard links, stale files, files added after planning and unreadable/corrupt evidence fail closed.
  Root and ancestor symlinks are refused too.
- Publication order is durable `summary.json`, then durable `.snapshot-expired`,
  then deletion. Both maintenance records live beside the immutable `run.json`.
  `ContributionSummary` (`ztfc-summary-v1`) contains public links, verified and
  observed outcome SHAs, receipt digests, evidence-derived outcome, conservative
  per-session costs, the exact sweep manifest and frozen selected-source provenance
   (`evidence`: original run bytes, exact expiry budget bytes when present, plus
   each source's byte length and digest).
  The reader verifies retained journal prefixes and unchanged non-journal evidence,
   reconstructs historical facts, and checks the current confirmed run is an allowed
  observation/stop continuation. Current selected sources are independently validated
  for status/export. `snapshotExpired: true` is
  monotonic: even a crash before the separate marker lands prevents resume.
  Every protected file remains byte-for-byte unchanged: run/config/control and
  all intents, handoff, track, tokens, push-ledger, nonces, budget, VM, profile
  and prepared body evidence. No journal is compacted or discarded.
- Each removable leaf is atomically moved to a deterministic name in the pinned
  controller-owned **`.retention-quarantine/` beside `artifacts/`**, owned by the
  controller and mode 0700. This storage is never available to a worker by architecture.
  The regular inode is streamed through a no-follow descriptor, identity/digest-checked,
  and its final named identity is checked again immediately before unlink. POSIX
  has no unlink-by-descriptor; the private parent and exclusive lifetime guard are
  essential authority, not isolation against an arbitrary same-UID controller attacker.
  Mismatched moved bytes are retained in quarantine for recovery, never deleted;
  unplanned leaves are never consumed. Both rename parents and deletion are fsynced. A crash
  after isolation is replayable; a swapped leaf is retained and refused. These
  temporary names are recognized only by the durable manifest. Already missing
  files are tolerated only after durable expiry evidence exists. Partial and
  complete applications can be rerun, reusing the identical summary bytes.
  The optional synchronous test fault hook is called at `summary`, `expired`,
  `quarantined` and `deleted` durable boundaries; a thrown fault releases the
  maintenance handle so recovery can reopen it.
- `readContributionSummary(store)` validates and returns the persisted summary,
  or null when neither summary nor expiry marker exists. Missing summary with a
  present marker, corrupt metadata, mismatched identity/digests and invalid
  manifests are refused. `assertResumable(store)` delegates to
  `RunStore.assertResumable()`; expired snapshots throw `RunStoreError('snapshot_expired')`.
  `RunStore.assertResumeMatches`, ordinary `persistRun` active transitions and actual
  checkpoint approval enforce this before any journal writes. Every added history
  edge is checked, so batching continuation with a later cancellation cannot bypass
  expiry. Observed public status, decline, cancellation, failure, pause and cleanup
  transitions remain permitted. Read-only open/status/export remain possible.
   Pending replay checks still require original artifact identities/digests.
   Completed batches have a durable `.retention-completed-<digest>.json` marker;
   later artifacts (including voluntary `recordAdoption` notes) remain untouched
   until a new explicit plan authenticates their own identities, selected evidence
   and retention eligibility. Later batches publish separate content-addressed
   `.retention-generation-<digest>.json` manifests before deletion. They crash-replay
   independently, including quarantine recovery, without replacing the first summary
   or skipping an unfinished first batch when newer artifacts have aged. Pending
   batches finish before any new generation is admitted. Completed batches do not
   pin the retention policy for later artifacts. This preserves the first summary
   and expiry marker. These controller-owned maintenance records are retained and
   excluded from activity timestamps and protected-store inventory digests; all
   pre-existing fail-closed stores remain unchanged.
   Permitted confirmed observations do not invalidate frozen summary facts.
  Resuming work requires fresh acquisition/reconstruction and independent
  verification in a **fresh run**, never clearing expiry on the old snapshot.
- `RunStore.withPinnedDirectory(work)` runs synchronous trusted controller
  maintenance against the pinned contribution directory while its lifetime guard
  is held, and refuses a closed, poisoned or replaced store. It is not a worker
  API; never retain the descriptor path or start asynchronous work in the callback.
   Maintenance shares the complete fresh RunStore evidence comparison, including
   held upstream repository ID, checkpoint records and bindings. Read-only archive
   opening validates stored configuration without requiring the old signing key to
   remain available; execution opening still enforces signing readiness.
   Preflight filesystem failures become fixed `RunStoreError('invalid_store')` diagnostics,
   and native async callbacks are refused before invocation; Promise-like results
   are refused just as with `withStoreDirectory`. Run/config/digest/control reads
   are bounded before allocation, including maintenance opening and revalidation,
  without native paths/messages/causes. `RunStore.assertObservationContinuation(prior)`
  validates a historical run against the current confirmed run, refusing identity/history
  divergence or any new edge that requires an unexpired snapshot (`run_diverged`).

### Selected evidence persistence convention

This slice consumes actual producer records with stricter maintenance preflight,
sharing the metrics producer's pure `recordedOutcome(run, tracker?)` and
`outcomeCosts(validatedBudget, modelNames)` projections. These are the exact
projections used by `contributionOutcome`; maintenance applies them to its bounded,
secret-checked and anchored snapshots rather than re-reading through the metrics
API's permissive unknown-on-corruption reader. Portable status and frozen summary
retain `metrics: { outcome, cost: { byCurrency } }`, including canonical
`open`/`accepted` outcomes, separate estimated/observed minor units, and model/VM
subtotals. Missing budget evidence is `byCurrency: 'unknown'`; unreconciled
observations remain `'unknown'`, never admission maxima claimed as observed costs.
`PrTracker` and `HandoffDriver` already persist `track/events.jsonl` and
`handoff/events.jsonl`: raw events are scanned, then their existing replay
validators establish identity, history, public links and outcome facts. Complete-line
tracker tail loss is refused using `isTrackerContinuation`; repaired selected
handoff/tracker journals are refused rather than presented as complete evidence. A missing
tracker file is **unknown**, never inferred merged from a lifecycle label. A valid
pending tracker reports `awaiting_review` (`metrics.outcome: 'open'`), `accepted`
when confirmed accepted, or `blocked` when its replay says so.
`BudgetLedger` snapshots live at `budget/ledger.json`. The new
`BudgetLedger.readOnlyEvidence(file, contributionId)` returns `{ state, bytes }`
under the existing non-reclaiming transaction guard, preserving exact scanned bytes
and digests. `readOnlySnapshot` delegates to this same read and returns only `state`.
An unresolved owner (live or retained after a crash) refuses reporting/sweep until
controller reconciliation; reporting never creates or steals the lock.
`validateBudgetSnapshot(raw, contributionId)` remains the shared detached decoder
for the already-authenticated historical bytes. Separate admission `costTotals` use existing `budgetTotals`, preserving
reservations and conservative maxima, with currencies kept per session. No
ledger or no session means null, not zero. Present invalid evidence throws.
Expiry retains exact budget bytes with the selected-source digest. Current budget
reconciliation may settle/release retained reservations or append new rows/sessions,
but may not rewrite old session identity, reservation identity/estimates or already
reconciled rows. Historical costs stay immutable; separately validated current costs
may differ. Unresolved transaction ownership still refuses both reads.
Offline receipts must use this run's `<runId>-s<positive safe integer>` session;
available budget evidence must contain that session, and a held authenticated upstream
repository ID must match the signed receipt. These checks never grant shipping authority.

Receipt issuance, command verification and policy/PR-content producers currently
**return** records; the integrating trusted controller may atomically persist the
following bounded, 0600 JSON records at the contribution root using its existing
private durable publication primitive. This module never scans arbitrary bulk
artifacts for authority, invents records, or auto-persists returned evidence:

| Record | Controller-owned payload |
|---|---|
| `receipt-evidence.json` | At most 128 complete `SignedReceipt` envelopes returned by `issueReceipt`; receipt schema remains `ztfc-receipt-v2`. Parsed receipt identities, canonical SHA-256 digests and Ed25519 signatures are verified offline. Signature verification is integrity evidence, not trusted-key or current shipping authorization. |
| `verification-evidence.json` | `{ runId, candidateSha, records }`; `records` are 1–128 actual verification-phase `CommandRecord` values returned by the evidence runner, with unique command IDs. Each `evidence` must match id, argv, status, supervised exit code, suite count and log digest. Status is reclassified using the producer's classifier, with timeout/signal, report counts (including supervised `skipped`) and capture mode checked. Missing skipped counts in legacy records fail closed; they never default to zero. All-skipped reports remain inconclusive. Truncated output cannot establish success. Only receipt-style metadata is exported, with `verified` calculated by `evidenceVerified`. Omit the optional source to represent absent verification; a present empty command array is invalid. |
| `portfolio-evidence.json` | `{ runId, disclosure, policyCitations }`; a present file requires a disclosure string and citations array, at most 128 actual policy assessment citations (`path`, positive `line`, `ruleId`, `excerpt`). Only a missing file yields null disclosure/citations. Missing fields in a present file fail closed; prose and defaults cannot replace them. |

Every selected JSON record is bounded to 1 MiB before allocation and must be valid
UTF-8. Metadata and pinned regular no-follow inode checks precede reads; bounded
reads detect growth and replacement. Journals are capped at 16 MiB, 10,000 records,
and 1 MiB per newline-terminated line. Blank/torn lines are refused; maintenance
never uses forgiving journal recovery. The **aggregate verification array** is at
most 128 entries: one per receipt plus one for a present standalone verification
source. Thus 128 receipts plus that source is refused
before sweep publication. The exact serialized summary is preflighted against its
4-MiB reader cap before summary, expiry or deletion. The complete prospective portable
bundle is also preflighted before expiry, using the same schema, consistency and size
checks as export. Export bounds still apply
to the portable bundle, whose summary excludes the manifest. Inventory streams
directory entries and bulk hashes, capped per contribution at 20,000 entries,
64 directory levels, 256 MiB per file and 1 GiB total file bytes; the root allows
10,000 contributions. Unsupported inventories/manifests fail before destructive effects.
Raw strings (including discarded fields and verification log excerpts) are
scanned with `assertNoSecrets` **before** projection. Missing optional sources
remain unknown/null. Corrupt, truncated, unreadable or secret-bearing selected
sources stop maintenance; secrets are never silently redacted into a successful
export. Log content is not exported; command metadata retains sanitized digests.

### Portable export contract

`exportContribution(store, outFile)` returns and writes one detached
`ContributionExport` with `schemaVersion: EXPORT_VERSION` (`ztfc-export-v1`):
the actual run/history, offline status (URLs, verified/outcome SHAs, observed
outcome and costs), sanitized summary, complete receipt envelopes/digests,
verification metadata, PR/outcome, disclosure and policy citations. The exported
summary omits the local sweep manifest and file identities. Missing verification
is null, with `verifiedSha: null`; no absence can earn a verification claim. An
independently observed outcome and its SHA remain available without verification.
Config, environment, token journals, nonce stores, budget locks, raw logs and
prepared body file paths are excluded. All output strings are scanned again.
`EXPORT_SCHEMA` is the versioned public JSON Schema and the runtime validator's
source of truth. `validateContributionExport(input)` rejects unknown fields,
non-JSON values/accessors and bundles beyond the 1-MiB strict snapshot bound,
strings beyond 8,192 UTF-16 code units, more than 20,000 JSON nodes or depth 12,
and more than 128 cost sessions. Persisted sources below the raw byte limit may
still exceed these portable bounds; controllers should preflight exportable evidence
before persisting it. Canonical snapshot limit failures report `invalid-input` at
`export`; schema and explicit consistency refusals report `invalid-evidence` at
`evidence`, while lifecycle-decoder failures report `invalid-evidence` at `export`.
The export validator also rejects
malformed structures, secret strings, invalid run/history, contradictory status,
receipt run/contribution/contributor/issue bindings, full signature metadata,
offline Ed25519 integrity, verification consistency and summary identities, returning
a detached bundle. Merged/declined outcomes require the matching lifecycle state,
an observed PR and outcome SHA; unknown has no observed outcome SHA. Historical PR
and verified SHA observations can survive later cancellation/blocking, but cannot
be promoted to a merge/decline claim. Offline receipt integrity never changes
trusted-key or expiry authority in shipping. A tracker-proven `merged_during_revision`
with `observedMergeSha` reports upstream outcome `merged` while execution remains
`blocked`; the legacy block without an observed SHA reports outcome `unknown`.
Neither representation authorizes further execution.
`parseCommandEvidence(input)` is the shared detached receipt/standalone command parser:
it validates the receipt command schema (1–128 records) and unique command IDs,
throwing fixed `ReceiptError('invalid_json'|'invalid_schema'|'invalid_evidence')`
refusals for strict JSON snapshots, schema failures and duplicate IDs respectively.
Credential-bearing strings propagate `SecretRedactionError`.
Validation completes **before** opening the destination. Output ancestors are
pinned without following symlinks; output uses exclusive creation at mode 0600,
fsyncs its file and parent directory, and never overwrites any existing leaf.
An output write/fsync failure is an error, not a successful export; the exclusive
partial file is left for the caller to inspect rather than overwritten on retry.
The exported summary retains expiry-time facts; current status/run and observed
outcome can advance through permitted confirmed lifecycle observations. Historical
non-null verified/outcome SHAs must agree with current observations, and terminal
historical outcomes cannot change. The expiry-time PR URL stays immutable while current
status may name a replacement PR only with a validated append-only tracker `rebound`
chain. The bundle's `relocations` records retain each old/new PR binding, the marker
body and contributor identity: every step must keep the same contributor fork ID,
fork owner/name, branch, base and bound upstream. Each URL is independently checked
against that upstream. Missing, contradictory or unmarked relocation proof refuses
export with `invalid-evidence`; legacy rebound entries without provenance cannot prove
a relocation for export. Tracker observation now persists that provenance only after
the replacement PR and fork identity are read successfully. Both historical and current
URLs and SHAs remain visible; relocation never clears expired-snapshot refusal.
The bundle also retains `originalPr`, the first tracker record's independent binding.
The relocation chain must start at that exact record, and its fork ID, contributor,
base and creation marker must agree with intact receipt-v2 evidence. Receipt v2 signs
numeric repository IDs, not repository names: portable fork names are consistency-bound
to the independent original tracker record, not claimed as signed receipt fields.
Replacement detail author and fork identity are checked before accepting even a
merged replacement, and actual observed author is persisted; absent or contradictory
detail identity cannot produce rebound or merge evidence. Established merged PRs
retain their existing deleted-fork semantics.
`validateRelocationEvidence(input)` validates and detaches this credential-free
tracker provenance, throwing `TrackError('invalid_journal')` on contradiction.
Export status includes `snapshotExpired` explicitly.

Replacement tracking requires `TrackDeps.retainedIdentity`. Obtain it with
`retainedPrIdentity(store)` while holding the RunStore: it validates retained signed
receipt evidence and uses the **held upstream numeric ID**, with the signed fork ID.
Missing authority refuses replacement observation (`unknown`), never a fresh lookup
substituted as authority. Ordinary tracking, including established merged/deleted
fork observations, remains available without this replacement-only input.

`PrIdentity` is the closed canonical tuple `{ upstreamId, upstreamOwner,
upstreamName, baseRef, forkId, forkOwner, forkName, headRef, contributor, number,
htmlUrl, apiUrl }`. `extractPrIdentity(detail)` checks every supplied identity path
enumerated in `PR_IDENTITY_PATHS`, including both PR URLs and repository API/HTML
URLs. Present null/malformed paths or parents contradict the tuple. Optional absent
paths are skipped, but enough observed fields must exist to determine the full
identity without copying expected bindings. Owner/repository names canonicalize to
lower case; refs and URL syntax remain exact. `samePrIdentity`,
`validatePrIdentity` and `prIdentityDigest` compare/validate/hash that tuple.
The replacement's observed tuple must equal retained expected identity **before**
the merged shortcut or any rebound. Each `RelocationEvidence` stores that observed
`identity` and `identityDigest`; sweep/export cross-bind numeric identity to held
authority and intact receipts again. Legacy proofs lacking these fields refuse.
Every claimed non-null verified SHA must match a retained verified candidate;
missing provenance projects null and cannot disable portable validation. Observed
outcome SHA remains independent. A pending
`handoff/events.jsonl.recovery` or `track/events.jsonl.recovery` (including malformed
or symlink intents) refuses maintenance before publication or artifact deletion.
The control-journal recovery check applies equally to already-held stores and fresh
read-only opens. Safe SecretRedactionError diagnostics survive run/config/control
preflight, archive opening and the expired-snapshot guard.

### Maintenance diagnostics and recovery

`MaintenanceError` exposes only fixed `code` and `stage` values; no raw filesystem
message, path, cause or selected source text is echoed. Known-safe `RunStoreError`
and `SecretRedactionError` retain their existing semantics. Injected fault-hook
exceptions propagate intentionally at durable crash boundaries.

| Code | Action |
|---|---|
| `invalid-input` | Correct the root, timestamp, retention override or portable input. |
| `stale-plan` | Close active controllers and obtain a fresh plan; inspect changed or quarantined inodes before recovery. Never delete mismatched held bytes. |
| `invalid-evidence` | Repair/recover the producing controller's confirmed evidence; missing optional evidence cannot substitute for corrupt present evidence. |
| `invalid-summary` | Recover the durable summary/marker pair and manifest; never clear expiry to reuse a snapshot. |
| `size-limit` | Use a supported bounded evidence/inventory format before maintenance; no oversized summary is published. |
| `io-error` | Check storage availability/permissions or use a fresh export destination; an exclusive partial output is preserved. |

Stages are the fixed names `input`, `read`, `inventory`, `evidence`, `summary`,
`revalidate`, `delete` and `export`. A valid crash prefix can be replanned/replayed;
a stale/invalid prefix requires controller recovery rather than blind deletion.

## Development commands

```sh
npm run build --workspace=@ai-dossier/zero-trust
npm test --workspace=@ai-dossier/zero-trust
npm run test:coverage --workspace=@ai-dossier/zero-trust
```

`make build-all` includes this package; `make test` and `make test-coverage`
discover it through the existing `packages/*` workspace glob, including PR CI.

## Durable write intents

`Journal` and `IntentDriver` are controller-only infrastructure. Use a dedicated
controller-owned directory, outside worker filesystems. One controller process must
exclusively own that directory throughout its lifetime (the supervisor must stop
the old controller before recovery). Duplicate opens/drivers within a process are
rejected; this is not a distributed lock or a worker-facing authorization API.

Construct a `Journal`, then an `IntentDriver` with the original run identity,
contribution ID, injected trusted `WriteAdapter`, and an ISO timestamp clock.
`resume()` reconciles pending writes; `execute(input)` also applies that barrier
before admitting any mutation. `snapshot()` returns the durable run and intents.
Close the journal before recovery. Recover with the same run/contribution/target
identity and the controller's current lifecycle record. Its immutable identity and
creation time must match, and its history must extend the journal's history exactly;
rollback and divergent histories are rejected. Newer lifecycle snapshots are fsynced
as `run_update` events. Call synchronous `observeRun(currentRun)` on every live
controller transition, including cancellation and cleanup failure. This takes effect
even while reconciliation is awaiting an adapter response. Already-issued mutations
cannot be recalled; their outcomes are still journaled and reconciled.

`execute` refuses `CONTRIBUTOR_CONFIRMED_OPERATIONS` (`engagement_comment`, `pr_create`,
`pr_update`, `pr_close`) with `IntentError('contributor_confirmed')` before anything is
journaled: those are contributor hand-offs (below). Journals that already hold such
intents stay replayable. Admission is checked after reconciliation: fork/push require
`shipping`. The same table admits the contributor hand-offs for PR edits (`shipping` or
`revising`) and withdrawal (`shipping`, `submitted`, `awaiting_review`, `revising` or
`accepted`, before recording `declined`); a revision updates the PR by `push_branch`.
Terminal states, `blocked_cleanup` and `paused_user` deny every mutation with
`WriteBlockedError`, including retries and calls for already-confirmed intents.
`resume()` may still reconcile attempted/ambiguous intents in these states, persisting
found/absent evidence without writing externally. Legacy journals remain replayable;
historical attempts are evidence, never current admission authority.

The adapter must authenticate artifact ownership/target, enforce current permission
and receipt checks, and implement compare-and-swap branch writes. For push results,
`found`/mutation success must include `remoteSha` equal to `candidateSha`. A different
or missing SHA blocks the run. A truly absent branch is `absent`; inability to prove
absence is `unknown`. No adapter exception text is persisted. An adapter throws
`WriteRefusedError` when it proved nothing unintended was written
(`authorization_refused`) or the remote holds content it must not touch
(`remote_diverged`): the driver blocks with that reason instead of retrying, and the
refusal (with its secret-free `detail`) is the `WriteBlockedError`'s `cause`.
`engagementMarker`/`parseEngagementMarker` are kept only to read legacy journals;
contributor hand-offs use `handoffMarker`/`findHandoffMarkers`.

Only one retry is available after proven absence, including across restarts.
Unknown reconciliation denies all further writes and persists a `PolicyBlocked`
transition from the current run when that edge is legal. Terminal/cleanup states
remain unchanged rather than inventing an illegal transition, but the bounded
reason is still journaled. Proven absence after the final attempt is journaled as
`exhausted`; it cannot enable a retry or repeatedly reconcile on restart.
`snapshot().blockedReason` on a persisted block preserves the bounded reason
(`unknown`, `reconciliation_error`, `invalid_evidence`, `unexpected_remote_sha`,
`retry_exhausted`, `remote_diverged`, `authorization_refused` or `fork_unverified`) without
storing provider exception text. A `reconcile` that throws `ReconcileDeferredError`
(evidence temporarily unreadable: rate limit, network) records nothing and blocks
nothing; `resume()`/`execute()` rethrow it and a later resume reads again. Only positive
evidence blocks. Likewise a `mutate` that throws `MutationDeferredError` (it proved nothing
was sent and no single-use authority was consumed, e.g. a rate-limited preflight or a
busy nonce-store lock) gets its attempt withdrawn (`withdrawn` event), so transient
failures never spend the one retry. A `mutate` that proved nothing was written but whose single-use authority
for the attempt is spent (a consumed receipt nonce, a journaled token mint) throws
`MutationVoidedError`: the driver journals `voided` with its reason. The attempt number is
used up, so the next attempt needs a fresh receipt, but the retry budget is untouched. At
most `MAX_VOIDED_ATTEMPTS` (3) attempts are voided; past that a void counts like any
ambiguous attempt, so attempt numbers stay within `MAX_ATTEMPT_SEQUENCE` (5), which the
receipt and nonce store accept.
Every intent and attempt is fsynced before the adapter runs;
confirmation is fsynced before success returns. File and ancestor directory entries
are fsynced on open. Write uncertainty poisons the live driver; recover from disk
and reconcile before trying again. Only an unparseable final line without its
trailing newline is quarantined, byte-for-byte, in a private sibling file. Open
records `journal_tail_recovered`; a fsynced write-ahead marker makes recovery itself
crash-resumable and idempotent. Complete malformed lines, corrupt middle lines,
invalid complete-prefix UTF-8 and valid JSON without its newline fail closed.
Recovery metadata is strictly validated on replay and grants no authorization. The trusted
storage/supervisor boundary is required: this mechanism cannot defend against an
actor who can rewrite the controller's journal or run a second controller process.

## Contributor hand-off (upstream writes)

Upstream writes (engagement comment, PR creation, and the PR title/body edit, reopen
and withdrawal described under "PR tracking and revisions") are contributor hand-offs, not
brokered writes (owner decision A in the [GitHub credentials decision
record](../../docs/features/zero-trust-full-cycle/decisions/github-credentials.md)).
A person reviews and submits every public submission under their own account. The
run prepares the exact content, issues a link, waits durably in
`awaiting_contributor`, and reconciles what was submitted.

- `buildPrContent` (`src/github/pr-body.ts`) renders the title and body: issue
  reference, cause, scope, LLM disclosure, the receipt's actual commands and
  statuses, regression evidence, permitted baseline failures, limitations, the
  optional receipt block, and the hidden run marker. Model and repository text is
  bounded, cannot forge a marker, and cannot make a blanket success claim. "All
  tests passed" is written only when every command passed. Star requests and
  advertising are rejected.
- `compareLink` / `issueCommentLink` (`src/github/handoff.ts`) take owner, repository,
  base and head only from the controller binding (`prBinding`, `issueBinding`).
  Prefilled fields are URL-encoded. A body that would push the URL past
  `MAX_PREFILL_URL_LENGTH` falls back to a short title-only compare URL plus a
  copy-paste body file. GitHub has no prefill parameter for issue comments, so the
  engagement hand-off always uses the issue link plus a body file. The marker
  `<!-- ai-dossier:ztfc contribution=… intent=… op=… -->` is mandatory in both cases.
- `reconcilePr` / `reconcileComment` (`src/github/reconcile.ts`) are credential-free
  reads (`anonymousReader`). PRs are listed by head + base + `state=all` and matched
  by marker and author. One match is found. Zero keeps waiting. Several matches, a
  match without the marker, one by another author, or a marked PR whose fork no
  longer resolves (found by a base-only scan back to the issue time) is `ambiguous`.
  A PR at a head SHA other than the candidate is `head_mismatch`. A truncated or failed listing is
  `unknown`. GitHub's duplicate-PR 422 is never relied on, because it only holds
  while the first PR is open.
- `HandoffDriver` (`src/github/handoff-driver.ts`) journals `link_issued` and
  `handoff_observed` in its own controller-owned journal directory. Issuing a link is
  never a write, and `IntentDriver` admits no write in `awaiting_contributor`.
  `issuePr` renders the PR content itself from `PrContentInput`. A link is issued
  only after the same admission as a brokered write: fresh policy, verified
  contributor, and for a PR also the verified fork binding, the receipt rendered in
  the body valid for the candidate (`receiptValid(sha, receiptDigest)`), and a remote branch SHA equal to the candidate (`HandoffAdmission`; the
  read-back is `ForkPusher.handoffReadBack(target)` from the verified push, #1066). No link is issued while any PR
  exists on the head/base, or while GitHub cannot be read. `resume()` reconciles
  before anything else. An observed PR moves the run to `submitted`. The journal keeps
  its URL, number, head SHA and state (`open`, `closed` or `merged`; a closed PR is
  surfaced, not hidden), and CI is reported `pending` or `unknown`, never green. An
  observed engagement comment moves it to `awaiting_maintainer`. An ambiguous match
  is a hand-off: the run stays in `awaiting_contributor`, issues no link, tells the
  contributor what to resolve, and reconciles again on resume. A moved head SHA
  blocks the run. Replay re-derives every issued link from its binding, title and
  body, and only the driver's own events may record an observation. `status()`
  shows the link, what it submits, and that the contributor is the author. Nothing
  is scheduled: no reminders, and no compute until an explicit resume.

### PR tracking and revisions

`PrTracker` (`src/github/track.ts`, #1068) takes over once the PR is observed
(`trackFromHandoff(record, fork)`), in its own controller-owned journal. It reads
GitHub only on an explicit `resume()`, `beginRevision()` or `shipRevision()`; nothing
polls, and `status()` reports CI as `not_observed` until a read in this process. It
records PR outcomes, review and revision steps only from its own reads: `observeRun`
accepts lifecycle progress made elsewhere (verification, pause, failures) and refuses
any of those steps (`run_diverged`). After each call, pass `snapshot().run` to the
other drivers' `observeRun`; a restart may hand it an older copy of the run.

- **State from observations only.** `observePr` reads the PR, the fork (bound by
  repository id) and its branch. Open is `awaiting_review`; `merged` is recorded only
  when GitHub reports the merge (even if the fork is gone afterwards), with the head
  it reported; closed and not merged is `declined`. A deleted PR, fork or head branch,
  a fork id that changed, or a head SHA (on the PR or the branch) that no verified
  push left there blocks. A read that fails records nothing (`unknown`, with the
  failed read and its HTTP status as `detail`).
- **Upstream CI as observed.** `observeCi` combines check runs and workflow runs for
  exactly the head SHA and the commit's statuses: `failed`, `awaiting_approval` (a
  fork PR's runs waiting for a maintainer), `pending`, `passed` (at least one success
  and nothing failing or outstanding), `none` (nothing ran, or everything was skipped)
  or `unknown` (a read failed, a listing was truncated, an answer was not understood
  or named another commit). Only `passed` is green, CI is reported only for a head the
  run verified, and the next permitted action says so in words.
- **Re-detection.** When the tracked PR is closed and not merged, `relocatePr` lists
  head + base + `state=all` and keeps PRs with this contribution's marker other than
  the tracked one. Exactly one, by the contributor, is followed; its head must be the
  verified SHA or the run blocks (`unexpected_head_sha`). Several, or one carrying
  other markers, by another account, or whose fork no longer resolves, hand off and
  record nothing; none means `declined`. Re-detection is skipped while a withdrawal
  or a revision is pending. The duplicate-PR 422 is never relied on.
- **Revisions.** `beginRevision()` reads the PR and keeps maintainer feedback
  (`MAINTAINER_ASSOCIATIONS`: OWNER, MEMBER, COLLABORATOR) that is not by the
  contributor or a bot, carries no ai-dossier marker, is not an empty approval, and
  was not addressed by a confirmed revision (an edited item is new). It rechecks
  freshness (`RevisionAdmission`: AI policy, issue, assignment, competing fixes and
  permission; contributor; fork binding) and moves the run to `revising`. A probe
  that answers no blocks; one that throws refuses without recording
  (`freshness_unavailable`, naming the probe). The returned feedback is untrusted
  input for the isolated revision. After independent verification brings the run to
  `shipping`, `shipRevision({ candidateSha, push })` rechecks freshness, blocks on a
  head that is neither the last verified SHA nor the candidate
  (`unexpected_head_sha`), journals the candidate, and pushes through the caller's
  `IntentDriver.execute` (`ForkPusher`: a fresh receipt, CAS from the last verified
  SHA). The revision is confirmed only when the PR head equals the candidate
  (`revised`, back to `submitted`); until then it is `revision_pending`, and
  `shipRevision` with the same candidate is safe to repeat. A CAS refusal blocks
  (`push_blocked`). A PR closed mid-revision issues a reopen action and pushes nothing
  while it is closed; a PR merged mid-revision blocks (`merged_during_revision`).
- **Contributor actions.** `requestEdit({ title, body })` (during a revision) and
  `requestWithdrawal({ reason, explanation })` (maintainer request or user
  instruction; not during a revision) write the prepared text to a body file whose
  digest covers exactly the file, and return the PR link and instructions. An edit
  must keep the PR's marker, may carry no hidden comment or invisible character, and
  is recorded only when a read shows the same title and body; it stays pending across
  a confirmed revision. A withdrawal comment carries its own `pr_close` marker; the
  run records `declined` only after it observes the PR closed, deletes nothing, and
  sends no follow-up. `cancelAction()` drops a pending action without touching GitHub.

## Controller-side model harness (#1094)

Decision: [model harness A/B/C](../../docs/features/zero-trust-full-cycle/decisions/model-harness.md).
`ModelAdapter` has `id` (pricing resource/model name) and
`complete(ModelRequest): Promise<ModelResult>`. Requests contain `system`,
`messages`, `tools`, positive safe-integer `maxOutputTokens`, `timeoutMs`, optional
`signal` and `attempts: 1 | 2` (default 1). Messages use user/assistant/tool roles;
assistant tool-call arguments are JSON strings and tool replies bind `tool_call_id`.
`ModelTool` is a function name/description/JSON-schema parameters definition.
`ModelResult` is `tool_calls` (`calls: { id, name, arguments: unknown }[]`), `text`
(`text`) or `malformed` (`reason: MalformedReason`), plus `usage: ModelUsage | null` with
`inputTokens`/`outputTokens`. `ModelMessage` is a role-discriminated union;
`ModelToolCallWire` models assistant calls and `ModelToolCall` models parsed proposals.
Malformed reasons are `invalid_response`, `response_too_large`, `secret_detected`.
Valid numeric usage survives malformed content, including rejected secrets; missing,
unreadable, oversized or invalid-usage bodies report null usage. Retried calls always
report null usage. Text accepts `finish_reason: stop` with absent/null/empty calls;
tool proposals require `finish_reason: tool_calls` and a nonempty list.
Only a complete single choice is accepted; unknown
tools, duplicate IDs, invalid JSON, truncation and arguments over
`MAX_TOOL_ARGUMENT_BYTES` (64 KiB UTF-8) are malformed. Proposals still require
`admitModelAction`; this transport invokes no tools and grants no authority.

`new OpenAICompatibleAdapter({ model, endpoint, apiKeyEnv, fetch })` checks a
nonempty environment key at startup and re-reads it at call time. HTTPS is required
except HTTP on `localhost`, `127.0.0.1` or `[::1]`. Query/fragment delimiters (even
empty ones) and credentials in endpoint URLs are refused; redirects
are disabled. It POSTs to the API base plus `/chat/completions`, with `tools`,
`max_tokens` and `stream: false`. The API key goes only in Authorization.
`apiKeyEnv` must be a shell environment identifier; model/endpoint strings pass
secret-pattern guards. Reserved GitHub-authority variables (`ZTFC_*`, `GIT_*`,
`GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_CLIENT_SECRET`) and GitHub-token key values
are refused by the adapter; no credential-module import is needed for this fence.
Response and parsed-argument nesting beyond 256 levels is `invalid_response`.
Invalid options give `invalid_request`; absent/empty keys
give `model_unavailable`, as do keys outside visible ASCII (the exact value
must match what the Authorization header sends). Local servers should use a long
dummy key: even a short placeholder is rejected if echoed in ordinary output.
There is no logging, credential field or raw provider error. Echoed keys and credential
patterns are rejected. Response bodies are capped at 1 MiB. Errors are bounded
`ModelError.code` (`invalid_request`, `model_unavailable`, `model_timeout`,
`model_aborted`, `model_http`); HTTP errors carry only numeric `status`.

`meteredComplete(adapter, ledger, sessionId, rates, request)` snapshots JSON input,
estimates input tokens conservatively as UTF-8 bytes of the serialized wire request
(including model and tool schemas), and reserves all output tokens/time/attempts
before calling. Rates are `BudgetRate[]` keyed by adapter ID, in the session's
currency. One token rate prices BOTH input and output: configure at least the higher
provider price for conservative admission. Split input/output pricing is not supported.
Reservation refusal throws `BudgetExhaustedError` with a limit/ceiling
code and calls no provider. Other ledger errors retain their typed semantics.
Observed usage is priced with pinned rates and settled; missing/invalid usage,
errors and timeouts use `settle(id, null)`, preserving the full hold. Accounting
keeps `max(estimate, observed)` as the existing ledger specifies; it never frees
money, tokens or time merely because observed usage was lower. Per-call token
commitment is `(wire bytes + maxOutputTokens) × attempts`; time commitment is
`timeoutMs × attempts`. Session limits must cover these conservative quantities.
An already-aborted caller is refused before reservation. The caller decides pause/failure
and explicitly reconciles unknown reservations on resume.

Both the transport and metering wrapper enforce a deadline and caller cancellation,
including a hanging body or injected adapter. `attempts: 2` authorizes at most one
retry on 429/5xx. Each attempt has its own `timeoutMs` bound; metering's outer
deadline is `timeoutMs × attempts`, at most `MAX_MODEL_TIMEOUT_MS` (Node's timer cap).
The second attempt's deadline includes a 50 ms fallback backoff, or the response's
`Retry-After` delay (seconds or date); a delay beyond its allowance refuses the retry.
Direct adapter callers must first reserve both attempts or use
`meteredComplete`. A retried result reports null usage because the failed attempt's
charge is unknown. No retries of malformed answers, other HTTP errors or transport
errors, and no provider fallback. Zero-priced models still require rates and
positive token/time ceilings. Output caps are sent to the provider; the adapter
cannot guarantee provider billing behavior.

Exported helpers `snapshotModelRequest`, `modelRequestBody` and `withModelDeadline`
share wire estimation/deadline behavior with compatible adapters. The snapshot
returns `SnapshotModelRequest` with attempts filled in. `MAX_MODEL_RESPONSE_BYTES`
exports the 1 MiB body cap. `observeModelBudget({ currency, resource, inputTokens,
outputTokens, timeMs }, rates)` prices actual usage, including zero output, with
shared safe-integer budget arithmetic; unpriceable usage retains an unknown hold.
Tests can reuse
`src/model/__tests__/scripted-model.ts:ScriptedModel` (not a production export).
An empty tools list permits text-only requests (`tools` is omitted on the wire when
empty). Optional `ModelRequest.logprobs` requests token likelihood metadata;
`ModelResult.tokenLogprobs` contains finite non-positive token log likelihoods when
the adapter exposes them. Missing/null metadata remains absent; malformed supplied
metadata fails closed. The controller execution loop is a separate slice.

## Typed decisions (#1119)

`createTypedQuestion(definition)` constructs a detached, frozen `TypedQuestion`;
`decide(question, inputs, { provider, floor?, cache?, budget, passes?, signal? })` revalidates
even directly supplied definitions. Questions have trusted `id`, `version`, `prompt`,
`escalateValue` and `acceptThreshold` (one finite [0,1] probability per answer).
The escalation sentinel is outside the closed answer set. Invalid definitions throw
non-echoing `InvalidQuestionError` before any call:

- `boolean`: real booleans, thresholds keyed `true`/`false`; true is permissive
  (strictness 0), false restrictive (1).
- `choice`: 2–64 distinct nonempty `options`, and exact finite numeric `strictness`
  keys. Higher is stricter; equal ranks are allowed.
- `score`: 2–64 distinct nonempty `scale` labels, least-to-most strict.

Policy consumers can select `citationMode: 'verbatim'` to require raw, literal quote
spans and preserve CR/LF source-file line numbers, including on cache reads. The
default `normalized` mode retains whitespace-normalized citations and the existing
Unicode line splitting. Citation mode is part of the decision cache identity.
`evaluateDecisionFloor` is the shared synchronous floor validator used when trusted
consumers compose restrictions: thenables, unknown keys and malformed values
escalate instead of being sanitized away.

Strictly more permissive answers require strictly higher thresholds. The trusted
question must encode the domain's ordering; untrusted text cannot choose it.

Before any floor/cache return or provider dispatch, `decide` checks the current
ledger session read-only with `isBudgetSessionExhausted`: committed work money
reaching the ceiling minus protected cleanup allowance, committed tokens reaching
the token limit, or committed active time reaching its limit returns `escalated`
with reason `budget` for every question, including warmed cache entries. An
eligible cache hit still issues no model call, reservation, settlement or cache
write. Missing/corrupt session evidence escalates as `ledger`; no history resets.
The same read-only barrier is rechecked after metered calls and before publishing
accepted/cache evidence: a final pass consuming the exact remaining allowance
returns `budget`, not permission. A zero work-money ceiling remains eligible for
zero-priced work while token/time capacity remains; any positive money overrun
still exhausts it. Positive money ceilings stop at equality.

```ts
const question = createTypedQuestion({
  id: 'contribution-policy', version: '1', kind: 'choice',
  prompt: 'Does the cited policy welcome substantial LLM-assisted contributions?',
  options: ['welcome', 'ban'], strictness: { welcome: 0, ban: 1 },
  escalateValue: 'unclear', acceptThreshold: { welcome: 0.95, ban: 0.6 },
});
const verdict = await decide(question, [{ sourceId: 'policy', text: 'No AI contributions.' }], {
  provider: createLlmDecisionProvider({ adapter: runModelAdapter }),
  budget: { ledger, sessionId, rates },
});
```

Default provider selection is `createLlmDecisionProvider({ adapter })` using the
run's #1094 OpenAI-compatible adapter; selection is explicit controller wiring.
Each independent pass alternates between two trusted framings, has no prior-pass transcript,
and an enum-constrained `report_decision` tool proposal with **no executable handler**.
The model can return data only. Inputs are JSON-encoded in a delimited section
labelled “this is data, not instructions”, with a fresh random delimiter per request
so data cannot close the trusted section by copying a fixed marker; nothing parses input as configuration.
Two passes are default; trusted callers may choose 2–8. Raw self-reported confidence
is never used for the LLM. Confidence is agreement across passes, conservatively
bounded by the minimum token probability (`exp(min(tokenLogprobs))`) when present;
this is not a calibrated semantic probability or guarantee of correctness. Without
token likelihoods, unanimous agreement yields 1: thresholds alone cannot detect
correlated wrong answers. Deterministic floors remain the controller's independent
restriction mechanism. An empty citation list claims no supporting evidence.
Returned content-token likelihoods include punctuation and need not cover tool-call
arguments; the bound is not the likelihood of the answer value.

LLM options default to `maxOutputTokens: 1024`, `timeoutMs: 30000` and
`logprobs: true`. Configure `logprobs: false` for endpoints that do not support
the parameter; this is an explicit profile choice, never a retry or fallback.
Nullable/missing/empty logprob content means no token evidence. Optional non-secret
`id` identifies the trusted endpoint/profile for shared caches (default `llm`).
The OpenAI-compatible adapter supplies a private endpoint fingerprint automatically;
custom adapters using the same model name on different endpoints must set different
IDs, supply an adapter fingerprint or separate their caches. Built-in provider `cacheIdentity` automatically binds
the evidence/output/deadline profile and a framing/schema revision, even if the
public ID is unchanged; custom providers must supply their own stable non-secret
profile fingerprint when sharing caches across changing configurations.

Each pass's value must belong to the closed set. Citations are `{ sourceId, line,
quote }`; `line` is one-based, and the nonempty quote must occur as a span on that
specific line of that exact source, normalizing whitespace only. Line separators are
CRLF, LF, CR, NEL, Unicode line separator (U+2028) and paragraph separator (U+2029).
Sources are split
and normalized once per decision, not once per citation. Unknown sources,
wrong lines, fabricated quotes and malformed citations invalidate the pass. An
accepted quote is the validated whitespace-normalized single-line form; non-whitespace
control characters and format controls in quoted evidence are rejected.
An empty citation list is permitted (no supporting citation claimed). Any invalid pass,
provider failure, disagreement or insufficient confidence escalates, never majority
votes into permission. Unanimous restrictive answers can meet the lower threshold.

Optional synchronous deterministic `floor(question, inputs)` returns
`{ minimumStrictness?, escalate? }`. It is evaluated before cache lookup. A stricter
floor than the unanimous answer escalates; it never substitutes a permissive answer.
An invalid/throwing floor escalates as `configuration`; intentional floor refusals
use `floor`. Questions and inputs are immutable snapshots
across awaits. Inputs are at most 256 unique sources and 1 MiB total serialized data.
Exceeding either limit returns `reason: 'input'` with the actual canonical input
digest and no provider call. Structural errors (duplicate IDs, bad types/keys),
invalid pass counts/provider identity throw non-echoing `InvalidDecisionError`
(`code: inputs | configuration`) before admission. Invalid questions throw
`InvalidQuestionError`; secret-bearing provider identity throws `SecretRedactionError`.

`Verdict` carries `value`, `confidence`, `citations`, `status`, bounded `reason`,
`provider`, `model`, `questionVersion`, and SHA-256 `inputDigest`. Every output passes
the shared secret guard. Both raw inputs and normalized source lines are scanned
before sending, so whitespace normalization cannot introduce an unguarded credential
pattern. Secret-bearing inputs are refused before sending; raw
provider errors are never returned or logged. Decision modules import no GitHub
credential modules. These verdicts grant no write/execution authority by themselves.
`Verdict` is status-discriminated: consumers must first require `status: 'accepted'`,
then interpret its closed answer (an escalated boolean question has a string sentinel,
not a boolean). Accepted citations concatenate the passes and may include duplicates.
The conservative secret policy also refuses documentation examples such as an
authorization header with a placeholder; sanitize source acquisition deliberately,
never weaken the shared credential policy to force a verdict.

Every pass goes through `meteredComplete` with the supplied durable ledger/session/
rates. No call happens without reservation; exhausted admission returns an escalated
verdict with `reason: 'budget'`. Failed calls retain conservative unknown holds.
`reason` also includes `invalid_pass`, `provider`, `confidence`, `disagreement`,
`floor`, `secret`, `cache`, `cache_write`, `ledger`, `configuration`, `aborted`,
`input` or `accepted`. Non-exhaustion ledger errors (missing rates/session, resume
fences, locking/persistence failures) are `ledger`, not provider failures. Rates
must match the provider's `model`. Optional `deps.signal` stops before admission,
interrupts active adapter calls and refuses subsequent passes. Unknown charges
after interruption/error retain their holds and require controller reconciliation
before a reopened ledger can admit new work. Trusted request/decode dependency
violations are `configuration`. No transient failure is cached.

`DecisionCache` is a synchronous `get`/`set` store in controller-owned trusted
storage, exclusively owned by the single controller, outside worker write access
(not an authenticated receipt). `get` returns unknown evidence for validation;
`undefined` or `null` means cache miss.
`set` must return `undefined`, never a Promise. Accidental asynchronous implementations
are refused and rejected promises are handled. Keys bind
question ID/version, provider ID/model and SHA-256 inputs, plus the complete question,
pass count, confidence mode, provider profile fingerprint and evaluated floor. Changed thresholds/prompt/floor
cannot reuse old permission. Key-sorted canonical JSON makes object property order
irrelevant to digests. Accepted and model-derived escalated results are detached on write/read and
revalidated; cache errors or corrupt evidence escalate. A cache hit makes no provider
call or new reservation. Identical questions return the same cached verdict,
including `invalid_pass`, `disagreement`, `confidence` and post-pass `floor`
escalations: re-asking cannot cherry-pick permission after uncertainty. Transient
budget/provider/ledger/secret/cancellation/cache failures remain uncached. A failed
cache write returns `cache_write` so paid-for computation is distinguishable from
corrupt/missing cache-read evidence. Uncertainty dominates overlapping synchronous
cache writes in this controller; accepted results can only become stricter, and
uncertainty cannot be overwritten with permission. They may still spend on duplicate passes.
Re-check reproducibility requires a working durable cache and unchanged identity;
failed persistence never grants permission, and the controller must repair it before
relying on cached uncertainty across restarts. No distributed cache/CAS is provided.

`createExternalDecisionProvider({ endpoint?, apiKeyEnv?, model?, id?, fetch, timeoutMs?,
maxOutputTokens? })` opts into a generic **Jev-style adapter shape**, not a claim
of compatibility with a particular vendor API: POST `{ question, inputs }`, accept
`{ value, probability, citations? }`. Adapt a vendor endpoint to this shape at the
trusted controller boundary. Configured external probability is used as supplied
(minimum across agreeing passes); values/citations still validate. Omitted citations
mean `[]`. HTTPS, no redirects, a 64 KiB UTF-8 response limit, deadlines, no retry
and no fallback apply. `id` is a public non-secret label (default `external`). A
private endpoint/profile fingerprint binds cache separation but is never returned
in verdicts: neither the endpoint hostname/path nor its hash is public evidence.
The controller supplies an environment variable **name**, never a key in question/
inputs; the transport validates it before admission and re-reads it at dispatch.
Keys use at least eight ASCII letters,
digits, `_` or `-`, and cannot be GitHub authority. Reserved GitHub environment
names are refused. Missing configuration/key, HTTP errors, malformed answers,
timeouts and key echoes escalate. Both endpoint/key-variable omitted means disabled;
partial/invalid configuration throws `ModelError('invalid_request')` at construction.
Disabled/keyless providers return `configuration`, reserve nothing and send nothing. Defaults are
`model: 'external-decision'`, `timeoutMs: 30000`, and output bound 65536.
Responses are limited to the smaller of 64 KiB and the configured byte-equivalent
output bound. External passes send 2–8 repeated independent HTTP requests with identical bodies,
not LLM-style alternating framings. This does not modify the existing `RunConfig`
schema or wire subsequent policy/controller consumers.

External calls use the same metered adapter boundary: explicit token-equivalent
rates for `model` and conservative input-byte/output/time upper bounds. Output
defaults to 64 KiB token-equivalents. Successful transport observes actual request/
response bytes as local token-equivalents (not claimed as provider-reported tokens),
and settles the reservation: the ledger still commits the larger estimated bound,
but a successful call does not leave an unknown hold blocking resume. Failed
transports keep unknown holds. Configure
rates/bounds for the service's billing contract (including zero-price service rates).
These byte-equivalents count toward the shared session token limit; two default
passes reserve at least 131072 output token-equivalents plus request bytes;
this is conservative admission, not a provider billing guarantee. There is never a
silent LLM ↔ external fallback. All tests inject fake providers/transports only.
Complete invalid responses (including unknown tools or garbled JSON arguments)
are cached `invalid_pass` escalations; re-asking cannot discard restrictive evidence
from earlier passes. Actual transport failures with no complete response and oversized
responses are uncached `provider` failures; secret outcomes are uncached `secret`.
A prior pass followed by a real transport failure still requires controller judgment
on retry, not a claim of reproducibility without a completed decision/cache write.
Custom adapters omit `tokenLogprobs` when unavailable; when present it must be a
nonempty finite non-positive array (an empty custom array is invalid). Adapter
`malformed` invalid-response outcomes include known usage when available. Complete
external invalid/secret responses settle their measured byte-equivalents, so they
do not leave an unknown hold solely because content was invalid. Public helpers include
`questionValues`, `questionStrictness` (rejects out-of-set values),
`validDecisionProbability`, and the exported `DEFAULT`/`MIN`/`MAX_DECISION_*` limits.

## Budget admission ledger

`BudgetLedger` is a separate controller-owned local-file admission primitive. Create
it once with `initialize(requiredResources, injectedRates)`, then `startSession`
with a unique session ID, finite minor-unit ceiling, cleanup allowance and positive
token/time limits. A revision gets a new session; opening/resuming never initializes
or rewrites history, and model changes do not rewrite prior pricing evidence.

Use `estimateBudget(request, rates)` before model calls or resource allocations,
then `reserve(sessionId, estimate, 'work')` **before** the action. Rates include a
source, pricing unit/batch size, currency, rational minor-unit FX conversion and
timestamp. Missing rates (including for free models) block startup/admission.
All arithmetic is integer, rounds charges upward, and rejects unsafe overflow.
The helper includes all attempts, input/max-output tokens, streaming duration and
optional streaming charges, rounded-up VM billing increments, and retained storage.
Token/time ceilings apply cumulatively to work even at zero incremental cost.

`settle(id, observed)` stores provider-reported money/usage/source separately from
the estimate; conservative accounting uses the larger amount per dimension.
Provider overruns remain visible and deny further work rather than being capped.
`settle(id, null)` retains the full unknown hold. `release(id, noChargeEvidence)`
is an explicit controller reconciliation that requires evidence no billable action
occurred. Repeated reconciliation fails closed; retain and use the reservation ID.
`snapshot()` exposes the contribution's entire history; `budgetTotals(state, id)`
returns spent/reserved/usage per session. Do not add different currencies together.
Only controller-authorized `teardown` reservations can access the cleanup allowance;
their commitments plus the new estimate may not exceed
`cleanupAllowance + max(0, ceiling − cleanupAllowance − work commitments)`.
Commitments include pending estimates and settled `max(estimate, observed)` charges,
excluding released reservations. Work overruns may put aggregate spending above the
session ceiling, but cannot consume the remaining cleanup allowance. Teardown
bypasses work token/time admission limits while retaining monetary accounting
and the cleanup-funds ceiling. Admission uses exact bigint totals; public
numeric `budgetTotals` rejects unrepresentable sums rather than capping them.

Mutations re-read and validate every row under an exclusive file lock and persist
via unique temp file + fsync + same-directory rename + directory fsync. Unknown
reservations survive a process crash. Missing/corrupt history is never reset.
Locks record PID, boot-ID/process-start-ticks token, creation time and unique ID.
An orphan is reclaimed only on proof of PID absence or a different start token;
live owners are never age-reclaimed. Unknown/legacy owners and unavailable process
evidence still block admission (`lock_timeout`). Reclamation is fsynced into
`<ledger>.recovery-journal/events.jsonl` before removing the dead owner's lock;
long basenames use `.zt-budget-recovery-<SHA-256-of-basename>/events.jsonl` in the
same directory. Reserved controller metadata paths are rejected so a second ledger
cannot replace another store's permanent guard or journal.
When `.lock.guard` would exceed the filename-component limit, both owner lock and
permanent guard use `.zt-budget-lock-<SHA-256-of-basename>.lock[.guard]` instead.
Mappings for existing shorter filenames are preserved.
Opening an existing ledger captures all pending reservation IDs as a resume barrier,
even if the old controller released its mutation lock before crashing. Dead-lock
recovery adds all pending IDs to that barrier and its durable audit. Unresolved
work holds fence new work but leave teardown available. An unresolved teardown
hold fences both work and teardown until explicitly settled or released.
Missing or empty journals within an existing recovery directory
fail closed. Deletion of the entire audit directory is outside the trusted-storage
contract: stop all existing handles and reopen before reconciling every old hold.
`settle(id, null)` does not clear the fence.
Every guarded admission also checks the freshly loaded rows: holds not acknowledged
by a successful complete transaction of that exact ledger instance require
reconciliation, even when the handle opened before another writer's final hold.
Locally acknowledged holds may coexist; their full estimates still count.
Teardown always retains its protected allowance and monetary accounting ceiling.
Never infer safe lock removal from age or a PID alone. Leftover temp files are
not committed state. Filesystem errors propagate; after write uncertainty reload
and reconcile before retrying an action. A write/fsync failure poisons the live
instance (`persistence_uncertain`); the complete state may already have committed.
Its owner lock is retained on uncertain persistence, so another instance cannot
steal it while that process is live. After owner death, reconcile before admission.
Finalization errors after a committed mutation poison the caller and restore the
same owner record before releasing the kernel guard. If that fence cannot be
persisted, the guard remains held until process termination. Stop the failed
controller before reopening; retrying a live poisoned instance is not recovery.
Directory aliases resolve to one canonical lock path; ledger symlinks are refused.
Use a pre-provisioned durable local
directory exclusively controlled by the controller; no network filesystem or
worker write access. The ledger neither invokes nor enforces provider token/time
limits: execution adapters must honor the admitted maximums, and pricing is an
estimate rather than a provider billing guarantee. It is not yet an execution
engine integration or the complete S1 release gate. Store locks require Linux
`/proc` and `/usr/bin/flock` from util-linux. A permanent private `.lock.guard`
inode holds the kernel lock for the whole transaction, including reclaim; never
unlink/replace guard files. The inherited open description keeps the lock held
after flock exits, and kernel process death releases it. Unsupported platforms,
missing flock or unreadable process identity fail closed. This is local controller
storage, not a distributed lease.
All store participants must share a stable PID namespace and a matching `/proc`
mount. Owner records bind that namespace; mismatches and namespace-less legacy
owner records fail closed. Never share controller stores across isolated container
PID namespaces. First reclaim audits publish from a complete fsynced staging
directory; unpublished staging remnants are not committed history.

## Canonical source and candidate identity

`exportSource(root, limits?)` requires a source-only directory. It rejects `.git`
at any depth; it never silently omits a checkout's configuration or submodules.
Export currently requires Linux with `/proc/self/fd` and no-follow directory opens;
unsupported platforms fail closed. Ancestor directories and children are opened
without following symlinks, directory enumeration is streamed in bounded batches,
reads are byte-bounded and identity/metadata changes
around reads are rejected. The worker supervisor should freeze source before export.
The snapshot contains copied, immutable base64 bytes, executable modes, directory
entries and SHA-256 hashes. No shipping operation re-reads the mutable filesystem.
Hard links are accepted as regular file bytes, never preserved as links.

Default limits: 10 MiB/file, 100 MiB total, 10,000 entries, 64 path components.
Paths must be valid UTF-8; absolute/traversal paths, controls, Windows separators,
drive delimiters, `.git`, and Unicode/case-fold aliases are rejected. `.git`
component rejection includes NTFS trailing ASCII spaces/dots and case-insensitive
`git~<single digit>` short names, plus HFS-ignorable spellings, at every depth.
Collision comparison strips Git's HFS ignorables (U+200C–U+200F, U+202A–U+202E,
U+206A–U+206F, U+FEFF), then conservatively uses NFKC plus expanding upper/lower case folds; names
are never silently normalized. Empty directories remain in the manifest binding
but do not appear in the Git tree, as in ordinary Git commits. `validateManifest`
revalidates persisted records and returns deep-frozen primitive snapshots.

```ts
import { exportSource, createCandidate, reconstructCandidate } from '@ai-dossier/zero-trust';

const manifest = exportSource(controllerSuppliedSourceDirectory);
const candidate = createCandidate(manifest, {
  baseSha: controllerRecordedUpstreamBaseSha,
  author: {
    login: authenticatedContributorLogin,
    name: approvedAuthorName,
    email: approvedAuthorEmail,
    timestamp: '2026-10-05T10:00:00Z',
  },
  committerTimestamp: '2026-10-05T10:01:00Z',
  message: 'fix: approved contribution\n\nLLM-assisted via ai-dossier.\n',
}, upstreamObjectPack);
// Persist manifest, record and authority in durable controller-owned storage.
// Keep authority OUTSIDE worker write access; it is not a worker-supplied hash.
const rebuilt = reconstructCandidate(manifest, candidate.record, candidate.authority, upstreamObjectPack);
// Verify and ship ONLY rebuilt.record.candidateSha (and its matching pack).
```

The caller authenticates contributor approval and upstream base acquisition.
Pass a complete SHA-1 Git object pack containing the supplied base and its object
closure (maximum 128 MiB input). A raw pack has no config/refs/hooks/alternates.
The primitive imports it with strict object validation into a fresh private bare
repository, validates the baseline with the same source/path/size rules, then
constructs one tree/commit using `hash-object --no-filters`, `mktree`, `commit-tree`.
Creation and reconstruction then run `fsck --strict --full --no-dangling` over
the candidate objects before returning authority or pack output. This independent
gate rejects unsafe objects even if source-path validation regresses, including
Git's security-sensitive `.gitmodules`/`.gitattributes` content checks. Any fsck
failure maps to the non-echoing `CanonicalError('invalid_path')` reason.
It never opens a worker repository or runs checkout/add/diff/filter drivers.
In-tree `.gitattributes` is preserved as data and cannot affect blob bytes.
Git runs from `/usr/bin/git` with an allowlisted environment, private empty home
under a fresh `/tmp` directory (inherited `TMPDIR` is ignored),
no templates/system/global config, disabled hooks/credential helpers/attributes,
no replacements and `protocol.allow=never`. Subprocesses have a 60-second timeout
and 128 MiB output cap; supervise controller resources independently for large or
hostile compressed object packs. Candidate reconstruction needs no protocol exception.
Source fetch adds a credential-free HTTPS exception under the receive-file bound
described above. Fork push adds its own exception: `exec`/`execAsync` accept the broker credential's
`GIT_CONFIG_*` set (which allows HTTPS) and nothing else that could change the
hardening, and the push runs asynchronously with a 120-second timeout so an aborted
lease kills it.

Author fields/timestamps and the message are fixed once; UTC timestamps require
whole seconds. The disclosed fixed committer is `CANONICAL_COMMITTER`. Raw commit
bytes are checked after creation. Persisted authority binds parent, approved
contributor and canonical record digest; changed manifest/tree/author/message/SHA
fails with a non-echoing typed `CanonicalError.reason`. JSON roundtrips reconstruct
identical SHAs. Creating a new record from edited inputs is a new candidate and
requires new verification; neither the binding digest nor these primitives issue
a signed verification receipt or authorize a GitHub write (#1008).

Adversarial tests use real symlink/FIFO/socket/files, malformed raw baseline trees,
gitlinks, no-follow race injection, and executable malicious filter/hook sentinels
with positive execution controls. Device rejection uses an actual `/dev/null` stat
injected at the source lstat boundary so the test requires no mknod privileges.

## Controller-signed receipts

`issueReceipt(input, signer, now)` accepts independently supervised command evidence
and the actual `@ai-dossier/core` `Signer` interface. Only Ed25519 is admitted. The
controller owns the private key and signer; neither belongs in worker/model tools.
The signature covers canonical sorted-key JSON bytes, including all identity,
profile/policy, command, network and operation bindings. `receiptDigest` hashes those
same bytes with SHA-256. Schema version is `ztfc-receipt-v2` (v2 added the required
`profile.accelerator`, `kvm` or `tcg`).

`verifyReceipt(envelope, trustedControllerKey, context, now)` verifies integrity,
controller key material, exact authenticated identity/SHA bindings, and the trusted
profile's required command list. It does **not** authorize a write or consume a nonce.
The caller obtains `context` from fresh authenticated facts and policy/checkpoint
checks, never from the receipt itself or worker output. Its `allowedShippingOperations`
is a fresh authenticated kind/target/expected-remote allowlist; a valid signed grant
cannot widen that current scope. Command statuses are
`passed | failed | inconclusive | skipped`. This conservative slice requires all
commands passed, exit zero and a positive known suite count to earn `verified`;
unknown discovery cannot authorize shipping. All configured required verification
commands must appear verbatim. Unknown or zero discovery requires a hand-off; never
invent counts or omit required checks to obtain authorization.

Use `authorizeShipping` inside the trusted `WriteAdapter.mutate` after `IntentDriver`
has persisted its attempted intent. Pass the exact expected remote SHA (`null` for
PR operations) and a `ReceiptNonceStore` in a **separate, controller-owned local
directory**. The context must carry the run's `boundaryEvidence` (from
`evaluateBoundary` with that run's ID): anything but that run's clean held verdict is
refused (`boundary_not_held`, `boundary_evidence_missing`, `boundary_wrong_run`) before a
nonce is consumed. Grants bind the existing `idempotencyKey`, operation kind/target,
expected remote SHA and a unique controller-generated nonce. Receipts expire exactly
15 minutes after issuance. Each grant is consumed and fsynced before authorization
returns. The returned grant permits only that one mutation, not repeated calls.
The store also fences repeated authorization of the same intent attempt even across
newly signed receipts/nonces. A new attempt number comes only from IntentDriver's
durable retry after reconciliation proved absence; it still requires a fresh grant.

Provision the nonce directory first; call `initialize()` only on first creation.
Never initialize/reset it on resume. Missing/corrupt complete history fails closed;
Initialization publishes a durable `nonce-initializing` intent before the complete
atomic header. A restart completes that intent before authorization. Legacy torn
first headers recover only with offset-zero quarantine evidence matching an exact
prefix of the fixed header; unknown or populated corrupt histories never reset.
the final torn-line recovery above preserves all completed consumptions.
The same Linux ownership proof and permanent kernel guard serialize independent
processes. Dead-owner reclaim is fsynced to `lock-recovery/events.jsonl` in the nonce
directory before its lock is removed. On uncertain persistence the instance is
fenced and its owner lock retained; a still-live owner cannot be reclaimed, even
by another instance in that process. Reopening after proven owner death replays
the consumed nonce/attempt set before any authorization. The controller must still
reconcile the journal and external mutation through `IntentDriver`. A consumed nonce
stays consumed after a crash or lost response. Reauthorization requires reconciliation,
fresh policy checks and a new controller-issued grant for the same verified candidate;
the store provides no automatic retry or external write. Assumptions: one trusted
controller authority, durable local filesystem with exclusive create/fsync semantics,
no worker access or administrative deletion of the consumed history; not NFS.

`renderReceipt(receipt)` emits an optional escaped collapsible evidence block, only
when upstream policy/template allows it. It rejects credential-pattern strings and
never prints raw logs. Rendering does not authenticate a signature; its evidence
claim is limited to the exact candidate and is not proof of patch correctness.

## Ecosystem support and package proxy (gate 2)

`src/ecosystem/` holds the VM-independent parts of feasibility gate 2; the in-VM proof is
`src/__tests__/vm-proxy.e2e.test.ts`, which drives the production evidence runner (see
[Evidence runner](#evidence-runner-1095)), with the host proxy stack in `scripts/zt-proxy.mjs`.
Design, evidence and verdict:
[package-proxy decision record](../../docs/features/zero-trust-full-cycle/decisions/package-proxy.md).

- `detectEcosystem(files)` (or `sourceFilesFromManifest(manifest)` first) accepts npm with
  `package-lock.json`, pip with a fully hash-pinned `requirements.txt`, and uv with
  `uv.lock` (virtual projects only; a project that installs itself is
  `project_build_required`). Everything else returns `unsupported_environment` with a
  specific reason.
- `selectProfile(detection)` picks a runtime from the versioned `profiles.json` that
  satisfies every project declaration and never substitutes a version.
  `recordProfileSelection` / `loadProfileRecord` store the choice once per run and
  re-verify it before execution. `profileReceiptBinding(record, accelerator)` gives the receipt's
  profile fields, with the accelerator taken from the VM handle.
- `buildCommandPlan(manager, proxy, options?)` returns provisioning (`package_proxy`) and
  verification (`none`) commands as argv data. `options` sets test targets (e.g. the
  regression test), timeouts, the profile's interpreter, and the environment directory,
  uv export file and junit report path, all outside the repository. Test commands carry
  `captureReport`; `parseJunitReport` turns the supervisor-read report into the suite
  count classification needs. uv provisions from an offline `uv export` of the lock, not
  `uv sync --frozen` (which fetches the lockfile URLs directly). `src/ecosystem/`
  executes nothing; the evidence runner runs the plans through a `VmAdapter`.
- `classifyOutcome`, `classifyRegression`, `applyProvisioning` and `applyVerification`
  treat timeouts, unreadable reports and zero suites as `inconclusive` (as are report case
  counts that contradict the exit status: exit 0 with a failing or no executed case, or a
  non-zero exit with no failing case), map provisioning
  failures to `unsupported_environment`, and enforce the two-repair cap from run history
  (`assertRepairAllowed`). `classifyCommand` adds the rule for setup steps without a
  report (exit 0 passes, other exits fail, a timeout or signal is `inconclusive`);
  `commandEvidence` (status from `classifyCommand`) and `overallStatus` build receipt evidence.
- `PROXY_POLICY`, `evaluateRequest`, `evaluateRedirect`, `buildLockIndex` and
  `checkArtifact` define the proxy policy. `renderSquidConfig`, `renderVerdaccioConfig`,
  `verdaccioEnvironment` and `proxpiEnvironment` render it for the OSS components that
  enforce it; `parseSquidAccessLog` reads Squid's evidence log. Registry addresses and
  hash formats live in `registries.ts`.
- `scripts/zt-proxy.mjs up|check|down` runs the stack on the controller host (Docker):
  Verdaccio and proxpi (with `proxy/zt_proxpi.py`, which requests canonical index URLs so
  no redirect is needed) on an internal network whose only exit is Squid with ssl-bump.
  `check` sends ordinary requests that the policy must admit or refuse, judged from
  Squid's own log.

Fixtures with known bugs live in `fixtures/ecosystem/`. CI self-checks them
(`scripts/zero-trust-fixtures-selfcheck.mjs`); that is the only host-side install/test run.

## Evidence runner (#1095)

`src/controller/evidence-runner.ts` is the production form of the gate-2 pipeline (PRD §5.5,
§5.6 steps 1, 2, 4 and 7; scenarios 6 and 7). Every function drives a `VmAdapter`; nothing
is installed or run on the host. The env-gated `vm-proxy.e2e.test.ts` proof calls these
functions against the real adapter, so the real-VM suite exercises this code.

- `provisionWorkspace({ adapter, runId, limits, manifest, profileRecord, proxyTarget, plan,
  collector, lifecycle, artifactsDir? })` checks the plan's networks, that the plan's manager
  is `profileRecord.manager`, the manifest (`validateManifest`) and that the profile is
  baked. It then creates a `provisioning` VM (container scope) forwarded to the one mirror,
  uploads exactly the manifest's files (exec bit from mode `100755`), runs the provisioning
  commands, calls `endProvisioning`, and requires the broker to refuse `package_proxy` with
  `network_not_allowed` (`ProvisioningNotClosedError` if it is accepted; any other error
  propagates). The returned `ProvisionedWorkspace` records that code as
  `phaseSwitch.refusedWith`. A provisioning command that does not pass destroys the VM,
  then makes `lifecycle.run` `unsupported_environment` through `applyProvisioning`, passes
  it to `lifecycle.observeRun` and throws `ProvisioningFailedError` with that run, the
  records and the failed command id.
- `runPlanned(adapter, workspace, command, collector, options?)` runs one verification
  command and returns a `CommandRecord`. It accepts only a workspace `provisionWorkspace`
  returned and that was not released (`EvidencePlanError('workspace_unproven')`
  otherwise). Its status comes from `classifyCommand`: test commands (`captureReport`) are
  classified from the supervisor-read report, so a timeout, a signal, a missing or
  unreadable report, zero or unknown suites, and case counts that contradict the exit
  status are `inconclusive`, never `passed`.
- `releaseWorkspace(adapter, workspace, lifecycle, cause?)` destroys a workspace VM
  through `teardownVm`; a caller holding a `provisionWorkspace` result must call it.
- `baselineEvidence({ ...workspace options, manifest, plan })` runs the plan's verification
  commands on the base in a fresh VM and returns `{ provisioning, records, status,
  phaseSwitch }`. `workspaceStatus` makes the status `inconclusive` when a setup step did
  not pass, and otherwise rolls the test commands up with `overallStatus` (none at all is
  `inconclusive`).
- `regressionEvidence({ ...workspace options, baseManifest, testFiles, candidateManifest,
  regressionTargets, endpoints, planOptions? })` builds the plan itself
  (`buildCommandPlan(profileRecord.manager, endpoints, { ...planOptions, testTargets:
  regressionTargets })`). It runs it on the base plus only the candidate's `testFiles`
  (`reproductionManifest(base, candidate, testFiles)`, which also adds any parent
  directories the base lacks), which must be `failed`, and then on the candidate, which
  must be `passed`, each in its own fresh VM. It returns `classifyRegression`'s proof.
  When the base does not fail, no candidate VM boots (`candidate: null`): the proof is
  `not_reproduced` when the base passed (a hand-off before patching) and `inconclusive`
  when it was inconclusive.
- Refusals before any VM: `EvidencePlanError(code, detail?)` with `network_mismatch`
  (`assertPlanNetworks`: a provisioning command not on `package_proxy` or a verification
  command not on `none`; `runPlanned` also refuses a provisioning command),
  `manager_mismatch`, `no_test_command` (no `captureReport` verification command),
  `no_regression_targets`, `no_test_files` and `test_file_missing` (absent from, or a
  directory in, the candidate). `detail` names a command id and phase or a test-file
  index, never repository text.
- `RunLifecycle` is `{ run, now, observeRun, journal?, retryDelayMs?, sleep? }`. The runner
  changes the run only on a failure, and every changed run (`unsupported_environment`,
  `blocked_cleanup`) reaches `observeRun` before the throw.
- Teardown on every path: each workspace VM is released through `teardownVm`, including
  when a command, an upload or the phase switch throws; `journal` then gets an
  `evidence_workspace_aborted` event with the stage, the command id and the error class.
  Three failed deletions make the run `blocked_cleanup` and throw `VmCleanupError`, with
  `cause` set to the failure that led to the teardown (for a failed provisioning,
  `{ failedAt, records }`). A blocked cleanup wins over a provisioning failure because
  `unsupported` has no cleanup edge. A `create` that throws returns no handle; the
  adapter cleans up after its own failed create.
- Logs: `logArtifact(stdout, stderr, outputTruncated)` makes each command's `LogArtifact`:
  the SHA-256 of the whole log, a tail excerpt of at most `MAX_LOG_EXCERPT_CHARS` (4096)
  UTF-16 code units, and `REDACTED_EXCERPT` (`[redacted]`) instead of the excerpt when the
  log or the excerpt matches `assertNoSecrets` (`redactedExcerpt` in `src/redaction.ts`).
  Evidence references the log by `log.digest` (`evidence.sanitizedLogDigest`), and each
  record is checked with `assertSecretFree`. With `artifactsDir` (e.g.
  `RunStore.storeDirectory('artifacts')`) the artifact is written once as a private
  `<digest>.<complete|truncated>.log.json`.
- `OutputCollector(capBytes = DEFAULT_OUTPUT_CAP_BYTES)` (`src/controller/output-collector.ts`,
  64 MiB) keeps every byte the guests returned (stdout, stderr, reports read back), and
  `outputs()` gives the chunks in arrival order for `evaluateBoundary`'s `guestOutputs`.
  Past the cap it drops the rest, sets `truncated`, and `outputs()` throws
  `OutputTruncatedError`: a partial canary scan is not a clean one. The e2e boundary test
  scans the probes' output plus the collector's.

`src/__tests__/fake-vm.ts` has `FakeVmAdapter`, an in-memory adapter for controller tests:
exec results scripted per argv (`on`) or by a function that sees the VM's uploaded files,
the real adapter's phase rules (`package_proxy` only while provisioning, one
`endProvisioning`, destroyed VMs refuse everything), `failDestroy` and `failCreate`
switches, and a call log.

## Local VM execution profile (gate 1)

`src/vm/` runs untrusted code in a disposable local QEMU VM; Linux x86_64 hosts only. Design,
QEMU flags, network design, measured overhead and residual risks:
[execution-profile decision record](../../docs/features/zero-trust-full-cycle/decisions/execution-profile.md).

- `preflightHost(request)` refuses closed (`unsupported_environment` + detail) on an
  unsupported OS or architecture, missing QEMU tools, or a forced `kvm` without `/dev/kvm`.
  There is no host-container fallback.
- `LocalQemuAdapter` implements the provider-neutral `VmAdapter` (create, exec, putFile,
  getFile, endProvisioning, destroy, listByRun) plus the `killAll` incident kill switch,
  `reconcile` and `releaseKillSwitch`. QEMU
  runs rootless with `restrict=on` user-mode networking, no forwards outside the provisioning
  phase and no shared folders; the
  broker (`BrokerClient`, `vm-guest/agent.py`) is the only data path.
- Network phases (#1010): `create({ phase: 'provisioning', proxyTarget })` adds exactly one
  `hostfwd` from host loopback to the guest relay; `ProvisionChannel` dials in through it and
  splices each guest connection to the one mirror. Worker commands reach it with
  `exec({ network: 'package_proxy' })` (refused outside provisioning, host-side and in the
  guest). `endProvisioning` powers the guest off and restarts it on the same disk with no
  forward; the guest announces its phase, and a mismatch fails the VM (destroyed on create;
  on a phase switch `endProvisioning` throws and the caller destroys it). The connector
  opens every connection with a per-boot relay key handed to the guest in the hello.
  `assertProfileBaked` refuses a selected profile the VM image does not carry
  (`profile_not_baked`); `profiles.json`'s `workerHardening` names the ones it does. `exec` also takes a
  validated `env` and `report: true` (a fresh report directory outside the workspace, read
  back by the agent).
- `teardownVm` caps deletion at three attempts, then moves the run to `blocked_cleanup` and
  hands it to `observeRun`; `assertPublicationPermitted(run, operationKind)` applies the intent
  admission table, which admits no GitHub write in `blocked_cleanup`.
- `bakeProfile` / `ensureBaseImage` build the hash-pinned image (`PROFILE_PINS`,
  `BAKE_RECIPE_VERSION`, `BAKED_DISK_GIB`); `parseManifest` and `assertStandaloneQcow2` check it.
  `DEFAULT_LIMITS` holds the PRD §5.1 defaults.
- Errors: `UnsupportedEnvironmentError` (`.detail` is an `UnsupportedDetail`), `VmCleanupError`,
  `BrokerError`, `BoundaryBreachError`, `PublicationDeniedError`. VM lifecycle events go to a
  journal dedicated to them, not the run's intent journal.
- `admitModelAction` (`src/authority.ts`) admits only a closed set of model actions bound to
  controller targets.
- `evaluateBoundary` / `assertBoundaryHeld` (`src/vm/evidence.ts`) judge hostile-fixture runs
  from host-side measurements; fixture reports are untrusted.

From `packages/zero-trust`:

```bash
npm run build
node scripts/zt-vm.mjs bake  --profile-dir <dir> --cache-dir <dir> [--accel auto|kvm|tcg]
node scripts/zt-vm.mjs smoke --profile-dir <dir> --state-dir <dir> [--accel ...] [--timings-out f]
node scripts/zt-vm.mjs kill-all --state-dir <dir> --reason <text>   # exit 2: a VM was left behind
node scripts/zt-vm.mjs reconcile --state-dir <dir> [--destroy]      # orphans; --destroy after kill-all
node scripts/zt-vm.mjs release --state-dir <dir> --reason <text>    # lift the kill switch
ZT_VM_E2E=1 ZT_PROFILE_DIR=<abs dir> npx vitest run src/__tests__/vm-gate.e2e.test.ts
node scripts/zt-proxy.mjs up --state-dir <dir> --out <endpoints.json>   # needs Docker
ZT_PROXY_E2E=1 ZT_PROFILE_DIR=<abs dir> ZT_PROXY_ENDPOINTS=<endpoints.json> \
  npx vitest run src/__tests__/vm-proxy.e2e.test.ts
node scripts/zt-proxy.mjs down --state-dir <dir>
```

The kill switch stays engaged until `release` lifts it, which is refused while any VM remains.

The hostile fixtures live in `fixtures/hostile/`; `.github/workflows/zero-trust-vm.yml` runs
the gate under KVM, plus a TCG smoke test, on every PR touching this package.

## Fork-side GitHub credential broker

`src/github/broker.ts`, `app-auth.ts`, `token-journal.ts`, `contributor.ts` and `push.ts`
(which hands the broker's push credential to git) are the only code that holds or handles
GitHub credentials (the hand-off and fork modules beside them are credential-free). They
are controller-only: the package index does not export them, and
`src/github/__tests__/isolation.test.ts` fails if any other module, including the index,
the hand-off modules and the worker broker, can reach them through an import chain.
Import them by path from trusted controller code.

Under the hybrid hand-off ([decision record](../../docs/features/zero-trust-full-cycle/decisions/github-credentials.md))
the broker performs fork pushes only. Upstream comments and PRs are contributor
hand-offs. `ForkCredentialBroker` has a typed operation API and no generic token call:

- `recover()` must run first. It revokes every journaled token without a recorded
  revocation before any admission. Values held in process memory (`TokenVault`) are
  revoked one by one. User-chain tokens whose values were lost are ended by deleting
  the grant with a live user token. An installation token whose value was lost cannot be
  revoked through any API, so the broker enters `blocked_cleanup` and reports its id and
  native expiry for the operator. It never records that token as revoked. Recovery over a
  journal whose run already ended returns `admitted: false`.
- `registerUserToken(value, expiresAt)` holds the contributor's unscoped user token
  (needed for `user_scoped` mints and the kill switch). `readAsContributor(path)` makes a
  GET with it, restricted to `/user`, `/user/installations` and
  `/user/installations/{id}/repositories` (optional `per_page`/`page`); any other path is
  refused `read_not_allowed`, and the value never leaves the broker. `rotateUserToken` records a
  refresh; the old token is marked `rotated` only once observed dead, and its scoped
  children stay journaled as live.
- `mintForkPush(intent, { repositoryId, via? }, scopeFrom?)` mints one token for one
  journaled `push_branch` intent attempt and returns a `ForkPushLease`. The token is
  narrowed to the verified fork's repository id with `contents:write`: an installation
  token (the default `via`) or a scoped user token minted from the unscoped user token
  (`scopeFrom`, default the newest held one). The journaled intent's target must name the
  same fork (`fork:<repositoryId>:branch:<name>`). A different repository, an unjournaled or
  non-push intent, a second mint for the same attempt, or scoping from a scoped token is
  refused before any network call. A token GitHub does not confirm as repository-selected
  with exactly that permission is revoked and refused.
- `take(lease)` hands out the lease's `GitPushCredential` once, inside the window;
  `revoke(lease)` ends it. `revoke` refuses the unscoped user token
  (`user_token_run_scoped`): only `endRun`, cancellation or `killAll` revoke it. `withForkPush(intent, target, operation, cancel?)` does all
  three and is the preferred entry point. It revokes on success, failure, throw and
  cancellation (including a cancel that arrives during the mint). A timer also revokes
  the token 15 minutes after the mint request, even mid-operation. GitHub's 1 h / 8 h
  lifetimes are recorded but never relied on.
- `GitPushCredential` is a git environment that redacts itself in JSON, `inspect` and
  `String()`. The token goes in an `http.extraheader` supplied via `GIT_CONFIG_*`, with
  the credential helper and global/system config off. The same overrides disable hooks,
  fsmonitor, proxies, redirects and non-HTTPS protocols, and force TLS verification. Run
  the push from a controller-owned clone the worker never had write access to.
- A revocation counts only when a liveness read after the DELETE returns 401. Each
  failed attempt is journaled with its stage and HTTP status, and the next attempt
  waits (1 s, then 4 s). After three failures the broker closes admission and calls
  `onCleanupBlocked`, so the controller moves the run to `blocked_cleanup`.
  `CredentialCleanupError.report` lists what is still outstanding.
- `endRun(reason?)` (run end or cancellation, journaled as `completed` or `cancelled`) revokes installation tokens and scoped children
  individually, deletes the grant if a child will not die, and revokes the unscoped user
  token last. Revoking the user token ends its refresh chain, so the journal records that
  the next run needs a new contributor authorization. Revoking or rotating a parent
  never counts as revoking a child.
- `killAll()` closes admission, waits for in-flight mints, and deletes the contributor's
  grant with an unexpired, unrevoked user-chain token *before* revoking anything else.
  It then revokes installation tokens. A 404 from the grant endpoint means "not
  deleted". If no held token can delete the grant (none held, or every attempt
  refused), `grant.deleted` is false and the report asks for a contributor
  re-authorization or a manual revoke. Every tracked scoped child, then the user token,
  is revoked one by one, and `complete` is false: a token of the grant the broker does
  not hold may still be live.
- `resolveByOperator(tokenId)` journals that the owner confirmed by hand that a token is
  dead. `settleExpired()` settles unresolved tokens whose *journaled* native `expiresAt`
  has passed; a token with no recorded expiry is never settled by time. Both return
  what is still unresolved, so the controller can complete cleanup.
- `onJournalFailed` reports a journal write failure (disk, permissions) separately from
  GitHub cleanup failures; `status()` then shows `journal_failed`.
- `status()` is safe to log: ids, kinds, states, times and failure counts only.
  `close()` stops an instance's timers and writes before a successor in the same process
  takes over the journal and vault.

The token journal (`token-journal.ts`) uses a `Journal` in its own controller
directory. Each event is replay-validated and scanned with `assertNoSecrets`, and token
values are never written. Tests replay the gate-3 probe's recorded status codes through
an in-memory fake (`__tests__/github-fake.ts`), so CI makes no GitHub calls.

An installation token whose value was lost in a full process crash cannot be revoked
through any GitHub API. The run stays in `blocked_cleanup` until `resolveByOperator`
or, when the mint response was journaled, `settleExpired` after its native expiry.

## Verified fork push (#1066)

`ForkPusher` (`src/github/push.ts`, controller-only, import by path) is the
`WriteAdapter` for `push_branch` (PRD §5.7, §5.9 "Push candidate"; decision record rows
4/4b; scenarios 10, 17, 18). Each attempt, in order:

1. Preflight reads the ref through `readForkBranch`. The candidate already there
   confirms without a token or receipt; anything other than the expected value blocks
   with `remote_diverged` and pushes nothing. An answer naming another repository id
   blocks with `fork_unverified`; an unreadable answer withdraws the attempt
   (`MutationDeferredError`).
2. `authorize(intent)` supplies the receipt, fresh controller context and the
   reconstructed candidate. The candidate must be the intent's SHA on the context's
   parent, and `authorizeShipping` verifies the receipt and burns its single-use nonce.
   A refusal (wrong parent, contributor, fork or SHA, replay, unverified candidate,
   policy) blocks with `authorization_refused` before any token is minted. A failed
   `authorize` callback or a nonce-store refusal raised before the store appends
   withdraws the attempt; a failed append leaves it ambiguous. A retry needs a fresh
   receipt. If the broker never hands the credential to git (the mint failed, was refused
   or was cancelled), nothing can have been pushed: the attempt is voided, not counted.
3. `push_intended` (branch, candidate, expected remote SHA) is appended to the push
   ledger, its own `Journal`, scoped to the fork's repository id.
4. Inside `broker.withForkPush`, git pushes exactly the candidate from a fresh
   `TrustedGit` repository holding only the candidate pack:
   `--force-with-lease=refs/heads/<branch>:<expected>` (empty: the branch must not
   exist), an explicit URL and `<sha>:refs/heads/<branch>`. The URL names the fork by
   owner/name; the token is narrowed to its repository id, so a name that moved to
   another repository after preflight is refused by GitHub. There is no remote, no
   wildcard and no plain force. `ls-remote` then reads the ref back from the git server.
5. Only a read-back equal to the candidate records `push_verified` and confirms. Another
   SHA blocks with `remote_diverged`; still the expected value, or unknown, is
   `push_uncertain`, which reconciliation settles: candidate → done, expected → one
   retry, anything else → `remote_diverged`.

The expected remote SHA is absent, or the last SHA a verified push left on the branch
(`expectedRemoteSha(intent)`, which the controller puts in the receipt grant). A
revision after a rebase therefore uses the same CAS against the previously verified SHA
and needs a receipt that binds it. `handoffReadBack(target)` is the
`HandoffAdmission.remoteBranchSha` for the PR hand-off: the branch SHA read back without
credentials, null when absent, refused when no verified push left it there.

`src/github/fork-ref.ts` (exported, credential-free) names push targets by fork
repository id, `fork:<repositoryId>:branch:<name>` (`forkTarget`/`parseForkTarget`).
`readForkBranch` answers a SHA, or null on 404, only after `GET /repos/{owner}/{repo}`
confirms the id; anything else throws `ForkRefError` with the HTTP status.

## Contributor authorization and fork prerequisites

Before anything is pushed, the run establishes who the contributor is and that their fork
is ready (#1065). Creating the fork and installing the App are one-time manual steps: the
fork API refuses the App's user token (403, because the App is not installed on the
upstream; decision record row 3b), so the run waits for them durably.

- `checkForkReadiness` (`src/github/fork.ts`, credential-free, exported) checks every
  prerequisite once per explicit call and never schedules anything. Discovery reads the
  contributor's same-name repository, then the upstream's fork listing (newest first, at
  most ten pages) filtered by owner, with no credential, and binds by repository id:
  `fork:true`, `parent.id` equal to the upstream id recorded at gating, and owner equal to
  the run's contributor. A name match alone never counts. A fork of another fork in the
  upstream network (`fork_wrong_parent`), a repository owned by another account
  (`fork_wrong_owner`), or a different repository than the one bound earlier
  (`fork_replaced`) blocks the run. These are the outcome's `reason`; the run itself records
  `policy_blocked`. Absence is reported only when the reads prove it: a failed read, or a
  capped listing that cannot rule out a bound or renamed fork, answers `unknown`.
- A missing fork moves the run from `gating` or `shipping` to `awaiting_contributor`
  (`fork_missing`); a missing or suspended App installation does the same
  (`installation_missing`). The outcome's one-line `nextPermittedAction` carries the exact
  link: the GitHub fork page, the App's install page with "Only select repositories", or
  the installation's settings page to unsuspend it. A re-check that finds the same wait
  records nothing; one that finds the next prerequisite missing records the new reason.
  When everything passes, the run resumes the phase that entered the wait
  (`resume_gating` / `resume_shipping`). `prerequisiteAction(run, upstream, appSlug)`
  re-derives the status line from a persisted run. The state machine keeps this wait apart
  from a link hand-off: a resume cannot leave a pending link, and an observed submission
  cannot leave a prerequisite wait. `fork_missing`, `installation_missing` and
  `installation_too_broad` are the only new run reason codes, and they leave only gating,
  shipping and the wait.
- The installation on the fork must have `repository_selection=selected`, select exactly
  the fork, and grant no permission beyond the App's declared set. `all`, an extra
  repository or an extra permission blocks with `installation_too_broad` and a link to the
  installation's settings. Any installation of the App on the upstream blocks the same way.
  Selection and permissions are read with the App JWT (`GET /repos/{owner}/{repo}/installation`);
  the selected repository set needs the contributor's user token. Until the contributor has
  authorized, the outcome is `authorization_required` and carries the `ForkReady` binding the
  broker is built with.
- `ContributorAuthorization` (`src/github/contributor.ts`) runs the GitHub App user
  authorization web flow. `begin(redirectUri)` accepts only a canonical loopback redirect,
  `http://127.0.0.1:<port>/<path>` or `http://[::1]:<port>/<path>` (an explicit port, no
  query or fragment), and creates a CSPRNG `state` and a PKCE S256 verifier in memory.
  `complete(callback, run)` spends the pending attempt first, compares `state` in constant
  time, exchanges the code, and reads `GET /user` with the new token before anything else.
  Only the run's contributor's token is handed to the broker. Another account's login or
  account id (scenario 17) blocks the run (`contributor_mismatch`, recorded as
  `policy_blocked`) and its token is revoked at once; a login that cannot be read revokes
  the token unused. `bindLogin(run, userId)` repeats the check on resume through the broker
  and, on a mismatch, ends the broker's run before blocking. `listenLoopback({ isExpected:
  auth.matchesPending })` listens on 127.0.0.1, answers 400 to anything but a well-formed
  callback carrying the pending `state` under its own Host header, then answers a fixed page
  that echoes nothing and sends no referrer.
- `refresh()` is single-flight and serialized with `complete` and `bindLogin`: the broker
  takes the new access token before the stored refresh token is replaced, so the pair is
  never half-updated, and a token the broker refuses is revoked. `bad_refresh_token`
  answers `reauthorize` and drops the chain; nothing retries. Once the broker has revoked
  the user token (run end, cancellation, kill switch), its refresh token is dead too:
  `refresh()` answers `reauthorize` and `status()` reports `reauthorization_required`, both
  without presenting it. A new process holds no refresh token and must authorize again.
  An App that does not issue expiring user tokens, or whose credentials or redirect GitHub
  refuses, is reported as `app_misconfigured`; a non-expiring token is revoked, never kept.
- The authorization code, `state`, access and refresh tokens never appear in an outcome,
  status, error message or the token journal; the object redacts itself in JSON and
  `inspect`. Every refusal carries a fixed next step.

## Permission freshness

`createFreshnessProbe({ read, upstream: { owner, repo, issue }, contributor, gated:
{ policyDigest, policy, eligibilityDigest, invitation? }, ownPr?: { number } })`
supplies credential-free, GET-only just-in-time admission for `HandoffAdmission`
and `RevisionAdmission` after permission has been admitted. Pass its `policyFresh`
method directly for publication/revision; initial engagement uses a separate
contact-permission check so that requesting approval does not require prior
shipping permission. For receipts,
set `ReceiptContext.policyPermitsShipping` from `await probe.policyFresh()`.
The controller must provide the already-admitted policy/eligibility snapshot and,
when permission was granted through an invitation, its `InvitationEvidence`.

Each `check()` reassesses current issue/repository/timeline facts, resolves the
current default-branch commit, and discovers policy files pinned to that commit.
An identical `policyDigest` reuses the gated assessment (including typed decisions);
changed file identities are classified by the restriction-only deterministic floor,
without a model call or inferred prose permission. A changed digest that still
permits is recorded in the returned immutable `FreshnessReport`, alongside `head`,
the current eligibility digest, assessment, `fresh`, and `reasons`.

Reasons include `policy_changed`, `issue_closed` (also locked),
`assignment_changed`, `competing_fix`, and `invitation_revoked`. Other structured
ineligibility (private/archived/disabled repository, PR-as-issue, or non-bug issue)
is `issue_ineligible`. Gated assignment requirements remain enforced alongside
current requirements. Unknown current ownership refuses unless an unchanged-policy
invitation independently establishes permission. Contributor-authored PRs do not compete; an `ownPr` numeric
collision never exempts another author or another repository. A newly required
approval/discussion requires permission bound to the current digest; an old grant
cannot authorize new requirements. `recheckInvitation(read, binding, evidence,
{ contributor, issueAuthor, policy })` shares the invitation observer's bounded
decoding/authority rules without persistence. It revalidates the original source,
then checks subsequent answers. Both comment URLs and API assignment-event URLs
emitted by `checkInvitation` are supported. Missing, edited, identity-mismatched
or no-longer-authorized sources refuse; assignment evidence also requires the
contributor to remain assigned. Later authorized declines revoke permission.
Another authorized observation with the same second-resolution timestamp is
also evaluated; a timestamp tie never silently preserves permission.
The freshness probe uses the maintainer association authority floor and does not
infer issue-author authority. Direct callers of `recheckInvitation` can supply
an explicit `InvitationPolicy.issueAuthorMayInvite` rule, as with initial observation.

Unknown, malformed, ambiguous, failed or truncated reads throw the sanitized
`FreshnessUnavailableError` from both methods, even when an earlier read already
proved staleness. Neither method retries, writes, journals, transitions a run,
uses credentials, or emits a contributor link. Callers decide what to do with
the result; stale returns `false`, whereas unavailable remains a refusal.
