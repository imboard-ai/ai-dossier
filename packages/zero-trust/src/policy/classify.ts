import { createHash } from 'node:crypto';
import { canonicalJson } from '../receipt/schema';
import { assertNoSecrets } from '../redaction';
import { type PolicyFile, validatePolicyFiles } from './discover';
import {
  POLICY_AI_MENTION,
  POLICY_PERMISSION_CAVEAT,
  POLICY_RULES,
  type PolicyCategory,
} from './rules';

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
const AI_MENTION = new RegExp(POLICY_AI_MENTION, 'iu');
const CAVEAT = new RegExp(POLICY_PERMISSION_CAVEAT, 'iu');
const CITATION_LIMIT = 128;
// Worst case: 128 * 200 six-byte JSON escapes, plus bounded paths/identities.
const POLICY_JSON_LIMIT = 256 * 1024;
const PERMISSIVE = new Set<PolicyCategory>([
  'ai_welcome',
  'assignment_optional',
  'direct_pr',
  'baseline_permitted',
]);
const AI_VALUES = {
  ai_ban: 'banned',
  ai_approval: 'requires_approval',
  ai_disclosure: 'disclosure_required',
  ai_welcome: 'welcomed',
} as const;

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function citationKey(c: PolicyCitation): string {
  return canonicalJson(c);
}

/** README prose contributes only inside contribution headings. Line numbers stay
 * those of the original blob. Nested headings stay within the enclosing section. */
function policyLines(file: PolicyFile): { text: string; line: number }[] {
  const lines = file.content.split(/\r\n|\n|\r/u);
  let sectionDepth = 0;
  let fenced = false;
  return lines.flatMap((text, index) => {
    if (file.path !== 'README.md') return [{ text, line: index + 1 }];
    if (/^\s*(?:```|~~~)/u.test(text)) fenced = !fenced;
    const heading = !fenced && /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(text);
    const setext =
      !fenced && index + 1 < lines.length && /^\s*(?:={3,}|-{3,})\s*$/u.test(lines[index + 1]);
    const depth = heading
      ? heading[1].length
      : setext
        ? /^\s*=/u.test(lines[index + 1])
          ? 1
          : 2
        : 0;
    if (depth) {
      if (/contribut/iu.test(heading ? heading[2] : text))
        sectionDepth = sectionDepth ? Math.min(sectionDepth, depth) : depth;
      else if (sectionDepth && depth <= sectionDepth) sectionDepth = 0;
    }
    return sectionDepth ? [{ text, line: index + 1 }] : [];
  });
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

/** Rules only. Conflicting dimensions and unrecognized AI prose require judgment.
 * Citations retain the first occurrence of each rule per blob (at most 128 total).
 * Assessment still examines every line even once the evidence cap is reached. */
export function classifyPolicy(files: readonly PolicyFile[]): PolicyAssessment {
  validatePolicyFiles(files);
  const categories = new Set<PolicyCategory>();
  const citations: PolicyCitation[] = [];
  let unknownAi = false;
  let unknownAssignment = false;
  let unknownDirect = false;
  let unknownBaseline = false;
  for (const file of [...files].sort((a, b) => compare(a.path, b.path))) {
    const cited = new Set<string>();
    for (const { text, line } of policyLines(file)) {
      // Matching view only: normalize spacing and separate independent clauses.
      // Original blob text/line remains the citation; no text is executed.
      const clauses = text.replace(/\s+/gu, ' ').split(/[.!?;,]|\bbut\b/iu);
      for (const clause of clauses) {
        let matchedAi = false;
        let matchedAssignment = false;
        let matchedDirect = false;
        let matchedBaseline = false;
        for (const rule of RULES) {
          if (!rule.regex.test(clause)) continue;
          const caveatText =
            rule.category === 'assignment_optional' ? clause.replace(rule.regex, '') : clause;
          if (PERMISSIVE.has(rule.category) && CAVEAT.test(caveatText)) continue;
          categories.add(rule.category);
          if (rule.category.startsWith('ai_')) matchedAi = true;
          if (rule.category.startsWith('assignment_')) matchedAssignment = true;
          if (
            rule.category === 'direct_pr' ||
            rule.category === 'discussion_first' ||
            rule.category === 'draft_required'
          )
            matchedDirect = true;
          if (rule.category.startsWith('baseline_')) matchedBaseline = true;
          if (!cited.has(rule.id) && citations.length < CITATION_LIMIT) {
            citations.push(
              Object.freeze({ path: file.path, line, ruleId: rule.id, excerpt: excerpt(text) })
            );
            cited.add(rule.id);
          }
        }
        if (
          !matchedAi &&
          AI_MENTION.test(clause) &&
          !/^\s*#{1,6}\s+(?:AI|LLM)\s+policy\s*$/iu.test(clause)
        )
          unknownAi = true;
        // A second unparsed AI assertion must not be swallowed by a recognized
        // match's gap. Multiple mentions in one clause are conservative ambiguity.
        if ((clause.match(new RegExp(POLICY_AI_MENTION, 'giu'))?.length ?? 0) > 1) unknownAi = true;
        if (!matchedAssignment && /\bassign(?:ment|ed)\b/iu.test(clause)) unknownAssignment = true;
        if (!matchedDirect && /\b(?:PRs?|pull requests?)\b/iu.test(clause)) unknownDirect = true;
        if (
          !matchedBaseline &&
          /\b(?:baseline|pre[- ]existing|unrelated) (?:test )?failures\b/iu.test(clause)
        )
          unknownBaseline = true;
      }
    }
  }
  const aiMatches = (Object.keys(AI_VALUES) as (keyof typeof AI_VALUES)[]).filter((category) =>
    categories.has(category)
  );
  const ai =
    unknownAi || aiMatches.length > 1
      ? 'unclear'
      : aiMatches.length === 1
        ? AI_VALUES[aiMatches[0]]
        : 'silent';
  const directPr =
    unknownDirect || categories.has('direct_pr') === categories.has('discussion_first')
      ? 'unclear'
      : categories.has('direct_pr')
        ? 'welcomed'
        : 'discussion_first';
  const assignment = unknownAssignment
    ? 'unclear'
    : categories.has('assignment_required')
      ? categories.has('assignment_optional')
        ? 'unclear'
        : 'required'
      : categories.has('assignment_optional') || directPr === 'welcomed'
        ? 'not_required'
        : 'unclear';
  return Object.freeze({
    ai,
    assignment,
    directPr,
    draftRequired: categories.has('draft_required'),
    receiptBlockAllowed: !categories.has('template_fixed'),
    baselineFailuresPermitted:
      categories.has('baseline_permitted') &&
      !categories.has('baseline_forbidden') &&
      !unknownBaseline,
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
