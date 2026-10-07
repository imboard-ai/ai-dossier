import type { BudgetLedger } from '../budget';
import type { BudgetRate } from '../budget-types';
import type { ModelAdapter, ModelRequest, ModelResult } from '../model/adapter';
import { assertSecretFree } from '../redaction';
import { isNonemptyString, isRecord } from '../state';

export type DecisionValue = string | boolean;
export const DEFAULT_DECISION_PASSES = 2;
export const MIN_DECISION_PASSES = 2;
export const MAX_DECISION_PASSES = 8;
export const MAX_DECISION_SOURCES = 256;
export const MAX_DECISION_INPUT_BYTES = 1024 * 1024;
export const MAX_DECISION_CITATIONS = 256;
export const MAX_DECISION_ANSWERS = 64;
interface QuestionBase {
  id: string;
  version: string;
  /** Fixed controller-authored text, never derived from the untrusted inputs. */
  prompt: string;
  escalateValue: string;
  acceptThreshold: Readonly<Record<string, number>>;
}
export type TypedQuestion = QuestionBase &
  (
    | { kind: 'boolean' }
    | {
        kind: 'choice';
        options: readonly string[];
        strictness: Readonly<Record<string, number>>;
      }
    | { kind: 'score'; scale: readonly string[] }
  );
export interface DecisionInput {
  sourceId: string;
  text: string;
}
export interface Citation {
  sourceId: string;
  /** One-based line; a quote is a span on this single line, whitespace normalized. */
  line: number;
  quote: string;
}
export type DecisionReason =
  | 'accepted'
  | 'invalid_pass'
  | 'disagreement'
  | 'confidence'
  | 'floor'
  | 'budget'
  | 'provider'
  | 'secret'
  | 'cache'
  | 'cache_write'
  | 'ledger'
  | 'configuration'
  | 'aborted'
  | 'input';
interface VerdictEvidence {
  confidence: number;
  citations: readonly Citation[];
  provider: string;
  model: string;
  questionVersion: string;
  inputDigest: string;
}
/** Consumers MUST narrow status before treating value as an answer/permission. */
export type Verdict = VerdictEvidence &
  (
    | { status: 'accepted'; reason: 'accepted'; value: DecisionValue }
    | { status: 'escalated'; reason: Exclude<DecisionReason, 'accepted'>; value: string }
  );
export interface DecisionBudget {
  ledger: BudgetLedger;
  sessionId: string;
  rates: BudgetRate[];
}
/** Trusted controller implementation. Raw answers remain untrusted, even externally. */
export interface DecisionProvider {
  readonly id: string;
  readonly model: string;
  readonly confidenceKind: 'agreement' | 'external';
  /** Non-secret configuration/schema/framing fingerprint; never returned in verdicts. */
  readonly cacheIdentity?: string;
  readonly adapter: ModelAdapter;
  request(question: TypedQuestion, inputs: readonly DecisionInput[], pass: number): ModelRequest;
  decode(result: ModelResult): unknown;
}
export interface DecisionCache {
  get(key: string): unknown;
  set(key: string, value: Verdict): undefined;
}
export interface DecisionFloor {
  minimumStrictness?: number;
  escalate?: boolean;
}
export interface DecisionDeps {
  provider: DecisionProvider;
  floor?: (question: TypedQuestion, inputs: readonly DecisionInput[]) => DecisionFloor;
  /** Controller-owned trusted storage, outside worker write access. */
  cache?: DecisionCache;
  budget: DecisionBudget;
  /** Independent calls with alternating trusted framings. Default two, maximum eight. */
  passes?: number;
  signal?: AbortSignal;
}
export class InvalidDecisionError extends Error {
  constructor(readonly code: 'configuration' | 'inputs') {
    super(code === 'inputs' ? 'Invalid decision inputs' : 'Invalid decision configuration');
    this.name = 'InvalidDecisionError';
  }
}
export class InvalidQuestionError extends Error {
  constructor() {
    super('Invalid typed question');
    this.name = 'InvalidQuestionError';
  }
}
export function questionValues(question: TypedQuestion): readonly DecisionValue[] {
  return question.kind === 'boolean'
    ? [true, false]
    : question.kind === 'choice'
      ? question.options
      : question.scale;
}
/** Boolean true is permissive; score scale is least-to-most strict. */
export function questionStrictness(question: TypedQuestion, value: DecisionValue): number {
  if (!questionValues(question).includes(value)) throw new InvalidQuestionError();
  if (question.kind === 'boolean') return value === true ? 0 : 1;
  if (question.kind === 'choice') return question.strictness[String(value)];
  return question.scale.indexOf(String(value));
}
const probability = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
export { probability as validDecisionProbability };
function keyedByAnswers(raw: unknown, keys: string[], valid: (value: unknown) => boolean): boolean {
  return (
    isRecord(raw) &&
    Object.keys(raw).length === keys.length &&
    keys.every((key) => Object.hasOwn(raw, key) && valid(raw[key]))
  );
}

/** Reject invalid definitions and detach/freeze every field at construction. */
export function createTypedQuestion(raw: TypedQuestion): TypedQuestion {
  try {
    const q: unknown = structuredClone(raw);
    assertSecretFree(q);
    if (!isRecord(q)) throw new InvalidQuestionError();
    const extra =
      q.kind === 'choice' ? ['options', 'strictness'] : q.kind === 'score' ? ['scale'] : [];
    if (
      !['boolean', 'choice', 'score'].includes(String(q.kind)) ||
      Object.keys(q).some(
        (key) =>
          ![
            'kind',
            'id',
            'version',
            'prompt',
            'escalateValue',
            'acceptThreshold',
            ...extra,
          ].includes(key)
      ) ||
      !['id', 'version', 'prompt', 'escalateValue'].every((key) => isNonemptyString(q[key])) ||
      !isRecord(q.acceptThreshold)
    )
      throw new InvalidQuestionError();
    if (q.kind !== 'boolean') {
      const values = q.kind === 'choice' ? q.options : q.scale;
      if (
        !Array.isArray(values) ||
        values.length < 2 ||
        values.length > MAX_DECISION_ANSWERS ||
        values.some((v) => typeof v !== 'string' || !v.trim() || v === q.escalateValue) ||
        new Set(values).size !== values.length ||
        Object.keys(values).length !== values.length
      )
        throw new InvalidQuestionError();
      Object.freeze(values);
    } else if (['true', 'false'].includes(q.escalateValue as string))
      throw new InvalidQuestionError();
    const values: readonly DecisionValue[] =
      q.kind === 'boolean'
        ? [true, false]
        : ((q.kind === 'choice' ? q.options : q.scale) as string[]);
    const keys = values.map(String);
    if (!keyedByAnswers(q.acceptThreshold, keys, probability)) throw new InvalidQuestionError();
    if (q.kind === 'choice') {
      if (!keyedByAnswers(q.strictness, keys, (v) => typeof v === 'number' && Number.isFinite(v)))
        throw new InvalidQuestionError();
      Object.freeze(q.strictness);
    }
    const question = q as unknown as TypedQuestion;
    // Strictly more permissive answers must have strictly higher admission thresholds.
    for (const a of values)
      for (const b of values) {
        if (
          questionStrictness(question, a) < questionStrictness(question, b) &&
          question.acceptThreshold[String(a)] <= question.acceptThreshold[String(b)]
        )
          throw new InvalidQuestionError();
      }
    Object.freeze(question.acceptThreshold);
    return Object.freeze(question);
  } catch {
    throw new InvalidQuestionError();
  }
}
