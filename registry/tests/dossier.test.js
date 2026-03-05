const { parseFrontmatter, validateDossier } = require('../lib/dossier');

describe('parseFrontmatter', () => {
  it('should extract top-level name correctly', () => {
    const content = `---
name: my-dossier
title: My Dossier
version: 1.0.0
---
# Content`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe('my-dossier');
  });

  it('should not be confused by nested name fields in tools_required', () => {
    const content = `---
name: my-dossier
title: My Dossier
version: 1.0.0
tools_required:
- check_command: git --version
  name: git
  version: '>=2.5.0'
---
# Content`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe('my-dossier');
    expect(result.frontmatter.tools_required[0].name).toBe('git');
  });

  it('should handle authors with nested name fields', () => {
    const content = `---
authors:
- name: John Doe
name: my-dossier
title: My Dossier
version: 1.0.0
---
# Content`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe('my-dossier');
  });

  it('should handle multiline arrays (improvement over old parser)', () => {
    const content = `---
name: test
title: Test
version: 1.0.0
tags:
  - javascript
  - nodejs
---
# Content`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.tags).toEqual(['javascript', 'nodejs']);
  });

  it('should throw on missing frontmatter', () => {
    expect(() => parseFrontmatter('# Just content')).toThrow(/Missing or malformed frontmatter/);
  });

  it('should throw on invalid YAML', () => {
    const content = `---
name: test
invalid: yaml: here:
---
# Content`;
    expect(() => parseFrontmatter(content)).toThrow(/Invalid frontmatter/);
  });

  it('should handle ---dossier delimiter', () => {
    const content = `---dossier
name: my-dossier
title: My Dossier
version: 1.0.0
---
# Content`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe('my-dossier');
    expect(result.frontmatter.title).toBe('My Dossier');
    expect(result.frontmatter.version).toBe('1.0.0');
  });

  it('should handle ---dossier with nested name fields', () => {
    const content = `---dossier
name: my-dossier
title: My Dossier
version: 1.0.0
tools_required:
- check_command: git --version
  name: git
---
# Content`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe('my-dossier');
    expect(result.frontmatter.tools_required[0].name).toBe('git');
  });

  it('should handle ---json frontmatter', () => {
    const content = `---json
{"name": "my-dossier", "title": "My Dossier", "version": "1.0.0"}
---
# Content`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe('my-dossier');
    expect(result.frontmatter.title).toBe('My Dossier');
    expect(result.frontmatter.version).toBe('1.0.0');
  });

  it('should extract body content correctly', () => {
    const content = `---
name: test
title: Test
version: 1.0.0
---
# My Content

This is the body.`;
    const result = parseFrontmatter(content);
    expect(result.body).toContain('# My Content');
    expect(result.body).toContain('This is the body.');
  });

  it('should throw on null input', () => {
    expect(() => parseFrontmatter(null)).toThrow();
  });

  it('should throw on undefined input', () => {
    expect(() => parseFrontmatter(undefined)).toThrow();
  });

  it('should throw on empty string input', () => {
    expect(() => parseFrontmatter('')).toThrow(/Missing or malformed frontmatter/);
  });
});

describe('validateDossier', () => {
  it('should pass valid frontmatter', () => {
    const result = validateDossier({
      name: 'my-dossier',
      title: 'My Dossier',
      version: '1.0.0',
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should fail on missing required fields', () => {
    const result = validateDossier({});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: name');
    expect(result.errors).toContain('Missing required field: title');
    expect(result.errors).toContain('Missing required field: version');
  });

  it('should fail on non-string name', () => {
    const result = validateDossier({
      name: 123,
      title: 'Test',
      version: '1.0.0',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Name must be a string, got number/);
  });

  it('should fail on non-string version', () => {
    const result = validateDossier({
      name: 'test',
      title: 'Test',
      version: 1.0,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Version must be a string, got number/);
  });

  it('should fail on invalid name format', () => {
    const result = validateDossier({
      name: 'Invalid-Name',
      title: 'Test',
      version: '1.0.0',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid name "Invalid-Name"/);
  });

  it('should fail on invalid version format', () => {
    const result = validateDossier({
      name: 'test',
      title: 'Test',
      version: '1.0',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Invalid version "1.0"/);
  });
});
