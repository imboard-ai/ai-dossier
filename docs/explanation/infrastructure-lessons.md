# Infrastructure Lessons

Findings that cost real time to diagnose, written down so they cost it once.

Each entry follows the same shape: the symptom you will actually see, what it turned
out to be, and how to check quickly. They are grouped by the thing that misled us,
because the symptom is rarely near the cause.

---

## Silent failure is the recurring theme

Four separate security mechanisms in this project stopped working without anything
turning red:

| Mechanism | Broke when | Undetected for |
|---|---|---|
| Ed25519 key format | the signer moved from minisign to Node crypto and started emitting SPKI PEM, while the trusted-key list stored raw base64 | ~8 months |
| Signature coverage | signatures only ever covered the body, leaving `risk_level` and `requires_approval` — the fields gating execution — unauthenticated | since inception |
| KMS OIDC trust | the repo was renamed `imboard-ai/dossier` → `imboard-ai/ai-dossier` and the IAM trust policy still named the old one | 9 months |
| Frontmatter mutation | `toSkillFrontmatter` mutated a parse result that is shared for identical input, leaking fields between calls | until a test called it twice |

None of them had a test or a scheduled job that exercised them. `sign.yml` in
particular was `workflow_dispatch`-only, so its breakage waited nine months for
somebody to sign something by hand.

**The rule:** a security mechanism that only runs when a human remembers is a
mechanism you should assume is broken. `sign.yml` now runs weekly for exactly this
reason — it signs a throwaway artifact and costs nothing, but converts a silent
credential failure into a red check within days.

---

## GitHub OIDC: print the claim, never infer it

A mismatched IAM trust policy fails with:

```
Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity
```

That message names nothing — not the claim presented, not the expected value, not the
role. We guessed wrong three times against it.

**The subject varies by trigger, in non-obvious ways:**

| Trigger | Subject |
|---|---|
| `workflow_dispatch` (from default branch) | `repo:OWNER/REPO:ref:refs/heads/main` |
| `pull_request` | `repo:OWNER/REPO:pull_request` |
| `deployment_status` | `repo:OWNER/REPO:ref:` — **note the empty ref** |

The `deployment_status` case is the trap. There is nothing after `ref:`, so no branch
pattern like `ref:refs/heads/*` can ever match it. It is also identical for every
deployment in the repo, **including fork pull requests** — so a role trusting that
claim is reachable from a fork. That is why the Vercel log workflow has its own
minimal role rather than reusing the one holding the KMS signing key.

**How to check:** run the `Print OIDC Claim` workflow (Actions → Print OIDC Claim). It
assumes no role and prints `sub`/`aud`/`ref`/`event_name`. Write the trust policy to
match what it prints.

Two more gotchas:

- `StringEquals` takes one value per key. Multiple allowed subjects need `StringLike`
  with a list, even when no wildcards are involved.
- A workflow needs to be on the **default branch** before `workflow_dispatch` will
  register it. You cannot dry-run a workflow before merging it — which is why anything
  destructive should ship with an explicit arming flag (see below).

---

## SSM via chamber: everything is a SecureString

`chamber write` stores values encrypted. Reading without `--with-decryption` returns
the **KMS ciphertext**, not the value:

```bash
aws ssm get-parameter --name /dossier/thing --with-decryption --query 'Parameter.Value' --output text
```

The failure mode is nasty because a ciphertext is a perfectly good non-empty string.
It passes any "did we get a value?" check and fails much later, far from the cause —
in our case as an opaque `404` from a third-party API several steps downstream.

**Guard for it:** a KMS ciphertext starts with `AQIC` and is long. Checking that at the
point of use turns a distant 404 into a message naming the real problem.

---

## Neon

### Three identifiers that look alike

The console surfaces an **org id** (`org-…`), a **project name** (`neon-gray-nest`) and
a **project id** (`hidden-heart-08015346`). Only the project id works against
`/projects/{id}/branches`; anything else returns a bare `404 project not found` that
does not say which of the three it wanted.

