import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDossierContent, parseDossierFile, validateFrontmatter } from '../parser';

describe('parseDossierContent', () => {
  it('should parse valid dossier with JSON frontmatter', () => {
    const content = `---dossier
{
  "dossier_schema_version": "1.0.0",
  "version": "1.0.0",
  "title": "Test Dossier",
  "objective": "Test parsing",
  "risk_level": "low"
}
---
# Body content
This is the markdown body.`;

    const result = parseDossierContent(content);

    expect(result.frontmatter.version).toBe('1.0.0');
    expect(result.frontmatter.title).toBe('Test Dossier');
    expect(result.body).toContain('# Body content');
    expect(result.body).toContain('This is the markdown body.');
    expect(result.raw).toBe(content);
  });

  it('should parse dossier with complex frontmatter', () => {
    const content = `---dossier
{
  "dossier_schema_version": "1.0.0",
  "version": "1.0.0",
  "title": "Complex Test",
  "objective": "Test complex parsing",
  "risk_level": "high",
  "risk_factors": ["data_loss", "security"],
  "destructive_operations": ["delete_files"],
  "checksum": {
    "algorithm": "sha256",
    "hash": "abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
  },
  "signature": {
    "algorithm": "ed25519",
    "signature": "sig123",
    "public_key": "key123",
    "signed_at": "2024-11-17T00:00:00Z"
  }
}
---
# Complex body
Multiple lines
With various content`;

    const result = parseDossierContent(content);

    expect(result.frontmatter.risk_level).toBe('high');
    expect(result.frontmatter.risk_factors).toEqual(['data_loss', 'security']);
    expect(result.frontmatter.destructive_operations).toEqual(['delete_files']);
    expect(result.frontmatter.checksum?.algorithm).toBe('sha256');
    expect(result.frontmatter.signature?.algorithm).toBe('ed25519');
  });

  it('should reject invalid frontmatter', () => {
    const content = `---dossier
key: [invalid
---
body`;

    expect(() => parseDossierContent(content)).toThrow('Failed to parse frontmatter');
  });

  it('should reject missing frontmatter', () => {
    const content = '# Just markdown without frontmatter';

    expect(() => parseDossierContent(content)).toThrow('Invalid dossier format');
  });

  it('should parse standard YAML frontmatter (--- delimiter)', () => {
    const content = `---
dossier_schema_version: "1.0.0"
title: YAML Dossier
version: "1.0.0"
status: Stable
---
# Body content`;

    const result = parseDossierContent(content);

    expect(result.frontmatter.title).toBe('YAML Dossier');
    expect(result.frontmatter.version).toBe('1.0.0');
    expect(result.frontmatter.status).toBe('Stable');
    expect(result.body).toContain('# Body content');
  });

  it('should parse ---dossier with YAML content', () => {
    const content = `---dossier
name: my-dossier
title: My Dossier
version: "1.0.0"
tags:
  - javascript
  - nodejs
---
# Content`;

    const result = parseDossierContent(content);

    expect(result.frontmatter.name).toBe('my-dossier');
    expect(result.frontmatter.title).toBe('My Dossier');
    expect((result.frontmatter as any).tags).toEqual(['javascript', 'nodejs']);
  });

  it('should parse ---json frontmatter', () => {
    const content = `---json
{"title": "JSON Dossier", "version": "1.0.0"}
---
# Content`;

    const result = parseDossierContent(content);

    expect(result.frontmatter.title).toBe('JSON Dossier');
    expect(result.frontmatter.version).toBe('1.0.0');
  });

  it('should handle empty body', () => {
    const content = `---dossier
{
  "dossier_schema_version": "1.0.0",
  "version": "1.0.0",
  "title": "Test"
}
---
`;

    const result = parseDossierContent(content);
    expect(result.body).toBe('');
  });

  it('should handle frontmatter with extra whitespace', () => {
    const content = `---dossier

{
  "dossier_schema_version": "1.0.0",
  "version": "1.0.0",
  "title": "Test"
}

---

# Body`;

    const result = parseDossierContent(content);
    expect(result.frontmatter.version).toBe('1.0.0');
    expect(result.body).toContain('# Body');
  });

  it('should preserve the raw content', () => {
    const content = `---dossier
{
  "title": "Test",
  "version": "1.0.0"
}
---
body`;

    const result = parseDossierContent(content);
    expect(result.raw).toBe(content);
  });

  it('should throw on null/undefined/empty input', () => {
    expect(() => parseDossierContent(null as any)).toThrow();
    expect(() => parseDossierContent(undefined as any)).toThrow();
    expect(() => parseDossierContent('')).toThrow();
  });
});

