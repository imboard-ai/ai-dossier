# Zero-Trust Full Cycle — External Open-Source Contributions

> **Document ID:** PRD-ZTFC-001
>
> **Status:** Approved for implementation specification
>
> **Date:** 2026-10-05
>
> **Amended:** 2026-10-06, hybrid hand-off for upstream writes (§5.7; [decision record](decisions/github-credentials.md))
>
> **Owner:** Yuval Dimnik
>
> **Project:** ai-dossier
>
> **Target blueprint:** `imboard-ai/git/zero-trust-full-cycle`
>
> **Base reference:** `imboard-ai/git/full-cycle-issue`
>
> **Grounding:** User-supplied initiative and decisions in discovery. The I'mBoard brief does not apply.
>
> **Interface:** CLI/workflow; visual wireframes explicitly waived by the owner.

## 1. Executive Summary

Build a reusable capability that takes a supplied GitHub issue through contribution-policy checks, isolated implementation, reproducible verification, and an upstream pull request from the contributor's fork. It must protect our infrastructure and credentials even when the repository, dependencies, tests, and instructions are hostile.

The initial supported ecosystems are Node.js and Python. Execution uses containers within a disposable, user-controlled VM. Trusted orchestration and credentials remain outside repository-controlled execution. Initial completion is **PR submitted**, not merged or deployed. Maintainer feedback initiates resumable follow-up runs.

The same engine serves project operators, developers, and students seeking portfolio contributions. It runs autonomously by default up to publication; users may choose models and intervention points. Every public upstream write (engagement comment, PR creation, update, or close) is a one-click contributor action on content the run prepares (§5.7), so a person reviews and owns each submission made under their name. Participation is optional, with no compulsory teaching mode and no reduction in security or verification for cheaper models.

### GO/KILL decision and investment thesis

**GO to specification, medium confidence.** A secure external-contribution engine extends ai-dossier's portable workflow capability and has multiple reusable applications. Demand, contribution acceptance, and adoption conversion remain hypotheses. Security feasibility is a mandatory release gate.

The investment is the capability itself. Operating outreach later incurs incremental model, compute, and review costs; it does not need an arbitrary five-issue growth pilot to justify every run. Failed growth experiments can end outreach without invalidating the reusable engine.

**Reconsider or stop implementation** if adversarial testing cannot preserve the authority boundary, representative supported repositories cannot be verified reliably, or maintenance effort exceeds the useful contribution benefit. Never compensate by weakening isolation.

## 2. Problem Statement

A contributor with a selected bug must coordinate unfamiliar setup, reproduction, debugging, tests, contribution conventions, fork routing, and review. Current internal full-cycle assumptions—trusted code, shared worktrees, privileged tools, direct pushes, merge/deploy ownership—do not hold upstream.

Maintainers need focused fixes with credible regression evidence, honest LLM disclosure, and low review overhead. Automated PR volume without those properties creates noise.

### Evidence and assumptions

- The owner has an existing internal full-cycle workflow and requests an external variant.
- The owner proposes useful contributions as a demonstration and distribution path for ai-dossier.
- Student portfolio use is an additional proposed application, not validated demand.
- The original eight-star baseline is user-supplied historical context, not a verified current metric.
- No measured demand, acceptance rate, saved-time baseline, or financial ROI is established.

**Highest-risk assumption:** a credentialed controller can consume hostile repository content and authorize only the intended, verified contribution. Credential-free tests alone do not prevent agent manipulation or shipping abuse.

## 3. Target Users & Personas

| User | Job | Desired outcome |
|---|---|---|
| ai-dossier operator | Demonstrate the framework by addressing selected upstream bugs | Useful, transparent contributions with observable outcomes |
| Developer contributor | Delegate execution while controlling scope and cost | Reproducible fix with less setup and coordination |
| Student / job seeker | Build a record of real OSS contributions | Traceable submitted/accepted/merged work, with optional involvement |
| Upstream maintainer | Review a proposed fix efficiently | Minimal patch, meaningful tests, policy compliance, no promotional burden |

### User Benefits

1. A selected issue becomes a validated proposed fix without mandatory manual coordination at every stage.
2. Repository execution cannot access contributor, model-provider, or infrastructure credentials.
3. Users control model cost, pauses, edits, and publication checkpoints.
4. Maintainers receive a focused contribution with accurate provenance and test evidence.
5. Portfolio users retain honest links to issue discussion, patches, tests, and maintainer outcomes. Automation does not imply unaided expertise or guarantee employment.

## 4. Strategic Context

This is an ai-dossier capability initiative, independent of I'mBoard. Distribution is earned through usefulness, not branded bulk submissions. Success is maintainer-valued work and repeat use; stars are secondary.