The cleanup workflow now lists projects and resolves id → name → org id, so any of the
three works. If you are calling the API by hand, get the project id from Neon Console →
project → Settings → General.

### Preview deployments failing is usually the branch quota

**Symptom:** every Vercel *preview* deployment fails with
`errorCode: BUILD_FAILED`, `errorMessage: Resource provisioning failed`, while
**production deploys succeed**.

That asymmetry is the tell. Production uses the primary branch and provisions nothing;
each preview tries to create a *new* Neon branch. On the free tier's 10-branch cap,
once you are at 10/10 every preview fails.

Note the build itself reports `readyState: READY` — nothing is wrong with your code,
and the `BUILD_FAILED` error code is misleading. Check Neon → Branches before
suspecting anything in the repo.

**It isn't only concurrent human PRs that exhaust the cap.** Fleet/batch
*throughput* does too: the full-cycle scheduler merging ~15 PRs in a ~6h overnight
window provisions a preview branch per push, and cleanup-on-close cannot keep pace
even though no two humans were ever working in parallel. Four previews failed with
this exact signature on 2026-09-02 from fleet cadence alone
(imboard-ai/ai-dossier#567); the failures self-healed within ~10–45 min once `Neon
Branch Cleanup` ran.

`.github/workflows/vercel-failure-logs.yml`'s `report` job is meant to post this
diagnosis onto the PR automatically, but it resolves the PR from the commit SHA at
the moment the `deployment_status` event fires — and under fleet cadence the branch
push (which triggers that event) can precede `gh pr create` by seconds to minutes.
Before #567 this raced silently: no PR yet ⇒ `No open PR for this commit; logging
only.` and the diagnosis never left the Action run. If a fleet-triggered preview
fails and the PR never got a comment, check the failed run's `report` job logs for
that line, or look for the commit-comment fallback the job now posts when no PR is
found after retrying.

### Overriding `DATABASE_URL` does not stop branch creation

Tempting theory: point Preview's `DATABASE_URL` at a shared branch and the integration
stops provisioning per-PR branches. **Measured, and it does not.**

A preview deployment created a branch anyway — the Neon branch count went 1 → 2 across
a single comment-only push. Overriding the variable changes what the application
*connects to*, not what the integration *provisions*.

So the override buys **isolation** (previews not pointed at per-PR databases). It does
not buy **suppression**, and the cleanup automation remains necessary.

### Branches leak without cleanup

`.github/workflows/neon-branch-cleanup.yml` deletes a PR's branch when the PR closes.
It is gated on the repository variable `NEON_CLEANUP_ARMED=true`; without it every
automatic run is a dry run.

Branches created by pushes with **no** open PR are not covered by the close event and
must be reclaimed with a manual dispatch.

---

## Trusted keys: compare key material, never key strings

**Symptom:** every locally signed dossier verifies as "valid but untrusted", however
many times you re-add the key. `keys add` reports success, `keys list` shows the key.

**Cause:** the same Ed25519 key has three legal spellings — raw 32-byte base64, SPKI
PEM, and base64 SPKI DER — and the trust check was a string comparison. The signer
started emitting PEM in 2025-11-18 while `keys generate` printed, and
`trusted-keys.txt` stored, raw base64. Neither side was wrong; they simply never
produced equal strings. It went unnoticed for ~8 months because the failure mode is a
warning, not an error.

**How to check quickly:** print both forms rather than reasoning about them.

```bash
ai-dossier keys list                                   # canonical form of what is trusted
grep -A1 'public_key' your-dossier.ds.md               # what the signature carries
```

If those differ in shape, the key is fine and the encoding is the bug.

**The rule that came out of it:** a trust decision resolves key *material* through one
parser (`normalizePublicKey` / `findTrustedIdentifier`), never a string equality on
whatever the file happened to contain. Two corollaries, both of which were live holes:

- The parser must be **strict**, not merely lenient-in-reverse. Node's base64 decoder
  discards unrecognized characters and stops at padding, so `<valid key><any trailing
  text>` decoded to that key — a key-substitution primitive. Round-tripping the decode
  and rejecting mismatches collapses each string onto at most one key.
- Validate on the **write** path too. `normalizePublicKey` returns uninterpretable
  input unchanged so exact-match still works when reading; that same leniency in
  `keys add` would store a typo or a `.pub` file *path* under a ✅, and the only
  symptom is "not trusted" forever after. `isSupportedPublicKey` exists for this.

**Ergonomic trap worth knowing:** a PEM starts with `-`, so `keys add "$(cat k.pub)"`
is parsed as an unknown option and the command never runs. Use `keys add -- "$(cat
k.pub)" "id"`, or copy the base64 command that `ai-dossier verify` prints.

