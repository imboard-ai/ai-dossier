# @ai-dossier/zero-trust

Private, provider-independent foundation for [PRD-ZTFC-001](../../docs/features/zero-trust-full-cycle/prd.md)
§5.1, §5.5 and §5.6 (gate 2), §5.7, §5.8 and §5.9. No model calls; the only
GitHub calls are the controller-only broker/push modules and credential-free reads in
`src/github/`, and the VM adapter and proxy scripts are described below. Receipts use
core's Ed25519 signer abstraction and Ajv schema validation.
This provides lifecycle/status, durable intent/budget, canonical Git and receipt primitives,
plus ecosystem detection, runtime profiles, command plans and package-proxy policy
(see the gate 2 section below).
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
`resume_identity_mismatch`, `persistence_uncertain`, `store_closed`. Stored
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
The BOM is preserved. Symlinks, submodules, malformed responses, duplicate entries,
truncated/over-cap listings, blob mismatches and every non-404 failed read yield
`{ kind: 'unknown' }`, without partial files, retries or a weaker fallback. A listed
file disappearing also yields unknown. Complete absence is `{ kind: 'known', files: [] }`.
`PolicyDiscovery` and `PolicyFile` describe the result; each file has `path`, `sha`
(Git blob SHA) and `content` (untrusted text). The injected reader is responsible
for the GitHub protocol and complete response; GitHub's 1,000-entry directory
truncation is necessarily above the stricter 20-entry cap.

`classifyPolicy(files)` returns `PolicyAssessment`: `ai` is `banned`,
`requires_approval`, `disclosure_required`, `welcomed`, `silent` or `unclear`;
`assignment` is `required`, `not_required` or `unclear`; `directPr` is `welcomed`,
`discussion_first` or `unclear`. It also returns `draftRequired`,
`receiptBlockAllowed` (false for fixed templates/no extra sections),
`baselineFailuresPermitted` (default false), and `citations` with original `path`,
1-based `line`, stable `ruleId` and at most 200-character `excerpt`.
Secret-bearing lines are replaced with `[redacted]` after `assertNoSecrets`, including
secrets outside the excerpt slice. Evidence retains the first occurrence of each
rule per file and is capped at 128 citations; every line still affects classification.
README contributes only sections headed with `/contribut/i` (ATX or setext headings,
including nested sections), preserving original line numbers. Other README prose
does not count. Direct inputs are bounded/validated by `validatePolicyFiles` and
invalid snapshots raise non-echoing `PolicyInputError` (unsafe paths also fail the
secret guard).

`POLICY_RULES` is frozen case-insensitive **data**, with category and ID for each
pattern; `PolicyRule`, `PolicyCategory` and `POLICY_AI_MENTION` are exported.
Opposing categories make their dimension `unclear`. An unrecognized AI mention
also makes AI unclear rather than silent. Assignment silence is `not_required`
only when direct PRs are welcomed; otherwise unclear. No model classification is
performed. These bounded literal rules do not understand all natural language;
`unknown` and `unclear` always require a block/hand-off, never permission. Repository
text is never executed or interpreted as controller instructions.

`policyDigest(assessment, files)` hashes canonical sorted-key JSON containing the
assessment (with sorted citations) and sorted `{ path, sha }` file identities using
SHA-256. Input order and object-key order cannot affect the digest; any blob SHA or
assessment change does. Content is bound by the supplied GitHub blob identity;
callers must use discovered snapshots, not fabricate SHA/content pairs. A digest
is a freshness binding, not authorization or proof that contributions are permitted.
Twenty synthetic fixtures in `fixtures/policy/` and fake-read tests run offline.

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
hostile compressed object packs. The canonical API needs no protocol exception. Only
the fork push adds one: `exec`/`execAsync` accept the broker credential's
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
`src/__tests__/vm-proxy.e2e.test.ts` with the host proxy stack in `scripts/zt-proxy.mjs`.
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
  `uv sync --frozen` (which fetches the lockfile URLs directly). This package executes
  nothing; the VM supervisor runs the plans.
- `classifyOutcome`, `classifyRegression`, `applyProvisioning` and `applyVerification`
  treat timeouts, unreadable reports and zero suites as `inconclusive`, map provisioning
  failures to `unsupported_environment`, and enforce the two-repair cap from run history
  (`assertRepairAllowed`). `commandEvidence` and `overallStatus` build receipt evidence.
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
