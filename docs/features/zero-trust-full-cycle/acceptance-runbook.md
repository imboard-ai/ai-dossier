# Zero-trust live acceptance runbook

The procedure for the owner-run acceptance demonstration in
[#1115](https://github.com/imboard-ai/ai-dossier/issues/1115): one real run of the engine against
the controlled upstream/fork pair, with a real VM, package proxy, model and GitHub. It covers PRD
§7's S4 (a contributor-submitted PR) and S5 (a verified revision of the same PR).

The run is owner-only. It needs the controlled repositories, the GitHub App, the contributor test
account, a KVM host and a model key. CI never runs it. Agents prepare everything up to the run and
stop there.

| Role | Repository or account |
|---|---|
| Upstream (maintainer side) | `imboard-ai/ztfc-upstream-fixture` |
| Contributor | `ydhidden` |
| Fork | `ydhidden/ztfc-upstream-fixture` |

These are the pair and accounts from the gate-3 probe
([credentials decision record](decisions/github-credentials.md)). Keep every other host name,
address, account ID, path and secret-store name out of the outcome record.

Commands below run from `packages/zero-trust` unless stated otherwise. `<repo>` is your checkout
of this repository. `<state-dir>` is the run's private state directory, and the run store is
`<state-dir>/runs`. Use **absolute paths** for `<state-dir>`, `<profile-dir>`, the proxy
endpoints file, the signer key and the controller public key: `zt-run` resolves relative paths
from `packages/zero-trust`, while the check script runs from `<repo>`. The [user guide](../../guides/zero-trust-contributions.md) explains every
field and state in more depth.

## 1. Prerequisites

| Requirement | Check |
|---|---|
| Linux x86_64 host with KVM | `test -r /dev/kvm && test -w /dev/kvm` |
| `qemu-system-x86_64`, `qemu-img`, and `genisoimage` (or `mkisofs` or `xorrisofs`) on `PATH` | `command -v qemu-system-x86_64 qemu-img genisoimage` |
| `/usr/bin/git`, `/usr/bin/prlimit`, `/usr/bin/flock` | `ls /usr/bin/git /usr/bin/prlimit /usr/bin/flock` |
| Node.js 20 or later | `node --version` |
| Docker, for the package proxy only | `docker info` |
| A browser on the same host as `zt-run`, or a forwarded loopback port | The OAuth callback goes to `127.0.0.1` |
| A model endpoint with an OpenAI-compatible Chat Completions API, and its key | |

Build once from `<repo>`:

```sh
npm ci
make build-zero-trust
cd packages/zero-trust
```

### 1.1 Bake the VM profile

```sh
node scripts/zt-vm.mjs bake --profile-dir <profile-dir> --cache-dir <cache-dir> --accel kvm
node scripts/zt-vm.mjs smoke --profile-dir <profile-dir> --state-dir <smoke-state-dir> --accel kvm
```

`smoke` must print timings with `"accelerator": "kvm"`. If a run VM does not boot, run
`node scripts/zt-vm.mjs diagnose --profile-dir <profile-dir> --out-dir <diag-dir>` and read the
serial log before changing anything.

### 1.2 Start the package proxy and write the endpoints file

```sh
node scripts/zt-proxy.mjs up --state-dir <proxy-state-dir> --out <proxy-up.json>
node scripts/zt-proxy.mjs check --state-dir <proxy-state-dir> --out <proxy-checks.json>
```

`check` must report every policy request with its expected outcome. Then write the run's proxy
endpoints file. The guest-side relay comes from `WORKER_RELAY`, the npm mirror from what `up`
printed. Nothing is typed by hand:

```sh
node -e '
const fs = require("node:fs");
const { WORKER_RELAY } = require("./dist/index.js");
const up = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const relay = `http://${WORKER_RELAY.host}:${WORKER_RELAY.port}`;
const file = { endpoints: { npmRegistry: `${relay}/`, pypiIndex: `${relay}/index/` },
               target: { host: up.npm.host, port: up.npm.port } };
fs.writeFileSync(process.argv[2], JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
' <proxy-up.json> <proxy-endpoints.json>
chmod 600 <proxy-endpoints.json>
```

The file must hold exactly `endpoints` and `target`, with an IPv4 `target.host`. Anything else
stops `start` after authorization and author confirmation with `error: operation_failed`
(exit 2); the internal diagnostic is `invalid_proxy_file`.

### 1.3 GitHub App

The App must declare exactly what the controller declares in `src/controller/wiring.ts`:
`{ contents: 'write', metadata: 'read' }`.

- Repository permissions: **Contents: Read and write**, **Metadata: Read-only**. Nothing else.
  An installation that grants anything more, such as Issues or Pull requests, is refused as
  `installation_too_broad` (detail `extra_permissions`) and the run ends `blocked`.
- **Expire user authorization tokens**: enabled. Otherwise `app_misconfigured`.
- **Callback URL**: `http://127.0.0.1/callback` (no port). The run listens on a random loopback
  port and puts it in the `redirect_uri` of the URL it prints.
- No webhook.
- Generate a private key and a client secret. Note the App ID, client ID and slug.

> [!IMPORTANT]
> The gate-3 probe App was created with Contents, Issues and Pull requests write. As it stands it
> is refused with `installation_too_broad`. Either create a new App as above, or edit the probe
> App to set Issues and Pull requests to "No access", then open the installation's settings on the
> contributor account and confirm it lists only Contents (read and write) and Metadata (read).

Install the App on the contributor account with **Only select repositories** and select only
`ydhidden/ztfc-upstream-fixture`. Never install it on the upstream, on "All repositories", or on
extra repositories.

### 1.4 Signer key and secrets

```sh
umask 077
openssl genpkey -algorithm ed25519 -out <signer-key.pem>
chmod 600 <signer-key.pem>
openssl pkey -in <signer-key.pem> -pubout -out <controller-public.pem>
```

The public key is the controller key the check script verifies receipts against. Export the
secrets into the shell that runs `zt-run`, under names of your choice. Do not write them into the
config or any file it names, and never type a secret inline on a command line, where it lands in
shell history:

```sh
export ZT_APP_PRIVATE_KEY="$(cat <app-private-key.pem>)"
read -rs ZT_APP_CLIENT_SECRET && export ZT_APP_CLIENT_SECRET   # paste, then Enter
read -rs ZT_MODEL_KEY && export ZT_MODEL_KEY                   # paste, then Enter
```

The model key variable must not be `GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_CLIENT_SECRET`, or start
with `ZTFC_` or `GIT_`.

## 2. Seed the upstream and open the issue

The upstream's `main` is still the gate-3 `range()` fixture. Replace its content with the npm
fixture and the acceptance policy in an ordinary commit by the maintainer account (no force-push,
so the old history and the fork's `main` stay ancestors):

```sh
git clone https://github.com/imboard-ai/ztfc-upstream-fixture.git <seed-dir>
cd <seed-dir>
git rm -r -q src test package.json README.md
cp -R <repo>/packages/zero-trust/fixtures/ecosystem/npm/base/. .
sed -i '/Known bug/d' src/duration.js
cp <repo>/packages/zero-trust/fixtures/acceptance/npm/upstream/CONTRIBUTING.md .
cp <repo>/packages/zero-trust/fixtures/acceptance/npm/upstream/README.md .
npm ci && npm test                     # the existing suite passes on the buggy base
git apply <repo>/packages/zero-trust/fixtures/ecosystem/npm/regression.patch
npm test                               # must FAIL: 900 !== 90
git checkout -- . && rm -f test/regression.test.js
git add -A
git status --short                     # src/, test/, package.json, package-lock.json, CONTRIBUTING.md, README.md; no node_modules
git commit -m "Seed the zero-trust acceptance baseline"
git push origin main
```

Keep `LICENSE` and `.gitignore` (`node_modules/`). Then open the bug issue as the maintainer
account, labelled `bug`. An unlabelled issue still passes; an `enhancement`, `feature`,
`question`, `discussion` or `documentation` label without `bug`, `defect` or `regression` makes
the gate hand off with `not_a_bug`:

```sh
gh issue create --repo imboard-ai/ztfc-upstream-fixture \
  --title "$(cat <repo>/packages/zero-trust/fixtures/acceptance/npm/issue-title.txt)" \
  --body-file <repo>/packages/zero-trust/fixtures/acceptance/npm/issue-body.md \
  --label bug
```

Note the issue URL. Leave it unassigned (an assignee other than the contributor is a hand-off),
and do not link any pull request to it. Issue #1 is the old `range()` report; closing it as
obsolete avoids confusion but does not affect the run.

The fork does not need syncing. The run pushes the candidate to a new branch,
`ztfc/<contribution-id>`, and Git uploads the new base commit with it. Syncing the fork's `main`
is harmless. Do not create `ztfc/*` branches on the fork yourself.

## 3. Run configuration

Write `run-config.json`, replacing every `<…>` (relative paths resolve from the directory you
run `zt-run` in):

```json
{
  "issueUrl": "https://github.com/imboard-ai/ztfc-upstream-fixture/issues/<number>",
  "contributor": "ydhidden",
  "executionProfile": {
    "provider": "local-qemu",
    "profileDir": "<profile-dir>",
    "stateDir": "<state-dir>",
    "accelerator": "kvm",
    "proxyEndpointsFile": "<proxy-endpoints.json>"
  },
  "modelProfile": {
    "phases": {
      "planning": {
        "adapter": "openai-compatible",
        "model": "<model-id>",
        "endpoint": "https://<model-endpoint>/v1",
        "apiKeyEnv": "ZT_MODEL_KEY"
      },
      "implementing": {
        "adapter": "openai-compatible",
        "model": "<model-id>",
        "endpoint": "https://<model-endpoint>/v1",
        "apiKeyEnv": "ZT_MODEL_KEY"
      }
    },
    "rates": [
      {
        "resource": "<model-id>",
        "currency": "USD",
        "unit": "token",
        "price": <US cents per 1,000,000 tokens, the provider's higher of input and output>,
        "units": 1000000,
        "source": "<provider price page and date>",
        "fx": { "currency": "USD", "numerator": 1, "denominator": 1, "timestamp": "<UTC time>" }
      },
      {
        "resource": "local-qemu",
        "currency": "USD",
        "unit": "millisecond",
        "price": 0,
        "units": 1,
        "source": "local VM, unbilled",
        "fx": { "currency": "USD", "numerator": 1, "denominator": 1, "timestamp": "<UTC time>" }
      }
    ]
  },
  "budget": {
    "currency": "USD",
    "ceilingMinor": 250,
    "cleanupAllowanceMinor": 25,
    "tokenLimit": 2000000,
    "activeMinutes": 120
  },
  "checkpoints": [],
  "limits": { "vcpus": 4, "memoryMiB": 8192, "diskGiB": 20, "commandTimeoutMs": 1200000, "activeMinutes": 120 },
  "signerKeyFile": "<signer-key.pem>",
  "githubApp": {
    "appId": <app-id>,
    "clientId": "<app-client-id>",
    "slug": "<app-slug>",
    "privateKeyEnv": "ZT_APP_PRIVATE_KEY",
    "clientSecretEnv": "ZT_APP_CLIENT_SECRET"
  },
  "retentionDays": 30
}
```

Budget notes:

- The ceiling applies **per budget session**. The initial run is session 1 and
  `resume --revise` opens session 2 with the same ceiling, so `ceilingMinor: 250` keeps the whole
  demonstration at or below $5.00 (2 × $2.50). Work is refused once it would cross
  `ceilingMinor − cleanupAllowanceMinor` ($2.25 here); the remaining $0.25 per session is kept for
  VM teardown.
- Every model call reserves its worst case before it runs: the request size in bytes counted as
  input tokens plus the output cap (16,384 tokens for planning and implementation calls, 1,024
  for typed decisions), times the token price. A reservation that would cross the ceiling is
  refused, so a very expensive model can stop the run even though the fixture is tiny. A model at or below about $3 per million tokens leaves ample
  headroom at $2.25 per session.
- The `local-qemu` rate is required; without it the first VM allocation fails with `missing_rate`.
- Set `checkpoints` to `["patch"]` if you want to read `artifacts/candidate.diff` before
  verification. The run then stops in `paused_user`; approve the digest that `status` prints with
  `approve --checkpoint patch --digest <sha256>` and `resume`.

The schema is closed: an unknown key is `unknown_key`, a secret-looking value is
`secret_detected`. Do not add `authorApproval` or `resumeRunId`.

## 4. The run

Run every command in one shell on the KVM host. Record the wall-clock time at each stop.
`status --root <state-dir>/runs --run <id> [--json]` is read-only and safe at any time.

### 4.1 Start

```sh
node scripts/zt-run.mjs start --config run-config.json --root <state-dir>/runs
```

1. It prints `authorization_url: "https://github.com/login/oauth/authorize?…"`. Open it in a
   browser **logged in as `ydhidden`** and authorize the App. If the browser is on another
   machine, forward the loopback port named in the URL's `redirect_uri` to the **same** port
   number first (`ssh -L <port>:127.0.0.1:<port> <kvm-host>`): the callback only accepts the
   exact `127.0.0.1:<port>` host.
2. It prints `author_identity: {…}`. Check `login` is `ydhidden` and `email` is the
   `<id>+ydhidden@users.noreply.github.com` address, then type `yes`. Without a terminal (for
   example piping into `tee`), pass `--confirm-author` instead; the identity is then accepted as
   printed.
3. The run gates, plans, implements, verifies and ships without further input.

**Stop A — `awaiting_contributor`, `reasonCode: "contributor_handoff"` from `shipping`.**
`status` shows the compare link in `nextPermittedAction` and a `candidateSha`. Check:

- `runId` (`ztc-<16 hex>-run-1`); note it.
- `candidateSha` exists on the fork:
  `gh api repos/ydhidden/ztfc-upstream-fixture/git/ref/heads/ztfc/<contribution-id> --jq .object.sha`
  equals it (`<contribution-id>` is the run ID without `-run-1`).
- `estimatedSpend` is below the ceiling.
- No comment was posted on the issue (the policy let it proceed directly).

Other stops on the way, and what they mean:

| Status | Meaning | Action |
|---|---|---|
| `gating`, policy hand-off (`ai_unclear`, `ownership_unclear`) | The typed policy decisions were not confident enough on `CONTRIBUTING.md` | Read the cited lines in `status`. This is a finding for the record. Do not reword the policy mid-run; cancel and start a new run if you change it. |
| `awaiting_contributor`, `contributor_handoff` from `gating` | The policy asked for an engagement comment, which the acceptance policy should not | Record it as a finding. Posting the prepared comment continues the run, but it is no longer the direct-PR path. |
| `awaiting_contributor`, `fork_missing` | The fork was not found under `ydhidden` | Fix the fork, then `resume`. |
| `awaiting_contributor`, `installation_missing` | The App is not installed on the fork, or is suspended | Install it on the fork only, then `resume`. |
| `blocked`, `installation_too_broad` | The installation grants extra permissions or repositories | Fix the App (section 1.3) and start a new run. |
| `paused_user` | A checkpoint, a non-reproducing bug, or a review flag | Read `nextPermittedAction` and the named artifact. |
| exit 4, `store_locked` | Another controller holds the store | Wait for it; never delete lock files. |

### 4.2 Submit the PR (contributor)

Open the compare link **logged in as `ydhidden`**. Review the prefilled title and body, change
nothing, and click **Create pull request**. Check the body before submitting: it has the
`## LLM disclosure` section, the `## Verification` command lines against `candidateSha`, and the
hidden `<!-- ai-dossier:ztfc … -->` marker. If `status` names a prepared body file instead, paste
that file. If the body lists "Upstream requires a draft PR" under Limitations, choose **Create
draft pull request** and record it as a policy finding.

### 4.3 Resume to `submitted`

```sh
node scripts/zt-run.mjs resume --root <state-dir>/runs --run <run-id>
```

**Stop B — `submitted`.** This is S4. Check:

- `status` names the PR and its upstream CI (`none` is expected: the fixture has no workflows).
- Exactly one PR exists for the head:
  `gh pr list --repo imboard-ai/ztfc-upstream-fixture --state all --head ztfc/<contribution-id>`.
- Run the check script (section 5) without `--after-revision`. It must pass.

### 4.4 Maintainer review

As the **maintainer account** (an owner, member or collaborator of the upstream; not `ydhidden`),
open the PR, choose **Files changed → Review changes → Request changes**, and submit a concrete,
in-scope request that needs a code change. Pick one the candidate does not already satisfy, for
example:

> Please also cover hours in the regression test: `toSeconds('1h')` should return 3600.

Feedback that is unclear, outside the issue, or tries to change targets or authority is not
admitted: the run stops in `paused_user` with no VM started. That is correct behaviour, not an
acceptance pass.

### 4.5 Revise

```sh
node scripts/zt-run.mjs resume --root <state-dir>/runs --run <run-id> --revise
```

The revision opens a new budget session, re-admits policy and permission, implements in a fresh
VM, verifies, and pushes the new candidate to the same branch with a compare-and-swap from the
last verified head. If `status` shows `shipping` with the revision push still to be confirmed,
run plain `resume` again until the state returns to `submitted` (or `awaiting_review`).

**Stop C — `submitted` after the revision.** This is S5. Check:

- `candidateSha` changed, and the PR's head commit is the new value (`gh pr view <pr-url> --json headRefOid`).
- It is still the same PR; no second PR exists for the head.
- Run the check script with `--after-revision`. It must pass.

The PR body still shows the first candidate's verification unless you ran `pr-edit` during the
revision. The check script accepts a body that names any verified candidate of this run.

## 5. Check script

From `<repo>`, with no controller running against the store: the last `zt-run` command has
exited and `status` shows the stop you expect (`submitted`, or `submitted`/`awaiting_review`
after the revision).

```sh
ZT_ACCEPTANCE_LIVE=1 node scripts/zt-acceptance-check.mjs \
  --root <state-dir>/runs --run <run-id> \
  --upstream imboard-ai/ztfc-upstream-fixture --fork ydhidden/ztfc-upstream-fixture \
  --controller-key <controller-public.pem>
# after the revision, add: --after-revision
```

It refuses to run without `ZT_ACCEPTANCE_LIVE=1`. It is read-only: it reads the run store's
step-artifact and PR-tracker journals (`<contribution-id>/control/steps/`, `<contribution-id>/track/`) without opening the store, and it
makes only `GET` requests to the GitHub API, anonymously by default. Set
`ZT_ACCEPTANCE_READ_TOKEN` to a read-only token if the anonymous rate limit gets in the way.

| Check | Passes when |
|---|---|
| `receipts` | Every retained receipt is `ztfc-receipt-v2`, intact, verified, bound to this run, and signed by the controller key |
| `identity` | The upstream and fork repository IDs equal the signed IDs, the fork's parent is the upstream, and the fork belongs to the contributor |
| `fork-branch` | `ztfc/<contribution-id>` on the fork points at the latest verified candidate |
| `single-pr` | Exactly one PR exists for that head and base with `state=all`, by the contributor, and it is the one the run recorded |
| `pr-body` | The body carries exactly the marker the run's PR tracker recorded (`op=pr_create`), the LLM disclosure, and the exact command lines of a verified receipt; after the revision the detail notes when the body still describes the first candidate |
| `pr-head` | The PR head is the latest verified candidate; with `--after-revision`, at least two verified candidates exist and the head also differs from the first |

It prints one PASS/FAIL row per check and exits 0 only when all pass, 1 on any failure, and 2
when it refuses to run (no `ZT_ACCEPTANCE_LIVE=1`, bad arguments, an unreadable or private key,
packages not built, a malformed token). Any unreadable, truncated, paginated or ambiguous answer
is a FAIL, and rows with the same detail share one root cause. `--json` prints the same result as
one object.

| FAIL detail | Likely cause | Action |
|---|---|---|
| `step_journal_incomplete`, `step_artifact_digest_mismatch`, `track_journal_incomplete` | A controller is still writing the store | Wait for it to exit, rerun |
| `step_journal_unreadable`, `track_journal_unreadable` | Wrong `--root`/`--run`, a relative path, or no PR tracked yet | Use absolute paths; `resume` after submitting |
| `receipt_signed_by_other_key` | Wrong `--controller-key` | Pass the public key of the config's `signerKeyFile` |
| `github_rate_limited`, `github_http_403`/`429` | Anonymous rate limit | Set `ZT_ACCEPTANCE_READ_TOKEN`, rerun |
| `github_http_404: <request>` | Wrong `--upstream`/`--fork`, or the branch is gone | Check the names |
| `fork_sha_mismatch … (an earlier verified candidate)` | The revision push is not confirmed yet | `resume`, then rerun |
| `pull_count_0`, `pull_not_recorded_by_run` | PR not created yet, or `resume` not run after creating it | Create the PR, `resume` |
| `pull_count_2` and up, `pr_marker_*`, `pr_commands_missing`, `pr_disclosure_missing` | Duplicate PR, or the body was edited | Defect or operator error: record it |
| `unexpected_error: …` | A bug in the check script or a stale package build | `make build-zero-trust`, rerun; otherwise record it |

Anything that is not a wait-and-rerun case is a finding: save the `--json` output and file a
sub-issue of #1002.

## 6. Record the outcome

Capture, for `docs/features/zero-trust-full-cycle/decisions/acceptance-demo.md`:

- The run states and reason codes at stops A, B and C (`status --json`), with wall-clock times.
- The base SHA, both verified candidate SHAs and the PR URL.
- Estimated and observed costs: `node scripts/zt-run.mjs metrics --root <state-dir>/runs --json`
  and the `estimatedSpend` of each session.
- Both check-script outputs. They print repository names and SHAs only, never numeric IDs.
- Any defect, filed as a sub-issue of #1002 and linked from the record.

`node scripts/zt-run.mjs export --root <state-dir>/runs --run <run-id> --out <file>` writes the portable bundle, but its `receipts`,
`verification`, `disclosure` and `policyCitations` stay empty for a live run: the composed
controller keeps receipts as step artifacts and never writes the `receipt-evidence.json`,
`verification-evidence.json` or `portfolio-evidence.json` records that export reads. Use the
check script for receipt evidence.

No account names beyond the public pair above, no host details, and no IDs other than SHAs and the
public repository names.

## 7. Cleanup

1. Stop tracking and revoke the run's credentials. In a waiting state the cancel is queued and
   applied by the next `resume`:

   ```sh
   node scripts/zt-run.mjs cancel --root <state-dir>/runs --run <run-id> --reason "acceptance demo complete"
   node scripts/zt-run.mjs resume --root <state-dir>/runs --run <run-id>
   ```

   The run ends `cancelled`. The PR stays open, and `status` gives a prepared close comment if you
   want to close it.
2. Confirm no VM is left. Report first, then destroy only what it reports:

   ```sh
   node scripts/zt-vm.mjs reconcile --state-dir <state-dir>/vms
   node scripts/zt-vm.mjs reconcile --state-dir <state-dir>/vms --destroy   # only if the report lists leftovers
   ```

   In an incident use `node scripts/zt-run.mjs kill-all --root <state-dir>/runs --reason <text>`
   instead. It fences the store for good and engages the VM kill switch; lift that with
   `node scripts/zt-vm.mjs release --state-dir <state-dir>/vms --reason <text>` once no VM remains.
3. Stop the proxy: `node scripts/zt-proxy.mjs down --state-dir <proxy-state-dir>`.
4. Revoke the contributor's App authorization. As `ydhidden`, open GitHub **Settings →
   Applications → Authorized GitHub Apps** and revoke the App. The API equivalent is
   `DELETE /applications/{client_id}/grant` with basic auth `<client_id>:<client_secret>` and the
   body `{"access_token": "<live user token from this grant>"}`. It answers 404 once no token from
   the grant is live, which is the normal state after cancel, so the settings page is the
   dependable route. Confirm the App no longer appears there.
5. Delete the App's client secret and private key if the App is not needed again, and remove the
   exported variables from the shell.
