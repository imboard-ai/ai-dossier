/**
 * GitHub URL utilities for dossier CLI
 */

/**
 * Convert GitHub blob URL to raw URL
 *
 * GitHub blob URLs return HTML pages, not raw file content.
 * This function converts them to raw.githubusercontent.com URLs.
 *
 * @example
 * // Converts blob URLs to raw URLs
 * convertGitHubBlobToRaw('https://github.com/owner/repo/blob/main/path/file.md')
 * // => 'https://raw.githubusercontent.com/owner/repo/main/path/file.md'
 *
 * @example
 * // Leaves other URLs unchanged
 * convertGitHubBlobToRaw('https://example.com/file.md')
 * // => 'https://example.com/file.md'
 */
function convertGitHubBlobToRaw(url: string): string {
  // https://github.com/OWNER/REPO/blob/BRANCH/PATH
  // -> https://raw.githubusercontent.com/OWNER/REPO/BRANCH/PATH
  const githubBlobRegex = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/;
  const match = url.match(githubBlobRegex);
  if (match) {
    const [, owner, repo, rest] = match;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}`;
  }
  return url;
}

export { convertGitHubBlobToRaw };
