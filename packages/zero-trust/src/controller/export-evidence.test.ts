import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFixtures, signedReceipt } from '../../fixtures/retention';
import { pushOf, rig, SHA1 } from '../github/__tests__/push-rig';
import {
  ExportEvidenceError,
  retainPortfolio,
  retainReceipt,
  retainVerification,
} from './export-evidence';

const fixtures = createFixtures();
afterEach(fixtures.cleanup);
it('keeps actual semantic receipt corruption distinguishable through shipping without authorizing a push', async () => {
  const source = fixtures.rig();
  const receipt = await signedReceipt(source);
  source.write('receipt-evidence.json', [{}]);
  const evidenceFile = path.join(source.directory, 'receipt-evidence.json');
  const evidenceBefore = fs.readFileSync(evidenceFile);
  const r = await rig();
  const nonceFile = path.join(r.dirs.nonces, 'events.jsonl');
  const before = fs.readFileSync(nonceFile);
  vi.spyOn(r.grants, 'shift').mockImplementation(() => {
    retainReceipt(source.store, receipt);
    return undefined;
  });
  await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(
    'authorize:ExportEvidenceError_invalid_export_evidence'
  );
  expect(r.mints()).toBe(0);
  expect(r.fork.sha()).toBeNull();
  expect(fs.readFileSync(nonceFile)).toEqual(before);
  expect(fs.readFileSync(evidenceFile)).toEqual(evidenceBefore);
});
it('normalizes semantic portfolio and verification corruption without replacing the evidence', () => {
  const r = fixtures.rig();
  for (const name of ['portfolio-evidence.json', 'verification-evidence.json']) r.write(name, {});
  expect(() => retainPortfolio(r.store, SHA1, [])).toThrow('invalid_export_evidence');
  expect(() => retainVerification(r.store, SHA1, [])).toThrow('invalid_export_evidence');
  for (const name of ['portfolio-evidence.json', 'verification-evidence.json'])
    expect(fs.readFileSync(path.join(r.directory, name), 'utf8')).toBe('{}');
});
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
