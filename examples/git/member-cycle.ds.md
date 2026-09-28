---dossier
{
  "dossier_schema_version": "1.0.0",
  "name": "member-cycle",
  "title": "Member Cycle — One Issue Inside a Batch, Verified Only Where It Is Cheap",
  "version": "1.3.0",
  "protocol_version": "1.0",
  "status": "Draft",
  "last_updated": "2026-09-24",
  "objective": "Implement ONE issue in its own worktree off a shared integration branch, test it by relevance, review it at the level the scheduler assigned (review=full: full-cycle-grade, security included; review=light: at least the correctness reviewer — never zero agents), and hand over to a parent orchestrator that owns all expensive verification",
  "category": [
    "development"
  ],
  "tags": [
    "issue",
    "workflow",
    "batch-cycles",
    "member",
    "integration-branch",
    "handover",
    "runstate",
    "review"
  ],
  "risk_level": "medium",
  "risk_factors": [
    "modifies_files",
    "network_access"
  ],
  "requires_approval": false,
  "destructive_operations": [
    "Pushes commits to its own member branch. Never to the integration branch, never to the default branch; the parent orchestrator owns integration, revert and eviction.",
    "Posts runstate milestones (implement, review) and the handover comment on its own issue"
  ],
  "inputs": {
    "required": [
      {
        "name": "issue_number",
        "description": "The issue this member implements",
        "type": "number"
      },
      {
        "name": "batch",
        "description": "Batch id this member belongs to, carried on every milestone as batch=<id>",
        "type": "string"
      },
      {
        "name": "worktree",
        "description": "Absolute path to this member's OWN worktree, branch already checked out off the integration branch, dependencies installed",
        "type": "string"
      },
      {
        "name": "integration_branch",
        "description": "The shared branch this member's branch is based on and whose parent will verify the combined result",
        "type": "string"
      }
    ],
    "optional": [
      {
        "name": "review",
        "description": "Review level the scheduler assigned this member (#771): light (default) or full. full = a risk-floor issue riding the batch — full-cycle-grade review (all review-issue agents, security included). The scheduler passes it via the {review} prompt placeholder or its review=full directive.",
        "type": "string",
        "default": "light"
      }
    ]
  },
  "authors": [
    {
      "name": "Yuval Dimnik"
    }
  ],
  "content_scope": "self-contained",
  "checksum": {
    "algorithm": "sha256",
    "hash": "d7eec3bcf9d6349552ee86ee395c6012332233fdedfc2339319951f9e88340cd"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "FF6L0xndB/DRVn9lpjOuXOmC1MiLt8Fj5aPVGtW+Odpa0XGNV6H3MX1dvRERuNLlNVzZaRenhJKnyfyBa8l2AQ==",
    "public_key": "m97FPrnq/zKlQArLvJl3bTZCUMWWpp/d0UJ/OfUKZeE=",
    "signed_at": "2026-09-24T09:21:21.057Z",
    "covers": "frontmatter+body",
    "key_id": "imboard-ai",
    "signed_by": "Yuval Dimnik <yuval.dimnik@gmail.com>"
  }
}
---

# Member Cycle — One Issue Inside a Batch

## Objective

Implement one issue, well, in isolation — then hand it over. A parent orchestrator merges every member onto the integration branch and runs the repo's expensive verification **once** for the whole batch. That amortization is the entire reason this workflow exists.

**The division of labour, and the one principle behind it: each level verifies what only it can see.**

- **You** can see your own change and are best placed to verify it deeply. Be thorough.
- **The parent** is the only actor that can see the *combination*. It runs the full suite, the repo's parity gate, and any browser pass — once, for everyone.

These reinforce each other. **Thorough members are what make a single expensive run viable.** If members hand over code they have not convinced themselves of, the one shared run fails constantly and the batch serialises on a parent untangling N changes at once — spending more than the runs saved.

**Non-responsibilities:** the repo-wide suite, any CI-parity/full-gate script, full e2e matrices, cross-package integration, the PR, the merge, the deploy, teardown, aggregate review, anything about sibling members. You never create a worktree or branch, never open a PR, never touch the integration branch directly.

