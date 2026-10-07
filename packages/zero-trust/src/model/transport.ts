import { assertNoSecrets } from '../redaction';
import { isRecord } from '../state';
import { ModelError } from './adapter';

/** Shared controller credential policy; no imports of GitHub authority. */
export function assertModelKeyEnv(name: string): void {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
    /^(?:ZTFC_|GIT_)/u.test(name) ||
    ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_CLIENT_SECRET'].includes(name)
  )
    throw new ModelError('invalid_request');
}
export function readModelKey(name: string, restricted = false): string {
  // Validate exact header bytes: fetch normalization must not evade key-echo detection.
  // Refuse accidental controller configuration selecting GitHub write authority.
  const key = process.env[name];
  if (
    !key ||
    !/^[\x21-\x7e]+$/u.test(key) ||
    /^(?:gh[pousr]_|github_pat_)/u.test(key) ||
    (restricted && !/^[A-Za-z0-9_-]{8,}$/u.test(key))
  )
    throw new ModelError('model_unavailable');
  return key;
}
export function modelEndpoint(endpoint: string, allowLoopbackHttp = false): URL {
  const url = new URL(endpoint);
  assertNoSecrets(endpoint);
  if (
    url.username ||
    url.password ||
    endpoint.includes('?') ||
    endpoint.includes('#') ||
    (url.protocol !== 'https:' &&
      !(
        allowLoopbackHttp &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new ModelError('invalid_request');
  return url;
}
export function containsModelKey(value: unknown, key: string): boolean {
  if (typeof value === 'string') return value.includes(key);
  if (Array.isArray(value)) return value.some((item) => containsModelKey(item, key));
  if (isRecord(value))
    return Object.entries(value).some(
      ([name, item]) => name.includes(key) || containsModelKey(item, key)
    );
  return false;
}
/** Guard recursive secret/key scans against adversarial JSON nesting. */
export function modelValueWithinDepth(value: unknown): boolean {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (stack.length) {
    const item = stack.pop() as { value: unknown; depth: number };
    if (item.depth > 256) return false;
    const children = Array.isArray(item.value)
      ? item.value
      : isRecord(item.value)
        ? Object.values(item.value)
        : [];
    for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}
/** Deadline races live in the caller; cancellation must never await a stalled tee. */
export async function readBoundedModelBody(
  response: Response,
  signal: AbortSignal | undefined,
  maxBytes: number
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      signal?.throwIfAborted();
      if (part.done) return Buffer.concat(chunks);
      bytes += part.value.byteLength;
      if (bytes > maxBytes) return null;
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}
