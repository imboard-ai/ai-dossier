import { createHash } from 'node:crypto';
import { BudgetError } from '../budget-types';
import { ModelError, type ModelResult } from '../model/adapter';
import { BudgetExhaustedError, meteredComplete } from '../model/metered';
import { assertSecretFree, SecretRedactionError } from '../redaction';
import { isRecord } from '../state';
import {
  type Citation,
  createTypedQuestion,
  DEFAULT_DECISION_PASSES,
  type DecisionDeps,
  type DecisionFloor,
  type DecisionInput,
  type DecisionReason,
  type DecisionValue,
  InvalidDecisionError,
  MAX_DECISION_CITATIONS,
  MAX_DECISION_INPUT_BYTES,
  MAX_DECISION_PASSES,
  MAX_DECISION_SOURCES,
  MIN_DECISION_PASSES,
  questionStrictness,
  questionValues,
  type TypedQuestion,
  type Verdict,
  validDecisionProbability,
} from './types';

// Receipt canonicalJson has a smaller limit and integer-only numbers; thresholds are fractional.
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((k) => [k, item[k]])
        )
      : item
  );
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');
const whitespace = (s: string) => s.replace(/\s+/gu, ' ').trim();
type Sources = ReadonlyMap<string, readonly string[]>;
const SEMANTIC_REASONS = ['invalid_pass', 'disagreement', 'confidence', 'floor'] as const;
type CacheableEscalation = (typeof SEMANTIC_REASONS)[number];
const VERDICT_KEYS: readonly string[] = [
  'value',
  'confidence',
  'citations',
  'status',
  'reason',
  'provider',
  'model',
  'questionVersion',
  'inputDigest',
] satisfies readonly (keyof Verdict)[];
/** Reject accidental async implementations of the documented synchronous cache contract. */
function synchronousCacheResult(value: unknown): unknown {
  if (value && typeof value === 'object' && 'then' in value && typeof value.then === 'function') {
    void Promise.resolve(value).catch(() => {});
    throw new Error('Asynchronous decision cache');
  }
  return value;
}
function failureReason(error: unknown, signal?: AbortSignal): Exclude<DecisionReason, 'accepted'> {
  if (signal?.aborted) return 'aborted';
  if (error instanceof BudgetExhaustedError) return 'budget';
  if (error instanceof BudgetError) return 'ledger';
  if (error instanceof SecretRedactionError) return 'secret';
  if (error instanceof ModelError && error.code === 'invalid_request') return 'configuration';
  return 'provider';
}

