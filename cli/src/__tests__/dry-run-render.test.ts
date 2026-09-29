import { analyzeDryRun } from '@ai-dossier/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPlanFile, RENDER_LIMIT, renderDryRun } from '../dry-run-render';

const doc = (code: string) =>
  `---dossier\n${JSON.stringify({ dossier_schema_version: '1.0.0', title: 'T', version: '1.0.0', risk_level: 'high', risk_factors: ['merges_code'] })}\n---\n\n\`\`\`bash\n${code}\n\`\`\`\n`;

const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('renderDryRun', () => {
  const plan = analyzeDryRun(
    doc('ls\necho x > f.txt\nrm -rf dist\ngh pr create --title x\ncurl https://example.com')
  );

  it('states plainly that it is a static preview and not a guarantee', () => {
    process.env.NO_COLOR = '1';
    const text = renderDryRun(plan, 'claude file.ds.md').join('\n');
    expect(text).toMatch(/Static preview/);
    expect(text).toMatch(/executing agent may take other actions/);
    expect(text).toMatch(/Not a safety guarantee/);
  });

  it('keeps the LLM command in the output', () => {
    process.env.NO_COLOR = '1';
    expect(renderDryRun(plan, 'claude file.ds.md').join('\n')).toContain(
      'Would run: claude file.ds.md'
    );
    expect(renderDryRun(plan, null).join('\n')).toContain('No LLM detected');
  });

  it('emits no escape codes under NO_COLOR', () => {
    process.env.NO_COLOR = '1';
    delete process.env.FORCE_COLOR;
    expect(renderDryRun(plan).join('\n')).not.toContain('\x1b[');
  });

  it('colors green/yellow/red groups when color is forced', () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    const lines = renderDryRun(plan);
    const find = (needle: string) => lines.find((l) => l.includes(needle)) ?? '';
    expect(find('[read]')).toContain('\x1b[32m');
    expect(find('[local]')).toContain('\x1b[33m');
    expect(find('[remote]')).toContain('\x1b[31m');
    expect(find('rm -rf dist')).toContain('\x1b[31m');
  });

  it('truncates long groups and points at --plan-out', () => {
    process.env.NO_COLOR = '1';
    const big = analyzeDryRun(
      doc(Array.from({ length: RENDER_LIMIT + 5 }, (_, i) => `gh issue view ${i}`).join('\n'))
    );
    expect(renderDryRun(big).join('\n')).toMatch(/and 5 more \(full list: --plan-out/);
  });
});

describe('buildPlanFile', () => {
  it('keeps the core plan shape and adds an execution block', () => {
    const plan = analyzeDryRun(doc('ls'));
    const file = buildPlanFile(plan, { file: 'a.ds.md', llm: 'claude', command: 'claude a.ds.md' });
    expect(Object.keys(file).sort()).toEqual(
      [
        'commands',
        'declared',
        'disclaimer',
        'dossier',
        'env',
        'execution',
        'files',
        'level',
        'network',
        'risk_score',
        'schema_version',
        'score_breakdown',
        'static_preview',
      ].sort()
    );
    expect(JSON.parse(JSON.stringify(file)).static_preview).toBe(true);
  });
});
