# @ai-dossier/zero-trust

Private, provider-independent foundation for [PRD-ZTFC-001](../../docs/features/zero-trust-full-cycle/prd.md)
§5.1, §5.7, §5.8 and §5.9. No VM/network/model/GitHub calls; receipts use core's
Ed25519 signer abstraction and Ajv schema validation.
This provides lifecycle/status, durable intent/budget, canonical Git and receipt primitives.
Publication remains gated on S1 feasibility.

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
was lost; this package performs no GitHub writes or resource teardown.

`StatusRecord` has all PRD status facts. `activeTimeMs` excludes waits. Money
estimates contain nonnegative finite `amount` and a matching three-letter
`currency`; these are estimates, not invoices. `candidateSha` is omitted if absent.
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
  estimatedSpend: { amount: 0.25, currency: 'USD' },
  budgetRemaining: { amount: 4.75, currency: 'USD' },
  reasonCode: ReasonCode.GatePassed,
  nextPermittedAction: 'approve_plan',
};
console.log(renderHuman(status));
console.log(renderJson(status));
```

The values above are illustrative controller-supplied facts; the status renderer
does not calculate spend, elapsed time or shipping authorization.

## Development

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

Admission is checked after reconciliation: engagement comments require `gating` or
`awaiting_maintainer`; fork/push/PR creation require `shipping`; PR updates require
`shipping` or `revising`. Explicit withdrawal (`pr_close`) is permitted in `shipping`,
`submitted`, `awaiting_review`, `revising` or `accepted`, before recording `declined`.
Terminal states, `blocked_cleanup` and `paused_user` deny every mutation with
`WriteBlockedError`, including retries and calls for already-confirmed intents.
`resume()` may still reconcile attempted/ambiguous intents in these states, persisting
found/absent evidence without writing externally. Legacy journals remain replayable;
historical attempts are evidence, never current admission authority.

The adapter must authenticate artifact ownership/target, enforce current permission
and receipt checks, and implement compare-and-swap branch writes. For push results,
`found`/mutation success must include `remoteSha` equal to `candidateSha`. A different
or missing SHA blocks the run. A truly absent branch is `absent`; inability to prove
absence is `unknown`. No adapter exception text is persisted. Engagement adapters
must include `engagementMarker(contributionId)` in comments and reconcile the unique
matching marker via `parseEngagementMarker`, with contributor/target checks.

Only one retry is available after proven absence, including across restarts.
Unknown reconciliation denies all further writes and persists a `PolicyBlocked`
transition from the current run when that edge is legal. Terminal/cleanup states
remain unchanged rather than inventing an illegal transition, but the bounded
reason is still journaled. Proven absence after the final attempt is journaled as
`exhausted`; it cannot enable a retry or repeatedly reconcile on restart.
`snapshot().blockedReason` on a persisted block preserves the bounded reason
(`unknown`, `reconciliation_error`, `invalid_evidence`, `unexpected_remote_sha`,
or `retry_exhausted`) without storing provider exception text.
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
Token/time ceilings apply cumulatively even at zero incremental cost.

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
session ceiling, but cannot consume the remaining cleanup allowance. Teardown still
respects cumulative token/time limits. Admission uses exact bigint totals; public
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
recovery adds all pending IDs to that barrier and its durable audit. All new
reservations, including teardown, are fenced until every old hold is explicitly
settled or released. Missing or empty journals within an existing recovery directory
fail closed. Deletion of the entire audit directory is outside the trusted-storage
contract: stop all existing handles and reopen before reconciling every old hold.
`settle(id, null)` does not clear the fence.
Every guarded admission also checks the freshly loaded rows: holds not acknowledged
by a successful complete transaction of that exact ledger instance require
reconciliation, even when the handle opened before another writer's final hold.
Locally acknowledged holds may coexist; their full estimates still count.
After reconciliation, teardown retains its protected allowance and accounting limits.
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
hostile compressed object packs. No protocol exceptions are needed by this API.

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
same bytes with SHA-256. Schema version is `ztfc-receipt-v1`.

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
directory**. Grants bind the existing `idempotencyKey`, operation kind/target,
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

## Ecosystem support and package proxy (gate 2 prep)

`src/ecosystem/` prepares feasibility gate 2 without a VM. Design and open questions:
[package-proxy decision record](../../docs/features/zero-trust-full-cycle/decisions/package-proxy.md).

- `detectEcosystem(files)` (or `sourceFilesFromManifest(manifest)` first) accepts npm with
  `package-lock.json`, pip with a fully hash-pinned `requirements.txt`, and uv with
  `uv.lock`. Everything else returns `unsupported_environment` with a specific reason.
- `selectProfile(detection)` picks a runtime from the versioned `profiles.json` that
  satisfies every project declaration and never substitutes a version.
  `recordProfileSelection` / `loadProfileRecord` store the choice once per run and
  re-verify it before execution. `profileReceiptBinding` gives the receipt's profile fields.
- `buildCommandPlan(manager, proxy)` returns provisioning (`package_proxy`) and
  verification (`none`) commands as argv data. This package executes nothing.
- `classifyOutcome`, `classifyRegression` and `applyVerification` treat timeouts and
  unreadable reports as `inconclusive` and enforce the two-repair cap from run history.
- `PROXY_POLICY`, `evaluateRequest`, `evaluateRedirect`, `buildLockIndex` and
  `checkArtifact` define the proxy policy. `renderSquidConfig`, `renderVerdaccioConfig`
  and `proxpiEnvironment` render it for the OSS components that enforce it.

Fixtures with known bugs live in `fixtures/ecosystem/`. CI self-checks them
(`scripts/zero-trust-fixtures-selfcheck.mjs`); that is the only host-side install/test run.
