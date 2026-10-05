# @ai-dossier/zero-trust

Private, provider-independent foundation for [PRD-ZTFC-001](../../docs/features/zero-trust-full-cycle/prd.md)
§5.1, §5.8 and §5.9. No runtime dependencies or VM/network/model/GitHub calls.
This is a lifecycle/status library, not a complete execution or isolation engine.
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
The caller owns controller-local atomic storage, concurrency, retention and
identity validation. JSON encoding is not an authenticated journal; that layer
is a separate foundation slice.

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

## Development

```sh
npm run build --workspace=@ai-dossier/zero-trust
npm test --workspace=@ai-dossier/zero-trust
npm run test:coverage --workspace=@ai-dossier/zero-trust
```

`make build-all` includes this package; `make test` and `make test-coverage`
discover it through the existing `packages/*` workspace glob, including PR CI.
