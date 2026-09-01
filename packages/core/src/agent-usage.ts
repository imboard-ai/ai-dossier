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

import * as path from 'node:path';

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

// Token counts and cost are untrusted agent output (#524) — negative or
// non-finite values are rejected rather than recorded, so a malformed or
// adversarial result cannot drive a reported cost negative or to Infinity.
function toCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Longest `model` value written to `runs.jsonl` before truncation (#524). */
const MAX_MODEL_LENGTH = 200;

/**
 * `model` is copied verbatim from untrusted agent JSON into a `runs.jsonl`
 * entry a later command (`ai-dossier history`, `sched stats`) may render.
 * Strip control characters (the terminal-escape/log-injection risk) and cap
 * the length, rather than trusting an agent-controlled string unbounded.
 */
function sanitizeModel(value: string | null): string | null {
  if (value === null) return null;
  let clean = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) clean += char;
  }
  return clean.length > MAX_MODEL_LENGTH ? clean.slice(0, MAX_MODEL_LENGTH) : clean;
}

/** Narrow an unknown value to a plain-object record; null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `type` of the preamble line `packages/sched` writes to a dispatch log at
 * spawn time (ai-dossier#524). It exists so a log is never 0 bytes for a unit
 * that ran; every parser here skips it rather than counting it as agent
 * output. Shared from `core` so the writer (`sched`'s `createSpawnDeps`) and
 * the readers (below) can never drift apart on the sentinel's spelling.
 */
export const SCHED_DISPATCH_EVENT = 'sched-dispatch';

