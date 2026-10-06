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
  '\\bsk-',
  'bearer\\s',
  'authorization[ \\t]*:\\s*token\\s',
]);
const credentialPattern = new RegExp(SECRET_PATTERNS.join('|'), 'i');

/** Reject even prefix-only tokens. Never include input in the diagnostic. */
export function assertNoSecrets(value: string): void {
  if (credentialPattern.test(value)) throw new SecretRedactionError();
}
