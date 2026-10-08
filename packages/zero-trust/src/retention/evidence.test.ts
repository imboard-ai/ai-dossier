import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFixtures, NOW, signedReceipt, verificationSource } from '../../fixtures/retention';
import { contributionEvidence } from './evidence';
import { exportContribution } from './export';
import { planSweep } from './retention';

const { rig, cleanup } = createFixtures();
afterEach(cleanup);
it('absent tracker/portfolio sources stay unknown; present portfolio requires both fields', () => {
  const r = rig();
  expect(contributionEvidence(r.store, r.directory)).toMatchObject({
    outcome: 'unknown',
    disclosure: null,
    policyCitations: null,
  });
  for (const raw of [
    { runId: r.runId, disclosure: 'text' },
    { runId: r.runId, policyCitations: [] },
  ]) {
    r.write('portfolio-evidence.json', raw);
    expect(() => contributionEvidence(r.store, r.directory)).toThrow();
  }
});
it.each([
  'timeout',
  'failure-count',
  'truncated',
  'empty-tests',
  'partial-counts',
])('refuses inconsistent successful verification %s before export or sweep', (kind) => {
  const r = rig(),
    raw = verificationSource(r.runId),
    record = raw.records[0];
  if (kind === 'timeout') record.timedOut = true;
  if (kind === 'failure-count') record.failures = 1;
  if (kind === 'truncated') record.log.outputTruncated = true;
  if (kind === 'empty-tests') record.tests = 0;
  if (kind === 'partial-counts') record.suites = null;
  r.write('verification-evidence.json', raw);
  const output = path.join(r.temp, 'refused');
  expect(() => exportContribution(r.store, output)).toThrow();
  expect(fs.existsSync(output)).toBe(false);
  r.artifact();
  r.close();
  expect(() => planSweep(r.root, NOW)).toThrow();
  expect(fs.existsSync(path.join(r.directory, 'summary.json'))).toBe(false);
});
it('enforces the aggregate 128 verification bound before sweep publication', async () => {
  const r = rig(),
    receipt = await signedReceipt(r);
  r.write('receipt-evidence.json', Array(128).fill(receipt));
  expect(contributionEvidence(r.store, r.directory).verification).toHaveLength(128);
  r.write('verification-evidence.json', verificationSource(r.runId));
  expect(() => contributionEvidence(r.store, r.directory)).toThrow('size-limit');
  r.artifact();
  r.close();
  expect(() => planSweep(r.root, NOW)).toThrow('size-limit');
  expect(fs.existsSync(path.join(r.directory, '.snapshot-expired'))).toBe(false);
});
