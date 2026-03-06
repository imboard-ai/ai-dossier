/**
 * Safely extract a single string from a Vercel query parameter.
 * Vercel types query values as `string | string[] | undefined`;
 * this helper normalises them to `string | undefined`.
 */
export function queryString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
