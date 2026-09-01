/**
 * Accept either a bare JSON array or the single-key wrapper object CLIs emit
 * (`gh issue view --json comments` → `{"comments":[...]}` (#496),
 * batch-prep's `--from-manifest` → `{"entries":[...]}`). Returns null when
 * `value` is neither shape.
 */
export function unwrapList(value: unknown, key: string): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value !== 'object') return null;
  const inner = (value as Record<string, unknown>)[key];
  return Array.isArray(inner) ? inner : null;
}
