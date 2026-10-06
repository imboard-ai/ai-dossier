# Decision record: GitHub credentials for the zero-trust shipper

- **Issue:** #1011 (epic #1002, slice S4, PRD feasibility gate 3)
- **Spec:** [PRD](../prd.md) §5.7, §5.9 "GitHub authority matrix", §9 gate 3
- **Probe:** [`packages/zero-trust/probes/github-credentials/`](../../../../packages/zero-trust/probes/github-credentials/)
- **Raw evidence (redacted):** [`docs/reports/evidence/ztfc-github-credentials-probe.jsonl`](../../../reports/evidence/ztfc-github-credentials-probe.jsonl)
- **Run date:** 2026-10-06
- **Status:** **UNSUPPORTED for fully autonomous upstream writes. DECIDED: hybrid hand-off (A),** owner decision of 2026-10-06. Feasibility gate 3 passes under the revised contract: fork-side writes are brokered, and upstream writes are hand-offs the contributor confirms. See [Verdict](#verdict) and [Decision](#decision).

> [!WARNING]
> **Broker design impact: scoped tokens outlive their parent.** A token minted with
> `POST /applications/{client_id}/token/scoped` lives for 8 h *independently* of the token it
> was scoped from (observed). A scoped token cannot itself be scoped again. Rotating the parent (refresh) or revoking it
> (`DELETE /applications/{client_id}/token`) does **not** invalidate scoped children. A broker
> that narrows per operation must therefore journal every scoped token it mints and revoke each
> one on its own, or delete the whole grant (`DELETE /applications/{client_id}/grant` with any
> live token from the grant, which observed revokes the children too). Revoking "the" user token is not enough, and a crash
> between mint and revoke leaves a live token until it expires.

## Setup

| Role | Fixture |
|---|---|
| Upstream | `imboard-ai/ztfc-upstream-fixture`, public, with bug issue #1. The App is **not** installed: `GET /repos/{upstream}/installation` with an App JWT returns 404. |
| Contributor | `ydhidden`, a separate account with only `read` on the upstream |
| Fork | `ydhidden/ztfc-upstream-fixture`, created by hand; `parent.id` matches the upstream |
| GitHub App | `ztfc-contributor-probe`: public, no webhook, expiring user tokens. Repository permissions: Contents, Issues, Pull requests write; Metadata read. |
| Installation | On `ydhidden`, `repository_selection=selected`, fork only |

The candidate is a real fix for the fixture bug: `<` becomes `<=` in `src/range.js`, plus a regression test. `node --test` passes. The single commit is authored and committed by the contributor's noreply identity at a fixed timestamp.

Credential labels used below:

- **ghu**: GitHub App user-to-server token, obtained through the web flow and then rotated with the refresh token.
- **ghu-scoped**: a ghu narrowed with `POST /applications/{client_id}/token/scoped`.
- **ghs**: an installation token narrowed with `repositories:[fork]` and `permissions:{contents:write}`.
- **anon**: no credential.

Notes on the evidence file:

- The `scoped` phase appears twice. The first pass aimed its fork-write test at a branch that did not exist (404), so the phase was fixed and run again. The token results are the same in both passes.
- The first `revocation` pass ran an earlier ordering of the phase, which is what exposed the scoped-child behaviour. The probe script has the corrected ordering, which ends in a grant deletion made with a live token. That corrected ordering was run after a second contributor authorization (the second `token response shape` and `revocation` block).

## Operation matrix (PRD §5.9)

"Observed" means this probe made the request on 2026-10-06 and got the result shown. The evidence column quotes the redacted request, the HTTP status, and GitHub's message. It also gives the `X-Accepted-GitHub-Permissions` header where GitHub returned one.

| # | Operation | Token type | Minimal permission | Attribution on GitHub | Lifetime | Revocation call | Result | Evidence (observed) |
|---|---|---|---|---|---|---|---|---|
| 1 | Read issue, policy, source | anon | none (public) | n/a | n/a | n/a | **SUPPORTED** | `GET /repos/{upstream}` → 200; `git clone` anonymous → ok |
| 2 | Engagement comment on the upstream issue | ghu | issues:write on the upstream (per header) | not reached | 8 h | n/a | **UNSUPPORTED** | `POST /repos/{upstream}/issues/1/comments` with ghu → **403** "Resource not accessible by integration", accepted `issues=write; pull_requests=write`. Same 403 for ghu-scoped and ghs. |
| 3a | Discover the fork | anon | none | n/a | n/a | n/a | **SUPPORTED** | `GET /repos/{upstream}/forks` → 200, lists `ydhidden/ztfc-upstream-fixture`; `GET /repos/{fork}` → `fork:true`, `parent_id` = upstream id |
| 3b | Create the fork | ghu | administration:write + contents:read on the **upstream** (per header) | n/a | n/a | n/a | **UNSUPPORTED** (one-time manual prerequisite instead) | `POST /repos/{upstream}/forks` with ghu → **403** "Resource not accessible by integration", accepted `administration=write,contents=read` |
| 4 | Push the verified candidate to the fork | **ghs** (recommended) or ghu | contents:write on the fork only | Commit: author/committer = contributor (`ydhidden`), unsigned. Pusher = `ztfc-contributor-probe[bot]` for ghs, the contributor for ghu. | ghs 1 h; ghu 8 h | `DELETE /installation/token` (ghs); `DELETE /applications/{client_id}/token` (ghu) | **SUPPORTED**; the broker must revoke after use, because native lifetime is above 15 min | `git push` ghu → ok, remote SHA = expected; `git push` ghs → ok, remote SHA = expected; ghs reuse after `DELETE /installation/token` → 401 |
| 4b | Expected-remote-SHA guard (scenario 18) | ghu or ghs | contents:write on the fork | n/a | n/a | n/a | **SUPPORTED** | An out-of-band commit moves the branch. The preflight `GET /git/ref` sees an SHA different from the recorded one and refuses. A plain push is rejected (non-fast-forward). `--force-with-lease=<ref>:<recorded>` is rejected "(stale info)". The remote stays at the out-of-band SHA. An explicit CAS push restores the verified SHA. |
| 5 | Create the cross-repository PR on the upstream | ghu | pull_requests:write on the upstream (per header) | not reached | 8 h | n/a | **UNSUPPORTED** | `POST /repos/{upstream}/pulls` with `head=ydhidden:<branch>`, `base=main` → **403** "Resource not accessible by integration", accepted `pull_requests=write`. Same 403 for ghu-scoped and ghs. |
| 6 | Update / close / reopen the upstream PR | ghu | pull_requests:write on the upstream | not reached | | | **UNSUPPORTED** (no PR can exist; every upstream write was refused) | Mechanics proven on a fork-internal PR (rows below) |
| 7 | Withdraw the contribution (close PR, explanatory comment) | ghu | pull_requests/issues:write on the upstream | not reached | | | **UNSUPPORTED** (same cause as rows 2 and 5) | |

The same mechanics run against a repository where the App **is** installed (a PR inside the fork) show that everything except the upstream boundary works:

| Operation | Token | Result | Attribution | Evidence (observed) |
|---|---|---|---|---|
| Create PR with explicit `head`/`base`/repo | ghu | 201 | `user.login=ydhidden`, `performed_via_github_app=ztfc-contributor-probe` | `POST /repos/{fork}/pulls` |
| Lost response (scenario 11) | anon list, then ghu | Found exactly one PR, by `head=ydhidden:<branch>`, `base`, `state=all` plus a hidden body marker. A blind second create gets **422** "A pull request already exists for ydhidden:<branch>". | | `GET …/pulls?head=…&base=…&state=all` |
| Update title/body | ghu, then ghu-scoped (pull_requests+issues:write) | 200, 200 | | `PATCH …/pulls/1` |
| Comment | ghu | 201 | `user.login=ydhidden`, `performed_via_github_app=ztfc-contributor-probe` | `POST …/issues/1/comments` |
| Close, reopen, close | ghu | 200 each time | | `PATCH …/pulls/1 {state}` |
| Permission outside the scope | ghu-scoped (contents only) commenting on the fork PR | **403** | | scoping enforces permissions, not only repositories |

Scenario 11 note: the 422 safety net only holds while a PR is **open**. After a close it does not stop a second create. So the broker must reconcile with `state=all` plus the hidden marker, never by relying on the 422.

## Probe questions

**Q1. Can a ghu token comment, open a cross-repository PR, update it and close it on an upstream without the App? Observed: no.** The comment and the PR create are both refused with 403 "Resource not accessible by integration". The ghu token carries the App's permissions, but only for repositories the App can access through an installation. GitHub's documentation for user access tokens says the same. Update and close could not be reached. The same calls succeed on a repository where the App is installed, so the token, its permissions and the request shapes are correct, and the upstream boundary is the only blocker.

**Q2. Is a scoped token aimed at the upstream owner rejected? How long does a scoped token live, and does it work? Observed: rejected, 8 h, and it works within its scope.**
- `target=imboard-ai` → **403** "Your app does not have access to the given target."
- `target=ydhidden` with `repository_ids:[upstream id]` → **403** "There is at least one repository that does not exist or is not accessible to the parent installation."
- `target=ydhidden`, `repository_ids:[fork]`, `contents:write` → 200 with a new ghu token (fields: `token`, `expires_at`, `installation.permissions={contents:write, metadata:read}`, `repository_selection=selected`). It creates and deletes a fork ref (201/204) and is refused anything outside its permission set (403 on a comment).
- `expires_at` is **8 h from the moment of scoping**. It is not the 15 minutes the PRD wants, and it is not tied to the parent token's expiry.
- Scoping does not invalidate the parent token: the parent ghu still returns 200.

**Q3. Revocation and rotation. Observed:**
- `DELETE /applications/{client_id}/token` on a ghu returns **204**. Afterwards the token gets 401 "Bad credentials", **and its refresh token is dead too** (`bad_refresh_token`). Revoking the current access token therefore ends the authorization chain, and the next run needs a new user authorization.
- A refresh returns a new ghu/ghr pair. The old access token then gets **401**, and the old refresh token gets `bad_refresh_token` on reuse. Reusing an old refresh token does **not** poison the chain: the current access token stays valid and the current refresh token still rotates.
- **Scoped tokens are independent of their parent.** A scoped child stayed valid (200) after its parent was rotated away, and also after its parent was revoked with `DELETE /token`. Each scoped token has to be revoked on its own (`DELETE /token` on it → 204, then 401 on reuse), or through the grant.
- `DELETE /applications/{client_id}/grant` needs a *live* token from the grant. Called with an already-revoked token it returns 404. Called with a live **scoped child** it returns **204**, and that child then gets 401. Deleting the grant is the only single call that ends every token of the contributor's authorization, scoped children included. A broker kill switch should use it, called with any live token it still holds.
- **A scoped token cannot be scoped again:** 401 "A scoped token cannot create another scoped token." Narrowing is one level deep, so the broker has to scope from the unscoped ghu each time.
- The first run left two scoped children (contents:read on the public fork, 8 h) that could not be revoked one by one, because the first ordering of the phase had not kept their values. After the contributor authorized again, the grant was deleted (204). GitHub documents that grant deletion revokes every token for that user–App pair, and on the second run a live child was observed dead afterwards. The two first-run children were not checked directly, because their values were never kept. The corrected script revokes or covers every token it mints.
- Installation tokens: `DELETE /installation/token` → 204, then 401 on reuse.

**Q4. Does git push work with ghu, and with a fork-only ghs? Can the narrowed tokens write to the upstream? Observed: push works with both; neither token can write to the upstream.**
- Push to the fork over HTTPS works with ghu and with a ghs narrowed to the fork with `contents:write` (`expires_at` = mint + 1 h). In both cases the remote SHA equals the expected SHA. Credentials were passed only as an `http.extraheader` supplied through the environment, with credential helpers and global config disabled.
- Push to the upstream with ghu → 403 "Permission to … denied to ydhidden". With ghs → 403 "denied to ztfc-contributor-probe[bot]".
- ghs on the upstream: comment 403, PR 403.
- Asking for an installation token that includes the upstream repository id → 422 "not accessible to the parent installation".

**Q5. What attribution appears? Observed:** comments and PRs show the contributor as the author (`user.login=ydhidden`) with the "via ztfc-contributor-probe" badge (`performed_via_github_app.slug`). Commits show the contributor as author and committer, matched through the noreply email, and are unsigned (`verification.reason=unsigned`). A ghs push is performed by the App bot, but the commits keep the contributor's authorship.

## Other observations

- **Final comment on the upstream issue.** The probe's closing note on upstream issue #1 could not be posted with the contributor's token (403, same as Q1). It was [posted with the repository owner's own identity](https://github.com/imboard-ai/ztfc-upstream-fixture/issues/1#issuecomment-6019731015) as fixture housekeeping. That is not a shipper path.

- **Token response shape**, both on code exchange and on refresh: `access_token` (ghu_), `expires_in=28800` (8 h), `refresh_token` (ghr_), `refresh_token_expires_in=15724800` (about 182 days), `scope=""`, `token_type=bearer`. This confirms that expiring user tokens are enabled.
- **Fork discovery needs no credential.** `GET /repos/{upstream}/forks` lists the fork, and `GET /repos/{fork}` gives `parent.id` for the binding check.
- `GET /user/installations` with ghu lists only the contributor's installation (`selected`).

## Verdict

**UNSUPPORTED.** The rows that fail are 2 (engagement comment), 3b (fork creation), 5 (upstream PR creation) and 6–7 (PR update/close/withdraw on the upstream).

Rows 1, 3a, 4 and 4b are **SUPPORTED**. Fork pushes work with a fork-only installation token or a scoped ghu. The broker must revoke after use, because both tokens are natively 1–8 h, longer than the PRD's 15-minute window. GitHub refuses reuse after revocation.

**PRD §5.9 consequence, applied:** "If the provider cannot satisfy this contract, startup is unsupported." The shipper cannot do the upstream-facing writes in the authority matrix with any short-lived, repository-limited GitHub App credential, so under the original contract zero-trust startup is **blocked**. The probe did **not** fall back to, or try, a PAT or OAuth-App token.

**Gate 3 (PRD §9): passed under the revised contract** in the [Decision](#decision) below. The broker does the fork-side writes (push, CAS, reconciliation) with short-lived, repository-limited, revoked credentials. The upstream comment and PR are hand-offs the contributor confirms. The #1011 broker acceptance criteria are rescoped to the fork-side broker.

### Decision

**Decided by the owner on 2026-10-06: A, hybrid hand-off.**

**Rationale.** Before anything is submitted upstream, the contributor reviews it and makes one click on a prefilled PR or comment. That click is a deliberate human-in-the-loop review: a person reviews and owns every public submission made under their name, which keeps low-quality AI contributions ("AI slop") out of maintainers' queues. It is also the only path that keeps the short-lived, repository-limited credential contract, because GitHub refuses App writes to upstreams that have not installed the App (rows 2 and 5).

**What changes.** The broker does every write it can do with short-lived credentials: fork push, branch CAS, and reconciliation reads. The upstream PR becomes a contributor click on a prefilled compare URL (`/compare/{base}...{owner}:{branch}?expand=1&title=…&body=…`), and the engagement comment becomes a prefilled comment. The run then reconciles the PR by `head` + `base` + hidden marker (scenario 11). Upstream close or withdrawal is likewise a hand-off to the contributor. The PRD amendment and the S4 issues are tracked separately.

Options considered:

| Option | Pros | Cons |
|---|---|---|
| **A. Hybrid hand-off (DECIDED)** | Keeps the credential contract intact (nothing long-lived, nothing broad). Uses only what was observed to work. Every public submission is reviewed and owned by a person. | Upstream publication is not fully autonomous, which amends the PRD's autonomy statement. The contributor must be present at the publication checkpoint. |
| B. Require the upstream to install the App | Fully automatic, and it works with the observed token types | Real OSS upstreams will not install a third-party App for drive-by contributors. This defeats the product's purpose. |
| C′. OAuth App user token with `public_repo`, authorized once per run and revoked with `DELETE /applications/{client_id}/token` when the run ends. **Possible future opt-in mode; not probed, and it would need its own probe.** | Expected to be able to write to any public upstream as the contributor. Revocation is documented, and the token's life is bounded by the run. | The scope is every public repository the user can reach, not repository-limited. The lifetime is the run, not 15 minutes per operation. Every run needs a fresh contributor consent. There is no per-operation narrowing, because OAuth Apps have no scoped-token endpoint. It would need the contract relaxed to "run-bounded and revoked". |
| C. OAuth App with `public_repo` scope, long-lived | Can write to arbitrary public repositories as the user | Non-expiring and not repository-limited, which is the broad long-lived token PRD §5.7 and §5.9 forbid. Ruled out. |
| D. Classic or fine-grained PAT | — | Classic PATs are broad and long-lived, which the PRD forbids. Fine-grained PATs cannot write to public repositories where the user is not a member. Ruled out. |
| E. Declare GitHub unsupported for MVP | Honest, with no contract change | Ends the product for its only target platform. |
