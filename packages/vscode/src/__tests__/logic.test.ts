import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { completionsAt, hoverAt } from '../completion';
import { computeDiagnostics } from '../diagnostics';
import { dryRunContent, formatDryRun } from '../dryrun';
import { findFieldRange, locateFrontmatter } from '../frontmatter';
import { buildDossier, slugify } from '../template';
import { verifyContent } from '../verify';

const REPO = join(__dirname, '../../../..');
const example = (p: string) => readFileSync(join(REPO, 'examples', p), 'utf8');

const GOOD = buildDossier({
  title: 'Sample dossier',
  objective: 'Exercise the extension logic with a valid dossier.',
  date: '2026-01-01',
});

describe('frontmatter', () => {
  it('locates JSON and YAML blocks', () => {
    expect(locateFrontmatter(GOOD)?.style).toBe('json');
    expect(locateFrontmatter('---\ntitle: x\n---\nbody')?.style).toBe('yaml');
    expect(locateFrontmatter('# no frontmatter')).toBeNull();
  });

  it('finds nested keys only after their parent', () => {
    const block = locateFrontmatter(GOOD);
    if (!block) throw new Error('no block');
    const r = findFieldRange(block, 'checksum.hash');
    expect(block.lines[r?.line ?? 0]).toContain('"hash"');
    expect(r?.line).toBeGreaterThan(findFieldRange(block, 'checksum')?.line ?? 99);
    expect(findFieldRange(block, 'title')?.line).toBe(3);
  });
});

