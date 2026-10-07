import { createHash } from 'node:crypto';
import { canonicalJson } from '../receipt/schema';
import { assertNoSecrets } from '../redaction';
import { type PolicyFile, validatePolicyFiles } from './discover';
import { policyRegions } from './regions';
import { POLICY_RULES, POLICY_TOPICS, type PolicyCategory, type PolicyDimension } from './rules';

export interface PolicyCitation {
  readonly path: string;
  readonly line: number;
  readonly ruleId: string;
  readonly excerpt: string;
}
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
}

const RULES = POLICY_RULES.map((rule) => ({ ...rule, regex: new RegExp(rule.pattern, 'iu') }));
const TOPICS = POLICY_TOPICS.map((topic) => ({ ...topic, regex: new RegExp(topic.pattern, 'iu') }));
const CITATION_LIMIT = 128;
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

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function citationKey(c: PolicyCitation): string {
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

function excerpt(text: string): string {
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
 * Citations retain the first occurrence of each rule per blob (at most 128 total).
 * Assessment still examines every line even once the evidence cap is reached. */
export function classifyPolicy(files: readonly PolicyFile[]): PolicyAssessment {
  validatePolicyFiles(files);
  const citations: PolicyCitation[] = [];
  const dimensions = Object.fromEntries(
    TOPICS.map(({ dimension }) => [
      dimension,
      {
        seen: false,
        unclear: false,
        restrictions: new Set<PolicyCategory>(),
      },
    ])
  ) as Record<
    PolicyDimension,
    { seen: boolean; unclear: boolean; restrictions: Set<PolicyCategory> }
  >;
  for (const file of [...files].sort((a, b) => compare(a.path, b.path))) {
    const cited = new Set<string>();
    function cite(ruleId: string, text: string, line: number): void {
      if (!cited.has(ruleId) && citations.length < CITATION_LIMIT) {
        citations.push(Object.freeze({ path: file.path, line, ruleId, excerpt: excerpt(text) }));
        cited.add(ruleId);
      }
    }
    for (const region of policyRegions(file)) {
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
  return Object.freeze({
    ai,
    assignment,
    directPr,
    draftRequired: dimensions.draft.seen,
    receiptBlockAllowed: !dimensions.template.seen,
    baselineFailuresPermitted: false,
    citations: Object.freeze(citations.sort((a, b) => compare(citationKey(a), citationKey(b)))),
  });
}

/** Canonical sorted-key JSON, sorted citations and path/blob identities. Content is
 * bound by its Git blob SHA, not interpreted or copied into the digest payload. */
export function policyDigest(assessment: PolicyAssessment, files: readonly PolicyFile[]): string {
  validatePolicyFiles(files);
  const citations = [...assessment.citations].sort((a, b) =>
    compare(citationKey(a), citationKey(b))
  );
  const payload = {
    assessment: { ...assessment, citations },
    files: files.map(({ path, sha }) => ({ path, sha })).sort((a, b) => compare(a.path, b.path)),
  };
  return createHash('sha256')
    .update(canonicalJson(payload, POLICY_JSON_LIMIT), 'utf8')
    .digest('hex');
}
