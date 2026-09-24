/**
 * Row shapes for the cross-provider token ledger (`ai-dossier usage`, #769).
 *
 * Every collector normalizes its source store into {@link UsageRow} — one row
 * per assistant message (the finest grain every store shares), so a view can
 * group by model × source × project × issue × session without caring which
 * tool produced the tokens.
 */

/** Which store a row was read from. */
export type UsageSource = 'claude-code' | 'opencode';

/** How a row's `issue` was attributed — a sched dispatch log is authoritative; a branch/dir name is a heuristic. */
export type IssueSource = 'dispatch' | 'branch';

export interface UsageRow {
  /** ISO-8601 time the message completed (or was created, when no completion time is recorded). */
  ts: string;
  /** Host that produced the row (`os.hostname()` of the collecting machine). */
  host: string;
  /** Provider that served the tokens — `anthropic` for Claude Code, opencode's own `providerID` otherwise. */
  provider: string;
  /** Concrete model id as the provider reported it, or null when the store recorded none. */
  model: string | null;
  input: number;
  output: number;
  /** Reasoning tokens reported separately (opencode); Claude folds thinking into `output`. */
  reasoning: number;
  cache_read: number;
  cache_write: number;
  /** Cost the source recorded, or null when it records none (Claude Code transcripts carry no cost). */
  cost_usd: number | null;
  source: UsageSource;
  /** Session the message belongs to — a Claude Code subagent is `<parent>/<agentId>`. */
  session_id: string;
  /** Parent session for subagents (Claude Code sidechains, opencode child sessions); null for a top-level session. */
  parent_session_id: string | null;
  /** Human label for the session when the store has one (opencode title, Claude subagent description). */
  title: string | null;
  cwd: string | null;
  project: string | null;
  branch: string | null;
  issue: number | null;
  issue_source: IssueSource | null;
  batch: string | null;
  /** Scheduler unit (`issue:<n>`, `batch:<id>`) when the session was sched-dispatched. */
  unit: string | null;
}

/** A provider limit / rate-limit wall observed in a source store. */
export interface LimitEvent {
  ts: string;
  host: string;
  /** Where the event was recorded. */
  source: 'claude-code' | 'sched';
  /** Provider hint — `anthropic` for Claude Code rows; sched events name none (null). */
  provider: string | null;
  session_id: string | null;
  unit: string | null;
  /** HTTP status when the store recorded one (e.g. 429). */
  status: number | null;
  /** The provider's own message, truncated. */
  detail: string;
  /** How many identical events this one stands for after {@link collapseLimitEvents}-style grouping (1 = itself). */
  count?: number;
  /** Timestamp of the last event folded into this one. */
  last_ts?: string;
}

/** Whether a collector ran, so a view can say "opencode: unavailable" instead of silently reporting zero. */
export interface CollectorStatus {
  source: string;
  status: 'ok' | 'unavailable' | 'error';
  rows: number;
  detail?: string;
}

/** Everything one collection pass produced. */
export interface Ledger {
  rows: UsageRow[];
  limits: LimitEvent[];
  collectors: CollectorStatus[];
  /** `session_id` → number of `ai-dossier run` invocations recorded from that session (runs.jsonl). */
  dossierRuns: Map<string, number>;
}
