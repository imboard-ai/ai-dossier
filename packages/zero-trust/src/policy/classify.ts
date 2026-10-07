import { createHash } from 'node:crypto';
import type { Citation, DecisionReason, Verdict } from '../decision/types';
import { canonicalJson } from '../receipt/schema';
import { assertNoSecrets, assertSecretFree } from '../redaction';
import { type PolicyFile, validatePolicyFiles } from './discover';
import { type PolicyRegion, policyRegions } from './regions';
import { POLICY_RULES, POLICY_TOPICS, type PolicyCategory, type PolicyDimension } from './rules';

export interface PolicyCitation {
  readonly path: string;
  readonly line: number;
  readonly ruleId: string;
  readonly excerpt: string;
}
export type PolicyAssessmentDimension =
  | 'ai'
  | 'assignment'
  | 'directPr'
  | 'draftRequired'
  | 'receiptBlockAllowed'
  | 'baselineFailuresPermitted';

export interface PolicyAssessment {
  readonly ai:
    | 'banned'
    | 'requires_approval'
    | 'disclosure_required'
    | 'welcomed'
    | 'silent'
    | 'unclear';
  readonly assignment: 'required' | 'not_required' | 'unclear';
  readonly directPr: 'welcomed' | 'discussion_first' | 'unclear';
  readonly draftRequired: boolean;
  readonly receiptBlockAllowed: boolean;
  readonly baselineFailuresPermitted: boolean;
  readonly citations: readonly PolicyCitation[];
  /** Assessment-wide refusal; dimension evidence remains available for audit. */
  readonly reason?: 'budget' | 'ledger';
  readonly decisions?: Readonly<Partial<Record<PolicyAssessmentDimension, PolicyDecisionEvidence>>>;
}

export interface PolicyDecisionEvidence {
  readonly status: Verdict['status'];
  readonly reason: DecisionReason;
  /** Raw question answer/sentinel. Non-draft permission is inverted in the assessment. */
  readonly value: string | boolean;
  /** Decimal string because receipt canonical JSON only accepts integer numbers. */
  readonly confidence: string;
  readonly provider: string;
  readonly model: string;
  readonly questionVersion: string;
  readonly questionDigest: string;
  readonly inputDigest: string;
  /** Complete distinct validated evidence; display truncation never changes this set. */
  readonly citations: readonly Citation[];
  readonly citationDigest: string;
}

const RULES = POLICY_RULES.map((rule) => ({ ...rule, regex: new RegExp(rule.pattern, 'iu') }));
const TOPICS = POLICY_TOPICS.map((topic) => ({ ...topic, regex: new RegExp(topic.pattern, 'iu') }));
export const POLICY_CITATION_LIMIT = 128;
// Worst case: 128 * 200 six-byte JSON escapes, plus bounded paths/identities.
const POLICY_JSON_LIMIT = 256 * 1024;
const CATEGORY_DIMENSION: Record<PolicyCategory, PolicyDimension> = {
  ai_ban: 'ai',
  ai_approval: 'ai',
  ai_disclosure: 'ai',
  assignment_required: 'assignment',
  discussion_first: 'directPr',
  draft_required: 'draft',
  template_fixed: 'template',
  baseline_forbidden: 'baseline',
};

export function comparePolicyText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function policyCitationKey(c: PolicyCitation): string {
  return canonicalJson(c);
}

