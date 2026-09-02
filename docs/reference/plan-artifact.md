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
  the plan was written against. `validate` uses it to measure head-distance. It must be
  7-40 lowercase hexadecimal characters (`[0-9a-f]{7,40}`); `plan post --head` validates
  its override against the same grammar, so a plan can never be posted in a form its own
  readers would silently ignore.
- The marker must be the first line of the comment body (leading/trailing whitespace on
  that line is ignored). Readers filter on that opening line, so a plan quoted inside
  another comment — whose lines start with `>` — is never mistaken for an artifact.
- Everything after the marker line is the plan's markdown.

### Supersede semantics

Posting is **append-only**: `plan post` never edits or deletes a prior comment. Readers
(`plan get`, `plan validate`) always take the **LAST** comment that opens with a
`plan:v1` marker. A new post therefore supersedes the old plan, exactly as `runstate:v1`
milestones accumulate — the full history stays readable on the issue.

## Required sections

The markdown after the marker must carry all five sections as `## ` headers. The order
above is canonical for authors; `post` and `validate` check presence, not order:

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
- `cli/src/new-thing.ts` (new) — a file this issue creates

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
present, so a reason containing slashes cannot masquerade as a path; a single trailing
`,`, `;`, or `:` after the path is dropped. Paths are repo-relative POSIX paths;
`validate` checks them with `git cat-file -e HEAD:<path>` against the current clone's
HEAD.

A path the issue's scope is to CREATE — it does not exist at HEAD yet, by design — is
marked `(new)` (matched case-insensitively — `(New)`/`(NEW)` are accepted) immediately
after the path — i.e. before the reason text, if any: `` - `path/to/new-file.ts` (new) — why ``
(a bare `` - `path/to/new-file.ts` (new) `` with no reason also parses).
`validate` skips the missing-at-HEAD check for a path marked this way; an unmarked path
absent at HEAD is a `missing-file` error, and a path marked `(new)` that already exists at
HEAD is a `stale-plan` warn (the plan is stale — the file it predicted to create already
exists).

## Commands

| Command | Behavior |
|---|---|
| `ai-dossier plan post --issue <n> --file <md>` | Validates the five sections, stamps `head=` (or takes `--head <sha>`, 7-40 lowercase hex — validated), comments the artifact. `--dry-run` prints the body; `--json` prints `{posted: false, dryRun: true, head, body}` (dry-run) or `{posted: true, head, url}`; refuses a body over 60000 characters pre-flight. |
| `ai-dossier plan get --issue <n> [--json]` | Text mode prints the artifact comment verbatim (terminal-control characters stripped on a TTY). `--json` prints `{head, problem, acceptance_criteria, predicted_files, new_files, approach, test_scope, url, created_at, author}` (section names snake_cased, `predicted_files` the extracted path array including `(new)`-marked paths, `new_files` the subset of those marked `(new)`). No plan → stderr message + **exit 1**. |
| `ai-dossier plan validate --issue <n>` | Runs the deterministic checks below and prints `{valid, reasons[]}`. Exits 0 when valid, 1 when invalid. |

All three accept `--repo <owner/name>` (target repository when running outside it).
Every gh/git subprocess call is bounded by a 120s timeout — a stalled call is killed and
reported as a named failure rather than hanging the command.

## Validation checks (all deterministic — no model call)

| `check` | severity | meaning |
|---|---|---|
| `artifact` | error | No `plan:v1` comment on the issue. |
| `artifact` | warn | The latest plan was posted by an account without write access to the repository (association is not MEMBER/OWNER/COLLABORATOR/BOT) — verify authorship before trusting it. Selection stays last-plan-wins; this is a signal, not a gate. |
| `sections` | error | A required `## ` section is missing from the artifact. |
| `sections` | warn | Predicted Files produced no paths (empty or no bullets). |
| `missing-file` | error | A predicted path does not exist at current HEAD and its bullet is not marked `(new)`. |
| `stale-plan` | warn | A predicted path is marked `(new)` but already exists at current HEAD — the plan may be stale. |
| `head-distance` | info | N > 0 commits on HEAD since the plan's `head=` — the plan may be stale. |
| `risk-floor` | info | A predicted path touches an elevated-risk surface (see below). |
| `git` | error / warn | git could not answer a file-existence (error) or head-distance (warn) probe — e.g. run outside a repository, no commits yet, git missing, or a stalled call. Disambiguated structurally (whether HEAD resolves to a real commit), never by matching git's stderr wording, which is locale- and version-dependent. |

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
  so a forged `-`-prefixed value cannot be read as a flag. `validate` additionally
  warns when the canonical plan's author lacks write access to the repository —
  selection itself stays last-plan-wins (the runstate:v1 convention); whether to
  restrict selection by authorship is an open protocol decision.
- Terminal output of network-reachable bodies strips control characters on a TTY, and
  error snippets strip them everywhere, so a forged comment cannot inject ANSI/OSC
  escape sequences into the operator's terminal.
- `post` is the only write; it validates sections, the `head=` grammar, and the body
  size before posting, and its retry hint on gh failure references a temp file with
  `--body-file` — never an inlined body a paste could execute.
