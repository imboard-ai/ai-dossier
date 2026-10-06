# Issue #986: registry adoption metrics investigation

## Problem
The weekly ledger on #985 needs registry account and dossier pull metrics. Its owner-approved slice explicitly deferred these dimensions until an endpoint and unattended credential contract are identified. Issue #986 has no comments resolving those blockers. This investigation used isolated pool worktree `feature/986-adoption-ledger-add-registry-accounts-pulls`, based on `f09cd1c`, run `r-986-e8d5`, executing model `openai/gpt-6.1-sol`.

## Acceptance Criteria
- [ ] Weekly ledger comment on #985 includes registry accounts and pulls, with the divergence flag using them.

## Approach
1. Resolve the metric source and definitions with the owner using the evidence below.
2. Establish the authorized endpoint, response schema, counting window, and unattended authentication/renewal contract before implementing collection.
3. After that decision, extend the existing collector, structured ledger payload, rendering, divergence heuristic, and workflow environment using the agreed contract.
4. Preserve missing/unavailable signals as unknown; do not substitute zero or infer accounts from publishers, trace users, or OAuth log entries.

## Reachability Evidence
N/A — scheduled collection infrastructure, not a new production data state. No production database counts were queried and no account or pull totals are asserted.

### Read-only endpoint observation
On 2026-10-06, a bounded Node fetch of `https://dossier-registry.vercel.app/api/v1/docs` returned HTTP 200. The response advertised health, docs, current-user info, dossier list/metadata/content/evidence, search, publishing, and deletion. It advertised GitHub OAuth-issued Bearer JWT authentication, but no account-total, pull-count, analytics, or service-token endpoint.

The observation ran outside the repository in `/tmp/opencode`, with `AbortSignal.timeout(30000)`, printing only the public docs response. It performed no authenticated request or network write. This answers the observable endpoint question as far as the public live contract permits; it does not prove the absence of an undocumented external analytics source.

## Predicted Files
- `scripts/adoption-funnel.mjs` — extend collection, additive ledger payload, rendering, and divergence once metric semantics are approved.
- `scripts/adoption-funnel.test.mjs` — mocked endpoint/schema, missing metrics, older ledger baseline, and divergence tests.
- `.github/workflows/adoption-funnel.yml` — wire the approved unattended credential source, if required.

Registry instrumentation files cannot be predicted until the owner selects an existing external source versus new instrumentation.

## Reusable Code
- `scripts/adoption-funnel.mjs:79-117` collects npm/GitHub metrics; `129-153` computes divergence; `161-178` renders the ledger; `181-209` reads/posts comments.
- `.github/workflows/adoption-funnel.yml:8-24` schedules collection and supplies `github.token` for GitHub issue/API access only.

## Evidence and Risk Areas
- `registry/README.md:18-35` documents the endpoint inventory and production URL; live docs agree that no adoption aggregate endpoint is advertised.
- `registry/api/auth/callback.ts:61-82` fetches GitHub identity/orgs and signs a JWT; it does not insert a registry account record.
- `registry/api/v1/me.ts:14-26` returns one token subject's identity and namespace permissions, not an account inventory.
- `registry/lib/auth.ts:10-13,59-62` signs/verifies HS256 JWTs. `registry/lib/constants.ts:42` sets seven-day expiry. `registry/docs/planning/registry-api-design.md:455,578` explicitly states no refresh token and re-login after expiry.
- `cli/src/credentials.ts:3,28` stores local per-registry credentials at `~/.dossier/credentials.json`. That interactive local store is not an Actions secret/renewal contract.
- `registry/api/v1/dossiers/[...name].ts:87-105,162-169` serves content or supplies a CDN content URL, without recording a pull count. Registry request totals alone need not equal CDN fetches or CLI cache hits.
- `registry/migrations/001_traces.sql` creates traces and trace steps; tracked-code search found no account or pull-count table/insertion.
- `gh secret list --repo imboard-ai/ai-dossier` returned no secret names; `gh variable list` exposed only unrelated AWS/Neon variables. This is discovery evidence, not proof about inaccessible environment/org secret stores. No secret values were read.
- The trap index was read in full and searched. Its adoption-funnel row (`docs/agent-traps.md:112`) requires preserving numeric/null cells in the versioned comment payload and adding status metadata rather than string sentinels.
- Website traffic #987 overlaps the collector/workflow, but has its own provider/credential decision. No implementation surfaces were changed here.

## Test Scope
No implementation or tests were changed. Verification consisted of tracked source inspection, live public API docs, issue history, and secret/variable names. Once the contract is resolved, test authenticated collection without token forwarding to npm, schema/period validation, endpoint failures, additive compatibility with prior comments, and registry growth/flat/unknown divergence cases.

## Open Questions
- Q: Does the public live API advertise accounts/pulls? → observed: HTTP 200 documentation has no such endpoint (bounded public GET described above).
- Owner decision: use an existing analytics/export endpoint (provide URL, schema, source owner and scope) or authorize new registry instrumentation/storage?
- Owner decision: what does “accounts” mean (ever-authenticated distinct identities, registered accounts, or active accounts), and what counts as a “pull” (successful origin content requests, CDN deliveries, or logical installs; retries/caches/bots; cumulative versus weekly)?
- Owner decision: which unattended identity and auth mechanism is authorized, where does its credential live (exact Actions secret/environment or OIDC contract), who provisions it, and how is it renewed/rotated? Existing seven-day interactive JWTs do not resolve this.

These are product/access-contract preferences, not an infrastructure flake. Do not manufacture a contract or build speculative telemetry. Hand off at plan with `decision-pending`.

## Visual Review
- [x] Not required (scheduled automation only).

## Base Branch
`main` — requested PR target. No PR is opened while the owner decision remains unresolved.