### Value versus effort

Strategic fit is high, potential contributor benefit is meaningful, confidence in demand is low-to-medium, and engineering effort is high. A speculative estimate is **8–14 engineer-weeks** for an experienced engineer with significant workflow reuse: policy/state 1–2, execution adapters 2–3, authority separation/shipping 3–5, adversarial testing/recovery/docs 2–4. This is not a repository-audited schedule or delivery commitment.

Separate one-time build cost, ongoing compatibility/security maintenance, and per-run model/VM spend. No revenue forecast or numeric ROI is asserted.

## 5. Solution Overview

### Product Feature Design

#### 5.1 Interaction contract

The registry dossier accepts these logical inputs; concrete CLI flag syntax belongs to implementation and must follow the existing dossier runner conventions.

| Input | Contract |
|---|---|
| `issue_url` | Required full public GitHub issue URL; one issue per run |
| `contributor` | Authenticated account that owns the fork and submits the prepared comment and PR |
| `execution_profile` | User-controlled disposable VM provider configuration; no in-place host execution |
| `model_profile` | Supported harness/model configuration; may vary by phase |
| `budget` | Required finite cost ceiling; includes model and compute estimates, with separately disclosed currencies/rates |
| `checkpoints` | Optional subset: plan, patch, verification; default none. Engagement and publication are always contributor hand-offs (§5.7) |
| `limits` | Defaults: 120 active minutes per run, 20 minutes per command, 4 vCPU, 8 GiB RAM, 20 GiB scratch; user may configure before execution |
| `resume_run_id` | Optional existing run; identities, upstream target, and prior authorization must match |

Unavailable models, missing rates, unsupported VM providers, or absent budget enforcement block startup. Subscription/local models may have zero incremental token charges, but token/time/resource limits still apply. Reserve estimated maximum cost before each model call or billed resource allocation; deny admission when it would exceed the ceiling. Stop and record estimated versus provider-reported spend separately; do not promise a provider billing guarantee beyond enforceable limits.

Every status response includes run ID, phase, state, upstream issue, contributor, candidate SHA if present, active time, estimated spend, budget remaining, reason code, and next permitted action. Human-readable output and a machine-readable state representation carry the same facts. Never print secrets.

#### 5.2 Six-step journey

1. User supplies issue, identity, model, budget, and optional checkpoints.
2. Controller checks scope and contribution policy; asks permission only when appropriate.
3. Worker reproduces the bug, proposes a plan, and implements inside isolation.
4. Fresh verification reproduces evidence against the immutable candidate commit.
5. Clean shipping pushes the verified commit to the contributor's fork and prepares a prefilled PR with accurate disclosure; the contributor reviews it and submits it with one click.
6. The run detects the submitted PR and tracks it; maintainer feedback can resume revisions on the same PR.

No visual UI is in scope; this journey and the state contract replace wireframes.

#### 5.3 Eligibility and community engagement

- Require an open, actionable bug in a public supported repository with documented verification, public dependencies, and no required service/private-package secrets.
- Inspect contribution rules, templates, AI policy, assignment, linked PRs, and relevant discussion. An explicit ban on LLM contributions ends the run.
- Stop for judgment on conflicting or unclear AI rules. Do not interpret silence as permission when the project requires approval.
- If prior assignment/discussion is required, or ownership is unclear, prepare one concise request disclosing heavy LLM use, proposed scope, and intended verification, which the contributor posts from an issue link plus a prepared body (§5.7; GitHub has no prefill for comments). Reconcile the posted comment by its marker, persist its URL, and await an explicit maintainer invitation/assignment.
- If rules welcome direct PRs on unassigned issues, proceed without ceremonial comments.
- An existing competing fix or assignee requires a documented invitation to collaborate; otherwise hand off.
- Never post automated reminders. Maintainer waits consume no worker/model compute. A status check occurs only on explicit user resume in MVP.
- If requested to provide a plan before assignment, only credential-free inspection is allowed; implementation waits.

Example engagement text, adapted to the project's conventions:

> I'd like to work on this issue using substantial LLM assistance through ai-dossier. My proposed approach is [approach], validated with [existing tests] and a focused regression test where appropriate. Would you welcome this contribution, and should I be assigned before proceeding?

#### 5.4 Execution and authority boundary

The VM is disposable, dedicated to one run, and contains development/verification containers. It has no host home mounts, SSH agent, cloud credentials, shared pool, internal routes, cloud metadata access, privileged mode, or host Docker socket exposure. The controller manages VM/container lifecycle through a constrained API. Destroy the VM at each hand-off or terminal state; resume provisions a fresh VM from sanitized persisted artifacts.

