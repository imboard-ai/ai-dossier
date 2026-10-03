import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { ExecutionPlan } from '../../orchestration/types';
import { generateGraphId, storeGraph } from '../../utils/graphStore';
import { startJourney } from '../startJourney';

function dossierFile(dir: string, name: string, risk: string, code: string): string {
  const path = join(dir, `${name}.ds.md`);
  const fm = JSON.stringify({
    dossier_schema_version: '1.0.0',
    title: name,
    version: '1.0.0',
    risk_level: risk,
  });
  writeFileSync(path, `---dossier\n${fm}\n---\n\n\`\`\`bash\n${code}\n\`\`\`\n`);
  return path;
}

function plan(
  entries: Array<{ name: string; path?: string; source: 'local' | 'registry' }>
): ExecutionPlan {
  return {
    entryDossier: entries[0].name,
    totalDossiers: entries.length,
    phases: entries.map((e, i) => ({
      phase: i + 1,
      dossiers: [{ name: e.name, source: e.source, path: e.path, version: '1.0.0' }],
    })),
  } as unknown as ExecutionPlan;
}

describe('startJourney dry_run', () => {
  it('returns a static per-step preview without creating a session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dryrun-'));
    const a = dossierFile(dir, 'a', 'low', 'ls');
    const b = dossierFile(dir, 'b', 'high', 'git push --force origin main');
    const graphId = generateGraphId();
    storeGraph(
      graphId,
      plan([
        { name: 'a', path: a, source: 'local' },
        { name: 'b', path: b, source: 'local' },
        { name: 'reg/c', source: 'registry' },
      ])
    );

    const result = await startJourney({ graph_id: graphId, dry_run: true });
    if (!('dry_run' in result)) throw new Error('expected dry-run output');

    expect(result.static_preview).toBe(true);
    expect(result.disclaimer).toMatch(/executing agent may take other actions/);
    expect(result.total_steps).toBe(3);
    expect(result.steps[0].plan?.level).toBe('low');
    expect(result.steps[1].plan?.commands[0].kind).toBe('destructive');
    expect(result.steps[2].plan).toBeNull();
    expect(result.risk_score).toBe(result.steps[1].plan?.risk_score);
    expect('journey_id' in result).toBe(false);
  });
});
