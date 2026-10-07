import { createHash } from 'node:crypto';
import { BudgetExhaustedError, meteredComplete } from '../model/metered';
import { assertSecretFree, SecretRedactionError } from '../redaction';
import { isRecord } from '../state';
import {
  type Citation,
  createTypedQuestion,
  type DecisionDeps,
  type DecisionFloor,
  type DecisionInput,
  type DecisionReason,
  type DecisionValue,
  questionStrictness,
  questionValues,
  type TypedQuestion,
  type Verdict,
  validDecisionProbability,
} from './types';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const whitespace = (s: string) => s.replace(/\s+/gu, ' ').trim();
function citations(raw: unknown, inputs: readonly DecisionInput[]): Citation[] | null {
  if (!Array.isArray(raw) || raw.length > 256) return null;
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
    const source = inputs.find((i) => i.sourceId === c.sourceId);
    const line = source?.text.split(/\r?\n/u)[(c.line as number) - 1];
    if (line === undefined || !whitespace(line).includes(whitespace(c.quote))) return null;
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

/** No provider/floor/cache failure may grant a more permissive answer. */
export async function decide(
  definition: TypedQuestion,
  rawInputs: readonly DecisionInput[],
  deps: DecisionDeps
): Promise<Verdict> {
  const question = createTypedQuestion(definition);
  const { provider, budget, cache, floor: floorFn, passes = 2 } = deps;
  const { id, model, confidenceKind, adapter } = provider;
  if (
    !Number.isSafeInteger(passes) ||
    passes < 2 ||
    passes > 8 ||
    !['agreement', 'external'].includes(confidenceKind) ||
    typeof id !== 'string' ||
    !id ||
    typeof model !== 'string' ||
    !model ||
    adapter.id !== model
  )
    throw new Error('Invalid decision configuration');
  assertSecretFree({ id, model });
  const inputs = structuredClone(rawInputs);
  if (
    !Array.isArray(inputs) ||
    inputs.length > 256 ||
    inputs.some(
      (i) =>
        !isRecord(i) ||
        Object.keys(i).some((k) => !['sourceId', 'text'].includes(k)) ||
        typeof i.sourceId !== 'string' ||
        !i.sourceId ||
        typeof i.text !== 'string'
    ) ||
    new Set(inputs.map((i) => i.sourceId)).size !== inputs.length ||
    Buffer.byteLength(JSON.stringify(inputs), 'utf8') > 1024 * 1024
  )
    throw new Error('Invalid decision inputs');
  for (const input of inputs) Object.freeze(input);
  Object.freeze(inputs);
  const inputDigest = digest(inputs);
  const verdict = (reason: DecisionReason, confidence = 0): Verdict =>
    freezeVerdict({
      value: question.escalateValue,
      confidence,
      citations: [],
      status: 'escalated',
      reason,
      provider: id,
      model,
      questionVersion: question.version,
      inputDigest,
    });
  try {
    assertSecretFree(inputs);
  } catch {
    return verdict('secret');
  }
  let floor: DecisionFloor;
  try {
    floor = structuredClone(floorFn ? floorFn(question, inputs) : {});
    if (
      !isRecord(floor) ||
      Object.keys(floor).some((k) => !['minimumStrictness', 'escalate'].includes(k)) ||
      (floor.escalate !== undefined && typeof floor.escalate !== 'boolean') ||
      (floor.minimumStrictness !== undefined && !Number.isFinite(floor.minimumStrictness))
    )
      return verdict('floor');
  } catch {
    return verdict('floor');
  }
  if (floor.escalate) return verdict('floor');
  const minimumStrictness = floor.minimumStrictness as number | undefined;
  const values = questionValues(question);
  const key = digest([
    question.id,
    question.version,
    id,
    model,
    inputDigest,
    question,
    confidenceKind,
    passes,
    floor,
  ]);
  try {
    const cached = cache?.get(key);
    if (cached !== undefined) {
      const v = structuredClone(cached);
      assertSecretFree(v);
      if (
        !isRecord(v) ||
        v.status !== 'accepted' ||
        v.reason !== 'accepted' ||
        v.provider !== id ||
        v.model !== model ||
        v.questionVersion !== question.version ||
        v.inputDigest !== inputDigest ||
        !values.includes(v.value) ||
        !validDecisionProbability(v.confidence) ||
        v.confidence < question.acceptThreshold[String(v.value)] ||
        (minimumStrictness !== undefined &&
          questionStrictness(question, v.value) < minimumStrictness) ||
        citations(v.citations, inputs) === null
      )
        return verdict('cache');
      return freezeVerdict(v);
    }
  } catch {
    return verdict('cache');
  }
  const answers: { value: DecisionValue; citations: Citation[]; confidence: number }[] = [];
  for (let pass = 0; pass < passes; pass++) {
    try {
      const request = provider.request(question, inputs, pass);
      const result = await meteredComplete(
        adapter,
        budget.ledger,
        budget.sessionId,
        budget.rates,
        request
      );
      const raw = structuredClone(provider.decode(result));
      assertSecretFree(raw);
      if (!isRecord(raw) || !values.includes(raw.value as DecisionValue))
        return verdict('invalid_pass');
      const evidence = citations(raw.citations, inputs);
      if (evidence === null) return verdict('invalid_pass');
      let confidence = 1;
      if (confidenceKind === 'external') {
        if (!validDecisionProbability(raw.confidence)) return verdict('invalid_pass');
        confidence = raw.confidence;
      } else if (result.tokenLogprobs !== undefined) {
        if (
          !Array.isArray(result.tokenLogprobs) ||
          result.tokenLogprobs.length === 0 ||
          result.tokenLogprobs.some((n) => !Number.isFinite(n) || n > 0)
        )
          return verdict('invalid_pass');
        confidence = Math.exp(Math.min(...result.tokenLogprobs));
      }
      answers.push({ value: raw.value as DecisionValue, citations: evidence, confidence });
    } catch (error) {
      return verdict(
        error instanceof BudgetExhaustedError
          ? 'budget'
          : error instanceof SecretRedactionError
            ? 'secret'
            : 'provider'
      );
    }
  }
  const strictest = answers.reduce((a, b) =>
    questionStrictness(question, a.value) >= questionStrictness(question, b.value) ? a : b
  );
  const agreement = answers.filter((a) => a.value === strictest.value).length / passes;
  const confidence = Math.min(agreement, ...answers.map((a) => a.confidence));
  if (agreement !== 1) return verdict('disagreement', confidence);
  if (
    minimumStrictness !== undefined &&
    questionStrictness(question, strictest.value) < minimumStrictness
  )
    return verdict('floor', confidence);
  if (confidence < question.acceptThreshold[String(strictest.value)])
    return verdict('confidence', confidence);
  const accepted = freezeVerdict({
    value: strictest.value,
    confidence,
    citations: answers.flatMap((a) => a.citations),
    status: 'accepted',
    reason: 'accepted',
    provider: id,
    model,
    questionVersion: question.version,
    inputDigest,
  });
  try {
    cache?.set(key, structuredClone(accepted));
  } catch {
    return verdict('cache');
  }
  return accepted;
}