Start from a hardened derivative of `mcr.microsoft.com/devcontainers/base:ubuntu24.04`, pinned by resolved digest. Build separate approved Node and Python profiles. Install tools at image build time, remove runtime sudo, drop capabilities, prohibit privilege escalation, and enforce resource limits outside repository control. The image template is a tooling choice, not evidence of isolation.

**Trusted agent/controller is separate from repository-controlled processes.** Model calls and parsing tools run in the trusted zone. Workers receive only explicit execution/file operations through a narrow broker. Neither model-provider tokens nor model gateway authorization is present in the worker. A worker cannot invoke the model gateway, shipping service, VM lifecycle API, or arbitrary controller commands.

Repository text, test output, templates, and model output are untrusted data. They cannot change network policy, identities, budgets, targets, or checkpoint settings. The agent cannot use a general authenticated shell in the trusted zone. GitHub actions are typed operations bound to the supplied issue/repository and contributor; publication additionally requires a valid controller-issued receipt.

Never execute a target repository's Dockerfile, devcontainer configuration, hooks, Git filters, or lifecycle commands on the host or trusted controller. Target installation/build/test commands may run only in the worker. Trusted Git operations use sanitized configuration, disabled hooks, no credential helpers from artifacts, and no external filters. Clone public source without credentials; submodules are disabled unless a supported public dependency policy explicitly approves them.

#### 5.5 Network and ecosystem support

| Stage | Allowed connectivity |
|---|---|
| Source acquisition | Approved public GitHub fetch endpoint, through source broker |
| Dependency provisioning | Externally enforced package-registry proxy; no arbitrary internet, internal addresses, or metadata |
| Build / regression / suites | No public network; isolated local service network only when declared and approved |
| Shipping | GitHub API/Git endpoints, from clean credentialed shipping environment only |

The package proxy permits constrained package downloads, not arbitrary requests to allowlisted domains. It enforces methods, paths, redirects, destination resolution, and request-size limits; worker DNS/direct connections cannot bypass it. Cache artifacts by content digest and verify lockfile hashes where available. Do not describe provisioning as air-gapped.

- **Node:** npm projects with `package-lock.json`; versioned profiles selected from supported runtime versions using project declarations. Missing/conflicting requirements hand off. No pnpm/Yarn adapter in MVP.
- **Python:** pip projects with hash-pinned fully resolved requirements, or uv projects with a supported `uv.lock` and frozen installation. Plain unconstrained requirements are unsupported in MVP. Native dependencies require approved prebuilt toolchains or cached public build inputs.
- Supported runtime versions and image digests are declared in a versioned profile manifest, recorded per run, and verified before execution. Unsupported requested versions are not silently substituted.
- Unavailable dependencies or public-internet integration tests result in `unsupported_environment`; never broaden access to complete the fix.

#### 5.6 Reproduce, implement, and verify

1. Record upstream base SHA and run documented relevant checks on that baseline.
2. Demonstrate the reported bug with an automated failing regression or reproducible manual steps. If unreproducible, hand off before patching.
3. Apply the smallest appropriate patch. Avoid unrelated refactoring, formatting, dependency churn, generated files, and promotional artifacts.
4. Add a regression test when feasible: demonstrate failure on the original base and success on the candidate. If automation is impractical, preserve manual reproduction and limitations explicitly.
5. Commit work on the isolated task branch; **never use `git stash`**. Failed candidates are preserved privately, never pushed to the contributor's public fork.
6. A fresh verifier reconstructs the candidate from sanitized source blobs, runs frozen dependency setup and relevant checks, and creates a trusted receipt for the exact SHA. Logs originate from the controller's process supervision, not a repository-authored success file.
7. A failure permits at most two localized repair attempts after the initial candidate. Resource/time/budget ceilings apply throughout. A timeout or unreadable report is inconclusive, never a pass.
8. Patch-related failures prohibit shipping. Unrelated baseline failures may be disclosed only when relevant build/regression checks pass, baseline/candidate evidence demonstrates no new failures, and repository policy explicitly permits such submission. Absent that permission, hand off.

Recheck upstream base before shipping. If it changed, rebase in isolation and verify again against the new base; any candidate SHA change invalidates the receipt. If the base advances again during publication, record the verified base and current base; never claim verification of an untested merge result.

#### 5.7 Clean shipping and verification receipt

Source export accepts bounded ordinary file blobs and their executable modes plus a controller-owned manifest; reject symlinks, special files, traversal paths, oversized files, and `.git` configuration/hooks. Reconstruct commits using trusted Git configuration; recompute tree/commit identities. The final reconstructed candidate SHA is the SHA tested and shipped. Failed export or identity mismatch stops shipping.

