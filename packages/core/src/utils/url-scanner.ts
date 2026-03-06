import type { DossierFrontmatter, ExternalReference } from '../types';

const URL_REGEX = /https?:\/\/[^\s"'<>\])|,;`]+/g;

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
  const cleaned = matches.map((url) => url.replace(/[.)]+$/, ''));
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

  if (Array.isArray(frontmatter.tools_required)) {
    for (const tool of frontmatter.tools_required as Array<Record<string, unknown>>) {
      if (typeof tool.install_url === 'string') {
        urls.push(tool.install_url);
      }
    }
  }

  if (typeof frontmatter.homepage === 'string') {
    urls.push(frontmatter.homepage as string);
  }

  if (typeof frontmatter.repository === 'string') {
    urls.push(frontmatter.repository as string);
  }

  if (Array.isArray(frontmatter.authors)) {
    for (const author of frontmatter.authors as Array<Record<string, unknown>>) {
      if (typeof author.url === 'string') {
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
