export class SecretRedactionError extends Error {
  constructor() {
    super('Record contains a prohibited credential pattern');
    this.name = 'SecretRedactionError';
  }
}

/** Shared case-insensitive policy. Strings prevent callers mutating RegExp state. */
export const SECRET_PATTERNS: readonly string[] = Object.freeze([
  'gh[pousr]_',
  'github_pat_',
  'sk-ant-',
  'sk-proj-',
  'sk-[A-Za-z0-9_-]{32,}',
  '(?:\\b|_)sk-',
  'bearer\\s',
  'authorization[ \\t]*:\\s*token\\s',
]);
const credentialPattern = new RegExp(SECRET_PATTERNS.join('|'), 'i');
// Recognize literal JSON/shell whitespace escapes without evaluating input.
// A single linear pass also detects headers stored inside serialized command text.
const escapedWhitespace =
  /(?<!\\)\\+(?:[tnrvfTNRVF]|[0-7]{1,3}|[xX][0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8})/g;
function normalizeWhitespace(sequence: string): string {
  const payload = sequence.replace(/^\\+/, '');
  if (/^[tnrvf]$/i.test(payload)) return ' ';
  const octal = /^[0-7]/.test(payload);
  const code = Number.parseInt(payload.slice(octal ? 0 : 1), octal ? 8 : 16);
  return [9, 10, 11, 12, 13, 32].includes(code) ? ' ' : sequence;
}

/** Reject even prefix-only tokens. Never include input in the diagnostic. */
export function assertNoSecrets(value: string): void {
  if (
    credentialPattern.test(value) ||
    credentialPattern.test(
      value.replace(/(?<!\\)\\+\r?\n/g, '').replace(escapedWhitespace, normalizeWhitespace)
    )
  )
    throw new SecretRedactionError();
}
