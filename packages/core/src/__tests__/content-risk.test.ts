import { describe, expect, it } from 'vitest';
import { assessContentRisk } from '../risk-assessment';
import type { DossierFrontmatter } from '../types';

describe('assessContentRisk', () => {
  it('should return low risk for body with no URLs', () => {
    const fm: DossierFrontmatter = { title: 'Test', version: '1.0.0' };
    const result = assessContentRisk(fm, '# Title\n\nNo URLs here.');
    expect(result.level).toBe('low');
    expect(result.issues).toHaveLength(0);
    expect(result.undeclaredUrls).toHaveLength(0);
  });

  it('should escalate to medium for undeclared URLs', () => {
    const fm: DossierFrontmatter = { title: 'Test', version: '1.0.0' };
    const body = 'Download from https://cdn.real-site.com/file.js';
    const result = assessContentRisk(fm, body);
    expect(result.level).toBe('medium');
    expect(result.undeclaredUrls).toContain('https://cdn.real-site.com/file.js');
  });

  it('should not flag URLs that are declared', () => {
    const fm: DossierFrontmatter = {
      title: 'Test',
      version: '1.0.0',
      external_references: [
        {
          url: 'https://cdn.real-site.com/file.js',
          description: 'CDN file',
          type: 'download',
          trust_level: 'trusted',
          required: true,
        },
      ],
      risk_factors: ['network_access'],
    };
    const body = 'Download from https://cdn.real-site.com/file.js';
    const result = assessContentRisk(fm, body);
    expect(result.undeclaredUrls).toHaveLength(0);
  });

  it('should escalate to high for script with unknown trust', () => {
    const fm: DossierFrontmatter = {
      title: 'Test',
      version: '1.0.0',
      external_references: [
        {
          url: 'https://cdn.real-site.com/setup.sh',
          description: 'Setup script',
          type: 'script',
          trust_level: 'unknown',
          required: true,
        },
      ],
      risk_factors: ['network_access'],
    };
    const body = 'Run https://cdn.real-site.com/setup.sh';
    const result = assessContentRisk(fm, body);
    expect(result.level).toBe('high');
    expect(result.issues.some((i) => i.includes('unknown trust level'))).toBe(true);
  });

  it('should warn when body has URLs but risk_factors missing network_access', () => {
    const fm: DossierFrontmatter = {
      title: 'Test',
      version: '1.0.0',
      external_references: [
        {
          url: 'https://cdn.real-site.com/file.js',
          description: 'CDN',
          type: 'download',
          trust_level: 'trusted',
          required: true,
        },
      ],
      risk_factors: [],
    };
    const body = 'Download from https://cdn.real-site.com/file.js';
    const result = assessContentRisk(fm, body);
    expect(result.issues.some((i) => i.includes('network_access'))).toBe(true);
  });
});