/** Parse one string as a JSON object; null for anything else (array, scalar, malformed). */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Extract usage from a claude `result`-shaped object — the payload of
 * `--output-format json`, and of the final `type:"result"` event of
 * `--output-format stream-json`. Both carry the same fields.
 *
 * `modelUsage` (summed across every model entry) is the source of record for
 * token counts and cost — it is the only block that reflects a multi-model
 * run accurately. The top-level `usage` / `total_cost_usd` (older: `cost_usd`)
 * fields are used ONLY when `modelUsage` is absent entirely: they are never
 * blended field-by-field with `modelUsage`, because the two blocks have been
 * observed to disagree (ai-dossier#524) — picking one field from each would
 * silently produce a number neither block actually reported.
 */
function extractResultUsage(parsed: Record<string, unknown>): AgentRunUsage {
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
  const rawModel = typeof parsed.model === 'string' && parsed.model ? parsed.model : modelFromUsage;
  const model = sanitizeModel(rawModel);
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
 * Sum per-turn usage from `type:"assistant"` stream events — the fallback for
 * a run that produced NO final `result` event (ai-dossier#524).
 *
 * The scheduler kills an agent that is still alive when ground truth says its
 * unit is already done (`reconcileRunning`'s external-advance branch), and a
 * killed agent never emits its `result` event. Before stream-json that meant
 * zero recoverable tokens for those dispatches — six of the eleven pilot units.
 * Each `assistant` event carries the usage of the request that produced it, so
 * summing them recovers what the run actually spent up to the kill.
 *
 * `total_cost_usd` stays null: per-turn events do not report cost, and this
 * path must not fabricate one from token counts.
 */
function sumAssistantUsage(events: readonly Record<string, unknown>[]): AgentRunUsage {
  let input = 0;
  let output = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawCacheCreation = false;
  let sawCacheRead = false;
  const models = new Set<string>();

  for (const event of events) {
    const message = asRecord(event.message);
    if (!message) continue;
    if (typeof message.model === 'string' && message.model) models.add(message.model);

    const usage = asRecord(message.usage);
    if (!usage) continue;

    const inputTokens = toCount(usage.input_tokens);
    if (inputTokens !== null) {
      input += inputTokens;
      sawInput = true;
    }
    const outputTokens = toCount(usage.output_tokens);
    if (outputTokens !== null) {
      output += outputTokens;
      sawOutput = true;
    }
    const cacheCreationTokens = toCount(usage.cache_creation_input_tokens);
    if (cacheCreationTokens !== null) {
      cacheCreation += cacheCreationTokens;
      sawCacheCreation = true;
    }
    const cacheReadTokens = toCount(usage.cache_read_input_tokens);
    if (cacheReadTokens !== null) {
      cacheRead += cacheReadTokens;
      sawCacheRead = true;
    }
  }

  return {
    model: sanitizeModel(models.size > 0 ? [...models].join(',') : null),
    input_tokens: sawInput ? input : null,
    output_tokens: sawOutput ? output : null,
    cache_creation_tokens: sawCacheCreation ? cacheCreation : null,
    cache_read_tokens: sawCacheRead ? cacheRead : null,
    total_cost_usd: null,
    result_text: null,
  };
}

/**
 * Parse a claude headless result into usage data — both output formats.
 *
 * Accepts either shape, because the two consumers spawn claude differently:
 *
 * - **A single JSON object** (`--output-format json`, what `ai-dossier run`
 *   uses): parsed whole.
 * - **A JSONL event stream** (`--output-format stream-json`, what the
 *   scheduler dispatches with since ai-dossier#524): the LAST `type:"result"`
 *   event wins — a per-unit log is append-mode, so a prior dispatch's result
 *   may precede this one in the same slice. With no `result` event at all (an
 *   agent killed mid-run), per-turn `assistant` usage is summed instead, so an
 *   interrupted dispatch still reports the tokens it really spent.
 *
 * Lines that do not parse as JSON objects are skipped rather than
 * disqualifying the stream: the sched dispatch preamble
 * ({@link SCHED_DISPATCH_EVENT}) sits at the head of every dispatch slice, and
 * an agent killed mid-write leaves a truncated final line.
 *
 * Returns null when nothing usage-bearing was found; individual fields are
 * null when the agent did not report them.
 */
export function parseAgentUsage(stdout: string | null | undefined): AgentRunUsage | null {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;

  // `--output-format json`: the whole payload is one object. Checked first so
  // a pretty-printed (multi-line) result is not mistaken for an event stream.
  // The sched preamble is excluded: a log holding only it means the agent
  // wrote nothing at all, which must read as null rather than as a result
  // object whose every field happens to be absent.
  const single = parseJsonObject(stdout);
  if (single && single.type !== SCHED_DISPATCH_EVENT) return extractResultUsage(single);

  let lastResult: Record<string, unknown> | null = null;
  const assistants: Record<string, unknown>[] = [];

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const event = parseJsonObject(trimmed);
    if (!event || event.type === SCHED_DISPATCH_EVENT) continue;

    if (event.type === 'result') lastResult = event;
    else if (event.type === 'assistant') assistants.push(event);
  }

  if (lastResult) return extractResultUsage(lastResult);
  if (assistants.length > 0) return sumAssistantUsage(assistants);
  return null;
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
    // The sched dispatch preamble (#524) is written by the scheduler, not by
    // opencode: skip it WITHOUT setting `sawEvent`, so a log holding only a
    // preamble still reads as "the agent wrote nothing" (null) rather than an
    // all-null usage object implying opencode reported no tokens.
    if (event.type === SCHED_DISPATCH_EVENT) continue;
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

/**
 * Pick the usage parser for a dispatched agent, keyed off the spawned
 * binary's basename — `opencode` (any path) routes to
 * {@link parseOpenCodeUsage}; everything else, including an
 * operator-configured command this build doesn't specifically recognize,
 * falls back to {@link parseAgentUsage} (the claude shape). A command this
 * build doesn't recognize is not guessed at further than that fallback —
 * its output either parses as a claude-shaped JSON result or the parser
 * returns null, never a fabricated guess.
 */
export function usageParserFor(
  cmd0: string
): (stdout: string | null | undefined) => AgentRunUsage | null {
  return path.basename(cmd0) === 'opencode' ? parseOpenCodeUsage : parseAgentUsage;
}
