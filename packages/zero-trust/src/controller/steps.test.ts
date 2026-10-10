import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Journal } from '../journal';
import { StepArtifacts } from './steps';

const roots: string[] = [];
const journals: Journal[] = [];
function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-step-artifacts-'));
  roots.push(root);
  const j = new Journal(root);
  journals.push(j);
  return { root, j, artifacts: new StepArtifacts(j, 'run-fixture') };
}
afterEach(() => {
  for (const j of journals.splice(0)) j.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('durable step artifacts', () => {
  it('detaches inputs, validates immutable bytes on every read, and reopens the actual journal', () => {
    const h = rig();
    const value = { nested: { value: 'original' } };
    h.artifacts.put('fixture', value);
    value.nested.value = 'changed';
    expect(h.artifacts.require('fixture')).toEqual({ nested: { value: 'original' } });
    expect(new StepArtifacts(h.j, 'run-fixture').require('fixture')).toEqual({
      nested: { value: 'original' },
    });
    const row = h.j.read()[0] as { digest: string };
    fs.writeFileSync(path.join(h.root, `${row.digest}.json`), '{}');
    expect(() => h.artifacts.get('fixture')).toThrow('invalid_step_artifact');
    expect(() => new StepArtifacts(h.j, 'run-fixture')).toThrow('invalid_step_artifact');
  });
  it('stores source artifacts larger than receipt JSON limits without embedding them in journal rows', () => {
    const h = rig();
    const source = { pack: 'a'.repeat(2 * 1024 * 1024) };
    h.artifacts.put('source', source);
    expect(h.artifacts.require('source')).toEqual(source);
    expect(fs.statSync(h.j.filePath).size).toBeLessThan(500);
  });
  it('refuses absent, foreign-run, malformed and unknown journal records', () => {
    const h = rig();
    expect(h.artifacts.get('missing')).toBeUndefined();
    expect(() => h.artifacts.require('missing')).toThrow('missing_step_artifact');
    h.j.append({
      type: 'artifact',
      runId: 'other',
      key: 'source',
      version: 1,
      digest: 'a'.repeat(64),
    });
    expect(() => new StepArtifacts(h.j, 'run-fixture')).toThrow('invalid_step_artifact');
  });
  it.each([
    [],
    null,
    { type: 'unknown' },
    {
      type: 'artifact',
      runId: 'run-fixture',
      key: '../source',
      version: 1,
      digest: 'a'.repeat(64),
    },
  ])('refuses corrupt rows %j', (row) => {
    const h = rig();
    h.j.append(row);
    expect(() => new StepArtifacts(h.j, 'run-fixture')).toThrow();
  });
  it('refuses symlinked or missing artifact bytes without falling back to a cache', () => {
    const h = rig();
    h.artifacts.put('source', { value: 'held' });
    const row = h.j.read()[0] as { digest: string };
    const file = path.join(h.root, `${row.digest}.json`);
    fs.unlinkSync(file);
    expect(() => h.artifacts.get('source')).toThrow();
    fs.symlinkSync(h.j.filePath, file);
    expect(() => h.artifacts.get('source')).toThrow();
  });
  it.each([
    undefined,
    Number.NaN,
    new Date(),
    { value: undefined },
    { value: () => 1 },
  ])('refuses non-JSON publication %j', (value) => {
    const h = rig();
    expect(() => h.artifacts.put('fixture', value)).toThrow();
    expect(h.j.read()).toEqual([]);
  });
  it('refuses source-selected storage keys', () => {
    const h = rig();
    expect(() => h.artifacts.put('../escape', {})).toThrow('invalid_step_artifact');
  });
});