After verification, an independent clean shipper performs only the writes GitHub allows with short-lived, repository-limited authorization: contents writes to the contributor's fork under an expected-SHA guard, plus credential-free reconciliation reads. Upstream writes (engagement comment, PR creation, update, and close) are **contributor-confirmed hand-offs**: the run prepares the exact content as a prefilled GitHub compare URL, or as an issue link plus a prepared comment body (GitHub has no prefill for comments), the contributor reviews and submits it under their own account, and the run reconciles the result. No credentials go to the worker; revoke shipping credentials after use. Do not require a broad long-lived token as a fallback.

**Why a hand-off** ([decision record](decisions/github-credentials.md), owner decision 2026-10-06). Primarily, deliberate human-in-the-loop review: a person reviews and owns every public submission made under their name, which keeps low-quality AI contributions out of maintainers' queues. It is also the only way to keep the credential contract. The gate-3 probe observed that GitHub App tokens, both user and installation, are refused (403) for comments, fork creation, and PR creation on an upstream that has not installed the App, while fork-side writes succeed. A per-run OAuth App token (option C′ in the record) remains a possible future opt-in that would need its own probe; it is not planned.

The shipper checks authenticated login, fork ownership and parent identity, upstream default branch, verified SHA, contribution permission, and open PR existence. Discover the contributor's fork; creating it is a one-time manual contributor step (GitHub's fork API also requires the App on the upstream), and the run waits for it durably. Add a trusted remote, push only the verified branch, then issue the compare URL with explicit base, head owner, and branch, a prefilled title and body, and a hidden run marker; never rely on ambient remotes or `--fill` alone.

Publish idempotently: persist intended branch and SHA before push, find existing fork branches/PRs on resume, and revise the same PR by pushing to its fork branch. Reconcile a submitted PR by head, base, `state=all`, and the hidden marker, never by GitHub's duplicate-PR refusal, which only holds while the first PR is open. A lost response or a repeated contributor click must not leave a second tracked PR or comment. No forced updates over unexpected remote commits. Such a mismatch hands off.

The prefilled PR follows upstream templates and contains issue reference, cause, scope, substantial LLM disclosure, actual test commands/results, regression evidence, baseline failures if permitted, and limitations. Respect required draft-PR conventions. No requests for stars, exaggerated autonomy/security claims, or advertising.

A compact optional collapsible receipt is appended only when the template/policy allows it. If not, retain the receipt locally and put required verification facts in the project's fields. It includes profile, runtime/image digest, candidate/base SHA, command exit statuses, suites actually counted (or `unknown`), network policy by phase, sanitized log references, and canonical receipt SHA-256.

The receipt is issued and authenticated by the trusted controller, with a signing key inaccessible to workers. Hash/signature protect integrity and provenance; they do not prove absence of all exploits. Signed intent blueprints authenticate instructions, not compliance. Never claim “all tests passed” when checks were skipped, pending, inconclusive, or failed.

