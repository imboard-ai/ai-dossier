# Plan Artifact Format (`plan:v1`)

The `plan:v1` artifact is the canonical per-issue plan, stored as a GitHub issue comment.
It exists so an issue is planned ONCE and then validated-and-refined, instead of being
replanned independently by every workflow that touches it (triage, batch prep,
plan-issue). It lives on the issue — not in a file — because batch preparation runs
before any branch exists.

The `ai-dossier plan` command group (`post`, `get`, `validate`) is the executable
implementation of this format; this page is the normative spec.

## The comment

A plan artifact is an issue comment whose body OPENS with a marker line:

```
<!-- plan:v1 head=<short-sha> -->
```

- `head=` is the abbreviated SHA (`git rev-parse --short HEAD`) of the repository HEAD
  the plan was written against. `validate` uses it to measure head-distance.
- The marker must be the FIRST characters of the comment body. Readers filter on the
  exact opening prefix, so a plan quoted inside another comment is never mistaken for
  an artifact.
- Everything after the marker line is the plan's markdown.

### Supersede semantics

Posting is **append-only**: `plan post` never edits or deletes a prior comment. Readers
(`plan get`, `plan validate`) always take the **LAST** comment that opens with a
`plan:v1` marker. A new post therefore supersedes the old plan, exactly as `runstate:v1`
milestones accumulate — the full history stays readable on the issue.

## Required sections

The markdown after the marker must carry all five sections as `## ` headers, in this
order:

```markdown
<!-- plan:v1 head=abc1234 -->

# Issue #462: <title>

## Problem
What is wrong or needed, synthesized from the issue.

## Acceptance Criteria
- AC1 <testable criterion>
- AC2 <testable criterion>

## Predicted Files
- `cli/src/foo.ts` — what changes and why
- `docs/foo.md` — what changes and why

## Approach
1. First change — what and why
2. Second change — what and why

## Test Scope
- What to test and how
```

`plan post` refuses a file missing any section. `plan validate` reports missing sections
as `check: "sections"` reasons.

### Predicted Files format

One bullet per file. The path is either backticked — `` - `path/to/file.ts` — why `` —
or the first bare token of the bullet — `- path/to/file.ts — why`. Backticks win when
present, so a reason containing slashes cannot masquerade as a path. Paths are
repo-relative POSIX paths; `validate` checks them with `git cat-file -e HEAD:<path>`
against the current clone's HEAD.

## Commands

| Command | Behavior |
|---|---|
| `ai-dossier plan post --issue <n> --file <md>` | Validates the five sections, stamps `head=` (or takes `--head <sha>`), comments the artifact. `--dry-run` prints the body; `--repo <owner/name>` retargets; refuses a body over 60000 characters pre-flight. |
| `ai-dossier plan get --issue <n> [--json]` | Text mode prints the artifact comment verbatim. `--json` prints `{head, problem, acceptance_criteria, predicted_files, approach, test_scope, url, created_at}` (section names snake_cased, `predicted_files` the extracted path array). No plan → stderr message + **exit 1**. |
| `ai-dossier plan validate --issue <n>` | Runs the deterministic checks below and prints `{valid, reasons[]}`. Exits 0 when valid, 1 when invalid. |

## Validation checks (all deterministic — no model call)

| `check` | severity | meaning |
|---|---|---|
| `artifact` | error | No `plan:v1` comment on the issue. |
| `sections` | error | A required `## ` section is missing from the artifact. |
| `sections` | warn | Predicted Files produced no paths (empty or no bullets). |
| `missing-file` | error | A predicted path does not exist at current HEAD. |
| `head-distance` | info | N > 0 commits on HEAD since the plan's `head=` — the plan may be stale. |
| `risk-floor` | info | A predicted path touches an elevated-risk surface (see below). |
| `git` | error / warn | git could not answer a file-existence (error) or head-distance (warn) probe — e.g. run outside a repository, or git missing. |

`valid` is true iff no reason has `severity: "error"`. A consumer that needs a stronger
signal (semantic sanity) dispatches its own model pass on top; `validate` is deliberately
the cheap deterministic floor.

### Risk-floor patterns

Deterministic, path-only (never reads file contents). A path hits a pattern when any
`/`-separated segment — or the file name without its extension — matches:

| Pattern | Matches |
|---|---|
| `auth-secrets` | `auth`, `oauth`, `sso`, `session`, `credential(s)`, `secret(s)`, `token`, `login`, `logout` segments; `.pem`, `.key`, `.p12`, `.pfx` files |
| `payments-billing` | `payment(s)`, `billing`, `invoice(s)`, `checkout`, `stripe`, `charge(s)`, `refund(s)` segments |
| `migrations-schema` | `migration(s)`, `migrate`, `schema`, `prisma`, `drizzle`, `knex`, `sequelize` segments; `.sql` files |
| `protocol-contract` | `protocol`, `wire`, `openapi`, `swagger`, `grpc`, `proto`, `contract(s)` segments |

Hits are informational: they lift the review floor a caller should apply, they never
fail validity on their own.

## Security posture

- `get` and `validate` are read-only: `gh issue view` plus local `git` read probes.
- Marker values (`head=`, predicted paths) arrive from the network — anyone who can
  comment on the issue can forge them. Before any value reaches a `git` argv it is
  rejected unless it is non-empty, dash-free, space-free, and control-character-free,
  so a forged `-`-prefixed value cannot be read as a flag.
- `post` is the only write, and it validates before posting.