function snapshotInputs(raw: readonly DecisionInput[]): readonly DecisionInput[] {
  let inputs: unknown;
  try {
    inputs = structuredClone(raw);
  } catch {
    throw new InvalidDecisionError('inputs');
  }
  if (
    !Array.isArray(inputs) ||
    inputs.some(
      (i) =>
        !isRecord(i) ||
        Object.keys(i).some((k) => !['sourceId', 'text'].includes(k)) ||
        typeof i.sourceId !== 'string' ||
        !i.sourceId ||
        typeof i.text !== 'string'
    ) ||
    new Set(inputs.map((i: DecisionInput) => i.sourceId)).size !== inputs.length
  )
    throw new InvalidDecisionError('inputs');
  return Object.freeze(
    inputs.map((i: DecisionInput) => Object.freeze({ sourceId: i.sourceId, text: i.text }))
  );
}
function evaluateFloor(
  fn: DecisionDeps['floor'],
  question: TypedQuestion,
  inputs: readonly DecisionInput[]
): DecisionFloor {
  const raw: unknown = structuredClone(fn ? fn(question, inputs) : {});
  if (
    !isRecord(raw) ||
    Object.keys(raw).some((k) => !['minimumStrictness', 'escalate'].includes(k)) ||
    (raw.escalate !== undefined && typeof raw.escalate !== 'boolean') ||
    (raw.minimumStrictness !== undefined &&
      (typeof raw.minimumStrictness !== 'number' || !Number.isFinite(raw.minimumStrictness)))
  )
    throw new Error('Invalid floor');
  return {
    ...(raw.escalate === undefined ? {} : { escalate: raw.escalate as boolean }),
    ...(raw.minimumStrictness === undefined
      ? {}
      : { minimumStrictness: raw.minimumStrictness as number }),
  };
}
function citations(
  raw: unknown,
  sources: Sources,
  max = MAX_DECISION_CITATIONS
): Citation[] | null {
  if (!Array.isArray(raw) || raw.length > max) return null;
  const result: Citation[] = [];
  for (const c of raw) {
    if (
      !isRecord(c) ||
      Object.keys(c).some((k) => !['sourceId', 'line', 'quote'].includes(k)) ||
      typeof c.sourceId !== 'string' ||
      typeof c.quote !== 'string' ||
      !whitespace(c.quote) ||
      !Number.isSafeInteger(c.line) ||
      (c.line as number) < 1
    )
      return null;
    const line = sources.get(c.sourceId)?.[(c.line as number) - 1];
    if (line === undefined || !line.includes(whitespace(c.quote))) return null;
    result.push({ sourceId: c.sourceId, line: c.line as number, quote: c.quote });
  }
  return result;
}
function freezeVerdict(v: Verdict): Verdict {
  assertSecretFree(v);
  for (const c of v.citations) Object.freeze(c);
  Object.freeze(v.citations);
  return Object.freeze(v);
}
function refusal(
  question: TypedQuestion,
  floor: DecisionFloor,
  value: DecisionValue,
  confidence: number
): 'floor' | 'confidence' | null {
  if (
    floor.minimumStrictness !== undefined &&
    questionStrictness(question, value) < floor.minimumStrictness
  )
    return 'floor';
  return confidence < question.acceptThreshold[String(value)] ? 'confidence' : null;
}
function passConfidence(
  kind: 'agreement' | 'external',
  raw: Record<string, unknown>,
  result: ModelResult
): number | null {
  if (kind === 'external') return validDecisionProbability(raw.confidence) ? raw.confidence : null;
  const logs = result.tokenLogprobs;
  if (logs === undefined) return 1;
  if (!Array.isArray(logs) || !logs.length || logs.some((n) => !Number.isFinite(n) || n > 0))
    return null;
  // Reduce avoids an argument-spread limit with large custom-adapter responses.
  return Math.exp(logs.reduce((a, b) => Math.min(a, b), 0));
}
function readCache(
  v: unknown,
  identity: Pick<Verdict, 'provider' | 'model' | 'questionVersion' | 'inputDigest'>,
  question: TypedQuestion,
  floor: DecisionFloor,
  sources: Sources
): Verdict | null {
  assertSecretFree(v);
  if (
    !isRecord(v) ||
    Object.keys(v).some((k) => !VERDICT_KEYS.includes(k)) ||
    Object.entries(identity).some(([k, value]) => v[k] !== value) ||
    !validDecisionProbability(v.confidence)
  )
    return null;
  const evidence = citations(v.citations, sources, MAX_DECISION_CITATIONS * MAX_DECISION_PASSES);
  if (evidence === null) return null;
  if (
    v.status === 'accepted' &&
    v.reason === 'accepted' &&
    questionValues(question).includes(v.value as DecisionValue) &&
    refusal(question, floor, v.value as DecisionValue, v.confidence) === null
  )
    return freezeVerdict({
      ...identity,
      value: v.value as DecisionValue,
      confidence: v.confidence,
      citations: evidence,
      status: 'accepted',
      reason: 'accepted',
    });
  if (
    v.status === 'escalated' &&
    v.value === question.escalateValue &&
    SEMANTIC_REASONS.includes(v.reason as CacheableEscalation) &&
    !evidence.length
  )
    return freezeVerdict({
      ...identity,
      value: question.escalateValue,
      confidence: v.confidence,
      citations: [],
      status: 'escalated',
      reason: v.reason as CacheableEscalation,
    });
  return null;
}

