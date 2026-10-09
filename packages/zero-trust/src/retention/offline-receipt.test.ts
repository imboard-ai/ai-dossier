import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFixtures, NOW, signedReceipt } from '../../fixtures/retention';
import { exportContribution, validateContributionExport } from './export';
import { offlineReceipt } from './offline-receipt';
import { planSweep } from './retention';

const { rig, cleanup } = createFixtures();
afterEach(cleanup);
it('shared offline validation accepts a complete real v2 envelope', async () => {
  const r = rig(),
    receipt = await signedReceipt(r);
  expect(offlineReceipt(receipt, r.store.run, r.store.contributionId)).toEqual(receipt);
  const signed = {
    ...receipt,
    signature: { ...receipt.signature, signed_by: 'Fixture', covers: 'body' },
  };
  expect(offlineReceipt(signed, r.store.run, r.store.contributionId).signature).toMatchObject({
    signed_by: 'Fixture',
    covers: 'body',
  });
});
it.each([
  'signed-at',
  'extra',
  'algorithm',
  'contribution',
  'contributor',
  'issue',
  'digest',
  'signature',
  'key',
  'covers',
])('sweep/export/helper agree on invalid envelope %s', async (kind) => {
  const r = rig(),
    receipt = await signedReceipt(r);
  const raw: Record<string, unknown> = { ...structuredClone(receipt.signature) };
  if (kind === 'signed-at') delete raw.signed_at;
  if (kind === 'extra') raw.extra = 'not allowed';
  if (kind === 'algorithm') raw.algorithm = 'rsa';
  if (kind === 'covers') raw.covers = 'invented';
  if (kind === 'key') raw.public_key = 'invalid';
  if (kind === 'signature') raw.signature = 'AAAA';
  if (kind === 'digest') receipt.digest = '0'.repeat(64);
  if (kind === 'contribution') receipt.receipt.contributionId = 'foreign';
  if (kind === 'contributor') receipt.receipt.contributor = 'foreign';
  if (kind === 'issue') receipt.receipt.issue = 2;
  const envelope = { ...receipt, signature: raw };
  expect(() => offlineReceipt(envelope, r.store.run, r.store.contributionId)).toThrow();
  const bundle = exportContribution(r.store, path.join(r.temp, 'empty'));
  expect(() => validateContributionExport({ ...bundle, receipts: [envelope] })).toThrow();
  r.write('receipt-evidence.json', [envelope]);
  expect(() => exportContribution(r.store, path.join(r.temp, 'bad'))).toThrow();
  r.close();
  expect(() => planSweep(r.root, NOW)).toThrow();
});
