/** Reviewed rule DATA only. No repository text becomes code or instructions.
 * Bounded gaps avoid backtracking over arbitrarily long hostile lines. */
export type PolicyCategory =
  | 'ai_ban'
  | 'ai_approval'
  | 'ai_disclosure'
  | 'ai_welcome'
  | 'assignment_required'
  | 'assignment_optional'
  | 'discussion_first'
  | 'direct_pr'
  | 'draft_required'
  | 'template_fixed'
  | 'baseline_permitted';

export interface PolicyRule {
  readonly id: string;
  readonly category: PolicyCategory;
  readonly pattern: string;
}

const AI =
  '\\b(?:AI(?:[- ]generated|[- ]assisted)?|LLMs?|large language models?|machine[- ]generated)\\b';
const GAP = '[^.!?\\n]{0,100}';

export const POLICY_RULES: readonly PolicyRule[] = Object.freeze(
  [
    {
      id: 'ai-ban-1',
      category: 'ai_ban',
      pattern: `${AI}${GAP}\\b(?:banned|prohibited|forbidden|not (?:accepted|allowed|permitted|welcome)|disallowed)\\b`,
    },
    {
      id: 'ai-ban-2',
      category: 'ai_ban',
      pattern: `\\b(?:no|ban|reject|do not (?:accept|submit|use)|don't (?:accept|submit|use))\\b${GAP}${AI}`,
    },
    {
      id: 'ai-approval-1',
      category: 'ai_approval',
      pattern: `${AI}${GAP}\\b(?:requires?|needs?|must obtain)\\b${GAP}\\b(?:approval|permission)\\b`,
    },
    {
      id: 'ai-approval-2',
      category: 'ai_approval',
      pattern: `\\b(?:approval|permission)\\b${GAP}\\b(?:required|before)\\b${GAP}${AI}`,
    },
    {
      id: 'ai-disclosure-1',
      category: 'ai_disclosure',
      pattern: `\\b(?:must|require[ds]?|please)\\b${GAP}\\b(?:disclos[e]|disclosure|declare|declaration)\\b${GAP}${AI}`,
    },
    {
      id: 'ai-disclosure-2',
      category: 'ai_disclosure',
      pattern: `${AI}${GAP}\\b(?:must be disclosed|disclosure (?:is )?required)\\b`,
    },
    {
      id: 'ai-welcome-1',
      category: 'ai_welcome',
      pattern: `${AI}${GAP}(?<!not )(?<!not  )\\b(?:welcome[d]?|encouraged|allowed|accepted|permitted)\\b`,
    },
    {
      id: 'ai-welcome-2',
      category: 'ai_welcome',
      pattern: `(?<!not )(?<!don't )\\b(?:welcome|encourage|accept|allow|permit)\\b${GAP}${AI}`,
    },
    {
      id: 'assignment-required-1',
      category: 'assignment_required',
      pattern:
        '\\b(?:assignment (?:is )?required|must be assigned|must (?:get|obtain|request) assignment|request assignment before)\\b',
    },
    {
      id: 'assignment-optional-1',
      category: 'assignment_optional',
      pattern:
        '\\b(?:assignment (?:is )?(?:not required|optional)|no assignment (?:is )?(?:required|needed))\\b',
    },
    {
      id: 'discussion-first-1',
      category: 'discussion_first',
      pattern:
        '\\b(?:discuss|discussion|open an issue|contact (?:a |the )?maintainer)\\b[^.!?\\n]{0,100}\\b(?:before|first|prior to)\\b[^.!?\\n]{0,100}\\b(?:PR|pull request|contribut(?:ing|ion))s?\\b',
    },
    {
      id: 'direct-pr-1',
      category: 'direct_pr',
      pattern:
        '\\b(?:direct (?:PRs|pull requests) (?:are )?(?:welcome[d]?|encouraged|accepted)|(?:feel free to|you (?:may|can)) (?:open|submit|send) (?:a )?(?:PR|pull request))\\b',
    },
    {
      id: 'draft-required-1',
      category: 'draft_required',
      pattern:
        '\\b(?:must|require[ds]?|please)\\b[^.!?\\n]{0,100}\\bdraft\\b|\\bdraft (?:PRs|pull requests) (?:are )?required\\b',
    },
    {
      id: 'template-fixed-1',
      category: 'template_fixed',
      pattern:
        "\\b(?:(?:do not|don't|must not) (?:modify|change|alter) (?:the |this )?(?:PR |pull request )?template|no (?:extra|additional) sections|(?:extra|additional) sections (?:are )?(?:not allowed|forbidden)|(?:keep|leave) (?:the |this )?template (?:unchanged|unmodified))\\b",
    },
    {
      id: 'baseline-permitted-1',
      category: 'baseline_permitted',
      pattern:
        '\\b(?:baseline|pre[- ]existing|unrelated) (?:test )?failures (?:are )?(?:permitted|allowed|acceptable)\\b',
    },
  ].map((rule) => Object.freeze(rule as PolicyRule))
);

/** Any AI mention without a recognized rule is ambiguous, not silence. */
export const POLICY_AI_MENTION = AI;
