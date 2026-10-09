import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../../canonical/export';
import type { CommandPlan } from '../../ecosystem/commands';
import { ReasonCode, transitionRun } from '../../state';
import { validateRunConfig } from '../config';
import { RunStore } from '../run-store';
import { publishVerification, type VerificationRecord } from '../verification-record';

/** Common durable setup; the unit/integration rigs retain independent effect observers. */
export function shippingStore(
  root: string,
  issueUrl: string,
  contributor: string,
  upstreamId: number,
  time: string
) {
  const keyFile = path.join(root, 'controller.pem');
  fs.writeFileSync(
    keyFile,
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  );
  const phase = {
    adapter: 'fake',
    model: 'fake',
    endpoint: 'https://model.example',
    apiKeyEnv: 'MODEL_KEY',
  };
  const config = validateRunConfig({
    issueUrl,
    contributor,
    executionProfile: {
      provider: 'local-qemu',
      profileDir: 'profile',
      stateDir: 'state',
      accelerator: 'auto',
      proxyEndpointsFile: 'endpoints.json',
    },
    modelProfile: {
      phases: { planning: phase, implementing: phase },
      rates: [
        {
          resource: 'fake',
          currency: 'USD',
          unit: 'token',
          price: 0,
          units: 1,
          source: 'fixture',
          fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: time },
        },
      ],
    },
    budget: {
      currency: 'USD',
      ceilingMinor: 100,
      cleanupAllowanceMinor: 10,
      tokenLimit: 100,
      activeMinutes: 120,
    },
    checkpoints: [],
    signerKeyFile: keyFile,
    githubApp: {
      appId: 1,
      clientId: 'fixture',
      slug: 'fixture',
      privateKeyEnv: 'APP_KEY',
      clientSecretEnv: 'APP_SECRET',
    },
  });
  const store = RunStore.create(path.join(root, 'stores'), config, time);
  store.recordUpstreamRepositoryId(upstreamId);
  for (const reason of [
    ReasonCode.GatePassed,
    ReasonCode.PlanApproved,
    ReasonCode.CandidateReady,
    ReasonCode.VerificationPassed,
  ])
    store.persistRun(transitionRun(store.run, reason, time));
  return { store, keyFile };
}

export function shippingVerification(
  store: RunStore,
  source: string,
  template: VerificationRecord
) {
  const dir = store.storeDirectory('artifacts');
  fs.cpSync(source, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'verification'), { recursive: true, force: true });
  const boundaryFile = path.join(dir, template.boundaryInputRef.artifact);
  const input = { ...JSON.parse(fs.readFileSync(boundaryFile, 'utf8')), runId: store.runId };
  const bytes = Buffer.from(JSON.stringify(input));
  fs.writeFileSync(boundaryFile, bytes, { mode: 0o600 });
  const { schemaVersion: _, recordDigest: __, ...body } = template;
  const verification = publishVerification(dir, {
    ...body,
    runId: store.runId,
    boundaryInputRef: { artifact: template.boundaryInputRef.artifact, digest: sha256(bytes) },
  });
  return { dir, boundaryFile, input, verification };
}

/** Trusted plan is not derived from the verification output or receipt. */
export function shippingCommandPlan(): CommandPlan {
  const report = (id: string, argv: string[]) => ({
    id,
    argv,
    phase: 'verification' as const,
    network: 'none' as const,
    env: {},
    timeoutMs: 1000,
    required: true,
    captureReport: true,
  });
  return {
    manager: 'npm',
    provisioning: [],
    verification: [
      report('npm-test', ['npm', 'test']),
      report('npm-test-regression', ['npm', 'test', '--', 'test/regression.test.js']),
    ],
  };
}
