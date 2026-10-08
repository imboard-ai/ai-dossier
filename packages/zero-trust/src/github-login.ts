/** Credential-free canonical human/org login predicate shared by local reporting. */
export function isGitHubLogin(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 39 &&
    /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/u.test(value)
  );
}