Example provenance: “This contribution used substantial LLM assistance, orchestrated with [ai-dossier](https://github.com/imboard-ai/ai-dossier). Verification results below apply to commit `<SHA>`.”

#### 5.8 Durable states and intervention

| State | Next action / semantics |
|---|---|
| `gating` | Inspect eligibility and policies |
| `awaiting_maintainer` | Durable hand-off; explicit user resume checks invitation; no nudges |
| `planning`, `implementing`, `verifying` | Isolated active execution |
| `paused_user` | Selected checkpoint or pause request; no active compute |
| `shipping` | Typed authenticated operations on verified candidate |
| `awaiting_contributor` | Durable hand-off: comment link + prepared body or prefilled PR link issued, or manual fork/App installation pending; no compute; resume reconciles a link by marker, or re-checks the fork and App installation and returns to the phase that entered the wait |
| `submitted` | Initial run complete, PR URL persisted; CI may be pending |
| `awaiting_review` | Durable post-submission hand-off |
| `revising` | Explicit resume addresses actionable feedback on same PR |
| `accepted`, `merged`, `declined` | Observed upstream outcomes; only observed merge marks `merged` |
| `blocked`, `unsupported`, `failed`, `cancelled` | Reason and preserved artifacts; no relaxed retry |

User pause prevents new commands immediately and terminates active commands before snapshotting; cancellation terminates workers and revokes credentials. Publication cannot be recalled once the contributor submits: reconcile and report any PR already created. Resume with a changed model retains the budget ledger and invalidates verification if source changes. User edits happen in isolation and require re-verification. Editing identity/target starts a new run.

Each revision is a new budgeted execution session under the same contribution ID. Reviewer text cannot authorize unrelated scope, secrets, or network changes. Ambiguous feedback hands off. Updating a PR requires re-verification and the same policy checks. Remote branch divergence blocks; an expected history rewrite uses explicit compare-and-swap authorization, never blind force push.

Persist sanitized source snapshots, state, receipts, and logs locally under controller ownership for 30 days by default; no opt-out external telemetry in MVP. Do not store credentials or raw environment dumps. Make retention configurable; preserve URLs/SHAs and summaries after artifact expiry, but mark an expired snapshot as non-resumable without fresh reconstruction and verification.

#### 5.9 Authority, evidence, and lifecycle clarifications

**Residual threat:** isolation protects credentials and infrastructure; it cannot prove semantic correctness of a patch or honesty of repository tests. A valid receipt means specified commands executed against a specified tree under a specified profile. It does not certify that a malicious patch is useful. A separate constrained review stage compares the patch to the approved issue scope, checks test discovery/count changes, and flags deleted/disabled tests, reduced assertions, skip markers, and build/test/configuration changes. Such changes require explicit justification and independent validation; uncertainty produces a hand-off, not an automatic pass. Model review is supplementary evidence, not a security proof.

**GitHub authority matrix:** every write is either mediated by the clean trusted broker or a contributor-confirmed hand-off, never a worker or general agent shell. The controller admits a hand-off under the same conditions as a brokered write; it issues the prefilled link only then, and journals it as an intent.

| Operation | Performed by | Resource / permissions | Admission condition |
|---|---|---|---|
| Read policy/issue/source | Broker, no credential | Public upstream read | Supplied target binding; no contributor credential required |
| Engagement comment | **Contributor hand-off** (issue link + prepared body) | Contributor's own account | Policy permits contact; one controller-journaled request; verified contributor login; no test receipt required |
| Discover fork | Broker, no credential | Public fork listing and `parent` identity | Eligibility and invitation/direct-PR permission; explicitly approved upstream parent |
| Create fork | **Contributor, one-time manual step** | Contributor's own account | Same as discover; run waits durably, then verifies parent and installation scope |
| Push candidate | Broker | Installation token narrowed to the fork, contents write | Current policy permission plus authenticated commit receipt and expected remote SHA |
| Create PR | **Contributor hand-off** (prefilled compare URL) | Contributor's own account | Verified fork/head/base bindings, receipt, policy permission |
| Update PR | Broker pushes the fork branch; title/body changes are a **contributor hand-off** | As above | Same as push and create |
| Withdraw contribution | **Contributor hand-off** (PR link plus a prepared close comment; GitHub has no close prefill) | Contributor's own account | Explicit maintainer request or user instruction; never delete upstream content |

The gate-3 probe established the exact API permissions, token lifetimes, and attribution for these operations ([decision record](decisions/github-credentials.md)). Install/authorize the broker's GitHub App on the contributor's fork only, before the run; no automatic token-scope expansion. Each brokered operation gets only its necessary authorization with maximum 15-minute use. GitHub's native lifetimes are longer (installation token 1 h, user token 8 h), so the broker revokes after use and denies reuse. A token scoped from a user token outlives its parent's revocation; the broker journals and revokes every token it mints, and its kill switch deletes the contributor's grant, the only call that ends them all. If the provider cannot satisfy this contract for brokered writes, startup is unsupported. Credential secrecy alone does not grant write authority.

**Canonical artifact/commit contract:** supported source consists of regular file blobs, executable bits, and directories only. Any symlink, Git submodule/gitlink, or special file in the baseline or candidate makes the repository unsupported in MVP; never silently discard it. Reject `.git` paths and case/path collisions during export. Use the supplied upstream base as the parent of one canonical candidate commit. Record authenticated contributor-approved author name/email and UTC timestamp once; use a disclosed ai-dossier committer identity and fixed recorded timestamp/message. Subsequent reconstruction uses these exact fields and blob bytes. Resume/rebase constructs a new candidate and invalidates old receipts; never claim GitHub's verified-signature badge without actual verification.

The signed receipt binds schema version, contribution/run/session IDs, contributor login, upstream repository ID/issue/default branch, fork repository ID, canonical base/parent and candidate SHAs, profile/policy digests, command/result evidence digests, issuance/expiry, and permitted shipping operations. Shipping permission expires after 15 minutes and is single-use per journaled operation; a resumed operation reconciles first, then the controller may reauthorize only the same immutable verified candidate after fresh policy checks. Wrong-parent, wrong-contributor, target mismatch, and receipt replay are rejected.

**Permission freshness:** accept invitations from the issue author only when repository rules grant that authority; otherwise require the repository owner or an actor whose GitHub association is OWNER, MEMBER, or COLLABORATOR and whose role satisfies repository rules. Persist actor, association evidence, comment/assignment URL, policy digest, and timestamp. If authority cannot be established, hand off. Recheck AI policy, issue open state, assignment, competing fixes, and permission immediately before publication and every revision. Revocation, issue closure, new conflicting ownership, deleted fork/PR, or conflicting feedback blocks. A requested withdrawal issues the contributor the PR link and a prepared close comment, and the run records `declined` once it observes the PR closed; no persuasion or automated follow-up. Feedback already addressed at the current SHA is not implemented twice.

**Write reconciliation:** persist an operation intent before any comment, fork, push, or PR mutation. Use contribution ID, target, operation kind, and candidate SHA as the idempotency key; a hidden marker in an allowed comment identifies engagement. On ambiguous response, and for every contributor hand-off, search the contributor's corresponding artifacts first. If identity cannot be established reliably, hand off instead of repeating a write. Reconcile push success from remote SHA. Never rely solely on locally missing response data.

**Budget lifecycle:** maintain a contribution-wide history with independent finite ceilings per initial/revision session; explicit resume allocates a new ceiling, never resets historical spend. Reserve atomically across concurrent operations, using pinned exchange rates and disclosed provider pricing. Bound token output, retries, streaming duration, VM minimum billing increments, retained-storage charges, and teardown reserve before admission. Settle reservations on observed usage; unknown charges remain reserved. No reservation may consume the cleanup allowance. No idle worker compute is intended at a hand-off, but already billed minimums/storage may remain charged and are reported.

A controller crash resumes from the journal, reconciles resources and writes, then admits new work. Failed teardown enters `blocked_cleanup`, disables new execution/publication, revokes credentials, retries deletion at most three times, and reports resource IDs and possible continuing charges for operator action. An incident kill switch stops all new admissions and shipping, terminates active workers, revokes authorizations, and invokes cleanup; publication already completed is recorded and can be withdrawn explicitly, not silently erased.

## 6. Success Metrics

### Capability acceptance

- All mandatory adversarial fixtures fail to reach host/internal data, credentials, unrestricted egress, or unauthorized GitHub operations. Any violation blocks release.
- Every shipped PR references the exact independently verified commit; mismatch rate must be zero.
- Every supported acceptance fixture reaches either an evidenced PR submission or the specified honest hand-off; no fabricated success.
- Repeated resume produces zero duplicate engagement comments, PRs, or unauthorized branch overwrites.
- Node/npm and Python/pip+uv representative fixtures pass the supported installation/reproduction/verification paths before release.

### Observe after deployment; do not invent growth targets

Track eligible-to-submitted rate; acceptance/merge/decline rate; maintainer-requested rework; contributor active time; model/VM cost per submitted and accepted contribution; repeat usage; and voluntarily reported ai-dossier adoption. Separate active execution from maintainer wait time and initial completion from acceptance.

Demand/effort baselines are unknown. Establish them through actual use; no fixed five-issue kill threshold, promised star uplift, or job-placement outcome.

## 7. User Stories & Requirements

### Release slices

- [ ] **S1 — Authority/isolation foundation:** disposable VM adapter, hardened images, constrained worker broker, credential/model separation, egress enforcement, budget ledger, adversarial fixtures. No external PRs until this gate passes.
- [ ] **S2 — Supplied issue and community gate:** policy discovery, single engagement request, durable permission/checkpoint states, explicit reasons, no automatic reminders.
- [ ] **S3 — Node/Python implementation and verification:** supported profile manifest, frozen provisioning, baseline/regression checks, localized repair cap, independent commit-bound receipts.
- [ ] **S4 — Fork shipping:** least-privilege fork-side credential routing, sanitized artifact reconstruction, fork readiness, verified fork push, prefilled contributor hand-off with idempotent PR reconciliation, accurate upstream-template disclosure.
- [ ] **S5 — Control and follow-up:** pause/edit/model changes, resumable maintainer revisions, outcome tracking, retention/export, contributor/student documentation. Same autonomous engine, optional checkpoints.

### Gherkin acceptance scenarios

Role/outcome mapping: contributor configuration/control is covered by scenarios 8–9; maintainer permission/noise by 1–3 and 16; developer correctness by 6–7 and 15; contributor artifact/publication integrity by 10–13 and 17–18; autonomous portfolio use by 14; operator lifecycle safety by 4–5 and 19–20. Each acceptance fixture must identify its actor, expected outcome, and S1–S5 ownership in its test metadata.

1. **Policy prohibition:** Given a repository bans LLM contributions, when the issue is supplied, then terminate before engagement or implementation with the rule cited.
2. **Permission required:** Given assignment is required, when no invitation exists, then issue at most one prepared disclosed request (issue link + body) for the contributor to post, reconcile the posted comment by marker, and persist `awaiting_maintainer`; repeated resume issues no additional request.
3. **Direct contribution:** Given direct PRs are welcomed and no competing assignee/fix exists, when gates pass, then proceed without mandatory user review unless selected.
4. **Hostile execution:** Given dependency/test scripts attempt secret reads, host mounts, metadata access, direct egress, container privilege escalation, or broker access, when executed, then access is denied and no shipping authorization is issued after a boundary failure.
5. **Hostile instructions:** Given repository text demands credential disclosure or a different target PR, when read by the model, then typed authority enforcement rejects those actions regardless of model output.
6. **Regression:** Given a reproducible bug, when an automated regression is feasible, then its failure on the base and success on the candidate are recorded with actual commands and statuses.
7. **Broken/inconclusive candidate:** Given verification fails or times out, when two repair attempts are exhausted or a ceiling is reached, then preserve work privately and terminate without a public branch push.
8. **Cheap model:** Given a lower-cost supported model, when selected, then identical isolation and verification requirements apply.
9. **Budget/pause:** Given insufficient reserved budget or a pause request, when a next action is proposed, then refuse new work, stop/snapshot safely, and preserve the ledger for resume.
10. **Shipping integrity:** Given modified artifacts or a changed SHA after verification, when shipping is requested, then reject the receipt and require fresh verification.
11. **Unobserved submission:** Given the contributor submitted the prefilled PR but the run did not observe it, or submitted it twice, when resumed, then find the PR by head, base, `state=all`, and run marker, persist exactly one, and hand off on an ambiguous match rather than issue another link.
12. **Upstream CI:** Given the PR exists but upstream checks await maintainer approval, when reporting completion, then report `submitted` and pending CI, not green checks or merged status.
13. **Review revisions:** Given actionable feedback and explicit resume, when the patch changes, then independently verify and push to the same PR's fork branch without overwriting unexpected contributor commits.
14. **Full autonomy:** Given no checkpoints, when all permission/security/verification gates pass, then run through to a prefilled PR without mandatory student line review; the contributor's one-click submission is the only required action, and LLM disclosure and contribution evidence remain accurate.
15. **Dishonest tests/scope:** Given hostile instructions induce an unrelated change on the correct target and tests return success, when independent scope/test-integrity checks detect an unexplained change, then hand off without shipping; a zero exit code alone does not authorize publication.
16. **Permission race:** Given permission is revoked or the issue is closed after implementation, when the publication/revision freshness check runs, then block the write and retain evidence. Given the contributor's engagement comment is not observed, when resumed, then reconcile the existing marked comment or hand off without issuing a duplicate request.
17. **Canonical identity:** Given a wrong parent/contributor, replayed receipt, altered author fields, unsupported source object, or path collision, when reconstructing/verifying/shipping, then reject without silently normalizing source or sending an unverified commit.
18. **Lost push response:** Given a push succeeded without acknowledgment, when resumed, then reconcile branch/SHA before mutation; unexpected remote content blocks, and any rewrite is an explicit expected-SHA compare-and-swap push.
19. **Lifecycle billing:** Given concurrent reservations, a controller crash, or an interrupted streaming call, when resumed, then retain unknown reservations and reconcile charges before admitting work; cleanup allowance remains available.
20. **Cleanup incident:** Given VM deletion fails three times, when cleanup completes its retry budget, then persist `blocked_cleanup`, deny publication/new execution, revoke authorization, and expose remaining resource IDs/charges to the operator.

### Demonstrable vertical increments

After S1's mandatory isolation gate, demonstrate S2 as a safe eligibility/permission hand-off, S3 as a private verified patch, S4 as an end-to-end contributor-submitted PR on a controlled upstream/fork pair, and S5 as a verified revision on that same PR. These increments are acceptance demonstrations, not permission to release unsafe partial infrastructure.

## 8. Out of Scope

- Automatic issue discovery, bulk PR generation, maintainer reminders, or unsolicited recruitment campaigns.
- Hosted multi-tenant service, billing platform, employer marketplace, job guarantees, or mandatory pedagogy.
- Internal full-cycle merge/deploy behavior, write access to upstream, or changing upstream CI to obtain green checks.
- Tool-performed upstream writes (comments, fork creation, PR create/update/close). A per-run OAuth App token is a possible future opt-in that needs its own probe; not planned.
- Non-Node/Python ecosystems, private dependencies, runtime sudo, arbitrary internet tests, target-defined privileged containers, or unsupported VM/credential providers.
- Treating a non-root developer image, receipt hash, or signed blueprint as proof of complete security.
- Dossier/skill source publication inside this code repository. Final blueprint publication follows the registry publishing workflow separately from this docs PR.

## 9. Dependencies & Risks

| Risk / dependency | Treatment |
|---|---|
| Kernel/runtime exploit | Disposable VM limits exposure; patched pinned images, no trusted assets in VM; cannot claim immunity |
| Prompt injection / confused deputy | Untrusted content never grants authority; typed action constraints enforced outside model |
| Provider credential separation | Mandatory adversarial feasibility spike before any contribution |
| GitHub permission granularity / fork network | App tokens cannot write to an upstream without the App (gate-3 probe). Fork-side writes brokered; upstream writes are contributor hand-offs; block unsupported setups |
| Package compatibility and proxy escapes | Versioned adapters, constrained artifact proxy, frozen dependencies, honest unsupported outcomes |
| Baseline failures / false-positive tests | Before/after evidence, independent verification, no silent skips |
| Maintainer rejection / spam | Repository policy first, one request where appropriate, minimal patch, truthful disclosure |
| Variable spend and unreliable model | Admission/reservation limits and repair caps; distinguish estimates from invoices |
| Resume/state corruption | Controller-owned journal, immutable artifacts, idempotent API actions, fail closed on mismatches |
| Portfolio misrepresentation | Honest LLM provenance and submitted/accepted/merged distinction; no unaided-skill claims |

### Pre-release feasibility gates

1. Prove credential isolation, blocked internal/metadata/direct egress, and constrained GitHub authority using hostile fixtures—including malicious text, symlinks, Git configuration, artifacts, and test output.
2. Prove representative npm, pip, and uv projects can install through the proxy, reproduce a bug, and verify offline with exact commit evidence.
3. Prove short-lived contributor identity/fork/PR permissions and clean artifact reconstruction through a controlled test repository pair. **Passed 2026-10-06 under the revised contract (hybrid hand-off):** fork-side writes work with short-lived repository-limited tokens; upstream writes are contributor-confirmed. See the [decision record](decisions/github-credentials.md).
4. Exercise pause/cancel, expired credentials, fork delay, upstream drift, lost API responses, report parsing failures, budget exhaustion, and remote branch divergence.

These gates establish release readiness, not market validation. Failure never permits a weaker fallback.

## 10. Open Questions & Decision Record

### Resolved by the owner

- ai-dossier initiative; I'mBoard business grounding excluded.
- Node.js and Python scope; supplied issue URL, no automated discovery.
- Security is non-negotiable; disposable VM plus container separation.
- Respect OSS conventions, disclose heavy LLM use, request assignment when appropriate, add meaningful regression coverage, minimize noise.
- Fully autonomous contributor/student execution with optional intervention and model selection, up to publication.
- 2026-10-06: hybrid hand-off (option A in the [decision record](decisions/github-credentials.md)). The broker does every write it can with short-lived, repository-limited credentials; the contributor submits each upstream comment and PR action with one click, and creates the fork once by hand. Primary reason: a person reviews and owns every public submission. Secondary: GitHub refuses App writes to upstreams that have not installed the App.
- Capability investment separated from incremental operating spend; no arbitrary five-issue growth gate.
- User-controlled infrastructure initially; own contributor identity; durable maintainer waits; resumable revisions; configured ceilings.
- Initial completion at PR submission; maintainer owns merge.
- No visual wireframes; workflow interaction/state contract is the design artifact.

### Implementation choices to validate, not silently assume

VM provider, harness adapter, exact supported runtime/image matrix, and registry artifact-proxy implementation must be selected and proven in S1/S4. The GitHub credential mechanism was selected by the gate-3 probe: a GitHub App installed on the contributor's fork only. This PRD defines their required interfaces and rejection behavior; it does not claim those integrations already exist.

### Publication checkpoint

The owner approved publication on 2026-10-05 after the specification reached Ready at critic iteration 2. Publish the approved specification through a docs PR and linked GitHub epic. Target artifact: `docs/features/zero-trust-full-cycle/prd.md`; no `wireframes.md`. Approval covers the specification and publication, not release before the feasibility gates pass.

### Critic record

- **Iteration 1 — Needs Revision:** required tighter semantic-evidence limits, operation-specific GitHub authority, canonical commit identity, lifecycle accounting, and permission/recovery races.
- **Revision:** added §5.9, acceptance scenarios 15–20, actor/outcome mapping, and vertical acceptance increments.
- **Iteration 2 — Ready for implementation specification:** independent critic identified no remaining substantive blocking product gaps. Runtime, provider, and credential integrations remain mandatory feasibility proofs, not assumed capabilities.
- **Launch readiness — Not Ready:** capability is unimplemented; no security fixtures or external contribution runs have been executed. Specification approval does not authorize launch before the release gates pass.
