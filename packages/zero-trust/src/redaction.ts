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
  /(?<!\\)\\+(?:[ \t\r\n]|[tnrvfTNRVF]|0[0-7]{1,3}|[0-7]{1,3}|[xX][0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8})/g;
function normalizeWhitespace(sequence: string): string {
  const payload = sequence.replace(/^\\+/, '');
  if (/^[ \t\r\n]|^[tnrvf]$/i.test(payload)) return ' ';
  const octal = /^[0-7]/.test(payload);
  const code = Number.parseInt(payload.slice(octal ? 0 : 1), octal ? 8 : 16);
  // printf %b permits a leading zero plus three digits; ANSI-C shell strings
  // consume only three. Reject conservatively if either interpretation is space.
  if (
    octal &&
    payload.length === 4 &&
    [9, 10, 11, 12, 13, 32].includes(Number.parseInt(payload.slice(0, 3), 8))
  )
    return ' ';
  return [9, 10, 11, 12, 13, 32].includes(code) ? ' ' : sequence;
}

/** Reject even prefix-only tokens. Never include input in the diagnostic. */
export function assertNoSecrets(value: string): void {
  const continued = value.replace(/(?<!\\)\\+\r?\n/g, '');
  if (
    credentialPattern.test(value) ||
    credentialPattern.test(continued.replace(escapedWhitespace, normalizeWhitespace)) ||
    // Serialized shell continuations can split the header name itself. Scan a
    // conservative collapsed view too, without parsing/evaluating command text.
    credentialPattern.test(
      continued
        .replace(/(?<!\\)\\{2,}(?:r\\{2,})?n/gi, '')
        .replace(escapedWhitespace, normalizeWhitespace)
    )
  )
    throw new SecretRedactionError();
}

/** Scan detached controller data, including container payloads and array metadata.
 * Cycles terminate; unsupported object payloads are refused rather than skipped. */
export function assertSecretFree(value: unknown): void {
  const seen = new Set<object>();
  const scan = (item: unknown): void => {
    if (typeof item === 'string') {
      assertNoSecrets(item);
      return;
    }
    if (typeof item !== 'object' || item === null || seen.has(item)) return;
    seen.add(item);
    if (item instanceof Map)
      for (const [key, field] of item) {
        scan(key);
        scan(field);
      }
    else if (item instanceof Set) for (const field of item) scan(field);
    else if (item instanceof String) assertNoSecrets(item.valueOf());
    else if (item instanceof Error) {
      assertNoSecrets(item.message);
      if (item.stack) assertNoSecrets(item.stack);
      scan(item.cause);
    } else if (
      !(item instanceof Date) &&
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new SecretRedactionError();
    for (const [key, field] of Object.entries(item)) {
      assertNoSecrets(key);
      scan(field);
    }
  };
  scan(value);
}
