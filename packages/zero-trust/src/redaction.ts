export class SecretRedactionError extends Error {
  constructor() {
    super('Record contains a prohibited credential pattern');
    this.name = 'SecretRedactionError';
  }
}

/** Reject even prefix-only tokens. Never include input in the diagnostic. */
export function assertNoSecrets(value: string): void {
  if (/(?:ghp_|github_pat_|ghs_|sk-ant-|bearer\s)/i.test(value)) throw new SecretRedactionError();
}
