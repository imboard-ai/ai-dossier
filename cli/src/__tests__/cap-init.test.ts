import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gateGapWarning,
  initManifest,
  MEMBER_GATE_CAPABILITIES,
  scaffoldManifest,
} from '../cap-init';
import { loadCapabilityManifest } from '../capability';

describe('cap init (#645)', () => {
  let dir: string;
  const pkg = (scripts: Record<string, string>, extra: object = {}) =>
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 't', scripts, ...extra })
    );

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-init-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('scaffolds a loadable manifest declaring both member-gate ids from detected scripts', () => {
    pkg({ build: 'tsc', test: 'vitest run' });
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const result = initManifest(dir, dir);
    expect(result.status).toBe('created');
    const manifest = loadCapabilityManifest(dir);
    expect(manifest.capabilities['typecheck.run']?.command).toBe('pnpm run build');
    expect(manifest.capabilities['test.focused']?.command).toBe('pnpm test');
    expect(manifest.capabilities['dependencies.install']?.command).toContain('pnpm install');
    expect(gateGapWarning(manifest)).toBeNull();
  });

  it('prefers a typecheck script over the build', () => {
    pkg({ typecheck: 'tsc --noEmit', build: 'tsc', test: 'jest' });
    expect(scaffoldManifest(dir)).toContain('command: "npm run typecheck"');
  });

  it('emits commented TODO stubs (not guesses) when nothing is detectable', () => {
    pkg({});
    initManifest(dir, dir);
    const manifest = loadCapabilityManifest(dir);
    expect(manifest.capabilities['test.focused']).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, '.dossier/automation/manifest.yaml'), 'utf-8')).toContain(
      '# TODO test.focused'
    );
    expect(gateGapWarning(manifest)).toContain('typecheck.run, test.focused');
  });

  it('is idempotent and never clobbers an existing manifest', () => {
    pkg({ test: 'vitest' });
    const target = path.join(dir, '.dossier/automation/manifest.yaml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const mine = 'version: 1\ncapabilities:\n  lint:\n    command: echo mine\n';
    fs.writeFileSync(target, mine);
    expect(initManifest(dir, dir).status).toBe('exists');
    expect(fs.readFileSync(target, 'utf-8')).toBe(mine);
  });
});

describe('gateGapWarning (#645)', () => {
  it('names the missing ids and the fix for a manifest-less repo', () => {
    const w = gateGapWarning({ path: null, capabilities: {} });
    for (const id of MEMBER_GATE_CAPABILITIES) expect(w).toContain(id);
    expect(w).toContain('ai-dossier cap init');
    expect(w).toContain('--skip-gate-check');
  });

  it('names only what is missing', () => {
    const w = gateGapWarning({
      path: '/x/manifest.yaml',
      capabilities: { 'typecheck.run': { command: 'x', lifecycle: 'active' } },
    });
    expect(w).toContain('test.focused');
    expect(w).not.toContain('typecheck.run,');
  });
});
