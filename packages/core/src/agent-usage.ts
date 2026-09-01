/**
 * Parsers for headless-agent JSON result output — the token/cost/model data
 * an `ai-dossier run` or `packages/sched` dispatch needs to record in
 * `runs.jsonl` (#458, #524).
 *
 * Shared between `cli` (the `ai-dossier run` headless path) and `sched` (the
 * scheduler's detached-agent dispatch path) so both consumers agree on which
 * block of a claude/opencode result is the source of record — the divergence
 * between them (one reading `usage`, the other `modelUsage`, and disagreeing
 * enough to fabricate a ~43% "saving" when mixed, ai-dossier#524) is exactly
 * the bug this module exists to close off. Lives in `core`, not `cli`,
 * because `sched` cannot depend on `cli` (the dependency runs the other way:
 * `cli` already depends on both `core` and `sched`).
 */

/**
 * Usage data extracted from an agent CLI's JSON result output.
 * Every field is null when the CLI did not report it — values are never
 * fabricated or estimated.
 */
export interface AgentRunUsage {
  /** Model id the agent reported; comma-joined when several models ran (token/cost fields are totals across all). */
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** Cache-creation (write) input tokens, summed across models when several ran. */
  cache_creation_tokens: number | null;
  /** Cache-read input tokens, summed across models when several ran. */
  cache_read_tokens: number | null;
  total_cost_usd: number | null;
  /** The final result text (claude's `result` field), for re-emitting to stdout. */
  result_text: string | null;
}

function toCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Narrow an unknown value to a plain-object record; null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a `claude -p --output-format json` result payload into usage data.
 *
 * `modelUsage` (summed across every model entry) is the source of record for
 * token counts and cost — it is the only block that reflects a multi-model
 * run accurately. The top-level `usage` / `total_cost_usd` (older: `cost_usd`)
 * fields are used ONLY when `modelUsage` is absent entirely: they are never
 * blended field-by-field with `modelUsage`, because the two blocks have been
 * observed to disagree (ai-dossier#524) — picking one field from each would
 * silently produce a number neither block actually reported.
 *
 * Returns null when the output is not a JSON object; individual fields are
 * null when absent.
 */
export function parseAgentUsage(stdout: string | null | undefined): AgentRunUsage | null {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;

  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  const usage = asRecord(parsed.usage) ?? {};
  const modelUsage = asRecord(parsed.modelUsage);
  // Keep only object-shaped entries; a scalar entry is malformed, not a model.
  const modelEntries = modelUsage
    ? Object.entries(modelUsage).filter(
        (entry): entry is [string, Record<string, unknown>] => !!asRecord(entry[1])
      )
    : [];
  const hasModelUsage = modelEntries.length > 0;

  const sumFromModelUsage = (camel: string, snake: string): number | null => {
    let sum = 0;
    let seen = false;
    for (const [, entry] of modelEntries) {
      const value = toCount(entry[camel]) ?? toCount(entry[snake]);
      if (value !== null) {
        sum += value;
        seen = true;
      }
    }
    return seen ? sum : null;
  };

  // modelUsage wins whenever it is present at all — even if it only answers
  // some of the fields — so a run's numbers always come from a single,
  // consistent block rather than a per-field blend with `usage`.
  const input_tokens = hasModelUsage
    ? sumFromModelUsage('inputTokens', 'input_tokens')
    : toCount(usage.input_tokens);
  const output_tokens = hasModelUsage
    ? sumFromModelUsage('outputTokens', 'output_tokens')
    : toCount(usage.output_tokens);
  const cache_creation_tokens = hasModelUsage
    ? sumFromModelUsage('cacheCreationInputTokens', 'cache_creation_input_tokens')
    : toCount(usage.cache_creation_input_tokens);
  const cache_read_tokens = hasModelUsage
    ? sumFromModelUsage('cacheReadInputTokens', 'cache_read_input_tokens')
    : toCount(usage.cache_read_input_tokens);
  const total_cost_usd = hasModelUsage
    ? sumFromModelUsage('totalCostUsd', 'total_cost_usd')
    : (toCount(parsed.total_cost_usd) ?? toCount(parsed.cost_usd));

  const modelKeys = modelEntries.map(([key]) => key);
  const modelFromUsage = modelKeys.length > 1 ? modelKeys.join(',') : (modelKeys[0] ?? null);
  const model = typeof parsed.model === 'string' && parsed.model ? parsed.model : modelFromUsage;
  const result_text = typeof parsed.result === 'string' ? parsed.result : null;

  return {
    model,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    total_cost_usd,
    result_text,
  };
}

/**
 * Parse an `opencode run --format json` result stream into usage data (#459).
 *
 * opencode emits one JSON event per line: the assistant's text arrives in
 * `type:"text"` parts, and per-step token/cost totals in `type:"step_finish"`
 * parts (a multi-step run emits several — tokens and cost are summed). The
 * model id is not present in the events, so `model` is null and callers fall
 * back to the requested --model alias. opencode's step_finish payload does
 * not report cache tokens separately, so those fields are always null here —
 * genuinely unavailable, not fabricated as zero. Returns null when the
 * output is not a JSONL event stream (any non-JSON line disqualifies it);
 * individual fields are null when absent.
 */
export function parseOpenCodeUsage(stdout: string | null | undefined): AgentRunUsage | null {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;

  let sawEvent = false;
  const texts: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawUsage = false;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      event = value as Record<string, unknown>;
    } catch {
      return null;
    }
    sawEvent = true;

    const part = asRecord(event.part);

    if (event.type === 'text' && part && typeof part.text === 'string') {
      texts.push(part.text);
    }
    if (event.type === 'step_finish' && part) {
      const tokens = asRecord(part.tokens);
      if (tokens) {
        const input = toCount(tokens.input);
        if (input !== null) {
          inputTokens += input;
          sawUsage = true;
        }
        const output = toCount(tokens.output);
        if (output !== null) {
          outputTokens += output;
          sawUsage = true;
        }
      }
      const cost = toCount(part.cost);
      if (cost !== null) {
        costUsd += cost;
        sawUsage = true;
      }
    }
  }

  if (!sawEvent) return null;

  return {
    model: null,
    input_tokens: sawUsage ? inputTokens : null,
    output_tokens: sawUsage ? outputTokens : null,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    total_cost_usd: sawUsage ? costUsd : null,
    result_text: texts.length > 0 ? texts.join('') : null,
  };
}
