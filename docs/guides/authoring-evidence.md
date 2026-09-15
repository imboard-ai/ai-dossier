# Authoring Evidence

**Last Updated**: 2026-09-15
**Status**: Active — shipped in `@ai-dossier/core`, the registry, and `@ai-dossier/cli` (`evidence` command group)

---

## 1. What it is

When you write or edit a dossier, you make judgment calls: this rule exists
because a run failed a specific way; that phrasing was tightened after an
agent misread it; this list is closed because an open-ended one invited a
new failure mode every time. Six months later, none of that reasoning is
visible in the file — only the rule itself. **Authoring evidence** attaches
a short rationale and a pointer to the agent session where the decision was
made to each rule or section you touch, so a later editor (human or agent)
can recover *why* a line says what it says instead of re-deriving it from
scratch or, worse, "fixing" something that was already the fix for a prior
failure.

The evidence lives in a sidecar file, `<name>.evidence.json`, stored in the
registry next to `<name>.ds.md` and keyed by the dossier's body checksum —
the same `checksum.hash` that lives in the dossier's frontmatter. It is
**never** part of the `.ds.md` file, **never** loaded by `ai-dossier run`,
and never enters an agent's context while a dossier executes. It exists
purely for the humans and agents who *edit* the dossier later — an
authoring-time record, not a runtime one. Evidence pointers use
provider-native session IDs (for Claude Code, the session UUID and the
per-message/tool-call `uuid` inside it), which means a reference is only
resolvable on the machine that ran the session. That is by design: the
rationale text is the shareable, portable part; the pointer is a bonus for
whoever still has the session, not a dependency the record requires to be
useful.

## 2. Not to be confused with execution tracing

[Execution tracing](tracing.md) records **what ran** — which steps of a
dossier fired, their outputs, timing, and success, for a specific
invocation of `ai-dossier run`. Authoring evidence records **why the text
says what it says** — the reasoning behind a rule at authoring time, not
the outcome of running it. A dossier can have rich traces and zero
evidence (heavily used, never explained) or rich evidence and zero traces
(carefully justified, rarely run). They're independent, complementary
records: traces are about execution, evidence is about provenance.

## 3. Record format

An evidence sidecar is a JSON document keyed by the dossier's checksum:

```json
{
  "evidence_schema_version": "1.0.0",
  "dossier": "imboard-ai/git/full-cycle-issue",
  "version": "3.8.0",
  "checksum": { "algorithm": "sha256", "hash": "<64 lowercase hex>" },
  "entries": [
    {
      "anchor": "Permitted-stop list is closed",
      "rationale": "Runs invented new stop categories when the list was open-ended; closing it removed the failure mode.",
      "created_at": "2026-09-15T08:00:00Z",
      "evidence": [
        {
          "provider": "claude-code",
          "session": "5a718af0-4e3c-4d6b-a7e1-e73bd3358ab4",
          "event": "toolu_01VrzBkULS3kxqPYzvbcke65",
          "host": "wls",
          "extra": { "ctx_session": "…", "ctx_event": "…" }
        }
      ]
    }
  ]
}
```

Field by field:

- `evidence_schema_version` — the schema version this record conforms to (currently `1.0.0`).
- `dossier` — the fully-qualified `namespace/name` this sidecar belongs to.
- `version` — the dossier version this sidecar was authored against.
- `checksum` — the dossier's body checksum at the time of authoring; a sidecar whose checksum does not match the currently published dossier is invalid and must be refreshed (`evidence sync`, see Workflow below).
- `entries` — one entry per rule or section you've explained. Each has:
  - `anchor` — the heading or rule text, written exactly as it appears in the dossier body, so a reader can find it.
  - `rationale` — one or two sentences: what failed, or what this rule/wording prevents. Free text, up to 500 characters.
  - `created_at` — ISO 8601 timestamp of when the entry was recorded.
  - `evidence` — zero or more session pointers (`provider`, `session`, optional `event`/`host`/`extra`) locating the agent session where the reasoning happened. `extra` is where tool-specific locator IDs (e.g. a local session-search index) go — see Optional tools below.

## 4. Workflow

The exact command sequence for authoring and shipping evidence alongside a dossier edit:

```bash
ai-dossier pull <namespace>/<name> --force
cp <name>.ds.md <name>.ds.md.bak   # optional, if you want a pre-edit copy
# edit <name>.ds.md — make your changes
ai-dossier evidence add <name>.ds.md \
  --anchor "<heading or rule as written in the body>" \
  --rationale "<one or two sentences: what failed / what this prevents>" \
  --session "$(ls -t ~/.claude/projects/*/*.jsonl | head -1 | xargs -n1 basename | sed 's/\.jsonl$//')" \
  --namespace <namespace>
# repeat evidence add, once per rule/section you changed
ai-dossier sign <name>.ds.md --key ~/.dossier/<org>.pem --key-id <org>
ai-dossier evidence sync <name>.ds.md
ai-dossier lint <name>.ds.md
ai-dossier publish <name>.ds.md --namespace <namespace>
ai-dossier evidence show <namespace>/<name>
```

