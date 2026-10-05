# @ai-dossier/zero-trust

Private, provider-independent foundation for [PRD-ZTFC-001](../../docs/features/zero-trust-full-cycle/prd.md)
§5.1, §5.8 and §5.9. No runtime dependencies or VM/network/model/GitHub calls.
This is a lifecycle/status and durable-intent library, not a complete execution or isolation engine.
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
use JSON quoting to neutralize line injection. Both reject credential prefixes
(`ghp_`, `github_pat_`, `ghs_`, `sk-ant-`, case-insensitive `Bearer` plus whitespace)
with `SecretRedactionError` containing no input. Other malformed facts raise
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
identity; the journal, not the supplied initial state, controls progress.

The adapter must authenticate artifact ownership/target, enforce current permission
and receipt checks, and implement compare-and-swap branch writes. For push results,
`found`/mutation success must include `remoteSha` equal to `candidateSha`. A different
or missing SHA blocks the run. A truly absent branch is `absent`; inability to prove
absence is `unknown`. No adapter exception text is persisted. Engagement adapters
must include `engagementMarker(contributionId)` in comments and reconcile the unique
matching marker via `parseEngagementMarker`, with contributor/target checks.

Only one retry is available after proven absence, including across restarts.
Unknown reconciliation persists a `PolicyBlocked` lifecycle transition and denies
all further writes. `snapshot().blockedReason` preserves the bounded reason
(`unknown`, `reconciliation_error`, `invalid_evidence`, `unexpected_remote_sha`,
or `retry_exhausted`) without storing provider exception text.
Every intent and attempt is fsynced before the adapter runs;
confirmation is fsynced before success returns. File and ancestor directory entries
are fsynced on open. Write uncertainty poisons the live driver; recover from disk
and reconcile before trying again. Invalid or torn JSONL fails closed and requires
operator recovery; it is never skipped or automatically truncated. The trusted
storage/supervisor boundary is required: this mechanism cannot defend against an
actor who can rewrite the controller's journal or run a second controller process.
