import type { DossierFrontmatter, ExternalReference } from '../types';

// Matches http/https URLs, stopping at whitespace and common delimiters
// that typically surround URLs in markdown/text (quotes, angle brackets,
// parentheses, commas, semicolons, backticks).
const URL_REGEX = /https?:\/\/[^\s"'<>\])|,;`]+/g;

// Strip trailing periods and closing parens that are often part of
// surrounding prose rather than the URL itself (e.g. "see https://x.com).")
const TRAILING_PUNCTUATION = /[.)]+$/;

const PLACEHOLDER_PATTERNS = [
  /^https?:\/\/example\.(com|org|net)/,
  /^https?:\/\/localhost/,
  /^https?:\/\/127\.0\.0\.\d/,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/0\.0\.0\.0/,
  /<[^>]+>/,
  /\$\{[^}]+\}/,
  /\{\{[^}]+\}\}/,
];

export function isPlaceholderUrl(url: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(url));
}

export function scanBodyForUrls(body: string): string[] {
  const matches = body.match(URL_REGEX) || [];
  const cleaned = matches.map((url) => url.replace(TRAILING_PUNCTUATION, ''));
  const unique = [...new Set(cleaned)];
  return unique.filter((url) => !isPlaceholderUrl(url));
}

export function collectDeclaredUrls(frontmatter: DossierFrontmatter): string[] {
  const urls: string[] = [];

  if (frontmatter.external_references) {
    for (const ref of frontmatter.external_references) {
      urls.push(ref.url);
    }
  }

  if (frontmatter.tools_required) {
    for (const tool of frontmatter.tools_required) {
      if (tool.install_url) {
        urls.push(tool.install_url);
      }
    }
  }

  if (typeof frontmatter.homepage === 'string') {
    urls.push(frontmatter.homepage);
  }

  if (typeof frontmatter.repository === 'string') {
    urls.push(frontmatter.repository);
  }

  if (frontmatter.authors) {
    for (const author of frontmatter.authors) {
      if (author.url) {
        urls.push(author.url);
      }
    }
  }

  return urls;
}

export function isUrlCoveredByDeclared(url: string, declaredUrls: string[]): boolean {
  return declaredUrls.some((declared) => url === declared || url.startsWith(declared));
}

export function findUndeclaredUrls(bodyUrls: string[], declaredUrls: string[]): string[] {
  return bodyUrls.filter((url) => !isUrlCoveredByDeclared(url, declaredUrls));
}

export function findStaleReferences(
  externalRefs: ExternalReference[],
  bodyUrls: string[]
): ExternalReference[] {
  return externalRefs.filter(
    (ref) => !bodyUrls.some((bodyUrl) => bodyUrl === ref.url || bodyUrl.startsWith(ref.url))
  );
}
