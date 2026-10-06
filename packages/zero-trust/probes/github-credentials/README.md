# GitHub credential feasibility probe (#1011)

Empirical probe for PRD-ZTFC-001 feasibility gate 3. It runs every GitHub write in the
§5.9 authority matrix with short-lived GitHub App credentials on a controlled
upstream/fork pair and writes one redacted evidence line per request. Results and the
verdict are in [`decisions/github-credentials.md`](../../../../docs/features/zero-trust-full-cycle/decisions/github-credentials.md).

This is a standalone Node ≥20 script with no dependencies. It is not part of the package
build or its tests, and it calls the live GitHub API.

## Prerequisites (one-time, by the owner)

- An upstream test repository you control, public, **without** the App installed, with
  an open bug issue.
- A separate contributor account with only read access to the upstream. It owns a fork
  created by hand (no GitHub App token can create forks without an installation on the
  upstream).
- A GitHub App with expiring user tokens on, a loopback callback URL, no webhook, and
  repository permissions Contents, Issues and Pull requests write plus Metadata read.
  Install it on the contributor account with only the fork selected.

## Configuration

| Variable | Meaning |
|---|---|
| `ZTFC_UPSTREAM` | `owner/repo` of the upstream fixture |
| `ZTFC_CONTRIBUTOR` | contributor login that owns the fork |
| `ZTFC_ISSUE` | upstream bug issue number |
| `ZTFC_INSTALLATION_ID` | optional; otherwise resolved from the fork with an App JWT |
| `ZTFC_REDIRECT_URI` | must match the App callback (default `http://127.0.0.1/callback`) |
| `ZTFC_STATE_DIR` | default `~/.cache/ztfc-probe` (created 0700) |
| `ZTFC_APP_ID`, `ZTFC_CLIENT_ID`, `ZTFC_CLIENT_SECRET`, `ZTFC_PRIVATE_KEY` | credentials, or… |
| `ZTFC_SECRET_COMMAND` | …a shell command whose stdout is the secret; `{key}` is replaced by `app-id`, `client-id`, `client-secret` or `private-key` |

Secrets are only held in memory and are scrubbed from all output. The rotating refresh
token is kept between phases in a 0600 file in the state directory, and the `revocation`
phase deletes it. The state directory also holds `state.json` (branch, SHAs, PR number)
and `evidence.jsonl`.

## Running

```sh
node probe.mjs authorize-url        # open the printed URL as the contributor
node probe.mjs exchange <<< "$REDIRECT_URL"   # paste the full redirect URL within 10 min
node probe.mjs discover             # fork discovery, fork API attempt
node probe.mjs push-user            # Q4a: push the fix to the fork with the ghu_ token
node probe.mjs upstream-writes      # Q1/Q5, scenario 11: comment, PR create/update/close/reopen
node probe.mjs install-token        # Q4b: fork-only installation token, negatives on upstream
node probe.mjs lease                # scenario 18: out-of-band remote change blocks the push
node probe.mjs scoped               # Q2: /token/scoped narrowed to the fork and to the upstream owner
node probe.mjs cleanup              # close probe PRs, final comment on the issue
node probe.mjs revocation           # Q3: rotation, reuse, DELETE token, DELETE grant
```

Run the phases in this order. `revocation` must be last: it tests refresh-token reuse and
ends by deleting the authorization grant, so a new run starts again at `authorize-url`.
Each phase rotates the user token once, so the previous phase's access token is dead.
