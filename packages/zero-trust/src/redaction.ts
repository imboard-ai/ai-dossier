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
  'sk-[A-Za-z0-9_-]{8,}',
  '\\bsk-',
  'bearer\\s',
  'authorization[ \\t]*:\\s*token\\s',
]);
const credentialPattern = new RegExp(SECRET_PATTERNS.join('|'), 'i');
// Recognize literal JSON/shell whitespace escapes without evaluating input.
// A single linear pass also detects headers stored inside serialized command text.
const escapedWhitespace = /\\(?:[tnrvf]|x(?:09|0[abcd]|20)|u(?:0009|000[abcd]|0020))/gi;

/** Reject even prefix-only tokens. Never include input in the diagnostic. */
export function assertNoSecrets(value: string): void {
  if (
    credentialPattern.test(value) ||
    credentialPattern.test(value.replace(escapedWhitespace, ' '))
  )
    throw new SecretRedactionError();
}
