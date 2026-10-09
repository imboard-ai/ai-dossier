/** Test-only store fixture. Each suite owns cleanup via createFixtures(). */
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ed25519Signer } from '@ai-dossier/core';
import { BudgetLedger, estimateBudget } from '../src/budget';
import { validateRunConfig } from '../src/controller/config';
import { logArtifact } from '../src/controller/evidence-runner';
import { RunStore } from '../src/controller/run-store';
import { replacePrivate } from '../src/durable-fs';
import { handoffMarker } from '../src/github/handoff';
import { PrTracker } from '../src/github/track';
import { Journal } from '../src/journal';
import { issueReceipt } from '../src/receipt/issue';
import { ReasonCode, transitionRun } from '../src/state';

export const START = '2026-01-01T00:00:00.000Z';
export const NOW = '2026-03-01T00:00:00.000Z';
export const SHA = 'a'.repeat(40);
export const HASH = 'b'.repeat(64);
export function verificationSource(runId: string) {
  const log = { ...logArtifact('test output', '', false) };
  return {
    runId,
    candidateSha: SHA,
    records: [
      {
        phase: 'verification',
        network: 'none',
        timedOut: false,
        captureReport: true,
        tests: 2,
        failures: 0,
        skipped: 0,
        durationMs: 100,
        id: 'test',
        argv: 'npm test',
        status: 'passed',
        exitCode: 0 as number | null,
        suites: 2 as number | null,
        log,
        evidence: {
          id: 'test',
          command: 'npm test',
          required: true,
          status: 'passed',
          exitStatus: 0 as number | string,
          suites: 2 as number | string,
          sanitizedLogDigest: log.digest,
        },
      },
    ],
  };
}
export async function signedReceipt(r: ReturnType<ReturnType<typeof createFixtures>['rig']>) {
  return issueReceipt(
    {
      contributionId: r.store.contributionId,
      runId: r.runId,
      sessionId: r.store.budgetSessionId(1),
      contributor: 'contributor',
      upstreamRepositoryId: 1,
      forkRepositoryId: 2,
      issue: 1,
      defaultBranch: 'main',
      baseSha: SHA,
      parentSha: SHA,
      candidateSha: SHA,
      profileDigest: HASH,
      policyDigest: HASH,
      profile: { name: 'node', runtime: '22', imageDigest: `sha256:${HASH}`, accelerator: 'tcg' },
      commands: [
        {
          id: 'test',
          command: 'npm test',
          required: true,
          status: 'passed',
          exitStatus: 0,
          suites: 2,
          sanitizedLogDigest: HASH,
        },
      ],
      networkPolicy: {
        acquisition: 'public',
        provisioning: 'proxy',
        verification: 'offline',
        shipping: 'clean',
      },
      permittedShippingOperations: [],
    },
    new Ed25519Signer(r.key),
    () => Date.parse(START)
  );
}
export function createFixtures() {
  const dirs: string[] = [],
    stores: RunStore[] = [];
  function rig(days?: number, checkpoints: string[] = []) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
    dirs.push(temp);
    const key = path.join(temp, 'signer.pem');
    fs.writeFileSync(
      key,
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 }
    );
    const phase = {
      adapter: 'fake',
      model: 'fake',
      endpoint: 'https://model.example',
      apiKeyEnv: 'MODEL_KEY',
    };
    const rate = {
      resource: 'fake',
      currency: 'USD',
      unit: 'token' as const,
      price: 1,
      units: 1,
      source: 'fixture',
      fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: START },
    };
    const config = validateRunConfig({
      issueUrl: 'https://github.com/owner/repo/issues/1',
      contributor: 'contributor',
      executionProfile: {
        provider: 'local-qemu',
        profileDir: 'profile',
        stateDir: 'state',
        accelerator: 'auto',
        proxyEndpointsFile: 'endpoints.json',
      },
      modelProfile: { phases: { planning: phase, implementing: phase }, rates: [rate] },
      budget: {
        currency: 'USD',
        ceilingMinor: 100,
        cleanupAllowanceMinor: 10,
        tokenLimit: 100,
        activeMinutes: 120,
      },
      signerKeyFile: key,
      githubApp: {
        appId: 1,
        clientId: 'fixture',
        slug: 'fixture',
        privateKeyEnv: 'APP_KEY',
        clientSecretEnv: 'APP_SECRET',
      },
      checkpoints,
      ...(days === undefined ? {} : { retentionDays: days }),
    });
    const root = path.join(temp, 'stores');
    const store = RunStore.create(root, config, START);
    stores.push(store);
    const directory = store.directory,
      runId = store.runId;
    function write(name: string, raw: unknown) {
      replacePrivate(path.join(directory, name), Buffer.from(JSON.stringify(raw)));
    }
    function artifact(name = 'snapshot', bytes = 'snapshot bytes') {
      const file = path.join(directory, 'artifacts', name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      return file;
    }
    function age(dir = directory) {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name),
          stat = fs.lstatSync(file);
        if (stat.isDirectory()) age(file);
        else if (!stat.isSymbolicLink()) fs.utimesSync(file, new Date(START), new Date(START));
      }
    }
    function close() {
      age();
      store.close();
    }
    function open() {
      const s = RunStore.open(root, runId);
      stores.push(s);
      return s;
    }
    return {
      temp,
      key,
      root,
      store,
      runId,
      directory,
      config,
      rate,
      write,
      artifact,
      age,
      close,
      open,
    };
  }
  function cleanup() {
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  }
  return { rig, cleanup, stores, dirs };
}
/** Actual tracker, budget and receipt producers, shared by module-owned suites. */
export async function producerEvidence(
  r: ReturnType<ReturnType<typeof createFixtures>['rig']>,
  merged = true,
  prUrl = 'https://github.com/owner/repo/pull/2'
) {
  let at = Date.parse(START);
  const now = () => {
    at += 1000;
    return new Date(at).toISOString();
  };
  r.store.recordUpstreamRepositoryId(1);
  for (const reason of [
    ReasonCode.GatePassed,
    ReasonCode.PlanApproved,
    ReasonCode.CandidateReady,
    ReasonCode.VerificationPassed,
    ReasonCode.PublicationObserved,
  ])
    r.store.persistRun(transitionRun(r.store.run, reason, now()));
  const journal = new Journal(r.store.storeDirectory('track'));
  try {
    const tracker = new PrTracker(
      journal,
      {
        bodyDirectory: r.store.storeDirectory('bodies'),
        admission: {
          policyFresh: async () => true,
          contributorVerified: async () => true,
          forkBindingVerified: async () => true,
        },
        now,
        read: async () => ({
          status: 200,
          body: {
            number: 2,
            html_url: prUrl,
            state: 'closed',
            merged,
            head: { sha: SHA, ref: 'task', repo: { id: 2 } },
            base: { ref: 'main' },
            title: 'Fix',
            body: '',
          },
        }),
      },
      {
        run: r.store.run,
        contributionId: r.store.contributionId,
        headSha: SHA,
        pr: {
          binding: {
            upstream: { owner: 'owner', repo: 'repo' },
            base: 'main',
            headOwner: 'contributor',
            branch: 'task',
          },
          fork: { repositoryId: 2, owner: 'contributor', repo: 'repo' },
          number: 2,
          url: prUrl,
          marker: handoffMarker({
            contributionId: r.store.contributionId,
            target: 'owner/repo#1',
            operationKind: 'pr_create',
            candidateSha: SHA,
          }),
        },
      }
    );
    if (merged) {
      await tracker.resume();
      r.store.persistRun(tracker.snapshot().run);
    }
  } finally {
    journal.close();
  }
  const ledger = new BudgetLedger(
    path.join(r.directory, 'budget/ledger.json'),
    r.store.contributionId
  );
  ledger.initialize(['fake'], [r.rate]);
  ledger.startSession({
    id: r.store.budgetSessionId(1),
    ceiling: { currency: 'USD', minor: 100 },
    cleanupAllowance: 10,
    tokenLimit: 100,
    timeLimitMs: 10000,
  });
  const reservation = ledger.reserve(
    r.store.budgetSessionId(1),
    estimateBudget(
      {
        currency: 'USD',
        model: {
          resource: 'fake',
          maxInputTokens: 2,
          maxOutputTokens: 3,
          retries: 0,
          streamingTimeMs: 1000,
        },
      },
      [r.rate]
    )
  );
  ledger.settle(reservation.id, {
    money: { currency: 'USD', minor: 8 },
    tokens: 8,
    timeMs: 500,
    source: 'model_usage',
  });
  const receipt = await issueReceipt(
    {
      contributionId: r.store.contributionId,
      runId: r.runId,
      sessionId: r.store.budgetSessionId(1),
      contributor: 'contributor',
      upstreamRepositoryId: 1,
      forkRepositoryId: 2,
      issue: 1,
      defaultBranch: 'main',
      baseSha: SHA,
      parentSha: SHA,
      candidateSha: SHA,
      profileDigest: HASH,
      policyDigest: HASH,
      profile: { name: 'node', runtime: '22', imageDigest: `sha256:${HASH}`, accelerator: 'tcg' },
      commands: [
        {
          id: 'test',
          command: 'npm test',
          required: true,
          status: 'passed',
          exitStatus: 0,
          suites: 3,
          sanitizedLogDigest: HASH,
        },
      ],
      networkPolicy: {
        acquisition: 'public',
        provisioning: 'proxy',
        verification: 'offline',
        shipping: 'clean',
      },
      permittedShippingOperations: [],
    },
    new Ed25519Signer(r.key),
    () => at
  );
  r.write('receipt-evidence.json', [receipt]);
  r.write('portfolio-evidence.json', {
    runId: r.runId,
    disclosure: 'This contribution used substantial LLM assistance.',
    policyCitations: [
      {
        path: 'CONTRIBUTING.md',
        line: 1,
        ruleId: 'ai-disclosure',
        excerpt: 'Disclose LLM assistance.',
      },
    ],
  });
  return receipt;
}