describe('parseDossierFile', () => {
  it('should read and parse a valid dossier file', () => {
    const tempDir = join(tmpdir(), `dossier-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const testFile = join(tempDir, 'test.ds.md');

    const content = `---dossier
{
  "dossier_schema_version": "1.0.0",
  "version": "1.0.0",
  "title": "File Test",
  "objective": "Test file parsing"
}
---
# Test body`;

    writeFileSync(testFile, content, 'utf8');

    const result = parseDossierFile(testFile);

    expect(result.frontmatter.title).toBe('File Test');
    expect(result.body).toContain('# Test body');

    // Cleanup
    unlinkSync(testFile);
  });

  it('should throw error for non-existent file', () => {
    const nonExistentPath = '/tmp/nonexistent-dossier.ds.md';

    expect(() => parseDossierFile(nonExistentPath)).toThrow('Dossier file not found');
  });
});

describe('validateFrontmatter', () => {
  it('should pass validation for complete valid frontmatter', () => {
    const frontmatter: any = {
      dossier_schema_version: '1.0.0',
      version: '1.0.0',
      title: 'Valid Dossier',
    };

    const errors = validateFrontmatter(frontmatter);
    expect(errors).toHaveLength(0);
  });

  it('should detect missing required fields', () => {
    const frontmatter: any = {
      version: '1.0.0',
      // Missing: dossier_schema_version, title
    };

    const errors = validateFrontmatter(frontmatter);

    expect(errors).toContain('Missing required field: dossier_schema_version');
    expect(errors).toContain('Missing required field: title');
    expect(errors).not.toContain('Missing required field: version');
  });

  it('should reject invalid risk_level', () => {
    const frontmatter: any = {
      dossier_schema_version: '1.0.0',
      version: '1.0.0',
      title: 'Test',
      risk_level: 'invalid_level',
    };

    const errors = validateFrontmatter(frontmatter);

    expect(errors).toContain(
      'Invalid risk_level: invalid_level. Must be one of: low, medium, high, critical'
    );
  });

  it('should accept all valid risk levels', () => {
    const validLevels = ['low', 'medium', 'high', 'critical'];

    for (const level of validLevels) {
      const frontmatter: any = {
        dossier_schema_version: '1.0.0',
        version: '1.0.0',
        title: 'Test',
        risk_level: level,
      };

      const errors = validateFrontmatter(frontmatter);
      expect(errors).toHaveLength(0);
    }
  });

  it('should reject invalid status', () => {
    const frontmatter: any = {
      dossier_schema_version: '1.0.0',
      version: '1.0.0',
      title: 'Test',
      status: 'invalid_status',
    };

    const errors = validateFrontmatter(frontmatter);

    expect(errors).toContain(
      'Invalid status: invalid_status. Must be one of: draft, stable, deprecated, experimental'
    );
  });

  it('should accept all valid statuses (case-insensitive)', () => {
    const validStatuses = [
      'draft',
      'stable',
      'deprecated',
      'experimental',
      'Draft',
      'Stable',
      'Deprecated',
      'Experimental',
    ];

    for (const status of validStatuses) {
      const frontmatter: any = {
        dossier_schema_version: '1.0.0',
        version: '1.0.0',
        title: 'Test',
        status,
      };

      const errors = validateFrontmatter(frontmatter);
      expect(errors).toHaveLength(0);
    }
  });

  it('should allow optional status field', () => {
    const frontmatter: any = {
      dossier_schema_version: '1.0.0',
      version: '1.0.0',
      title: 'Test',
      // status is optional
    };

    const errors = validateFrontmatter(frontmatter);
    expect(errors).toHaveLength(0);
  });
});
