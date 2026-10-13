# Zero-trust contributions: user guide

This guide is for people who use the zero-trust contribution engine (`@ai-dossier/zero-trust`)
to propose a fix for a bug in someone else's open-source project. It covers setup, the run from
start to submitted pull request, every place the run stops and hands control back to you, the
controls you have, costs, retention, and the security model. Apart from one constant named in
[setup step 2](#one-time-setup), you should not need to read the code to use it.

Three kinds of reader will find their own sections:

- **Developer contributors** delegating the work while keeping control of scope and cost: read
  everything from [What it does](#what-it-does-and-does-not-do) to
  [Retention, export and metrics](#retention-export-and-metrics).
- **Students and portfolio builders**: also read [For students and portfolio use](#for-students-and-portfolio-use).
- **Upstream maintainers** who received a pull request made with this tool: start at
  [For maintainers](#for-maintainers).

The specification is [PRD-ZTFC-001](../features/zero-trust-full-cycle/prd.md). The
[package README](../../packages/zero-trust/README.md) is the implementer's spec of record; this
guide summarizes it for users and links to it where detail matters.

> [!IMPORTANT]
> The package is private and its release gates are still being worked through (PRD §9). Treat
> runs against real upstream projects as early use: read every prepared comment and pull request
> before you submit it.

## What it does and does not do

You give the run one public GitHub issue URL. The run:

1. reads the project's contribution rules, AI policy and the issue, and decides whether you may
   contribute, need to ask first, or must stop;
2. reproduces the bug, plans and implements a minimal fix with a model, inside a disposable local
   VM that holds no credentials;
3. verifies the exact candidate commit again in a fresh VM and signs a receipt for it;
4. pushes that verified commit to **your fork** with a short-lived token limited to the fork;
5. prepares the pull request and gives you a link. **You** open the link, review the prefilled
   title and body, and submit it under your own account;
6. tracks the pull request when you ask it to, and can make revisions on the same pull request
   after maintainer feedback.

What it does not do:

- **The initial completion is "PR submitted".** It is not "merged" and not "deployed". The
  maintainer owns the merge. The run reports `merged` only when it has observed the merge on
  GitHub.
- **It never writes to the upstream project itself.** Every upstream comment and every pull
  request create, edit, reopen or close is an action you take yourself on GitHub, on content the
  run prepared: usually one click on a prefilled page, or pasting a prepared comment.
  The run's credentials can only push to your fork. This is a deliberate owner decision: a person
  reviews and owns every public submission made under their name
  ([GitHub credentials decision record](../features/zero-trust-full-cycle/decisions/github-credentials.md)).
- It does not find issues for you, open pull requests in bulk, post reminders, or nudge
  maintainers. Nothing runs between your commands: every wait costs no model or VM compute
  until you resume explicitly.
- It does not create your fork or install anything on the upstream project. Creating the fork and
  installing the GitHub App on it are one-time manual steps.
- It supports only Node.js projects using npm with `package-lock.json`, and Python projects using
  pip with a fully hash-pinned `requirements.txt` or uv with `uv.lock`. Anything else ends as
  `unsupported`. Projects that need private packages, private services or the public internet in
  their tests are unsupported.
- It does not certify that a fix is correct. A receipt proves which commands ran against which
  commit in which profile, and what they returned. See [Security model](#security-model-in-brief).

## Prerequisites

Described generically; any machine that matches works.

| Requirement | Why | Notes |
|---|---|---|
| A Linux x86_64 machine | Untrusted code runs in a local QEMU VM | Other operating systems and architectures are refused (`unsupported_environment`). There is no container-only fallback. |
| KVM (`/dev/kvm` readable and writable by your user) | Speed | Without KVM the same image runs under TCG emulation. It works but is much slower. Set `accelerator` accordingly. |
| `qemu-system-x86_64`, `qemu-img`, and `genisoimage` (or `mkisofs` or `xorrisofs`) on `PATH` | Run and bake the VM | Checked at start; missing tools refuse the run. |
| Git at `/usr/bin/git`, and `prlimit` and `flock` in `/usr/bin` (util-linux) | Trusted Git operations and local locks | The controller calls these by absolute path. |
| Node.js 20 or later | Runs the controller scripts | |
| Docker | Runs the package proxy on the controller machine | Only the proxy uses Docker. Repository code never runs in Docker on your machine. |
| `/proc` | Local store and budget locks | Standard on Linux. Don't share one state directory between separate container PID namespaces. |
| A baked VM profile | The disposable VM image the work runs in | Built once with `zt-vm.mjs bake` (below). |
| A GitHub App installed on **your fork only** | Short-lived, fork-only push tokens | Installed with "Only select repositories" and only the fork selected. Never install it on the upstream. |
| Your fork of the upstream repository | Where the verified commit is pushed | Create it by hand on GitHub. The run waits if it is missing. |
| A model endpoint and key | Planning, implementation and typed decisions | An OpenAI-compatible Chat Completions endpoint. The key is read from an environment variable whose name you put in the config. |
| An Ed25519 signing key file | Signs verification receipts | A private key file owned by you with mode `0600`. |

### One-time setup

All commands run from `packages/zero-trust` in a checkout of this repository. The scripts are
repository scripts, not an installed binary, so build first:

```sh
npm install
make build-zero-trust   # builds @ai-dossier/core first, then this package
cd packages/zero-trust
```

1. **Bake the VM profile.** This builds the hash-pinned image once. `--accel` is `auto`, `kvm` or
   `tcg`.

   ```sh
   node scripts/zt-vm.mjs bake --profile-dir <profile-dir> --cache-dir <cache-dir> --accel auto
   node scripts/zt-vm.mjs smoke --profile-dir <profile-dir> --state-dir <smoke-state-dir>
   ```

2. **Start the package proxy.** Dependencies are installed only through a controller-side mirror
   (Verdaccio for npm, proxpi for PyPI) whose only route out is a Squid proxy enforcing the
   package policy. It needs Docker.

   ```sh
   node scripts/zt-proxy.mjs up --state-dir <proxy-state-dir> --out <proxy-up.json>
   ```

   `up` prints the mirror addresses. It is not itself the run's proxy endpoints file. Write that
   file yourself as a private regular file (mode `0600`) in exactly this shape:

   ```json
   {
     "endpoints": {
       "npmRegistry": "<worker-relay-url>/",
       "pypiIndex": "<worker-relay-url>/index/"
     },
      "target": { "host": "<mirror-ipv4-from-zt-proxy-up>", "port": 4873 },
      "caCertificateFile": "<absolute-proxy-state-dir>/ca-public/ca.crt"
   }
   ```

   `<worker-relay-url>` is the guest-side relay address from the `WORKER_RELAY` constant in
   `src/vm/qemu-args.ts`, not the mirror's address. `target` is the mirror for your project's
   ecosystem as `zt-proxy up` printed it (`npm` or `pypi`, with its port). `target.host` must be
   the IPv4 address it printed; host names are refused. The file is at most 16 KiB. Stop the proxy with
   `node scripts/zt-proxy.mjs down --state-dir <proxy-state-dir>`. Details:
    [package-proxy decision record](../features/zero-trust-full-cycle/decisions/package-proxy.md).

   The Squid inspection CA lasts **24 hours** from `up`. Supply `caCertificateFile` as an
   absolute path to its public certificate; it is checked before every provisioning VM allocation.
   An expired CA pauses the run with `proxy_ca_expired`. Restart with `zt-proxy down` then
   `zt-proxy up` using the same state directory, and resume explicitly. Missing, malformed or
   not-yet-valid certificates also pause with an actionable notice. Legacy external proxies
   without TLS interception may omit this field; their certificate lifetime cannot be checked.
   Mirror/provisioning failures pause and retain a bounded, redacted failure excerpt in the
   diagnostic; genuine unsupported ecosystem/profile/host refusals remain terminal.

   **Read the provisioning diagnostic.** After the run has paused, this read-only example
   selects the latest diagnostic for the run from the step journal and verifies the retained
   artifact digest. `<contribution-id>` is the run ID without its trailing `-run-1`, not the
   full run ID. No journal recovery, OAuth, VM or model operation runs:

   ```sh
   node -e '
   const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
   const dir = process.argv[1], runId = process.argv[2];
   const rows = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
   const row = rows.filter(r => r.type === "artifact" && r.runId === runId && r.key === "diagnostic").at(-1);
   if (!row || !/^[a-f0-9]{64}$/.test(row.digest)) throw new Error("diagnostic unavailable");
   const bytes = fs.readFileSync(path.join(dir, `${row.digest}.json`));
   if (crypto.createHash("sha256").update(bytes).digest("hex") !== row.digest) throw new Error("diagnostic digest mismatch");
   const d = JSON.parse(bytes);
   console.log(JSON.stringify({ phase: d.phase, code: d.code, failedAt: d.failedAt, status: d.status, excerpt: d.log?.excerpt, next: d.next }, null, 2));
   ' <state-dir>/runs/<contribution-id>/control/steps <run-id>
   ```

   The excerpt is bounded and credential-redacted; CA preflight notices have no command
   excerpt because allocation was refused before a command ran. The latest diagnostic is
   retained historical evidence and may describe an earlier pause after a successful resume.

   **Never point `up --out` at `<proxy-endpoints.json>`.** Its raw stack output has a different
   format and overwrites the derived run endpoints file, making `start` fail with `operation_failed`.

3. **Create the GitHub App.** In your GitHub account settings, create a GitHub App:
   - Repository permissions: **Contents: read and write**, **Metadata: read**. Nothing else. An
     installation that grants more than this is refused (`installation_too_broad`).
   - **Expire user authorization tokens** enabled. An App without expiring user tokens is refused
     (`app_misconfigured`).
   - Callback URL: the IPv4 loopback address with the path `/callback` and no port (the
     `redirect_uri` in the `authorization_url` the run prints shows the exact form). The run
     listens on a random loopback port during authorization, which GitHub accepts for loopback
     callbacks. Because GitHub redirects your browser to that loopback address, open
     `authorization_url` in a browser on the same machine as `zt-run`, or forward that port to it.
   - No webhook is needed.

   Note the App ID, client ID and slug. Generate a private key and a client secret, and keep both
   in environment variables, not in files the config names.

4. **Fork the upstream repository** on GitHub, under the account you will contribute from.

5. **Install the App on the fork only.** Choose "Only select repositories" and select only the
   fork. Installing it on "All repositories", on extra repositories, or on the upstream blocks the
   run.

6. **Create the signing key:**

   ```sh
   openssl genpkey -algorithm ed25519 -out <signer-key.pem>
   chmod 600 <signer-key.pem>
   ```

7. **Export the secrets** into the shell that runs `zt-run`, under names of your choice:

   ```sh
   export ZT_APP_PRIVATE_KEY="$(cat <app-private-key.pem>)"
   export ZT_APP_CLIENT_SECRET='<client secret>'
   export ZT_MODEL_KEY='<model API key>'
   export ZT_GITHUB_READ_TOKEN='<read-only token>'   # optional; see githubReadTokenEnv
   ```

   The model key variable must not be named `GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_CLIENT_SECRET` or
   start with `ZTFC_` or `GIT_`, and a value that looks like a GitHub token is refused. A local
   model server that ignores keys still needs a non-empty placeholder value.

## Configuration reference

`zt-run start --config <file.json>` reads one JSON file (at most 1 MiB). The schema is closed:
an unknown key anywhere refuses the file with `unknown_key`, and nothing in it may look like a
secret (`secret_detected`). Secrets are only ever named by environment variable. Relative paths
are resolved from the directory you run `zt-run` in.

A complete example (replace every `<…>`):

```json
{
  "issueUrl": "https://github.com/<upstream-owner>/<upstream-repo>/issues/<number>",
  "contributor": "<your-github-login>",
  "executionProfile": {
    "provider": "local-qemu",
    "profileDir": "<profile-dir>",
    "stateDir": "<state-dir>",
    "accelerator": "auto",
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
        "price": 1500,
        "units": 1000000,
        "source": "<where this price came from>",
        "fx": { "currency": "USD", "numerator": 1, "denominator": 1, "timestamp": "2026-10-10T00:00:00Z" }
      },
      {
        "resource": "local-qemu",
        "currency": "USD",
        "unit": "millisecond",
        "price": 0,
        "units": 1,
        "source": "local VM, unbilled",
        "fx": { "currency": "USD", "numerator": 1, "denominator": 1, "timestamp": "2026-10-10T00:00:00Z" }
      }
    ]
  },
  "budget": {
    "currency": "USD",
    "ceilingMinor": 2000,
    "cleanupAllowanceMinor": 100,
    "tokenLimit": 2000000,
    "activeMinutes": 120
  },
  "checkpoints": ["plan", "patch"],
  "limits": { "vcpus": 4, "memoryMiB": 8192, "diskGiB": 20, "commandTimeoutMs": 1200000, "activeMinutes": 120 },
  "signerKeyFile": "<signer-key.pem>",
  "githubApp": {
    "appId": 123456,
    "clientId": "<app-client-id>",
    "slug": "<app-slug>",
    "privateKeyEnv": "ZT_APP_PRIVATE_KEY",
    "clientSecretEnv": "ZT_APP_CLIENT_SECRET"
  },
  "githubReadTokenEnv": "ZT_GITHUB_READ_TOKEN",
  "retentionDays": 30
}
```

### Top-level fields

| Field | Required | Meaning and limits |
|---|---|---|
| `issueUrl` | yes | Full URL of one public GitHub issue. Owner at most 39 characters. Refused with `invalid_issue_url` otherwise. |
| `contributor` | yes | Your GitHub login: the account that owns the fork and submits the comment and pull request. At most 39 characters. |
| `authorApproval` | no | Do not write this yourself. `zt-run start` fills it after you confirm the commit author (see [Step 1](#step-1-start-the-run)): `userId`, `login`, `name`, `email`, `source` (`default` or `override`) and `approvedAt`. A config that supplies it cannot substitute for that confirmation. |
| `executionProfile` | yes | Where and how the VM runs. See below. |
| `modelProfile` | yes | Models per phase and their prices. See below. |
| `budget` | yes | Finite spending and usage ceilings for one session. See below. |
| `checkpoints` | no | Subset of `"plan"`, `"patch"`, `"verification"`, no duplicates. Default `[]` (no pauses). Engagement and publication are always your hand-offs regardless. |
| `limits` | no | VM and time limits. Each value may only **lower** the default. See below. |
| `signerKeyFile` | yes | Path to the Ed25519 private key that signs receipts. Must be a regular file you own, mode `0600`, one hard link, at most 16 KiB. |
| `githubApp` | yes | Your GitHub App. See below. |
| `githubReadTokenEnv` | no, but recommended | Name of the environment variable holding a read-only GitHub token for reading the upstream. Without it every read is anonymous, and GitHub allows only 60 anonymous API reads per hour per IP address: one run makes dozens, so a second run in the same hour can stall at the gate. Create a fine-grained personal access token with **Public repositories (read-only)** access and no permissions. The token is sent only on the controller's fixed `GET` reads, never to the VM, the model or any write. If the field is set but the variable is empty, the run refuses to start (`read_token_unavailable`) rather than falling back to anonymous reads. Set it before the first `start`: it is part of the run's identity, so a run started without it cannot add it on `resume` (start a new run instead). |
| `retentionDays` | no | Days to keep run artifacts after last activity. Default `30`, between 1 and 3650. |
| `resumeRunId` | no | Exists in the stored schema, but `zt-run start` refuses a config that sets it (`invalid_resume_run_id`). To continue a run, use `zt-run resume --run <id>`. |

### `executionProfile`

| Field | Meaning |
|---|---|
| `provider` | Must be `"local-qemu"`. Any other value is `unsupported_environment`. |
| `profileDir` | The baked profile directory from `zt-vm.mjs bake`. |
| `stateDir` | The controller's private state directory. The run store is `<stateDir>/runs`, and that is the `--root` you pass to every `zt-run` command. |
| `accelerator` | `"auto"`, `"kvm"` or `"tcg"`. `kvm` without `/dev/kvm` is refused. |
| `proxyEndpointsFile` | The private (`0600`) endpoints file from [setup step 2](#one-time-setup). It is read after authorization and author confirmation; a malformed file stops `start` there with `error: operation_failed`. |

### `modelProfile`

`phases` holds `planning` and `implementing` (required) and `repair` (optional; repairs and
revision feedback use `implementing` when it is absent). Each phase has:

| Field | Meaning |
|---|---|
| `adapter` | `"openai-compatible"`, the only adapter today. Hosted APIs, subscription plans that expose this API, and local servers all work through it. CLI-only plans do not. |
| `model` | The model ID sent to the endpoint. It must also have a rate in `rates`. |
| `endpoint` | Base URL; `/chat/completions` is appended. Must be `https://`, or plain `http://` only for a loopback address (a local server). No credentials, query or fragment in the URL. |
| `apiKeyEnv` | Name of the environment variable that holds the key. |

`rates` is the price list the budget uses. Every model named in `phases` needs one rate, even a
free one; a missing model rate refuses the config (`missing_rate`). The local VM also needs a
`local-qemu` rate with unit `millisecond` and price exactly `0`. That one is not checked at start:
without it the run fails with `missing_rate` at its first VM allocation. Each rate has:

| Field | Meaning |
|---|---|
| `resource` | The model ID, or `local-qemu`. Each resource appears once. |
| `currency` | ISO 4217 code of the price, upper case. |
| `unit` | `token`, `millisecond`, `vm_increment` or `byte_millisecond`. |
| `price` | Integer price in minor units of `currency` (cents for USD) per `units`. Zero is allowed. |
| `units` | How many units the price covers, for example `1000000` tokens. Positive integer. |
| `source` | Where the price came from. Recorded with every estimate. |
| `fx` | Conversion into the budget currency: `currency` (must equal `budget.currency`), integer `numerator` and `denominator`, and a `timestamp`. Same-currency rates must use `1`/`1`. |

One token rate prices both input and output tokens. Use at least the provider's higher rate so
estimates stay conservative.

### `budget`

| Field | Meaning |
|---|---|
| `currency` | Accounting currency, three upper-case letters. |
| `ceilingMinor` | Spending ceiling for one session, in minor units. Positive integer. |
| `cleanupAllowanceMinor` | Part of the ceiling reserved for VM teardown, never spent on work. Positive integer, at most `ceilingMinor`. |
| `tokenLimit` | Cumulative token limit for the session, even for zero-priced models. |
| `activeMinutes` | Active-time limit for the session. At most `limits.activeMinutes`. |

### `limits`

Defaults are the maximums. A value above its default is refused (`invalid_limits`).

| Field | Default and maximum |
|---|---|
| `vcpus` | 4 |
| `memoryMiB` | 8192 |
| `diskGiB` | 20 |
| `commandTimeoutMs` | 1200000 (20 minutes per command) |
| `activeMinutes` | 120 |

### `githubApp`

| Field | Meaning |
|---|---|
| `appId` | The App's numeric ID. |
| `clientId` | The App's client ID. |
| `slug` | The App's URL slug, used for the install link. |
| `privateKeyEnv` | Name of the environment variable holding the App's private key (PEM text). |
| `clientSecretEnv` | Name of the environment variable holding the App's client secret. |

## The six-step journey

Every command below runs from `packages/zero-trust` and takes `--root <stateDir>/runs`. Run IDs
look like `ztc-0123456789abcdef-run-1`. `status` is safe at any time: it reads only, never
changes anything, and can run while another command is working.

### Step 1: start the run

```sh
node scripts/zt-run.mjs start --config run-config.json --root <state-dir>/runs
```

1. The run prints `authorization_url: "https://github.com/login/oauth/authorize?…"`. Open it and
   authorize the App as your contributor account. The URL contains no token.
2. It prints `author_identity: {…}`: the name and email that will author the commit. The default
   is your GitHub profile name (or login) and your `<id>+<login>@users.noreply.github.com`
   address. Type `yes` at the prompt to confirm. The prompt appears only when both standard input
   and standard output are a terminal; otherwise (for example when piping into `tee`) you must
   pass `--confirm-author`, and the identity is then printed and accepted at once, so set it
   explicitly with `--author-name` and `--author-email` if it matters. An email override must be
   your noreply address or a verified email of the same account; with the App permissions from
   setup step 3 the run cannot read your email list, so in practice only the noreply address is
   accepted. The identity is recorded once and never changes on resume.
3. The run then works until it reaches a durable stop and prints its status.

A second `start` with the same configuration while the first is still running exits with code 4,
after its own authorization and author confirmation (the guard is checked when the run is created).

### Step 2: policy and permission

The run reads the project's contribution rules, templates, AI policy, assignment and linked pull
requests. Typed decisions (closed questions asked of your model, with independent passes and
strict confidence thresholds) classify the prose, and a deterministic floor can only make an
answer stricter. Any disagreement, failure or uncertainty becomes a hand-off, never a pass.

- An explicit ban on LLM contributions ends the run as `blocked`, citing the rule.
- If the project welcomes direct pull requests on unassigned issues, the run continues without
  any comment.
- If the project wants assignment or discussion first, the run prepares **one** short engagement
  comment that discloses substantial LLM assistance and the intended approach, and stops in
  `awaiting_contributor`. You post it (see [hand-offs](#states-and-hand-offs)). After the run
  observes your comment it waits in `awaiting_maintainer` for an explicit invitation or
  assignment from an owner, member or collaborator.
- Unclear rules, competing work, or a maintainer answer that is not a plain yes end in a hand-off
  for you to decide.

### Step 3: reproduce, plan and implement

Inside a fresh VM (no credentials, no network except the package proxy during dependency
installation), the run records the upstream base, runs the project's checks on it, reproduces the
bug, and has the model plan and implement a minimal fix. If you selected the `plan` checkpoint, it
pauses with the plan in `artifacts/plan.txt` for your approval before implementing. If the bug
cannot be reproduced, it hands off before patching.

### Step 4: independent verification

If you selected the `patch` checkpoint, the run pauses before verification starts, for your
approval of `artifacts/candidate.diff`. A fresh VM then rebuilds the candidate commit from
controller-held source, runs frozen dependency setup through the package proxy, and runs the
relevant checks with no network. A regression test must fail on the base and pass on the candidate. A
timeout, unreadable report or zero test suites is inconclusive, never a pass. At most two localized
repair attempts follow a failure. A separate scope and test-integrity review flags unrelated
changes, deleted or disabled tests, reduced assertions and build or test configuration changes,
and hands off on anything it cannot justify. If you selected the `verification` checkpoint, the run
pauses before shipping, for your approval of `artifacts/verification/<candidateSha>.json`.

### Step 5: shipping and the pull request hand-off

The run rechecks the upstream base (rebasing and verifying again if it moved), rechecks the policy,
issue, assignment and permission, checks your fork and the App installation, signs a receipt for
the exact verified commit, and pushes it to a branch on your fork with a compare-and-swap guard.
Then it prepares the pull request and stops:

```sh
node scripts/zt-run.mjs status --root <state-dir>/runs --run ztc-0123456789abcdef-run-1
```

```text
runId: "ztc-0123456789abcdef-run-1"
phase: "awaiting_contributor"
state: "awaiting_contributor"
upstreamIssue: "https://github.com/<upstream-owner>/<upstream-repo>/issues/<number>"
contributor: "<your-github-login>"
candidateSha: "0123456789abcdef0123456789abcdef01234567"
activeTimeMs: 1843000
estimatedSpend: {"amount":412,"currency":"USD"}
budgetRemaining: {"amount":1588,"currency":"USD"}
reasonCode: "contributor_handoff"
nextPermittedAction: "… Link: https://github.com/<upstream-owner>/<upstream-repo>/compare/…"
authorApproval: {"userId":<id>,"login":"<your-github-login>","name":"<name>","email":"<id>+<your-github-login>@users.noreply.github.com","source":"default","approvedAt":"<UTC time>"}
```

Every value is JSON-quoted so text from GitHub or the repository cannot fake a line. `--json`
prints the same facts as one JSON object. Money is in minor units of the budget currency;
`estimatedSpend` includes reservations not yet settled. `estimatedSpend`, `budgetRemaining` and
`activeTimeMs` cover the current budget session; each revision starts a new one.

Open the link. GitHub shows a compare page with the title and body prefilled. Review it, edit it
if you want, and click **Create pull request** yourself. If the body was too long to prefill, the
status names a prepared body file to paste instead. The body keeps a hidden marker
(`<!-- ai-dossier:ztfc … -->`); don't remove it, because that is how the run finds your pull
request.

### Step 6: record the submission and follow it

```sh
node scripts/zt-run.mjs resume --root <state-dir>/runs --run ztc-0123456789abcdef-run-1
```

Resume finds the pull request by head, base and marker, records it, and moves the run to
`submitted`. This is the initial completion. Upstream CI is reported as observed (`pending`,
`awaiting_approval` for a fork pull request waiting for a maintainer, `failed`, `passed`, `none`
or `unknown`); local verification is never reported as upstream CI passing.

From then on, each `resume` makes one observation, with no model call, VM or new budget: review
in progress (`awaiting_review`), `accepted`, `merged`, or `declined`. When a maintainer asks for
changes, `resume --revise` starts a verified revision on the same pull request (see
[Controls](#controls)).

## States and hand-offs

`status` always shows the state, the reason code of the last transition, and the exact next
permitted action. This table covers every run state.

| State | What it means | What you do | Command |
|---|---|---|---|
| `gating` | Checking eligibility and contribution policy. Active, or dormant after a policy hand-off. | Wait, or pause. After a hand-off, deal with what the status names, then resume. | `status`, `pause`, `resume` |
| `awaiting_maintainer` | Your engagement comment was observed; waiting for a maintainer's invitation or assignment. No compute, no reminders. | Wait for a maintainer to reply on the issue, then resume. A decline ends the run as `declined`; an ambiguous answer hands off with the comment URL. | `resume` |
| `planning` | The model is planning the fix. Active. | Wait, or pause. | `status`, `pause` |
| `implementing` | The model is implementing in the VM. Active. | Wait, or pause. | `status`, `pause` |
| `verifying` | Independent verification of the candidate. Active. | Wait, or pause. | `status`, `pause` |
| `shipping` | Rechecks, receipt and fork push of the verified commit. Active. | Wait, or pause. | `status`, `pause` |
| `paused_user` | Stopped at a checkpoint you selected, by your `pause`, or by a hand-off (bug not reproduced, review flag, revision feedback not admitted). The VM is destroyed. | Review the named artifact and approve or reject its digest, or edit, change model or checkpoints, then resume. | `approve`, `reject`, `edit`, `resume` |
| `awaiting_contributor` | A hand-off you must complete on GitHub: post the engagement comment, submit the pull request, create the fork, or install the App. No compute. | Follow the link in `nextPermittedAction` (rows below), then resume. | `resume` |
| `submitted` | Your pull request was observed. Initial completion. CI may be pending. | Resume when you want an update; `resume --revise` after a maintainer requests changes. | `resume`, `resume --revise`, `withdraw` |
| `awaiting_review` | The pull request is open and under review. | Resume to observe; `resume --revise` after a maintainer requests changes. | `resume`, `resume --revise`, `withdraw` |
| `revising` | A verified revision of the same pull request is in progress. | Wait, or pause. | `status`, `pause` |
| `accepted` | A maintainer approved the pull request; the merge has not been observed. | Resume to observe the merge. | `resume`, `resume --revise`, `withdraw` |
| `merged` | The run observed the upstream merge. Terminal. | Nothing. Export for your records. | `export` |
| `declined` | Closed without merge, a maintainer declined, or your withdrawal was observed. Terminal. | Nothing. | `export` |
| `blocked` | A rule or check stopped the run (for example a policy ban, wrong fork, or changed permission). Terminal; never retried with weaker rules. | Read `reasonCode` and the retained evidence. Start a new run if the cause is fixed. | `status`, `export` |
| `unsupported` | The environment or project is not supported (OS, VM, ecosystem, dependencies). Terminal. | Use a supported setup in a new run. | `status` |
| `failed` | Execution failed. A candidate that failed is kept privately and never pushed. Terminal. | Inspect the evidence before a new run. | `status`, `export` |
| `cancelled` | You cancelled, rejected a checkpoint, or ran `kill-all`. Terminal. A pull request already submitted stays open; the status shows its link and a prepared close comment. | Post that comment and close the pull request on GitHub if you no longer want it. | `status`, `export` |
| `blocked_cleanup` | A VM or credential could not be confirmed destroyed or revoked after three attempts. New work and publication are refused. | Reconcile resources and credentials (see [Kill switch](#kill-switch-and-cleanup)). Once cleanup is confirmed the run moves to `blocked`. | `kill-all`, `status` |

The hand-offs behind those states, with their reason codes. Other hand-offs (a bug that does not
reproduce, a review flag, a policy that needs judgment) leave the run in `gating` when they happen
there, and move it to `paused_user` from any later phase. The status line then says what was not
admitted, and `resume` checks again after you have dealt with it.

| Situation | `reasonCode` | What you do | Then |
|---|---|---|---|
| Engagement comment link | `contributor_handoff` (from `gating`) | Open the issue link, paste the prepared body file as a new comment, and post it. GitHub cannot prefill comments. Don't post it twice. | `resume` (moves to `awaiting_maintainer`) |
| Pull request link | `contributor_handoff` (from `shipping`) | Open the compare link, review the prefilled title and body, click **Create pull request**. | `resume` (moves to `submitted`) |
| Ambiguous match | stays `awaiting_contributor` | The run found several marked pull requests or comments, one by another account, or one without its marker. It issues no new link. Close or fix the extra ones as the status says. | `resume` |
| Fork missing | `fork_missing` | Fork the upstream repository on GitHub under your contributor account. | `resume` (re-checks and returns to the phase that waited) |
| App installation missing or suspended | `installation_missing` | Install the App on the fork only ("Only select repositories"), or unsuspend it, from the link given. | `resume` |
| App installation too broad | `installation_too_broad` (run is `blocked`) | The installation selects all repositories, extra repositories, or grants extra permissions, or the App is installed on the upstream. Fix the installation and start a new run. | `start` |
| Checkpoint `plan` | `user_paused` | Read `artifacts/plan.txt` in the run store and approve the digest from the status line. | `approve`, then `resume` |
| Checkpoint `patch` | `user_paused` | Read `artifacts/candidate.diff`. | `approve`, then `resume` |
| Checkpoint `verification` | `user_paused` | Read `artifacts/verification/<candidateSha>.json`. | `approve`, then `resume` |
| Stale checkpoint | `user_paused` | The content changed since the checkpoint opened (`checkpoint_stale`). The status shows the reject command only. | `reject` or `cancel` |
| Revision feedback not admitted | `user_paused` (run moves to `paused_user`) | The maintainer feedback was unclear, unrelated to the issue, or tried to change targets or authority. Nothing was implemented and no VM started. Decide yourself: reply to the maintainer, or cancel. | Your call |
| Reauthorization needed | unchanged | The App user token expired or was revoked, and the run printed a new `authorization_url`. | Open it, or run `authorize`, then `resume` |

Artifact paths are relative to the run's directory in the run store (`<state-dir>/runs/<contribution-id>/`).

## Controls

| Control | Command | Notes |
|---|---|---|
| Checkpoints | `checkpoints` in the config, or `resume --checkpoints plan,patch,verification` / `--checkpoints none` | Changing them requires `paused_user` and resets earlier checkpoint records. |
| Approve | `approve --run <id> --checkpoint <plan\|patch\|verification> --digest <sha256>` | The digest must match the open checkpoint exactly. Approval does not continue the run; `resume` does. |
| Reject | `reject --run <id> --checkpoint <point> --digest <sha256> --reason <text>` | **Rejecting cancels the run.** |
| Pause | `pause --run <id> --reason <text>` | Returns as soon as the request is saved (`pause_requested: "<id>"`). The controller stops admitting work, destroys the VM and keeps the held source and conversation. Refused in a state with no compute (`nothing_to_pause`). A request that reaches a dormant run is applied at the next `resume`; until then `status` shows `pause_requested`. |
| Resume | `resume --run <id>` | Provisions a fresh VM and returns to the interrupted phase. An open checkpoint must be approved first. |
| Cancel | `cancel --run <id> --reason <text>` | Allowed in any non-terminal state except `blocked_cleanup`. Destroys VMs and revokes credentials. In a waiting state (paused, awaiting you or a maintainer, submitted) the request is queued: run `resume` to apply it; until then `status` shows `cancel_requested`. A submitted pull request cannot be recalled; the cancelled status gives you a prepared close comment to post yourself. |
| Edit | `edit --run <id> --patch <file.diff>` | Only while paused from `implementing` or `verifying`. A text Git diff (at most 10 MiB); binary patches, symlinks and unsafe paths are refused. Every accepted edit needs fresh review and verification, and the pull request says **"Includes contributor edits"**. Refused while paused from `shipping` (`edit_after_verification`). |
| Model change | `resume --run <id> --model-profile <file.json>` | Only while `paused_user`. The file (at most 1 MiB) holds a `modelProfile` object only. Budget history stays; later calls use the new prices under the same session. |
| Revisions | `resume --run <id> --revise` | After maintainer feedback on a submitted pull request. Opens a new budget session under the same contribution, re-admits policy and permission, implements in a fresh VM, verifies, and pushes to the same branch. Refused without a pull request (`revision_unavailable`). Only remarks GitHub shows as from a maintainer count; a maintainer whose org membership is private looks like any other account, and `status` names whose remarks were left out. Add `--reviewers <login,...>` to count remarks from accounts you know are maintainers. |
| Edit the pull request | `pr-edit --run <id> --title <text> --body-file <file>` | Only during a live revision. Title at most 256 characters; body file private (`0600`), at most 65,536 bytes, keeping the marker. Prints a link and instructions; you make the edit on GitHub; a later `resume` confirms it. |
| Withdraw | `withdraw --run <id> --reason <maintainer_request\|user_instruction> --explanation <text>` | Not during a revision. Explanation at most 2,000 characters. Prints the pull request link and a prepared close comment; you post it and close the pull request; the run records `declined` when it observes the close. Nothing is deleted. |
| Drop a pending action | `cancel-action --run <id>` | Removes a pending local `pr-edit` or `withdraw` without touching GitHub. A different action while one is pending is refused (`action_pending`). |
| Authorize | `authorize --run <id>` | Runs the App authorization again without executing any phase. |
| Kill switch | `kill-all --reason <text>` | See below. |

Identity, contributor, issue, upstream and fork cannot change inside a run
(`identity_change_requires_new_run`); start a new run.

### Kill switch and cleanup

```sh
node scripts/zt-run.mjs kill-all --root <state-dir>/runs --reason "<why>"
```

`kill-all` fences the whole run store, engages the VM kill switch, and cancels every non-terminal
run in it, including paused, waiting and submitted ones: their pull requests stay open but are no
longer tracked. It destroys their VMs, revokes their GitHub credentials (deleting your App
authorization grant first), and prints each run's status followed by `incident_stop: completed`. It exits 2 if any run is left in
`blocked_cleanup`. The fenced store cannot start new work: use a new `stateDir` once the incident
is resolved. Publication already done stays recorded, and each cancelled status gives you a
prepared close comment if you want to withdraw; nothing upstream is erased.

If a run is in `blocked_cleanup`, its status lists what is still outstanding. Run `kill-all` again
to retry; destroy leftover VMs with
`node scripts/zt-vm.mjs reconcile --state-dir <state-dir>/vms --destroy`;
and if the report says the App grant was not deleted, revoke the App's authorization yourself in
your GitHub settings (Applications, Authorized GitHub Apps). Lift the VM kill switch with
`node scripts/zt-vm.mjs release --state-dir <state-dir>/vms --reason <text>` only after no VM
remains. Never
delete files under `<stateDir>/.start-guards` while controllers may be running.

An uncertain installation-token mint with a completed successful response (malformed 201)
records an expiry bound **one hour after the response is observed**, allowing
for slow requests. Retry `kill-all` after that bound: it journals `token_expired` and
reconciles cleanup. Before the bound it remains blocked. Legacy requests without a
recorded bound never expire automatically. Transport failures and 5xx responses also stay unbounded:
the server may still be processing the request after a disconnect or gateway timeout.
User-chain access-token expiry also does
not prove that its refresh authority is dead.

For a lost user-chain token, revoke the entire App authorization in GitHub settings
(Applications → Authorized GitHub Apps); checking only that access has expired is
insufficient. For an unbounded installation request, confirm the token cannot still
be valid (including any in-flight request) or revoke the installation. After checking
by hand, acknowledge **one exact journaled token ID** from the run's private
`tokens/events.jsonl` (`id`, not a credential value):

```sh
node scripts/zt-run.mjs resolve --root <state-dir>/runs --run <run-id> --token <token-id> --confirm-dead
```

This records `operator_resolved` under the run's lifetime lock, then retries normal
resource cleanup. It needs no OAuth, model call or App credentials when all tokens
are settled. Missing confirmation, unknown/already-settled IDs, other run IDs and
active writer locks are refused. Repeat for each independently unresolved token.
Other tokens, VM failures or accounting holds keep `blocked_cleanup`; only complete
cleanup moves the run to `blocked`. No admission or incident fence is lifted. Exit 2
is expected for either blocked state: inspect `status` to distinguish them.

### Exit codes and errors

| Exit | Meaning |
|---|---|
| 0 | A durable stop, including every hand-off. |
| 2 | Blocked, failed, unsupported, cancelled, cleanup blocked, or the operation was unavailable. |
| 3 | Invalid input: a fixed `error: <code>` line plus the usage line. |
| 4 | Another controller holds the run store (`store_locked`) or is busy. |

Errors print as `error: <code>` and never include provider messages or secrets. Common codes:
`invalid_config`, `unknown_key`, `missing_rate`, `invalid_limits`, `invalid_signer_key`,
`author_confirmation_required`, `checkpoint_stale`, `checkpoint_closed`, `nothing_to_pause`,
`cleanup_required`, `action_pending`, `action_unavailable`, `revision_unavailable`, `invalid_reviewer`,
`snapshot_expired`, `incident_active`, `store_locked`.

## Costs and budgets

- **Estimates are reserved before every action.** Before each model call or VM allocation the run
  estimates the maximum cost from your `rates` and reserves it. If the reservation would exceed
  the session ceiling, the action is refused. `estimatedSpend` in the status includes those
  reservations.
- **Provider-reported spend is recorded separately.** When a provider reports usage, the run
  stores it next to the estimate and counts the larger of the two. An overrun stays visible and
  stops further work rather than being capped. Unknown usage (an interrupted call) keeps its full
  reservation.
- **Prices are estimates, not invoices.** The run does not read your provider's bill and gives no
  billing guarantee beyond the limits it enforces. `metrics` reports estimated and observed
  amounts separately.
- **Zero-priced models still have limits.** A subscription plan or local model can have a price of
  `0`, but it still needs a rate, and `tokenLimit` and `activeMinutes` still apply. The local VM
  is priced at zero through its `local-qemu` rate.
- **Cleanup is always funded.** `cleanupAllowanceMinor` is kept back for VM teardown and is never
  spent on work.
- **Each revision is a new session** with its own ceiling. Earlier spend is never reset.
- Active time counts only working states; time waiting for you or a maintainer is not active.
- Currencies are never added together.

## Retention, export and metrics

Run artifacts stay in your `stateDir`, under your control. Nothing is sent to an external
telemetry service. Credentials and raw environments are never stored.

- **Retention.** Artifacts are kept for `retentionDays` (default 30) after a run's last activity.
  Removal only happens when you ask for it:

  ```sh
  node scripts/zt-run.mjs sweep --root <state-dir>/runs           # dry run: prints counts only
  node scripts/zt-run.mjs sweep --root <state-dir>/runs --apply   # deletes expired artifacts
  ```

  Stop running controllers first. A swept run keeps its summary (pull request URL, verified and
  observed commit SHAs, receipt digests, outcome and costs), but its snapshot is marked expired and
  can never be resumed; continuing that work means a new run. Runs in `blocked_cleanup` are never
  swept.
- **Export.** `export --run <id> --out <file>` writes one sanitized JSON bundle
  (`ztfc-export-v1`): the run history, status, pull request and outcome, receipts, verification
  metadata, LLM disclosure and policy citations. It excludes config, environment, tokens, raw logs
  and local file paths. The output file must not exist yet.
- **Metrics.** `metrics --root <state-dir>/runs [--json]` aggregates every run in the store:
  eligible-to-submitted, accepted, merged and declined rates, rework per submitted contribution,
  median active time, cost per submitted and accepted contribution, and repeat usage. Missing or
  damaged evidence shows as `unknown`, never as zero or success.
- **Adoption note.** `adoption --run <id> --note <text>` stores an optional, voluntary note (at most
  2,000 characters) locally, for example whether the maintainers adopted ai-dossier. It is never
  inferred.

## For students and portfolio use

The engine can help you build a record of real open-source contributions. Keep that record honest:

- **Submitted, accepted and merged are different outcomes.** A run ends at "submitted". Only cite
  a contribution as merged when the run (or GitHub) shows the merge. `metrics` and `export` keep
  the three apart for you.
- **The work used substantial LLM assistance, and says so.** Every engagement comment and pull
  request discloses it, and you should not remove that disclosure. Do not describe the work as
  unaided, or as evidence of skills you did not exercise.
- **You are the author of record.** You confirmed the commit author, you reviewed and submitted
  the pull request, and you answer the maintainers. Read what you submit.
- **Participation is optional and the security is the same for everyone.** There is no required
  teaching mode, and a cheaper model gets exactly the same isolation and verification.
- **No outcome is promised.** Using the tool does not guarantee a merge, a job or any other
  result. Maintainers may decline, and that is a legitimate outcome.

A useful portfolio entry links the issue, the pull request, and the export bundle, and states the
observed outcome.

## For maintainers

You received a pull request made with this tool. Here is what it contains and how to steer it.

- **A person submitted it.** The tool cannot open, edit or close pull requests or post comments on
  your repository. The contributor reviewed the prepared content and submitted it from their own
  account.
- **What the body contains:** the issue reference, the cause, the scope of the change, a
  disclosure of substantial LLM assistance, the commands that were actually run with their
  results, regression evidence (a test that fails before and passes after, when feasible), any
  baseline failures your policy permits disclosing, limitations, and, where your template allows,
  a collapsible verification receipt. "All tests passed" appears only when every command passed.
  A hidden marker (`<!-- ai-dossier:ztfc … -->`) lets the tool find its own pull request; it
  carries no instructions. "Includes contributor edits" means the contributor changed the code by
  hand and it was verified again.
- **It follows your rules.** It reads your contribution guide, templates and AI policy first. A
  ban on LLM contributions stops it before any comment or code. Where you require assignment, it
  asks once and waits for an owner, member or collaborator; it never sends reminders.
- **Your CI is yours.** A fork pull request waiting for workflow approval is reported to the
  contributor as awaiting approval, not as passing. The tool never changes your CI.
- **To ask for changes**, review as usual. If the contributor chooses to revise, the tool reads
  feedback from owners, members and collaborators, and implements it only when it is actionable and
  within the original issue; anything else goes back to the contributor to decide. Revisions are pushed to
  the same branch and verified again.
- **To ask for withdrawal**, say so in the pull request. The contributor gets a prepared close
  comment and closes the pull request themselves. Nothing in your repository is deleted, and there
  is no follow-up.

## Security model in brief

The design assumes the repository, its dependencies, its tests, its instructions and the model's
output can all be hostile.

- **Disposable local VM.** Repository code runs only inside a QEMU VM created for the run and
  destroyed at every stop. The VM has no host mounts, no credentials, and no network except, during
  dependency installation, one forward to the package proxy. Verification checks run with no
  network.
  Details: [execution-profile decision record](../features/zero-trust-full-cycle/decisions/execution-profile.md).
- **Constrained package proxy.** Dependencies come through a caching mirror that admits only
  package downloads, checked against lockfile hashes. Details:
  [package-proxy decision record](../features/zero-trust-full-cycle/decisions/package-proxy.md).
- **Model calls stay on the controller.** The model sees no shell and no credentials; its
  proposals are untrusted data checked against a closed list of actions bound to your issue and
  fork. Details: [model-harness decision record](../features/zero-trust-full-cycle/decisions/model-harness.md).
- **Fork-only, short-lived credentials.** The GitHub App token is narrowed to your fork with
  contents write, usable for at most 15 minutes for one push, and revoked right after use.
  Upstream writes are your own actions. Details: [GitHub credentials decision record](../features/zero-trust-full-cycle/decisions/github-credentials.md).
- **Untrusted text is data.** Repository files, issue and pull request text, test output and model
  output cannot change targets, identities, network policy, budgets or checkpoints. Status,
  errors, journals and exports are scanned for secrets, and output that looks like one is refused
  instead of written.
- **Fail closed.** Anything unknown, unreadable, truncated or ambiguous becomes a hand-off or a
  block. There is no weaker fallback and no silent retry.

### Residual risks

- A hypervisor or kernel exploit could escape the VM. The VM limits exposure; it cannot prove
  immunity.
- A receipt proves which commands ran on which commit and what they returned. It does not prove
  that the patch is useful, that the project's tests are honest, or that no exploit exists. The
  scope and test-integrity review is supporting evidence, not proof.
- Typed decisions use independent model passes; correlated model errors can still agree on a
  wrong answer. Deterministic checks and authority limits do not depend on the model.
- The package proxy forward listens on the controller machine's loopback interface during
  provisioning. The controller machine is assumed to be single-user.
- The mirrors serve what the public registries serve. Integrity rests on lockfile hashes.
- Another process running as your OS user can tamper with the controller's files. That is out of
  scope, the same as hostile code inside the controller.
- If the controller crashes between minting and revoking an installation token whose value was
  lost, the token lives until its native expiry. The run stays in `blocked_cleanup` and reports it.

## Command summary

Every command needs `--root <stateDir>/runs`. This table summarizes `node scripts/zt-run.mjs --help`.

| Command | Arguments |
|---|---|
| `start` | `--config <file.json>` [`--confirm-author`] [`--author-name <name>`] [`--author-email <email>`] |
| `resume` | `--run <id>` [`--revise`] [`--reviewers <login,...>`] [`--model-profile <file.json>`] [`--checkpoints plan,patch,verification\|none`] |
| `edit` | `--run <id>` `--patch <file.diff>` |
| `pr-edit` | `--run <id>` `--title <text>` `--body-file <file>` |
| `withdraw` | `--run <id>` `--reason <maintainer_request\|user_instruction>` `--explanation <text>` |
| `cancel-action` | `--run <id>` |
| `status` | `--run <id>` [`--json`] |
| `pause` | `--run <id>` `--reason <text>` |
| `cancel` | `--run <id>` `--reason <text>` |
| `approve` | `--run <id>` `--checkpoint <plan\|patch\|verification>` `--digest <sha256>` |
| `reject` | `--run <id>` `--checkpoint <plan\|patch\|verification>` `--digest <sha256>` `--reason <text>` |
| `authorize` | `--run <id>` |
| `kill-all` | `--reason <text>` |
| `resolve` | `--run <id>`, `--token <token-id>`, `--confirm-dead` |
| `metrics` | [`--json`] |
| `adoption` | `--run <id>` `--note <text>` |
| `sweep` | [`--apply`] |
| `export` | `--run <id>` `--out <file>` |

Reasons are at most 500 characters and notes at most 2,000. Unknown, repeated or missing flags and
positional arguments are refused with exit code 3.
