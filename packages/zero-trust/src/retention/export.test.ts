import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFixtures, SHA, signedReceipt } from '../../fixtures/retention';
import { ReasonCode, transitionRun } from '../state';
import { MaintenanceError } from './errors';
import { exportContribution, validateContributionExport } from './export';

const { rig, cleanup } = createFixtures();
afterEach(cleanup);
it('binds a valid signed receipt to the exported contributor, contribution, issue and verification', async () => {
  const r = rig(),
    receipt = await signedReceipt(r);
  r.write('receipt-evidence.json', [receipt]);
  const bundle = exportContribution(r.store, path.join(r.temp, 'receipt'));
  expect(validateContributionExport(bundle).receipts).toEqual([receipt]);
  const contributor = structuredClone(bundle);
  contributor.run = { ...contributor.run, contributor: 'different' };
  expect(() => validateContributionExport(contributor)).toThrow();
  const issue = structuredClone(bundle);
  issue.run = { ...issue.run, upstreamIssue: 'https://github.com/owner/repo/issues/2' };
  issue.status.upstreamIssue = issue.run.upstreamIssue;
  expect(() => validateContributionExport(issue)).toThrow();
  const contribution = structuredClone(bundle);
  contribution.run = { ...contribution.run, runId: 'ztc-0000000000000000-run-1' };
  expect(() => validateContributionExport(contribution)).toThrow();
  const verification = structuredClone(bundle);
  verification.verification = null;
  expect(() => validateContributionExport(verification)).toThrow();
});
it('rejects fabricated merged/declined outcomes and an unknown observed outcome SHA', () => {
  const r = rig(),
    bundle = exportContribution(r.store, path.join(r.temp, 'valid'));
  for (const outcome of ['merged', 'declined', 'unknown']) {
    const forged = structuredClone(bundle);
    forged.outcome = forged.status.outcome = outcome;
    forged.status.outcomeSha = SHA;
    expect(() => validateContributionExport(forged)).toThrow();
  }
});
it('keeps historical public observations after cancellation or blocking without claiming an outcome', () => {
  const r = rig();
  for (const reason of [
    ReasonCode.GatePassed,
    ReasonCode.PlanApproved,
    ReasonCode.CandidateReady,
    ReasonCode.VerificationPassed,
    ReasonCode.PublicationObserved,
  ])
    r.store.persistRun(transitionRun(r.store.run, reason, r.store.run.updatedAt));
  const bundle = exportContribution(r.store, path.join(r.temp, 'valid'));
  bundle.pr = bundle.status.pr = 'https://github.com/owner/repo/pull/2';
  bundle.status.verifiedSha = SHA;
  bundle.outcome = bundle.status.outcome = 'awaiting_review';
  for (const reason of [ReasonCode.UserCancelled, ReasonCode.PolicyBlocked]) {
    const retained = structuredClone(bundle);
    retained.run = transitionRun(retained.run, reason, retained.run.updatedAt);
    retained.status.state = retained.run.state;
    expect(validateContributionExport(retained).pr).toBe(bundle.pr);
    expect(validateContributionExport(retained).status.outcomeSha).toBeNull();
  }
  const foreign = structuredClone(bundle);
  foreign.pr = foreign.status.pr = 'https://github.com/other/repo/pull/2';
  expect(() => validateContributionExport(foreign)).toThrow();
});
it.each([
  'existing',
  'missing-parent',
])('destination %s failures never echo secret-bearing names or causes', (kind) => {
  const r = rig();
  const name = path.join(r.temp, kind === 'existing' ? 'ghp_filename' : 'ghp_parent/output');
  if (kind === 'existing') fs.writeFileSync(name, 'preserve');
  let error: unknown;
  try {
    exportContribution(r.store, name);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(MaintenanceError);
  expect(error).toMatchObject({ code: 'io-error', stage: 'export' });
  expect(String(error)).not.toContain('ghp_');
  expect(error).not.toHaveProperty('cause');
  if (kind === 'existing') expect(fs.readFileSync(name, 'utf8')).toBe('preserve');
});
