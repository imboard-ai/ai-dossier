import type { BudgetLedger } from '../budget';
import type { BudgetRate } from '../budget-types';
import type { ModelAdapter, ModelRequest, ModelResult } from '../model/adapter';
import { assertSecretFree } from '../redaction';
import { isRecord } from '../state';

export type DecisionValue = string | boolean;
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
  | 'cache';
export interface Verdict {
  value: DecisionValue;
  confidence: number;
  citations: readonly Citation[];
  status: 'accepted' | 'escalated';
  reason: DecisionReason;
  provider: string;
  model: string;
  questionVersion: string;
  inputDigest: string;
}
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
  readonly adapter: ModelAdapter;
  request(question: TypedQuestion, inputs: readonly DecisionInput[], pass: number): ModelRequest;
  decode(result: ModelResult): unknown;
}
export interface DecisionCache {
  get(key: string): Verdict | undefined;
  set(key: string, value: Verdict): void;
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
  /** Independent calls with different trusted framings. Default two, maximum eight. */
  passes?: number;
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
  if (question.kind === 'boolean') return value === true ? 0 : 1;
  if (question.kind === 'choice') return question.strictness[String(value)];
  return question.scale.indexOf(String(value));
}
const probability = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
export { probability as validDecisionProbability };

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
      !['id', 'version', 'prompt', 'escalateValue'].every(
        (key) => typeof q[key] === 'string' && (q[key] as string).trim().length > 0
      ) ||
      !isRecord(q.acceptThreshold)
    )
      throw new InvalidQuestionError();
    if (q.kind !== 'boolean') {
      const values = q.kind === 'choice' ? q.options : q.scale;
      if (
        !Array.isArray(values) ||
        values.length < 2 ||
        values.length > 64 ||
        values.some((v) => typeof v !== 'string' || !v.trim() || v === q.escalateValue) ||
        new Set(values).size !== values.length ||
        Object.keys(values).length !== values.length
      )
        throw new InvalidQuestionError();
      Object.freeze(values);
    } else if (['true', 'false'].includes(q.escalateValue as string))
      throw new InvalidQuestionError();
    const question = q as unknown as TypedQuestion;
    const values = questionValues(question);
    const keys = values.map(String);
    if (
      Object.keys(q.acceptThreshold).length !== keys.length ||
      keys.some(
        (key) =>
          !Object.hasOwn(q.acceptThreshold as object, key) ||
          !probability((q.acceptThreshold as Record<string, unknown>)[key])
      )
    )
      throw new InvalidQuestionError();
    if (question.kind === 'choice') {
      if (
        !isRecord(question.strictness) ||
        Object.keys(question.strictness).length !== keys.length ||
        keys.some(
          (key) =>
            !Object.hasOwn(question.strictness, key) || !Number.isFinite(question.strictness[key])
        )
      )
        throw new InvalidQuestionError();
      Object.freeze(question.strictness);
    }
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