---

## A workspace package's own `^x.y.0` range can shadow-copy itself

Bumping a monorepo package's `version` past a dependent's declared caret range
(e.g. `packages/sched` `0.5.x → 0.6.0` while `cli/package.json` still pins
`"@ai-dossier/sched": "^0.5.0"`) makes `npm install` decide the workspace
symlink no longer satisfies the range. It then fetches the **published**
registry version into a real, non-symlinked `cli/node_modules/@ai-dossier/sched`
— silently shadowing the local workspace package with old code. The symptom
looks nothing like a version problem: `tsc` reports a brand-new exported field
as `Property 'x' does not exist on type 'Y'`, because the type-checker is
reading the stale nested copy's `.d.ts`, not the one you just edited. `npm ls
<pkg> --all` shows it immediately (`invalid: "^0.6.0" from cli`); `rm -rf
cli/node_modules && npm install` from the repo root clears it (a partial `rm
-rf cli/node_modules/@ai-dossier/sched` was not enough in practice — the
directory came back at the old version until the whole `node_modules` was
removed). The actual fix is to bump the dependent's declared range in the same
commit as the version bump (`^0.5.0 → ^0.6.0`), not just the version.

## Publishing dossiers

### Use a CLI built from current `main`

`node_modules/.bin/ai-dossier` in a checkout can be an old published version. Signing
or linting with a pre-0.9.0 CLI silently produces the wrong result: it emits the legacy
signature format and rejects correctly-signed dossiers against the old schema. An entire
batch of 14 publishes failed this way before anyone noticed the version.

Check `ai-dossier --version` against `packages/core/package.json` before a bulk
operation.

### `lint` exit codes

`ai-dossier lint` exits non-zero for **warnings** as well as errors, and a fully clean
file prints `no issues found` with no error-count line at all. Any script gating on
lint must handle both output shapes, or it will reject files that are fine.

### The registry index is cached

After `publish` or `remove`, `ai-dossier list` can lag by a few minutes — the index is
served through a CDN. `ai-dossier info <name>` queries the API directly and is
authoritative. To force it:

```bash
curl -s https://purge.jsdelivr.net/gh/imboard-ai/dossier-content@main/index.json
```

---

## Destructive automation: arm it explicitly

Anything that deletes should ship inert and be armed as a separate, deliberate step.

The Neon cleanup workflow deletes databases, and `workflow_dispatch` does not register
until a workflow is on the default branch — so it could not be tested before merging.
Merging an untested deleter is a bad trade; not merging means never testing it. The
resolution is a repository variable (`NEON_CLEANUP_ARMED`) that gates deletion, so the
sequence becomes: merge inert → dry-run → read the log → arm.

That gate proved itself immediately: merging the PR closed the PR, which fired the
workflow on its first real trigger. It deleted nothing.

Alongside that, selection for a destructive operation should be conservative by
construction — exclude primary/protected items structurally, keep an explicit deny
list, require a positive match against the specific thing being cleaned up, and log
anything unclassifiable instead of acting on it.
