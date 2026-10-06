/** Untrusted text rules for contributor hand-off content (PRD §5.7). */
import type { CommandEvidence } from '../receipt/schema';
import { assertNoSecrets } from '../redaction';

export class HandoffError extends Error {
  constructor(readonly code: string) {
    super(`Zero-trust hand-off rejected: ${code}`);
    this.name = 'HandoffError';
  }
}

const SUCCESS_CLAIM = /all\s+tests\s+passed/giu;
const PROMOTION: readonly RegExp[] = [
  /\bstar(?:ring)?\s+(?:this|the|our|my)\s+(?:repo|repository|project)\b/iu,
  /\b(?:give|leave)\s+(?:us|it|me|this)\s+a\s+star\b/iu,
  /\bplease\s+star\b/iu,
  /[⭐\u{1f31f}]/u,
  /\bsponsor\s+(?:us|me|this|the\s+project)\b/iu,
  /\bbuy\s+me\s+a\s+coffee\b/iu,
  /\bfollow\s+(?:us|me)\s+on\b/iu,
  /\bsubscribe\s+to\s+(?:our|my)\b/iu,
  /\bcheck\s+out\s+(?:our|my)\b/iu,
];

/** Model or repository text: bounded, single-sourced, unable to forge a run marker
 * or a blanket success claim. Newlines survive only where `multiline` allows them. */
export function untrustedText(value: unknown, maxLength: number, multiline = true): string {
  if (typeof value !== 'string') throw new HandoffError('invalid_text');
  let text = value.replace(/\r\n?/gu, '\n');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip control characters from untrusted text.
  text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/gu, '');
  text = multiline ? text.trim() : text.replace(/\s+/gu, ' ').trim();
  text = text
    .replace(/<!--/gu, '&lt;!--')
    .replace(/--!?>/gu, '--&gt;')
    .replace(SUCCESS_CLAIM, '[untrusted success claim]');
  if (!text || text.length > maxLength) throw new HandoffError('invalid_text');
  assertNoSecrets(text);
  return text;
}

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"'`\r\n]/gu,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '`': '&#96;',
        '\r': '&#13;',
        '\n': '&#10;',
      })[c] as string
  );
}

/** Receipt vocabulary: only `passed` counts, and only when a required command exists. */
export function allRequiredPassed(commands: readonly CommandEvidence[]): boolean {
  const required = commands.filter((c) => c.required);
  return required.length > 0 && required.every((c) => c.status === 'passed');
}

/** No star requests or advertising; a blanket success claim needs passing evidence. */
export function assertContentPolicy(text: string, commands?: readonly CommandEvidence[]): void {
  if (PROMOTION.some((pattern) => pattern.test(text)))
    throw new HandoffError('promotional_content');
  if (/all\s+tests\s+passed/iu.test(text) && !(commands && allRequiredPassed(commands)))
    throw new HandoffError('unsupported_success_claim');
}