Notes on ordering: `sign` regenerates the dossier's checksum, so `evidence
sync` runs **after** `sign` to refresh the sidecar's recorded checksum to
match — publishing a sidecar whose checksum doesn't match the just-signed
dossier is rejected by the registry (`EVIDENCE_MISMATCH`). `evidence add`
creates the sidecar automatically on first use if one doesn't already
exist next to the dossier file — there's no separate "create the sidecar"
step you have to remember. Skip `evidence add` only when the change is
purely cosmetic (typo fix, reformatting) with nothing to explain.

**Always pass `--namespace` explicitly on `evidence add`/`evidence init`
when it might differ from your default.** The default namespace mirrors
`publish`'s own resolution: `--namespace` if given, else your first org,
else your username. If you belong to an org but are publishing this
dossier under your personal namespace (or vice versa), the sidecar's
`dossier` field is stamped with the *default*, not the namespace you
`publish` to — and `publish` then rejects it with `EVIDENCE_MISMATCH:
evidence record dossier "<default>/<name>" does not match "<actual>/<name>"`.
There's no in-place fix for a sidecar with the wrong namespace baked in
(`evidence sync` only refreshes `version`/`checksum`) — delete the sidecar
and re-run `evidence add` with the correct `--namespace` if this happens.

## 5. Finding the session ID

For Claude Code, the session UUID is the filename of the newest `*.jsonl`
file under `~/.claude/projects/<project-slug>/` (the project slug is your
working directory path with `/` replaced by `-`). One-liner to print the
newest session id for the current project:

```bash
ls -t ~/.claude/projects/*/*.jsonl | head -1 | xargs -n1 basename | sed 's/\.jsonl$//'
```

The `event` field (the per-message/tool-call `uuid`) comes from the `uuid`
field of the relevant line inside that JSONL file — the specific message
or tool call where the decision was actually made, if you want to point
more precisely than "somewhere in this session".

Two other ways a session ID can reach you without hand-copying it: a hook
receives `session_id` on stdin (useful for a `PostToolUse`/`Stop` hook
that auto-records evidence), and a dispatch wrapper may export
`AI_DOSSIER_SESSION_ID` into the environment, which `evidence add --session`
reads as its default when `--session` is omitted.

## 6. Optional tools

Any local session-search or indexing tool (for example a personal
context-search index) can be used to *find* the right earlier session when
you're recording evidence for a decision made several sessions ago rather
than the one you're in right now. If such a tool has its own ID scheme for
locating a session or event, put those IDs under an entry's `extra` field
(`--extra key=value`, repeatable) — never as the entry's only locator. The
record must stay fully valid and useful with just `provider` + `session`;
`extra` is a bonus for whoever also has that tool installed, not a
dependency.

## 7. Reading evidence when editing

Before changing a rule in a dossier that already carries evidence, check
what's already been recorded for it:

```bash
ai-dossier evidence show <namespace>/<name>
```

This prints each anchor with its rationale and session pointers. If the
rule you're about to change has an entry, read the rationale first — it
may be there specifically because an earlier, more obvious version of the
rule already failed in exactly the way you're about to reintroduce. An
agent editing a dossier should treat a matching evidence entry as it would
a code comment explaining a workaround: read it before "simplifying" the
thing it explains. If your edit changes the rule's substance (not just
wording), record new evidence for it rather than leaving the stale
rationale attached to text it no longer describes.

## Step text for publish-dossier

The `imboard-ai/meta/publish-dossier` dossier lives in the registry, not in
this repo (dossiers are published, never committed — see
`authoring-guidelines.md`). The block below is the exact markdown to
insert as a new **Step 2b** between its Step 2 (Edit) and Step 3 (Sign),
plus the one-line addition to Step 3 itself.

```markdown
### Step 2b: Record evidence for every rule you changed

For each rule/section you added or changed, record why:

ai-dossier evidence add <name>.ds.md \
  --anchor "<heading or rule as written in the body>" \
  --rationale "<one or two sentences: what failed / what this prevents>" \
  --session "$(ls -t ~/.claude/projects/*/*.jsonl | head -1 | xargs -n1 basename | sed 's/\.jsonl$//')"

Skip only when the change is cosmetic. The sidecar `<name>.evidence.json` is published next to the dossier by `ai-dossier publish`; it is never loaded on `run`.
```

And in Step 3 (Sign), add this line **after** the `sign` command and
**before** `lint`:

```
ai-dossier evidence sync <name>.ds.md
```

## Pilot

The first dossier to carry evidence is `imboard-ai/git/full-cycle-issue`.
The test question: does an editing agent recover the reasoning behind a
rule faster from the rationale + session refs than from the dossier text
alone? This issue does not publish evidence for `full-cycle-issue` — that
is a follow-up, tracked separately.
