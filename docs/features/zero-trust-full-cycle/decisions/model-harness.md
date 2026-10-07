# Model harness decision — #1094

Owner-authorized choice A, 2026-10-07. Implements PRD §5.1, §5.4, §5.9 and the
harness selection required by §10. Offline adapter tests prove transport and
metering behavior; this is not a claim of complete engine release readiness.

## A — Chosen: controller-side OpenAI-compatible Chat Completions

The trusted controller supplies a fixed system message, conversation and closed
function-tool list. An injected HTTP transport returns proposals as untrusted
JSON. A later orchestration loop must pass each proposal through `admitModelAction`
before executing anything. This adapter itself executes no proposal and provides
no shell, filesystem or network tool to the model. An empty tool list supports
text-only closed questions for the subsequent typed-decision slice (#1119).

One interface supports hosted compatible APIs, subscription coding plans **when
they expose this API**, and local servers. CLI-only plans are not automatically
supported. Explicit zero prices still consume token/time allowance. Non-streaming
MVP simplifies bounded duration and conservative settlement; partial/truncated,
ambiguous or malformed results never become valid proposals. A single retry of
429/5xx is possible only with a two-attempt reservation, with unknown first-attempt
usage retained. No silent provider fallback. Native Anthropic Messages is a possible
future adapter, not implemented here.

Trade-offs: compatible APIs vary in tool support and usage reporting; absent usage
retains the full budget hold. The configured output limit is a provider contract,
not proof of provider billing. Byte-count input bounds avoid optimistic token
estimates. Response bytes and per-call arguments are capped independently.
One configured token rate prices both input and output; use at least the higher
provider rate so the estimate is conservative. Each attempt is bounded by its
own deadline and retries include a bounded abortable backoff, never a silent fallback.

## B — Rejected: trusted-zone agent CLI plus MCP

Claude Code/opencode bring ambient shell and file tools into the trusted zone.
PRD §5.4 prohibits a general authenticated agent shell there; a narrow MCP server
does not remove the CLI's other authority. Convenience and subscription integration
do not justify widening the controller boundary.

## C — Rejected: agent CLI inside the VM

This offers the CLI's native agent loop and tools behind VM execution isolation,
reducing controller-loop implementation work, but fails the credential contract.
This puts a model credential/gateway authorization in repository-controlled worker
execution, contrary to PRD §5.4's explicit credential separation. Worker isolation
must not depend on a model obeying instructions to protect its own credential.

## Contract and evidence

`ModelAdapter.complete` yields tool calls, text or a fixed malformed reason, with
validated usage or null. Arguments remain `unknown`, at most 64 KiB each.
`meteredComplete` uses the existing durable `BudgetLedger`: reserve before calling,
settle only observed usage, retain unknown charges after timeout/error/retry.
Both paths bound elapsed time and abort the transport. The key is read from the
configured environment variable at call time, sent only in Authorization, never
returned/logged/journaled. Missing key refuses startup as `model_unavailable`.

Recorded-response tests and temporary real-ledger tests under
`packages/zero-trust/src/model/__tests__/` require no provider/registry network.
Import-graph tests fence all VM modules from the model module, transitively and
including type imports; existing GitHub credential isolation remains unchanged.
