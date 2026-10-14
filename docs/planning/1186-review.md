# Issue #1186 review evidence

Run `r-1186-f79a`; base includes #1191 / PR #1214.

Seven independent report-only OpenCode reviewers ran on openai/gpt-6.1-sol.
Full-tier wall duration: 353.5 seconds (floor 300 seconds). No UI flows selected.
Reports and independent owned offline probes are retained under `/tmp/opencode/1186-review-*`.

## Validity gate and serial repair

All 12 findings were valid; five repeated root causes were dismissed as duplicates:
the controller/decision wrapper profile loss (reported by five reviewers), and
explicit-null validation inconsistency (reported twice). Seven deduplicated fixes:

1. Preserve resolved profile in both actual production decorators; test composed
   decision and execution calls against captured serialized wire bytes.
2. Share strict optional-profile validation, treating only undefined as absent.
3. Reuse the existing adapter test helper with explicit scenario overrides.
4. Bind sanitized no-charge provenance privately to the built-in adapter and exact
   metered invocation; consume once; mint only from this complete call's own first
   rejected response. Arbitrary adapters and replayed fetch exceptions stay unknown.
5. Recognize OpenAI 401 invalid_request_error / invalid_api_key pre-generation shape.
6. Correct the typed-decision likelihood defaults documentation.
7. Correct typed-decision failed-call accounting documentation.

No product/business escalation, follow-up issue, or scope expansion required.
Conformance initially met AC1–3; AC4 was unverifiable from the restricted diff
because #1191 is on base. Strengthened its existing real controller regression:
held reservation blocks step, a stop notice is read from durable artifacts, and
the recorded phase calls remain unchanged across two controller instances.

## Verification

Base regression: 11 targeted failures on isolated origin/main, passing on implementation.
Implementation workspace coverage: core 783, sched 1358, vscode 55, pool 153,
zero-trust 4966 and CLI 2197 passed; script tests passed. Initial full coverage
timed out on disk-backed fs-heavy zero-trust tests; tmpfs + longer timeout passed.
Cold recovered worktree uses npm ci and make build-all; source bytes match the
verified implementation. Original invalid pool directory preserved.
Zero-trust is private, so the version-bump gate correctly requires no npm bump.
Production-only npm audit at high threshold passed (moderate advisories remain).
Review repair tests include real composition and captured-error replay controls.

## Second security pass

Blind conformance at ef68e10 found all four ACs met. Security independently
reproduced a same-scope subclass/replaced-method sequence: billed/unknown work
followed by a second complete call's rejection released the aggregate reservation.
Eighth deduplicated fix: record the original built-in complete method, never grant
authority to subclasses, and count completion entries across the entire metered
scope. More than one invocation permanently disqualifies release; a replaced
method cannot authenticate rejection provenance. Regressions cover both decorators
and billed, unknown, caught-error and subclass inputs.

## Final validity gate

Conformance at 1105272 again found AC1–4 met. Two final security findings assumed
arbitrary controller-host code imports internal registration/minting helpers, or
implements hidden billed retries inside the injected fetch. Both are dismissed
as `contradicts-project-rule`: the owner-authorized model-harness decision
(`docs/features/zero-trust-full-cycle/decisions/model-harness.md:7–14,25–31,48–61`)
chooses trusted controller-authored transport injection, with untrusted JSON/model
proposals and VM code separated by the import graph. A same-process hostile
transport has the API key and filesystem/ledger access already; treating that
code as a sandboxed actor changes the project's chosen trust boundary. Fetch's
single-attempt contract is now explicit in its JSDoc and the package reference;
adapter-managed retries and accidental decorator/method replay remain fenced
and covered by executable regressions. No review escalation remains.

Final review totals: eight serial fixes; seven dismissed findings (five duplicates,
two contrary to the documented trust boundary). Full package coverage at ef68e10:
4976 passed, 14 opt-in VM tests skipped; subsequent accounting fences passed all
125 model tests and three real-composition profile tests. No public package version
changed; zero-trust is private.