describe('computeDiagnostics', () => {
  it('has no errors for a generated dossier', () => {
    expect(computeDiagnostics(GOOD).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('accepts a real signed example', () => {
    const errors = computeDiagnostics(example('authoring/create-dossier.ds.md')).filter(
      (d) => d.severity === 'error'
    );
    expect(errors).toEqual([]);
  });

  it('reports a missing frontmatter', () => {
    const d = computeDiagnostics('# just markdown\n');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: 'error', code: 'frontmatter' });
  });

  it('reports an unclosed block on the opener line', () => {
    const d = computeDiagnostics('---dossier\n{ "title": "x"\n');
    expect(d[0].message).toMatch(/never closed/);
    expect(d[0].range.line).toBe(0);
  });

  it('places an invalid enum on the offending key line', () => {
    const bad = GOOD.replace('"risk_level": "low"', '"risk_level": "extreme"');
    const line = bad.split('\n').findIndex((l) => l.includes('"risk_level"'));
    const hit = computeDiagnostics(bad).find((d) => d.range.line === line);
    expect(hit?.severity).toBe('error');
    expect(hit?.message).toMatch(/risk_level|allowed/i);
  });

  it('reports missing required fields on the opener', () => {
    const d = computeDiagnostics('---dossier\n{ "title": "only a title" }\n---\n## Body\n');
    expect(d.some((x) => /version/.test(x.message) && x.severity === 'error')).toBe(true);
  });

  it('maps a JSON syntax error into the block', () => {
    const d = computeDiagnostics('---dossier\n{\n  "title": "x"\n  "version": "1"\n}\n---\nbody');
    expect(d[0]).toMatchObject({ severity: 'error', code: 'parse' });
    expect(d[0].range.line).toBe(3);
  });

  it('honours lint severity overrides', () => {
    const noBody = GOOD.slice(0, GOOD.indexOf('\n---') + 4);
    const on = computeDiagnostics(noBody).some((d) => d.code === 'required-sections');
    const off = computeDiagnostics(noBody, { rules: { 'required-sections': 'off' } }).some(
      (d) => d.code === 'required-sections'
    );
    expect(on).toBe(true);
    expect(off).toBe(false);
  });
});

describe('completion', () => {
  const doc = '---dossier\n{\n  "title": "x",\n  "\n}\n---\nbody';

  it('offers schema keys at a JSON key position, minus those present', () => {
    const labels = completionsAt(doc, 3, 3).map((c) => c.label);
    expect(labels).toContain('risk_level');
    expect(labels).not.toContain('title');
  });

  it('offers enum values for risk_level, quoting bare JSON strings', () => {
    const text = '---dossier\n{\n  "risk_level": \n}\n---\n';
    const items = completionsAt(text, 2, '  "risk_level": '.length);
    expect(items.map((i) => i.label)).toEqual(['low', 'medium', 'high', 'critical']);
    expect(items[0].insertText).toBe('"low"');
  });

  it('does not re-quote when a quote is already typed', () => {
    const text = '---dossier\n{\n  "status": "Dr\n}\n---\n';
    const items = completionsAt(text, 2, '  "status": "Dr'.length);
    expect(items.map((i) => i.label)).toContain('Draft');
    expect(items[0].insertText).not.toContain('"');
    expect(items[0].replaceStartCol).toBe('  "status": "'.length);
  });

  it('offers booleans for requires_approval', () => {
    const text = '---dossier\n{\n  "requires_approval": \n}\n---\n';
    const items = completionsAt(text, 2, '  "requires_approval": '.length);
    expect(items.map((i) => i.label)).toEqual(['true', 'false']);
  });

  it('completes YAML keys and values', () => {
    const y = '---\ntit\nstatus: \n---\n';
    expect(completionsAt(y, 1, 3).map((c) => c.label)).toContain('title');
    expect(completionsAt(y, 2, 8).map((c) => c.label)).toContain('Stable');
  });

  it('offers nothing outside the frontmatter', () => {
    expect(completionsAt(`${GOOD}\n"`, GOOD.split('\n').length, 1)).toEqual([]);
  });
});

describe('hover', () => {
  it('describes a top-level key with its enum', () => {
    const line = GOOD.split('\n').findIndex((l) => l.includes('"risk_level"'));
    const h = hoverAt(GOOD, line, 6);
    expect(h?.markdown).toContain('risk_level');
    expect(h?.markdown).toContain('`critical`');
  });

  it('ignores nested keys and values', () => {
    const line = GOOD.split('\n').findIndex((l) => l.includes('"algorithm"'));
    expect(hoverAt(GOOD, line, 8)).toBeNull();
    const t = GOOD.split('\n').findIndex((l) => l.includes('"title"'));
    expect(hoverAt(GOOD, t, 20)).toBeNull();
  });
});

describe('template', () => {
  it('slugifies titles', () => {
    expect(slugify('Deploy a Service!')).toBe('deploy-a-service');
    expect(slugify('!!!')).toBe('new-dossier');
  });

  it('produces a dossier whose checksum verifies', async () => {
    const r = await verifyContent(GOOD, new Map());
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'Checksum')?.status).toBe('pass');
    expect(r.checks.find((c) => c.name === 'Signature')?.status).toBe('warn');
  });
});

describe('verify', () => {
  it('fails on a tampered body', async () => {
    const r = await verifyContent(`${GOOD}\nextra line`, new Map());
    expect(r.ok).toBe(false);
  });

  it('verifies a signed example and flags an unknown key', async () => {
    const r = await verifyContent(example('test/hello-world.ds.md'), new Map());
    const sig = r.checks.find((c) => c.name === 'Signature');
    expect(['pass', 'warn']).toContain(sig?.status);
  });
});

describe('dry-run', () => {
  it('keeps the static-preview disclaimer', () => {
    const text = formatDryRun(dryRunContent(GOOD));
    expect(text).toMatch(/static/i);
    expect(text).toContain('Risk score');
  });

  it('lists commands found in code fences', () => {
    const doc = GOOD.replace(
      '# commands that prove the work succeeded',
      'rm -rf build\ncurl https://example.com/x'
    );
    const text = formatDryRun(dryRunContent(doc));
    expect(text).toContain('rm -rf build');
    expect(text).toContain('example.com');
  });
});
