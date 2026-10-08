import { expect, it } from 'vitest';
import { verificationSource } from '../../fixtures/retention';
import { parseVerification } from './verification';

it('reclassifies passed, failed, setup, timeout and signal records using producer facts', () => {
  const raw = verificationSource('run'),
    r = raw.records[0];
  expect(parseVerification(raw, 'run').verified).toBe(true);
  r.exitCode = 1;
  r.failures = 1;
  r.status = r.evidence.status = 'failed';
  r.evidence.exitStatus = 1;
  expect(parseVerification(raw, 'run').verified).toBe(false);
  r.timedOut = true;
  r.status = r.evidence.status = 'inconclusive';
  r.evidence.exitStatus = r.evidence.suites = 'unknown';
  expect(parseVerification(raw, 'run').verified).toBe(false);
  r.timedOut = false;
  r.exitCode = null;
  expect(parseVerification(raw, 'run').verified).toBe(false);
  const setup = verificationSource('run');
  const s: Record<string, unknown> = setup.records[0];
  s.captureReport = false;
  s.suites = s.tests = s.failures = null;
  setup.records[0].evidence.suites = 'unknown';
  expect(parseVerification(setup, 'run').commands[0].status).toBe('passed');
  expect(parseVerification(setup, 'run').verified).toBe(false);
});
it('refuses foreign identities, missing log facts, illegal counts and inconsistent status', () => {
  expect(() => parseVerification({}, 'run')).toThrow();
  expect(() => parseVerification(verificationSource('other'), 'run')).toThrow();
  for (const key of ['durationMs', 'timedOut', 'captureReport', 'log']) {
    const raw = verificationSource('run'),
      record: Record<string, unknown> = raw.records[0];
    delete record[key];
    expect(() => parseVerification(raw, 'run')).toThrow();
  }
  const raw = verificationSource('run');
  raw.records[0].failures = 3;
  expect(() => parseVerification(raw, 'run')).toThrow();
});
