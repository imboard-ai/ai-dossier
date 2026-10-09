import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFixtures, NOW, producerEvidence } from '../../fixtures/retention';
import { Journal } from '../journal';
import { SecretRedactionError } from '../redaction';
import { exportContribution, validateContributionExport } from './export';
import { applySweep, planSweep } from './retention';
import { inventory } from './sweep-files';

const { rig, cleanup } = createFixtures();
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});
it('portable and persisted unsupported verified SHA refuses despite intact original receipt', async () => {
  const r = rig();
  await producerEvidence(r);
  const bundle = exportContribution(r.store, path.join(r.temp, 'valid'));
  bundle.status.verifiedSha = 'c'.repeat(40);
  expect(() => validateContributionExport(bundle)).toThrow('invalid-evidence');
  r.artifact();
  r.close();
  const file = path.join(r.directory, 'track/events.jsonl');
  const events = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  events[0].verifiedSha = 'c'.repeat(40);
  fs.writeFileSync(file, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  r.age();
  const before = inventory(r.directory).protectedDigest;
  const store = r.open();
  expect(() => exportContribution(store, path.join(r.temp, 'invalid'))).toThrow('invalid-evidence');
  store.close();
  expect(() => planSweep(r.root, NOW)).toThrow('invalid-evidence');
  expect(inventory(r.directory).protectedDigest).toBe(before);
  expect(fs.existsSync(path.join(r.directory, 'summary.json'))).toBe(false);
});
it('portable credential refusal preserves SecretRedactionError; malformed snapshots still map safely', () => {
  const r = rig();
  const bundle = exportContribution(r.store, path.join(r.temp, 'valid'));
  bundle.disclosure = 'ghp_planted';
  expect(() => validateContributionExport(bundle)).toThrow(SecretRedactionError);
  expect(() => validateContributionExport({ impossible: 1n })).toThrow('invalid-input');
});
it.each([
  'track',
  'handoff',
])('actual %s journal interrupted after truncate leaves sidecar that refuses export, plan and stale apply before writes', async (directory) => {
  const r = rig();
  await producerEvidence(r);
  const artifact = r.artifact();
  r.close();
  const plan = planSweep(r.root, NOW);
  const dir = path.join(r.directory, directory);
  const file = path.join(dir, 'events.jsonl');
  fs.appendFileSync(file, '{"incomplete":');
  const truncate = fs.ftruncateSync.bind(fs);
  const spy = vi.spyOn(fs, 'ftruncateSync').mockImplementation((fd, length) => {
    truncate(fd, length);
    throw new Error('crash after truncate');
  });
  expect(() => new Journal(dir)).toThrow();
  spy.mockRestore();
  expect(fs.existsSync(`${file}.recovery`)).toBe(true);
  r.age();
  const before = inventory(r.directory).protectedDigest;
  const store = r.open();
  expect(() => exportContribution(store, path.join(r.temp, 'invalid'))).toThrow('invalid-evidence');
  store.close();
  expect(() => planSweep(r.root, NOW)).toThrow('invalid-evidence');
  expect(() => applySweep(plan)).toThrow();
  expect(fs.existsSync(artifact)).toBe(true);
  expect(fs.existsSync(path.join(r.directory, 'summary.json'))).toBe(false);
  expect(inventory(r.directory).protectedDigest).toBe(before);
});
it.each([
  'track',
  'handoff',
])('present null/malformed/symlink %s recovery intents are never silently skipped', async (directory) => {
  const r = rig();
  await producerEvidence(r);
  const file = path.join(r.directory, directory, 'events.jsonl.recovery');
  for (const content of ['null', 'not json']) {
    fs.writeFileSync(file, content, { mode: 0o600 });
    expect(() => exportContribution(r.store, path.join(r.temp, 'invalid'))).toThrow(
      'invalid-evidence'
    );
    fs.unlinkSync(file);
  }
  fs.symlinkSync('/nonexistent-owned-target', file);
  expect(() => exportContribution(r.store, path.join(r.temp, 'invalid'))).toThrow(
    'invalid-evidence'
  );
});