**Review IS your responsibility (Step 4b).** Your own diff is reviewed by you, before handover, at the level the scheduler assigned: `review=full` → full-cycle-grade review, `review=light` → at least the correctness reviewer. A member that posts `phase=review status=done` without having run a single review agent has not reviewed anything (imboard#4178, run `r-4178-928b`: `agents_done=0`, shipped with no review until the parent caught it by hand).

## Prerequisites

- `gh` installed and authenticated; `ai-dossier` CLI available (beware shadow copies — a repo-local `node_modules/.bin/ai-dossier` can shadow the global install; call the newer binary by absolute path if a documented subcommand reports `unknown command`).
- You are dispatched into a prepared worktree. You do not create one.

## Actions to Perform

### Step 0: Preconditions — assert, never assume

```bash
cd "<worktree>"
git rev-parse --is-inside-work-tree     # must succeed
git branch --show-current                # must be YOUR member branch
git status --porcelain                   # must be empty
```

Any failure: post `runstate ... --status blocked --kv reason=<slug> --kv batch=<batch>` and hand back **without touching a file**. A dirty tree is the parent's call to recover, not yours.

Confirm a dependency marker a fresh clone lacks is present. **Search the worktree, do not assume it
sits at the worktree root** — a monorepo's workspace root is often a subdirectory:

```bash
MARKER=$(find . -maxdepth 3 \( -name node_modules -o -name vendor -o -name .venv \) -type d -print -quit)
[ -n "$MARKER" ] || echo "env-cold"
```

Nothing found → `reason=env-cold`; warm-up was owed to you.

> Two traps, both hit in practice (ai-dossier#676):
>
> - **Do not check the worktree root only.** Batch `b-20260909-01` evicted `#4159` for `env-cold`
>   while `main/node_modules` held 1173 packages. The same issue then completed as a standalone
>   full-cycle on the same machine and shipped a PR.
> - **Do not locate the root by "nearest lockfile" either.** imboard carries a stray
>   `package-lock.json` at the worktree root that shadows the real `main/pnpm-lock.yaml`, so a
>   lockfile search resolves to the wrong directory and reports cold on a warm tree. Searching for
>   the marker itself cannot be shadowed this way.

Record where you started — every later diff is scoped to it:

```bash
BOUNDARY=$(git rev-parse HEAD)
```

### Step 1: Understand the issue, and check it is actually implementable

Read the issue in full, including comments. Then apply two checks that are cheap now and expensive later:

**Does every artifact the issue names actually exist on your base?** An issue that says "migrate onto the hook extracted by #N", "use the helper added in #N", or "follow the pattern from #N" is depending on #N's work. If that work is unmerged, the issue is not implementable — **regardless of how the dependency is phrased.** Verify by looking for the symbol or file on your base branch, not by trusting the prose.

**Does the body enumerate a countable work list?** "Document the five API families" that turns out to name eight is not a small issue. Count what the body actually asks for, not what its title or labels suggest.

If either check fails, **stop and hand back** (Step 6). This is a correct and valued outcome — a member that hands back in minutes costs a fraction of one that forces work against a missing dependency.

### Step 2: Implement, and be thorough

Plan, implement, write tests, run them, iterate until you are genuinely confident in your own change. Being thorough here is the point — the parent's single expensive run is the last line of defence, not the first.

**Scope your tests by RELEVANCE, not volume.** Run:

- tests you wrote for this change
- existing tests covering the files and modules you changed
- **tests for direct consumers, one hop out** — the integration test that exercises the module you edited counts, even when you did not touch that test's file
- typecheck and lint/format over your changed surface

Do **not** run: the repo-wide suite, the repo's CI-parity or full-gate script, full e2e matrices, cross-package integration, deploy. Those cost tens of minutes and run **once** at batch level. Running one yourself is the exact duplication this workflow exists to eliminate. If you believe one is genuinely needed, **say so in the handover instead of running it.**

**Lint and format your changed files explicitly**, and note the command and the paths it covered. A member's unformatted file fails a shared gate and costs the parent an entire expensive cycle to discover.

### Step 2b: Prove every test you wrote actually runs

**Writing a test is not running it.** Before you move on, for each test you added:

1. **Observe it FAIL against the unfixed code** — revert your change, or neuter the line the
   test targets, and watch the test go red for the reason you expect. Then restore and watch
   it go green.
2. If a test cannot be made to fail, it is asserting nothing. Find out why before keeping it.

This is the single cheapest defect check in this workflow, and skipping it is the most common
way a member ships a broken batch. Two measured failures, both from tests authored against an
*imagined* contract rather than an executed one:

- a test pinned the exact wording of a UI string that the code never produced
- a test asserted an emit sequence behind a request validator its fixture never satisfied, so
  the handler diverted to the error path and **neither assertion was ever reachable** — the
  test had never passed, from the moment it was written

Both looked correct in review. Both were caught by a shared gate long after the member
declared success, at the cost of an entire batch verification cycle.

Say in your handover that you did this, and what you saw. "Proved red by neutering X, restored,
green" is the sentence a parent needs.

### Step 3: Conformance — your own verdict on your own ACs

Check your change against the issue's acceptance criteria, honestly, before anyone else sees it. This is the signal that lets the parent distinguish **fix this** (tests red, ACs met) from **evict this** (ACs not met). Getting it wrong in your own favour is worse than handing back.

If the ACs cannot be met as written, say so in the handover and stop. Do not adjust the criteria to fit what you built.

### Step 4: Commit — before you claim anything is verified

**A fix that exists only in your working tree does not exist.** Commit and push to your member branch, then verify against the committed state.

```bash
git add -A && git commit -m "<type>: <subject> (#<issue_number>)"
git push -u origin "$(git branch --show-current)"
```

Never push to the integration branch or the default branch.

A useful diagnostic if a check passes locally but fails for the parent: **a stack trace citing a line number your patch moved means the running code does not contain your patch.**

Now post the implement milestone (the scheduler's contract): `ai-dossier runstate post --issue <issue_number> --phase implement --status done --run <run_id> --kv mode=slot --kv batch=<batch> ...` with the CLI's required keys.

### Step 4b: Review your own change — at the assigned review level, never zero agents

Resolve the review level: the `review` input; else the dispatch prompt (`Review level: review=full` directive, or a `{review}` value); else `light`. **If unsure, use `full`** — uncertainty raises review, never lowers it.

Fetch the reviewer workflow and run its **per-issue** flow (not aggregate mode) over YOUR diff only — `git diff $BOUNDARY...HEAD`:

```bash
ai-dossier run imboard-ai/git/review-issue --pull
```

| Level | Agents that MUST run | Notes |
|---|---|---|
| `review=full` | review-issue tier **`full`** — every dimension agent (DRY, **Security**, Supportability, Maintainability, Documentation, Convention/Contract) **plus Conformance** — forced regardless of what the diff's paths would select | this member is a risk-floor issue (auth, billing, security, migrations, deploy) riding the batch; its review is what full-cycle would have given it. review-issue's time floor applies (full tier < 5 min = not performed → redo once). |
| `review=light` | review-issue's own Stage 1 + Stage 2 selection, **with a floor of the correctness reviewer: Conformance** (Agent 7) | when the issue has no AC list, Conformance still runs against the issue body's stated fix/requirements instead of dropping out. A Stage 1 risk-floor path in your diff promotes you to `full` — say so. |

Visual Conformance (Agent 8) does not run here — a member has no runtime (review-issue's own batch note). If your change is visual, say so in the handover for the parent's single browser pass.

**Dispatch.** Launch the selected agents in parallel, report-only, as review-issue says. **If your runtime cannot spawn sub-agents** (a single-agent executor, e.g. an opencode or codex profile), run each selected agent's review prompt yourself as a **separate, sequential pass** over the diff and record `review_substituted=self` — a substituted agent that ran counts; an agent that never ran does not.

Apply the surviving fixes (review-issue's validity gate, dedupe, apply), re-run your Step 2 relevance-scoped tests, then **commit and push again** (Step 4's rules). A `not-met` from Conformance gets one bounded fix loop; still `not-met` → hand back (Step 6), do not force it.

**The review milestone is posted AFTER the handover (Step 5)** — it is the last thing you post, and the scheduler's prompt tells you to post it then. It must carry the agents that actually ran:

```bash
ai-dossier runstate post --issue <issue_number> --phase review --status done --run <run_id> \
  --kv mode=slot --kv batch=<batch> --kv review=<light|full> --kv tier=<micro|docs|small|full> \
  --kv head=<pushed sha> --kv fixed=<n> --kv escalated=<n> \
  --kv agents_done=<comma list of agent names, e.g. conformance,security,dry> \
  --kv agents_pending=none [--kv review_substituted=self]
```

**NEVER post `phase=review status=done` with `agents_done=0`, `none`, or an empty list** — that is a false "reviewed" claim, and batch-integrate refuses to ship a member that carries one. If an agent that must run (per the table) could not finish, post `--status partial` with it in `agents_pending`; if no review could run at all, post `--status blocked --kv reason=review-not-run`. Both are honest; a zero-agent `done` is not.

### Step 5: Handover — the artifact the parent depends on

Post a comment on the issue whose first line is exactly `## handover:v1`, containing:

| Field | Why the parent needs it |
|---|---|
| Files changed, and why | orients a reader in a diff they did not write |
| **The exact test commands you ran, and their results** | tells the parent what is already covered |
| **The direct consumers you considered one hop out** | name them even where you ran none, and say why |
| The lint/format command and the paths it covered | a shared formatting gate failure is otherwise found the expensive way |
| **What you deliberately did NOT verify** | names the blast radius the parent must cover |
| Assumptions and points of uncertainty | where a failure is most likely to be genuine |
| Your conformance verdict | fix-vs-evict, per Step 3 |
| **Review level, the agents that ran, findings fixed/escalated** (Step 4b) | `review=full` members are the ones batch-integrate re-reviews at the risk floor; a missing review is a ship blocker |

Two behaviours make a handover genuinely useful, and both are worth the words:

- **If you find a pre-existing failure, prove it is pre-existing** — reproduce it with your own changes reverted, say so, and do not fix it. Without this the parent burns time attributing a failure to a member that did not cause it.
- **Offer the parent a repair option where you can see one.** "If X needs tuning, it is a one-line change at Y, and the test asserts a relation rather than a literal so tuning will not break it" turns a possible eviction into a minute of work.

If your change is visual, say plainly what a reviewer should look at and at which viewport — the parent runs one browser pass for the whole batch.

**Then post the Step 4b `phase=review` milestone — last — and end your run.** Its `agents_done` must name the agents that ran; see Step 4b for `partial` / `blocked`.

### Step 6: Handing back

If the issue is not implementable, is larger or different than it reads, or its ACs cannot be met — **stop and say so in the handover.** Post `runstate ... --status blocked --kv reason=<slug> --kv mode=slot --kv batch=<batch>`, leave the tree clean, and report.

Reporting this is a correct outcome and is treated as such. **A member that forces a green is worse than one that hands back.**

## Success Criteria

- Exactly one member branch, pushed, with commits scoped to this issue
- Relevance-scoped verification actually run, and named in the handover
- No repo-wide suite, parity gate, or e2e matrix executed
- `## handover:v1` posted, including what was not verified, the conformance verdict and the review summary
- Review run at the assigned level (Step 4b): `review=full` → full tier incl. Security; `review=light` → at least Conformance; the `phase=review` milestone lists the agents that ran — never `agents_done=0`
- Integration branch and default branch untouched

## Rationale — why these clauses exist

Every rule above is here because its absence was measured in a real batch.

- **Relevance scoping, "one hop out"** — a member changed a module and never ran the pre-existing integration test that exercises it. The defect surfaced 81 minutes into the parent's gate instead of in seconds.
- **Name the lint command** — a member's four unformatted files failed a shared gate and cost a full expensive cycle. After the requirement was added, four of four members reported it and the gate passed first time.
- **Commit before claiming verified** — a repair verified against an uncommitted working tree shipped a branch that did not contain it; CI found it, at the cost of a cycle.
- **Prove a pre-existing failure** — one member did exactly this, and it is the reason the parent did not chase a failure that was not the batch's.
- **Handing back is valued** — a member found its issue depended on unmerged work, declined to copy that work forward, and handed back in four minutes. Forcing it would have cost far more and produced a divergent duplicate.
- **Never zero review agents** — imboard#4178's member (run `r-4178-928b`, batch `b-20260924-01`) posted `phase=review status=done agents_done=0`: nothing looked at the diff, and the parent had to review it by hand before the batch PR. With risk-floor issues now admitted into batches as `review=full` members (#770 Option A), the member review is load-bearing.
- **A member's own tests can pin a bug.** One asserted grammatically wrong copy; a repo-wide guard caught what the member's expectations encoded. Your tests are necessary, not sufficient — which is why the shared gates exist and why you must not route around them.
