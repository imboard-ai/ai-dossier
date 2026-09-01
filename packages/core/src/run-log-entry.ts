/**
 * The `~/.dossier/runs.jsonl` entry schema (#458, #524).
 *
 * Lives in `core`, not `cli`, so `packages/sched`'s dispatch path can write
 * entries in the same shape `cli`'s `ai-dossier run` and `ai-dossier history`
 * already read — one schema, two writers — without `sched` depending on
 * `cli` (the dependency runs the other way). `cli/src/run-log.ts` re-exports
 * this type and owns the actual file I/O (respecting the `auditLog` config
 * flag); `sched` writes its own entries independently — see
 * `packages/sched/src/run-log.ts`.
 */
export interface RunLogEntry {
  timestamp: string;
  dossier: string;
  resolved_version: string;
  source: 'cache' | 'registry' | 'local' | 'url';
  registry?: string;
  /**
   * How the version was resolved (only meaningful for registry sources):
   *   - 'pinned'      — caller passed name@version explicitly
   *   - 'registry'    — resolver called the registry and got a fresh version
   *   - 'cache'       — resolver served from TTL'd resolution cache (no registry call)
   *   - 'stale-cache' — registry was unreachable; fell back to highest cached semver
   * Useful for postmortems answering "did this run hit a stale resolution that
   * masked a registry outage?". Absent for local files and URLs.
   */
  resolution_source?: 'pinned' | 'registry' | 'cache' | 'stale-cache';
  verification: 'passed' | 'failed' | 'skipped' | 'nested-skip';
  llm: string;
  user: string;
  cwd: string;
  nested: boolean;
  /**
   * Deprecated: written by the pre-#401 update-check machinery. Retained on the
   * interface so `dossier history` can still display this field when reading
   * older runs.jsonl entries. Not written by new runs.
   */
  update_available?: string;
  /**
   * Cost/observability fields (#458). All optional and nullable so old-schema
   * entries still parse; written by new runs with explicit nulls when a value
   * is unavailable — never fabricated.
   */
  /** Wall-clock duration of the run in milliseconds (action start → entry write). */
  duration_ms?: number | null;
  /**
   * The exact agent command spawned (binary + args). Prompt content is excluded
   * (headless prompts travel over stdin). Null when nothing was spawned
   * (nested-skip, failed verification, dry-run, no LLM detected, unknown LLM).
   */
  spawned_command?: string | null;
  /** Model id as reported by the agent CLI, else the requested --model alias. Null when unknown. */
  model?: string | null;
  /** Exit code of the spawned agent process, or of the CLI action for early exits. Null when killed by a signal or failed to spawn. */
  exit_code?: number | null;
  /** Why the spawned process produced no exit code: spawn error (e.g. ENOENT) or signal. Null when the process exited normally. */
  spawn_error?: string | null;
  /** Input tokens reported by the agent CLI. Null when unavailable. */
  input_tokens?: number | null;
  /** Output tokens reported by the agent CLI. Null when unavailable. */
  output_tokens?: number | null;
  /**
   * Cache-creation (write) and cache-read input tokens reported by the agent
   * CLI (#524). Sourced from `modelUsage`, the same as `input_tokens`/
   * `output_tokens` — see `parseAgentUsage` in `./agent-usage`. Null when
   * unavailable.
   */
  cache_creation_tokens?: number | null;
  cache_read_tokens?: number | null;
  /** Total cost in USD reported by the agent CLI. Null when unavailable. */
  total_cost_usd?: number | null;
  /**
   * The scheduler unit this run belongs to (#524), e.g. `issue:524` or
   * `batch:b1` — set by `packages/sched` dispatch entries, null/absent for
   * an ordinary `ai-dossier run` invocation (which has no unit).
   */
  unit?: string | null;
}