/** No provider/floor/cache failure may grant a more permissive answer. */
export async function decide(
  definition: TypedQuestion,
  rawInputs: readonly DecisionInput[],
  deps: DecisionDeps
): Promise<Verdict> {
  const question = createTypedQuestion(definition);
  const {
    provider,
    budget,
    cache,
    floor: floorFn,
    passes = DEFAULT_DECISION_PASSES,
    signal,
  } = deps;
  const { id, model, confidenceKind, adapter, cacheIdentity } = provider;
  if (
    !Number.isSafeInteger(passes) ||
    passes < MIN_DECISION_PASSES ||
    passes > MAX_DECISION_PASSES ||
    !['agreement', 'external'].includes(confidenceKind) ||
    typeof id !== 'string' ||
    !id ||
    typeof model !== 'string' ||
    !model ||
    !adapter ||
    typeof adapter.complete !== 'function' ||
    adapter.id !== model ||
    (cacheIdentity !== undefined && typeof cacheIdentity !== 'string')
  )
    throw new InvalidDecisionError('configuration');
  assertSecretFree({ id, model, cacheIdentity });
  const inputs = snapshotInputs(rawInputs);
  const identity = {
    provider: id,
    model,
    questionVersion: question.version,
    inputDigest: digest(inputs),
  };
  const escalate = (reason: Exclude<DecisionReason, 'accepted'>, confidence = 0): Verdict =>
    freezeVerdict({
      ...identity,
      value: question.escalateValue,
      confidence,
      citations: [],
      status: 'escalated',
      reason,
    });
  if (
    inputs.length > MAX_DECISION_SOURCES ||
    Buffer.byteLength(stableJson(inputs), 'utf8') > MAX_DECISION_INPUT_BYTES
  )
    return escalate('input');
  if (signal?.aborted) return escalate('aborted');
  try {
    assertSecretFree(inputs);
  } catch {
    return escalate('secret');
  }
  let floor: DecisionFloor;
  try {
    floor = evaluateFloor(floorFn, question, inputs);
  } catch {
    return escalate('configuration');
  }
  if (floor.escalate) return escalate('floor');
  const sources: Sources = new Map(
    inputs.map((i) => [i.sourceId, i.text.split(/\r?\n/u).map(whitespace)])
  );
  const key = digest([
    question.id,
    question.version,
    id,
    model,
    identity.inputDigest,
    question,
    confidenceKind,
    cacheIdentity,
    passes,
    floor,
  ]);
  const remember = (v: Verdict): Verdict => {
    try {
      // Overlapping writes can retain uncertainty or become stricter, never erase it.
      const existing = synchronousCacheResult(cache?.get(key));
      if (existing !== undefined) {
        const previous = readCache(structuredClone(existing), identity, question, floor, sources);
        if (!previous) return escalate('cache');
        if (previous.status === 'escalated') return previous;
        if (
          v.status === 'accepted' &&
          questionStrictness(question, previous.value) >= questionStrictness(question, v.value)
        )
          return previous;
      }
      if (synchronousCacheResult(cache?.set(key, structuredClone(v))) !== undefined)
        return escalate('cache_write');
    } catch {
      return escalate('cache_write');
    }
    return v;
  };
  const semantic = (reason: CacheableEscalation, confidence = 0) =>
    remember(escalate(reason, confidence));
  try {
    const cached = synchronousCacheResult(cache?.get(key));
    if (cached !== undefined)
      return (
        readCache(structuredClone(cached), identity, question, floor, sources) ?? escalate('cache')
      );
  } catch {
    return escalate('cache');
  }
  const answers: { value: DecisionValue; citations: Citation[]; confidence: number }[] = [];
  for (let pass = 0; pass < passes; pass++) {
    if (signal?.aborted) return escalate('aborted');
    try {
      const request = provider.request(question, inputs, pass);
      const result = await meteredComplete(
        adapter,
        budget.ledger,
        budget.sessionId,
        budget.rates,
        signal ? { ...request, signal } : request
      );
      if (signal?.aborted) return escalate('aborted');
      if (result.kind === 'malformed')
        return escalate(result.reason === 'secret_detected' ? 'secret' : 'provider');
      const raw = structuredClone(provider.decode(result));
      assertSecretFree(raw);
      if (!isRecord(raw) || !questionValues(question).includes(raw.value as DecisionValue))
        return semantic('invalid_pass');
      const evidence = citations(raw.citations, sources);
      const confidence = passConfidence(confidenceKind, raw, result);
      if (evidence === null || confidence === null) return semantic('invalid_pass');
      answers.push({ value: raw.value as DecisionValue, citations: evidence, confidence });
    } catch (error) {
      return escalate(failureReason(error, signal));
    }
  }
  const strictest = answers.reduce((a, b) =>
    questionStrictness(question, a.value) >= questionStrictness(question, b.value) ? a : b
  );
  const agreement = answers.filter((a) => a.value === strictest.value).length / passes;
  const confidence = Math.min(agreement, ...answers.map((a) => a.confidence));
  if (agreement !== 1) return semantic('disagreement', confidence);
  const reason = refusal(question, floor, strictest.value, confidence);
  if (reason) return semantic(reason, confidence);
  return remember(
    freezeVerdict({
      ...identity,
      value: strictest.value,
      confidence,
      citations: answers.flatMap((a) => a.citations),
      status: 'accepted',
      reason: 'accepted',
    })
  );
}
