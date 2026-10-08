import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createFixtures, NOW, SHA, verificationSource } from '../../fixtures/retention';
import { FakeVmAdapter } from '../__tests__/fake-vm';
import { exportSource } from '../canonical/export';
import { baselineEvidence } from '../controller/evidence-runner';
import { OutputCollector } from '../controller/output-collector';
import { buildCommandPlan } from '../ecosystem/commands';
import { detectEcosystem, sourceFilesFromManifest } from '../ecosystem/detect';
import { recordProfileSelection, selectProfile } from '../ecosystem/profiles';
import { WORKER_RELAY } from '../vm/qemu-args';
import { exportContribution, validateContributionExport } from './export';
import { planSweep } from './retention';
import { parseVerification } from './verification';

const { rig, cleanup } = createFixtures();
afterEach(cleanup);
it('duplicate standalone command IDs refuse parsing, public validation, output and expiry', () => {
  const r = rig();
  const source = verificationSource(r.runId);
  r.write('verification-evidence.json', source);
  const good = exportContribution(r.store, path.join(r.temp, 'valid'));
  const tampered = structuredClone(good);
  if (!tampered.verification) throw new Error('missing fixture verification');
  tampered.verification[0].commands.push(structuredClone(tampered.verification[0].commands[0]));
  expect(() => validateContributionExport(tampered)).toThrow();
  source.records.push(structuredClone(source.records[0]));
  expect(() => parseVerification(source, r.runId)).toThrow();
  r.write('verification-evidence.json', source);
  expect(() => exportContribution(r.store, path.join(r.temp, 'duplicate'))).toThrow();
  expect(fs.existsSync(path.join(r.temp, 'duplicate'))).toBe(false);
  const file = r.artifact();
  r.close();
  expect(() => planSweep(r.root, NOW)).toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe('snapshot bytes');
  expect(fs.existsSync(path.join(r.directory, 'summary.json'))).toBe(false);
  expect(fs.existsSync(path.join(r.directory, '.snapshot-expired'))).toBe(false);
});
it.each([
  1, 2,
])('actual producer retains %i skipped tests and cannot acquire an invented passing verdict', async (skipped) => {
  const r = rig();
  const manifest = exportSource(path.join(__dirname, '../../fixtures/ecosystem/npm/base'));
  const detection = detectEcosystem(sourceFilesFromManifest(manifest));
  if (!detection.supported) throw new Error('unsupported fixture');
  const selection = selectProfile(detection);
  if (!selection.ok) throw new Error('missing profile');
  const relay = `http://${WORKER_RELAY.host}:${WORKER_RELAY.port}/`;
  const adapter = new FakeVmAdapter((request) =>
    request.report
      ? {
          exitCode: 0,
          report: Buffer.from(
            `<testsuites><testsuite name="suite" tests="2" failures="0" skipped="${skipped}"><testcase name="a"><skipped/></testcase><testcase name="b">${skipped === 2 ? '<skipped/>' : ''}</testcase></testsuite></testsuites>`
          ),
        }
      : {}
  );
  const produced = await baselineEvidence({
    adapter,
    runId: r.runId,
    manifest,
    plan: buildCommandPlan('npm', { npmRegistry: relay, pypiIndex: `${relay}index/` }),
    limits: { vcpus: 1, memoryMiB: 512, diskGiB: 1, commandTimeoutMs: 1000 },
    profileRecord: recordProfileSelection(r.store.storeDirectory('profile'), r.runId, selection),
    proxyTarget: WORKER_RELAY,
    collector: new OutputCollector(),
    lifecycle: {
      run: r.store.run,
      now: () => new Date(NOW),
      observeRun: () => {},
      sleep: async () => {},
    },
  });
  const records = produced.records.filter((record) => record.captureReport);
  expect(records[0].skipped).toBe(skipped);
  expect(records[0].status).toBe(skipped === 2 ? 'inconclusive' : 'passed');
  const source = { runId: r.runId, candidateSha: SHA, records };
  r.write('verification-evidence.json', source);
  expect(exportContribution(r.store, path.join(r.temp, 'honest')).verification?.[0].verified).toBe(
    skipped !== 2
  );
  const corrupt = structuredClone(source);
  if (skipped === 2) {
    Object.assign(corrupt.records[0], { status: 'passed' });
    corrupt.records[0].evidence.status = 'passed';
    expect(() => parseVerification(corrupt, r.runId)).toThrow();
  }
  delete (corrupt.records[0] as unknown as Record<string, unknown>).skipped;
  expect(() => parseVerification(corrupt, r.runId)).toThrow();
});

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
  s.suites = s.tests = s.failures = s.skipped = null;
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