/** A comma stays inside its sentence. Protect A.I. before punctuation splitting. */
function units(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b\u02bc]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/\bwon't\b/gu, 'will not')
    .replace(/\bcan't\b/gu, 'cannot')
    .replace(/n't\b/gu, ' not')
    .replace(/\ba\.i\.(?=\W|$)/gu, 'ai')
    .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+/u, '')
    .split(/[.!?;]/u)
    .map((unit) => unit.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

export function policyExcerpt(text: string): string {
  try {
    // Scan the entire line first: slicing can hide a secret prefix at the edge.
    assertNoSecrets(text);
    const value = Array.from(text).slice(0, 200).join('');
    assertNoSecrets(value);
    return value;
  } catch {
    return '[redacted]';
  }
}

/** Deterministic restriction floor only: no permission can be inferred from text.
 * Citations retain the first occurrence of each rule per file (at most 128 total).
 * Assessment still examines every line even once the evidence cap is reached. */
export interface PolicyFloor {
  readonly assessment: PolicyAssessment;
  readonly restrictions: Readonly<Record<PolicyDimension, readonly PolicyCategory[]>>;
  readonly regions: ReadonlyMap<string, readonly PolicyRegion[]>;
  readonly contradictions: Readonly<Record<PolicyDimension, boolean>>;
}

/** Internal consumer floor metadata is independent of bounded display evidence. */
export function analyzePolicyFloor(files: readonly PolicyFile[]): PolicyFloor {
  validatePolicyFiles(files);
  const citations: PolicyCitation[] = [];
  const regions = new Map<string, readonly PolicyRegion[]>();
  const dimensions = Object.fromEntries(
    TOPICS.map(({ dimension }) => [
      dimension,
      {
        seen: false,
        unclear: false,
        restrictions: new Set<PolicyCategory>(),
        contradiction: false,
      },
    ])
  ) as Record<
    PolicyDimension,
    { seen: boolean; unclear: boolean; restrictions: Set<PolicyCategory>; contradiction: boolean }
  >;
  for (const file of [...files].sort((a, b) => comparePolicyText(a.path, b.path))) {
    const cited = new Set<string>();
    function cite(ruleId: string, text: string, line: number): void {
      if (!cited.has(ruleId) && citations.length < POLICY_CITATION_LIMIT) {
        citations.push(
          Object.freeze({ path: file.path, line, ruleId, excerpt: policyExcerpt(text) })
        );
        cited.add(ruleId);
      }
    }
    const selected = policyRegions(file);
    regions.set(file.path, selected);
    for (const region of selected) {
      for (const { text, line } of region.lines) {
        for (const unit of units(text)) {
          for (const topic of TOPICS) {
            if (!topic.regex.test(unit)) continue;
            const state = dimensions[topic.dimension];
            state.seen = true;
            const restrictions = RULES.filter(
              (rule) =>
                CATEGORY_DIMENSION[rule.category] === topic.dimension && rule.regex.test(unit)
            );
            // A separate refusal-only check. Do not change #1091's classification
            // units or infer permission from the nonrestrictive sub-clause.
            if (
              restrictions.length &&
              unit
                .split(/[,():—]|\bbut\b/u)
                .some(
                  (clause) =>
                    topic.regex.test(clause) &&
                    !RULES.some(
                      (rule) =>
                        CATEGORY_DIMENSION[rule.category] === topic.dimension &&
                        rule.regex.test(clause)
                    )
                )
            )
              state.contradiction = true;
            if (region.ambiguous || !restrictions.length) {
              state.unclear = true;
              cite(
                region.ambiguous ? `markdown-ambiguous-${topic.dimension}` : topic.id,
                text,
                line
              );
            }
            for (const restriction of restrictions) {
              state.restrictions.add(restriction.category);
              cite(restriction.id, text, line);
            }
          }
        }
      }
    }
  }
  const ai = !dimensions.ai.seen
    ? 'silent'
    : dimensions.ai.unclear
      ? 'unclear'
      : dimensions.ai.restrictions.has('ai_ban')
        ? 'banned'
        : dimensions.ai.restrictions.has('ai_approval')
          ? 'requires_approval'
          : 'disclosure_required';
  const directPr =
    dimensions.directPr.seen && !dimensions.directPr.unclear ? 'discussion_first' : 'unclear';
  // The legacy silence exception needs directPr=welcomed, which this floor
  // cannot produce; assignment silence therefore remains unclear.
  const assignment =
    dimensions.assignment.seen && !dimensions.assignment.unclear ? 'required' : 'unclear';
  const assessment = Object.freeze({
    ai,
    assignment,
    directPr,
    draftRequired: dimensions.draft.seen,
    receiptBlockAllowed: !dimensions.template.seen,
    baselineFailuresPermitted: false,
    citations: Object.freeze(
      citations.sort((a, b) => comparePolicyText(policyCitationKey(a), policyCitationKey(b)))
    ),
  });
  const restrictions = Object.freeze(
    Object.fromEntries(
      Object.entries(dimensions).map(([dimension, state]) => [
        dimension,
        Object.freeze([...state.restrictions]),
      ])
    )
  ) as PolicyFloor['restrictions'];
  const contradictions = Object.freeze(
    Object.fromEntries(
      Object.entries(dimensions).map(([dimension, state]) => [dimension, state.contradiction])
    )
  ) as PolicyFloor['contradictions'];
  return Object.freeze({ assessment, restrictions, regions, contradictions });
}

export function classifyPolicy(files: readonly PolicyFile[]): PolicyAssessment {
  return analyzePolicyFloor(files).assessment;
}

/** Known validated citation fields in sorted-key JSON order. The full set is
 * hashed incrementally so large valid quotes do not consume the display budget. */
function decisionCitationKey(c: Citation): string {
  return JSON.stringify({ line: c.line, quote: c.quote, sourceId: c.sourceId });
}
export function canonicalPolicyDecisionCitations(
  citations: readonly Citation[]
): readonly Citation[] {
  assertSecretFree(citations);
  const distinct = new Map(citations.map((c) => [decisionCitationKey(c), c]));
  return Object.freeze(
    [...distinct]
      .sort(([a], [b]) => comparePolicyText(a, b))
      .map(([, c]) => Object.freeze({ sourceId: c.sourceId, line: c.line, quote: c.quote }))
  );
}
export function policyDecisionCitationDigest(citations: readonly Citation[]): string {
  const hash = createHash('sha256').update('[');
  let separator = '';
  for (const citation of canonicalPolicyDecisionCitations(citations)) {
    hash.update(separator).update(decisionCitationKey(citation));
    separator = ',';
  }
  return hash.update(']').digest('hex');
}

/** Canonical sorted-key JSON, sorted citations and path/blob identities. Content is
 * bound by its Git blob SHA, not interpreted or copied into the digest payload. */
export function policyDigest(assessment: PolicyAssessment, files: readonly PolicyFile[]): string {
  validatePolicyFiles(files);
  const citations = [...assessment.citations].sort((a, b) =>
    comparePolicyText(policyCitationKey(a), policyCitationKey(b))
  );
  const payload = {
    assessment: {
      ...assessment,
      citations,
      ...(assessment.decisions
        ? {
            decisions: Object.fromEntries(
              Object.entries(assessment.decisions).map(([dimension, evidence]) => {
                const { citations: fullCitations, ...metadata } = evidence;
                return [
                  dimension,
                  { ...metadata, citationDigest: policyDecisionCitationDigest(fullCitations) },
                ];
              })
            ),
          }
        : {}),
    },
    files: files
      .map(({ path, sha }) => ({ path, sha }))
      .sort((a, b) => comparePolicyText(a.path, b.path)),
  };
  return createHash('sha256')
    .update(canonicalJson(payload, POLICY_JSON_LIMIT), 'utf8')
    .digest('hex');
}
