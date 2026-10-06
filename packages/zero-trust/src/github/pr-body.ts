/** Prefilled pull request content (PRD §5.7). Commands and results come from the parsed
 * receipt, never from model text; model and repository text is untrusted and bounded. */
import type { IntentInput } from '../intents';
import { receiptDigest } from '../receipt/issue';
import { renderReceipt } from '../receipt/render';
import { type CommandStatus, parseReceipt } from '../receipt/schema';
import { handoffMarker, MAX_BODY_LENGTH, prTitle } from './handoff';
import { assertContentPolicy, escapeHtml, HandoffError, untrustedText } from './text';

export const LLM_DISCLOSURE_URL = 'https://github.com/imboard-ai/ai-dossier';

export type RegressionEvidence =
  | {
      readonly command: string;
      readonly baseStatus: CommandStatus;
      readonly candidateStatus: CommandStatus;
    }
  | { readonly manualSteps: string };

export interface PrContentInput {
  readonly intent: IntentInput;
  readonly issue: number;
  readonly title: string;
  readonly cause: string;
  readonly scope: string;
  /** Controller-verified receipt for `intent.candidateSha`. */
  readonly receipt: unknown;
  /** Whether the upstream template/policy allows the collapsible receipt block. */
  readonly receiptAllowed: boolean;
  readonly regression: RegressionEvidence;
  /** Failures also present on the base; listed only when repository policy permits it. */
  readonly baselineFailures?: { readonly permitted: boolean; readonly failures: readonly string[] };
  readonly limitations: readonly string[];
  /** Upstream pull request template, if any; untrusted. */
  readonly template?: string;
}

export interface PrContent {
  readonly title: string;
  readonly body: string;
}

const STATUSES: readonly CommandStatus[] = ['passed', 'failed', 'inconclusive', 'skipped'];

function status(value: unknown): CommandStatus {
  if (!STATUSES.includes(value as CommandStatus)) throw new HandoffError('invalid_evidence');
  return value as CommandStatus;
}

function code(text: string): string {
  return `<code>${escapeHtml(untrustedText(text, 4096, false))}</code>`;
}

export function buildPrContent(input: PrContentInput): PrContent {
  if (input.intent?.operationKind !== 'pr_create') throw new HandoffError('not_a_handoff');
  const marker = handoffMarker(input.intent);
  const receipt = parseReceipt(input.receipt);
  if (receipt.candidateSha !== input.intent.candidateSha)
    throw new HandoffError('receipt_candidate_mismatch');
  if (!Number.isSafeInteger(input.issue) || input.issue < 1 || receipt.issue !== input.issue)
    throw new HandoffError('invalid_issue');
  const title = prTitle(input.title);
  const sha = receipt.candidateSha;
  const commands = receipt.commands;
  // Stricter than the content check: no blanket claim while anything was not `passed`.
  const everyPassed = commands.every((c) => c.status === 'passed');

  const baseline = input.baselineFailures;
  if (baseline && baseline.failures.length > 0 && baseline.permitted !== true)
    throw new HandoffError('baseline_failures_not_permitted');
  const limitations = input.limitations.map((l) => `- ${untrustedText(l, 1000, false)}`);
  const regression = input.regression;

  const sections = [
    `Fixes #${input.issue}`,
    '',
    '## Cause',
    untrustedText(input.cause, 4000),
    '',
    '## Scope',
    untrustedText(input.scope, 4000),
    '',
    '## LLM disclosure',
    `This contribution used substantial LLM assistance, orchestrated with [ai-dossier](${LLM_DISCLOSURE_URL}). ` +
      `Verification results below apply to commit \`${sha}\`. ` +
      'I reviewed this pull request before submitting it from my own account.',
    '',
    '## Verification',
    `Commands run against \`${sha}\` (status, exit status, test suites counted):`,
    ...commands.map(
      (c) =>
        `- ${code(c.command)}${c.required ? '' : ' (optional)'}: ${c.status}; exit=${c.exitStatus}; suites=${c.suites}`
    ),
    '',
    everyPassed
      ? 'All tests passed.'
      : 'Not every check passed; the statuses above are the complete record.',
    '',
    '## Regression evidence',
    'manualSteps' in regression
      ? `Manual reproduction (no automated regression): ${untrustedText(regression.manualSteps, 2000, false)}`
      : `- ${code(regression.command)}: base \`${receipt.baseSha}\` ${status(regression.baseStatus)}; candidate ${status(regression.candidateStatus)}`,
  ];
  if (baseline && baseline.failures.length > 0)
    sections.push(
      '',
      '## Baseline failures (also failing on the base; permitted by repository policy)',
      ...baseline.failures.map((f) => `- ${untrustedText(f, 500, false)}`)
    );
  sections.push('', '## Limitations', ...(limitations.length ? limitations : ['- None known.']));
  sections.push(
    '',
    input.receiptAllowed
      ? renderReceipt(receipt)
      : `Verification receipt retained by the contributor (SHA-256 \`${receiptDigest(receipt)}\`).`
  );
  if (input.template !== undefined)
    sections.push('', '---', '', untrustedText(input.template, 16000));
  sections.push('', marker);

  const body = sections.join('\n');
  if (body.length > MAX_BODY_LENGTH) throw new HandoffError('invalid_body');
  assertContentPolicy(`${title}\n${body}`, commands);
  return Object.freeze({ title, body });
}
