import { describe, expect, it } from 'vitest';
import { calculateChecksum } from '../checksum';
import { formatDossierContent } from '../formatter';

function makeDossier(frontmatter: Record<string, unknown>, body = '# Test\n\n## Section\nContent') {
  const json = JSON.stringify(frontmatter, null, 2);
  return `---dossier\n${json}\n---\n${body}`;
}

const baseFrontmatter = {
  dossier_schema_version: '1.0.0',
  title: 'Test Dossier',
  version: '1.0.0',
  protocol_version: '1.0',
  status: 'Stable',
  objective: 'Test formatting',
  risk_level: 'low',
  requires_approval: false,
  checksum: {
    algorithm: 'sha256',
    hash: '',
  },
};

describe('formatDossierContent', () => {
  describe('key sorting', () => {
    it('should sort frontmatter keys in conventional order', () => {
      const body = '# Test\n\n## Section\nContent';
      const fm = {
        version: '1.0.0',
        title: 'Test',
        dossier_schema_version: '1.0.0',
        checksum: { algorithm: 'sha256', hash: calculateChecksum(body) },
        objective: 'Test formatting',
        status: 'Stable',
        protocol_version: '1.0',
        risk_level: 'low',
        requires_approval: false,
      };
      const content = makeDossier(fm, body);
      const result = formatDossierContent(content);

      // Parse the formatted output to check key order
      const match = result.formatted.match(/^---dossier\n([\s\S]*?)\n---/);
      const formatted = JSON.parse(match![1]);
      const keys = Object.keys(formatted);

      // dossier_schema_version should be first
      expect(keys[0]).toBe('dossier_schema_version');
      // title before version
      expect(keys.indexOf('title')).toBeLessThan(keys.indexOf('version'));
      // checksum should be last
      expect(keys[keys.length - 1]).toBe('checksum');
    });

    it('should not sort keys when sortKeys is false', () => {
      const body = '# Test\n\n## Section\nContent';
      const fm = {
        version: '1.0.0',
        title: 'Test',
        checksum: { algorithm: 'sha256', hash: calculateChecksum(body) },
      };
      const content = makeDossier(fm, body);
      const result = formatDossierContent(content, { sortKeys: false });

      const match = result.formatted.match(/^---dossier\n([\s\S]*?)\n---/);
      const formatted = JSON.parse(match![1]);
      const keys = Object.keys(formatted);

      expect(keys[0]).toBe('version');
      expect(keys[1]).toBe('title');
    });
  });

  describe('indentation', () => {
    it('should use 2-space indent by default', () => {
      const body = '# Test\n\n## Section\nContent';
      const content = makeDossier(
        { title: 'Test', checksum: { algorithm: 'sha256', hash: calculateChecksum(body) } },
        body
      );
      const result = formatDossierContent(content);
      expect(result.formatted).toContain('  "title"');
    });

    it('should respect custom indent', () => {
      const body = '# Test\n\n## Section\nContent';
      const content = makeDossier(
        { title: 'Test', checksum: { algorithm: 'sha256', hash: calculateChecksum(body) } },
        body
      );
      const result = formatDossierContent(content, { indent: 4 });
      expect(result.formatted).toContain('    "title"');
    });
  });

  describe('trailing whitespace', () => {
    it('should trim trailing whitespace from body lines', () => {
      const body = '# Test   \n\n## Section  \nContent   ';
      const content = makeDossier(baseFrontmatter, body);
      const result = formatDossierContent(content);

      // Extract the body from the formatted output
      const parts = result.formatted.split('---\n');
      const formattedBody = parts[parts.length - 1];

      expect(formattedBody).not.toMatch(/[ \t]+\n/);
      expect(formattedBody).toContain('# Test\n');
      expect(formattedBody).toContain('## Section\n');
    });
  });

  describe('final newline', () => {
    it('should ensure file ends with newline', () => {
      const body = '# Test\n\n## Section\nContent';
      const content = `---dossier\n${JSON.stringify(baseFrontmatter, null, 2)}\n---\n${body}`;
      const result = formatDossierContent(content);
      expect(result.formatted.endsWith('\n')).toBe(true);
    });
  });

  describe('checksum update', () => {
    it('should update checksum after formatting', () => {
      const body = '# Test\n\n## Section\nContent';
      const fm = {
        ...baseFrontmatter,
        checksum: {
          algorithm: 'sha256',
          hash: 'oldhash0000000000000000000000000000000000000000000000000000000000',
        },
      };
      const content = makeDossier(fm, body);
      const result = formatDossierContent(content);

      const match = result.formatted.match(/^---dossier\n([\s\S]*?)\n---/);
      const formatted = JSON.parse(match![1]);
      const expectedHash = calculateChecksum(body);
      expect(formatted.checksum.hash).toBe(expectedHash);
    });

    it('should not update checksum when disabled', () => {
      const body = '# Test\n\n## Section\nContent';
      const oldHash = 'oldhash0000000000000000000000000000000000000000000000000000000000';
      const fm = {
        ...baseFrontmatter,
        checksum: { algorithm: 'sha256', hash: oldHash },
      };
      const content = makeDossier(fm, body);
      const result = formatDossierContent(content, { updateChecksum: false });

      const match = result.formatted.match(/^---dossier\n([\s\S]*?)\n---/);
      const formatted = JSON.parse(match![1]);
      expect(formatted.checksum.hash).toBe(oldHash);
    });
  });

  describe('changed detection', () => {
    it('should report changed=false when content is already formatted', () => {
      const body = '# Test\n\n## Section\nContent';
      const fm = {
        ...baseFrontmatter,
        checksum: { algorithm: 'sha256', hash: calculateChecksum(body) },
      };
      const content = makeDossier(fm, body);
      // Format once to get canonical form
      const first = formatDossierContent(content);
      // Format again — should be unchanged
      const second = formatDossierContent(first.formatted);
      expect(second.changed).toBe(false);
    });

    it('should report changed=true when content needs formatting', () => {
      const body = '# Test   \n\n## Section\nContent';
      const content = makeDossier(baseFrontmatter, body);
      const result = formatDossierContent(content);
      expect(result.changed).toBe(true);
    });
  });

  describe('unknown keys', () => {
    it('should place unknown keys alphabetically but before checksum/signature', () => {
      const body = '# Test\n\n## Section\nContent';
      const fm = {
        title: 'Test',
        dossier_schema_version: '1.0.0',
        custom_field_b: 'b',
        custom_field_a: 'a',
        checksum: { algorithm: 'sha256', hash: calculateChecksum(body) },
      };
      const content = makeDossier(fm, body);
      const result = formatDossierContent(content);

      const match = result.formatted.match(/^---dossier\n([\s\S]*?)\n---/);
      const formatted = JSON.parse(match![1]);
      const keys = Object.keys(formatted);

      const aIdx = keys.indexOf('custom_field_a');
      const bIdx = keys.indexOf('custom_field_b');
      const checksumIdx = keys.indexOf('checksum');

      // custom_field_a before custom_field_b (alphabetical)
      expect(aIdx).toBeLessThan(bIdx);
      // Both before checksum
      expect(bIdx).toBeLessThan(checksumIdx);
    });
  });
});
