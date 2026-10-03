/**
 * Which issue-comment authors an artifact reader may act on (#808).
 *
 * `plan:v1` and `runstate:v1` artifacts are ordinary issue comments, so anyone who can
 * comment can forge one. GitHub's `author_association` for the comment is the check every
 * reader shares: repo OWNER, org MEMBER, or COLLABORATOR. It is a coarse "belongs to the
 * project" signal, NOT a proof of write permission (a MEMBER need not have push access; a
 * COLLABORATOR may be read/triage only) — it needs no extra API call and is what `gh issue
 * view --json comments` already returns.
 *
 * GitHub's `CommentAuthorAssociation` has no BOT value, and a comment posted with a GitHub
 * App / Actions token reports NONE or CONTRIBUTOR: such artifacts are NOT trusted. The
 * fleet posts as the operator's own user (OWNER/MEMBER), so no allowlist is needed.
 */
export const TRUSTED_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set([
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
]);

/**
 * True only for a string naming a trusted association. Fails closed: an absent field (a gh
 * that does not report it) or any non-string is untrusted.
 */
export function isTrustedAuthorAssociation(value: unknown): boolean {
  return typeof value === 'string' && TRUSTED_AUTHOR_ASSOCIATIONS.has(value);
}
