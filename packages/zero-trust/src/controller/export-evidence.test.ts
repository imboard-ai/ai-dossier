import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFixtures } from '../../fixtures/retention';
import { pushOf, rig, SHA1 } from '../github/__tests__/push-rig';
import { ExportEvidenceError, retainPortfolio } from './export-evidence';

const fixtures = createFixtures();
afterEach(fixtures.cleanup);
it.each([
  'invalid_export_evidence',
  'export_evidence_limit',
  'export_evidence_unavailable',
] as const)('keeps %s distinguishable through real shipping without consuming a nonce or minting a token', async (code) => {
  const r = await rig();
  const nonceFile = path.join(r.dirs.nonces, 'events.jsonl');
  const before = fs.readFileSync(nonceFile);
  vi.spyOn(r.grants, 'shift').mockImplementation(() => {
    throw new ExportEvidenceError(code);
  });
  await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(
    `authorize:ExportEvidenceError_${code}`
  );
  expect(r.mints()).toBe(0);
  expect(r.fork.sha()).toBeNull();
  expect(fs.readFileSync(nonceFile)).toEqual(before);
});
it('reports unavailable storage without exposing its message or replacing prior portfolio bytes', () => {
  const r = fixtures.rig();
  retainPortfolio(r.store, SHA1, []);
  const file = path.join(r.directory, 'portfolio-evidence.json');
  const before = fs.readFileSync(file);
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).endsWith('/portfolio-evidence.json'))
      throw new Error('private filesystem details');
    return rename(from, to);
  });
  expect(() => retainPortfolio(r.store, SHA1, [])).toThrow('export_evidence_unavailable');
  expect(fs.readFileSync(file)).toEqual(before);
});
