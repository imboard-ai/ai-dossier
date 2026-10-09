import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ed25519Signer } from '@ai-dossier/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { candidateInput, harness, removeTemps, TIME } from '../__tests__/verifier-fixture';
import { sha256 } from '../canonical/export';
import { idempotencyKey } from '../intents';
import { ReceiptNonceStore } from '../receipt/nonces';
import { canonicalJson } from '../receipt/schema';
import { authorizeShipping, verifyReceipt } from '../receipt/verify';
import { ReasonCode, transitionRun } from '../state';
import { validateRunConfig } from './config';
import { RunStore } from './run-store';
import {
  buildReceiptContext,
  issueShippingReceipt,
  makeAuthorize,
  makeHandoffAdmission,
  prContentInput,
  type ShippingAuthorizeDeps,
  shippingIntent,
} from './shipping';
import { publishVerification, type VerificationRecord } from './verification-record';
import { verifyCandidate } from './verifier';

let template: VerificationRecord;
let artifacts: string;
const roots: string[] = [];
const stores: RunStore[] = [];
beforeAll(async () => {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    test: [
      { address: '127.0.0.1', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
    ],
  });
  const h = harness();
  const result = await verifyCandidate(h.deps(), candidateInput());
  if (result.kind !== 'verified') throw new Error('fixture failed');
  template = result.record;
  artifacts = h.artifactsDir;
  vi.restoreAllMocks();
});
afterAll(removeTemps);
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-shipping-'));
  roots.push(root);
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
    issueUrl: 'https://github.com/owner/repo/issues/1',
    contributor: 'contributor',
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
          fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: TIME },
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
  const store = RunStore.create(path.join(root, 'stores'), config, TIME);
  stores.push(store);
  store.recordUpstreamRepositoryId(11);
  for (const reason of [
    ReasonCode.GatePassed,
    ReasonCode.PlanApproved,
    ReasonCode.CandidateReady,
    ReasonCode.VerificationPassed,
  ])
    store.persistRun(transitionRun(store.run, reason, TIME));
  const dir = store.storeDirectory('artifacts');
  fs.cpSync(artifacts, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'verification'), { recursive: true, force: true });
  const boundaryFile = path.join(dir, template.boundaryInputRef.artifact);
  const input = JSON.parse(fs.readFileSync(boundaryFile, 'utf8'));
  input.runId = store.runId;
  const bytes = Buffer.from(JSON.stringify(input));
  fs.writeFileSync(boundaryFile, bytes, { mode: 0o600 });
  const { schemaVersion: _, recordDigest: __, ...body } = template;
  const verification = publishVerification(dir, {
    ...body,
    runId: store.runId,
    boundaryInputRef: { artifact: template.boundaryInputRef.artifact, digest: sha256(bytes) },
  });
  const candidate = candidateInput();
  // The trusted command plan is independent of the receipt and verification record.
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
  const deps: ShippingAuthorizeDeps = {
    store,
    fork: {
      repositoryId: 22,
      owner: 'contributor',
      repo: 'repo',
      fullName: 'contributor/repo',
      installationId: 33,
    },
    bindings: {
      contributionId: store.contributionId,
      forkRepositoryId: 22,
      forkOwner: 'contributor',
      forkRepo: 'repo',
      branch: 'task',
      candidateSha: candidate.candidateSha,
      baseSha: verification.baseSha,
      parentSha: verification.parentSha,
      sessionId: 'session-1',
      defaultBranch: 'main',
      policyDigest: 'a'.repeat(64),
      verificationDigest: verification.recordDigest,
      expectedRemoteSha: null,
    },
    profile: { digest: verification.profileDigest, binding: structuredClone(verification.profile) },
    commandPlan: {
      manager: 'npm',
      provisioning: [],
      verification: [
        report('npm-test', ['npm', 'test']),
        report('npm-test-regression', ['npm', 'test', '--', 'test/regression.test.js']),
      ],
    },
    manifest: structuredClone(candidate.manifest),
    record: structuredClone(candidate.record),
    authority: structuredClone(candidate.authority),
    basePack: Buffer.from(candidate.basePack),
    signer: new Ed25519Signer(keyFile),
    now: () => Date.parse(TIME),
    policyFresh: vi.fn(async () => true),
  };
  const authorize = () => makeAuthorize(deps)(shippingIntent(deps.bindings));
  const editBoundary = (change: Record<string, unknown>) =>
    fs.writeFileSync(boundaryFile, JSON.stringify({ ...input, ...change }), { mode: 0o600 });
  return { deps, store, verification, dir, boundaryFile, editBoundary, authorize };
}

describe('credential-free shipping authorization', () => {
  it('round-trips an attempted intent through single-use nonce authorization', async () => {
    const h = rig();
    const input = shippingIntent(h.deps.bindings);
    const intent = {
      ...input,
      key: idempotencyKey(input),
      status: 'attempted' as const,
      attempts: 1,
      retryReady: false,
      artifactRef: null,
    };
    const authorization = await makeAuthorize(h.deps)(intent);
    const directory = path.join(h.dir, 'nonce-store');
    fs.mkdirSync(directory, { mode: 0o700 });
    const nonces = new ReceiptNonceStore(directory);
    nonces.initialize();
    const key = await h.deps.signer.getPublicKey();
    const consume = () =>
      authorizeShipping(
        authorization.receipt,
        key,
        authorization.context,
        intent,
        null,
        nonces,
        h.deps.now
      );
    await expect(consume()).resolves.toEqual(
      authorization.receipt.receipt.permittedShippingOperations[0]
    );
    await expect(consume()).rejects.toThrow();
  });

  it.each([
    'unknown binding',
    'missing binding',
    'unknown profile',
    'missing profile',
    'unsafe branch',
    'unsafe default branch',
  ])('refuses %s context input', async (kind) => {
    const h = rig();
    if (kind === 'unknown binding') Object.assign(h.deps.bindings, { extra: 1 });
    if (kind === 'missing binding')
      delete (h.deps.bindings as unknown as Record<string, unknown>).sessionId;
    if (kind === 'unknown profile') Object.assign(h.deps.profile.binding, { extra: 1 });
    if (kind === 'missing profile') Object.assign(h.deps.profile, { binding: null });
    if (kind === 'unsafe branch') Object.assign(h.deps.bindings, { branch: '../main' });
    if (kind === 'unsafe default branch')
      Object.assign(h.deps.bindings, { defaultBranch: '../main' });
    await expect(buildReceiptContext(h.deps)).rejects.toThrow();
  });

  it('refuses mismatched intent kind, target, contributor binding and candidate', async () => {
    const h = rig();
    const intent = shippingIntent(h.deps.bindings);
    for (const change of [
      { operationKind: 'pr_create' as const },
      { target: 'fork:99:branch:task' },
      { contributionId: 'other' },
      { candidateSha: 'f'.repeat(40) },
    ])
      await expect(makeAuthorize(h.deps)({ ...intent, ...change })).rejects.toThrow(
        'operation_denied'
      );
  });
  it('keeps boundary reads pinned when the artifacts pathname is replaced', async () => {
    const h = rig();
    const artifacts = h.store.storeDirectory('artifacts');
    const held = `${artifacts}-held`;
    const clean = fs.readFileSync(h.boundaryFile);
    h.editBoundary({ listenerConnections: 1 });
    const original = h.store.withStoreDirectory.bind(h.store);
    vi.spyOn(h.store, 'withStoreDirectory').mockImplementation((name, work) =>
      original(name, (directory) => {
        fs.renameSync(artifacts, held);
        fs.mkdirSync(artifacts, { mode: 0o700 });
        fs.writeFileSync(path.join(artifacts, path.basename(h.boundaryFile)), clean, {
          mode: 0o600,
        });
        return work(directory);
      })
    );
    await expect(buildReceiptContext(h.deps)).rejects.toThrow('boundary_not_held');
    expect(h.deps.policyFresh).not.toHaveBeenCalled();
  });
  it('normalizes policy and malformed boundary diagnostics without echoing supplied text', async () => {
    const h = rig();
    const sentinel = 'private-provider-response';
    vi.mocked(h.deps.policyFresh).mockRejectedValue(new Error(sentinel));
    await expect(buildReceiptContext(h.deps)).rejects.toThrow('policy_unavailable');
    await expect(buildReceiptContext(h.deps)).rejects.not.toThrow(sentinel);
    fs.writeFileSync(h.boundaryFile, `{"${sentinel}":`, { mode: 0o600 });
    await expect(buildReceiptContext(h.deps)).rejects.toThrow('boundary_evidence_invalid');
    await expect(buildReceiptContext(h.deps)).rejects.not.toThrow(sentinel);
  });
  it('reconstructs the canonical candidate and issues a fresh single grant on each attempt', async () => {
    const h = rig();
    const first = await h.authorize();
    const second = await h.authorize();
    expect(first.candidate.record).toEqual(h.deps.record);
    expect(first.context.requiredCommands).toEqual([
      { id: 'npm-test', command: 'npm test' },
      { id: 'npm-test-regression', command: 'npm test -- test/regression.test.js' },
    ]);
    expect(first.receipt.receipt.permittedShippingOperations).toHaveLength(1);
    expect(first.receipt.receipt.permittedShippingOperations[0]?.operationKey).toBe(
      idempotencyKey(shippingIntent(h.deps.bindings))
    );
    expect(first.receipt.receipt.permittedShippingOperations[0]?.nonce).not.toBe(
      second.receipt.receipt.permittedShippingOperations[0]?.nonce
    );
    expect(h.deps.policyFresh).toHaveBeenCalledTimes(4);
    expect(first.context.boundaryEvidence.runId).toBe(h.store.runId);
    await expect(
      verifyReceipt(first.receipt, await h.deps.signer.getPublicKey(), first.context, h.deps.now)
    ).resolves.toEqual(first.receipt.receipt);
  });

  it('accepts revising and carries the ledger compare-and-swap SHA', async () => {
    const h = rig();
    h.store.persistRun(transitionRun(h.store.run, ReasonCode.PublicationObserved, TIME));
    h.store.persistRun(transitionRun(h.store.run, ReasonCode.RevisionRequested, TIME));
    Object.assign(h.deps.bindings, { expectedRemoteSha: h.deps.record.baseSha });
    const result = await h.authorize();
    expect(result.context.allowedShippingOperations[0]?.expectedRemoteSha).toBe(
      h.deps.record.baseSha
    );
    expect((await buildReceiptContext(h.deps)).policyPermitsShipping).toBe(true);
  });

  it.each([
    'boundary missing',
    'boundary malformed',
    'boundary breached',
    'wrong run',
    'earlier failed VM',
  ])('refuses %s before policy or signing', async (kind) => {
    const h = rig();
    const sign = vi.spyOn(h.deps.signer, 'sign');
    if (kind === 'boundary missing') fs.rmSync(h.boundaryFile);
    if (kind === 'boundary malformed') fs.writeFileSync(h.boundaryFile, '{');
    if (kind === 'boundary breached') h.editBoundary({ listenerConnections: 1 });
    if (kind === 'wrong run') h.editBoundary({ runId: 'other-run' });
    if (kind === 'earlier failed VM')
      fs.writeFileSync(path.join(h.dir, `boundary-${'d'.repeat(32)}.json`), '{}', { mode: 0o600 });
    await expect(h.authorize()).rejects.toThrow();
    expect(h.deps.policyFresh).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([
    'cancelled',
    'unknown upstream',
    'wrong fork id',
    'wrong fork owner',
    'upstream fork',
    'invalid installation',
    'wrong contribution',
  ])('refuses %s identity/state', async (kind) => {
    const h = rig();
    if (kind === 'cancelled')
      h.store.persistRun(transitionRun(h.store.run, ReasonCode.UserCancelled, TIME));
    if (kind === 'unknown upstream')
      Object.assign(h.deps, {
        store: {
          ...h.store,
          validateEvidence: () => h.store.validateEvidence(),
          upstreamRepositoryId: undefined,
        },
      });
    if (kind === 'wrong fork id') Object.assign(h.deps.fork, { repositoryId: 23 });
    if (kind === 'wrong fork owner') Object.assign(h.deps.fork, { owner: 'other' });
    if (kind === 'upstream fork') Object.assign(h.deps.fork, { repositoryId: 11 });
    if (kind === 'invalid installation') Object.assign(h.deps.fork, { installationId: 0 });
    if (kind === 'wrong contribution') Object.assign(h.deps.bindings, { contributionId: 'other' });
    await expect(h.authorize()).rejects.toThrow();
    expect(h.deps.policyFresh).not.toHaveBeenCalled();
  });

  it.each([
    'missing record',
    'wrong digest',
    'omitted command',
    'empty plan',
    'duplicate plan',
    'online plan',
    'wrong profile',
    'wrong base',
    'changed SHA',
    'changed manifest',
    'changed author',
  ])('refuses %s', async (kind) => {
    const h = rig();
    if (kind === 'missing record')
      fs.rmSync(path.join(h.dir, 'verification', `${h.verification.candidateSha}.json`));
    if (kind === 'wrong digest')
      Object.assign(h.deps.bindings, { verificationDigest: 'f'.repeat(64) });
    if (kind === 'omitted command')
      (h.deps.commandPlan.verification as unknown[]).push({
        ...h.deps.commandPlan.verification[0],
        id: 'must-run',
      });
    if (kind === 'empty plan') Object.assign(h.deps.commandPlan, { verification: [] });
    if (kind === 'duplicate plan')
      (h.deps.commandPlan.verification as unknown[]).push(h.deps.commandPlan.verification[0]);
    if (kind === 'online plan')
      Object.assign(h.deps.commandPlan.verification[0] as object, { network: 'package_proxy' });
    if (kind === 'wrong profile') Object.assign(h.deps.profile, { digest: 'f'.repeat(64) });
    if (kind === 'wrong base') Object.assign(h.deps.bindings, { baseSha: 'b'.repeat(40) });
    if (kind === 'changed SHA') Object.assign(h.deps.bindings, { candidateSha: 'b'.repeat(40) });
    if (kind === 'changed manifest')
      Object.assign(h.deps.manifest.entries[0] as object, { bytes: 'YWx0ZXJlZA==' });
    if (kind === 'changed author') Object.assign(h.deps.authority.author, { login: 'other' });
    await expect(h.authorize()).rejects.toThrow();
  });

  it.each(['false', 'unknown', 'throws'])('refuses %s policy before signing', async (kind) => {
    const h = rig();
    Object.assign(h.deps, {
      policyFresh: async () => {
        if (kind === 'throws') throw new Error('probe');
        return kind === 'false' ? false : undefined;
      },
    });
    const sign = vi.spyOn(h.deps.signer, 'sign');
    await expect(h.authorize()).rejects.toThrow();
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([
    'bindings',
    'fork',
    'plan',
    'profile',
    'manifest',
    'record',
    'authority',
    'pack',
    'run',
    'record file',
  ])('fails closed on hostile async %s mutation', async (kind) => {
    const h = rig();
    Object.assign(h.deps, {
      policyFresh: async () => {
        if (kind === 'bindings')
          Object.assign(h.deps.bindings, { contributor: 'other', sessionId: 'other-session' });
        if (kind === 'fork') Object.assign(h.deps.fork, { owner: 'other' });
        if (kind === 'plan')
          Object.assign(h.deps.commandPlan.verification[0] as object, { argv: ['true'] });
        if (kind === 'profile') Object.assign(h.deps.profile, { digest: 'b'.repeat(64) });
        if (kind === 'manifest') Object.assign(h.deps.manifest, { digest: 'b'.repeat(64) });
        if (kind === 'record') Object.assign(h.deps.record, { candidateSha: 'b'.repeat(40) });
        if (kind === 'authority') Object.assign(h.deps.authority.author, { name: 'Other' });
        if (kind === 'pack') h.deps.basePack.fill(0);
        if (kind === 'run')
          h.store.persistRun(transitionRun(h.store.run, ReasonCode.UserCancelled, TIME));
        if (kind === 'record file')
          fs.rmSync(path.join(h.dir, 'verification', `${h.verification.candidateSha}.json`));
        return true;
      },
    });
    await expect(h.authorize()).rejects.toThrow();
  });

  it('detaches the requested intent before policy yields', async () => {
    const h = rig();
    const intent = shippingIntent(h.deps.bindings);
    Object.assign(h.deps, {
      policyFresh: async () => {
        Object.assign(intent, { target: 'fork:99:branch:evil' });
        return true;
      },
    });
    const result = await makeAuthorize(h.deps)(intent);
    expect(result.receipt.receipt.permittedShippingOperations[0]?.target).toBe(
      'fork:22:branch:task'
    );
  });

  it('refuses supplied verification or binding substitutions and mutation while signing', async () => {
    const h = rig();
    await expect(
      issueShippingReceipt(
        h.deps,
        { ...h.verification, verdict: 'failed' },
        h.deps.bindings,
        h.deps.now
      )
    ).rejects.toThrow();
    await expect(
      issueShippingReceipt(
        h.deps,
        h.verification,
        { ...h.deps.bindings, branch: 'other' },
        h.deps.now
      )
    ).rejects.toThrow();
    const sign = h.deps.signer.sign.bind(h.deps.signer);
    vi.spyOn(h.deps.signer, 'sign').mockImplementation(async (content) => {
      Object.assign(h.deps.bindings, { sessionId: 'other' });
      return sign(content);
    });
    await expect(h.authorize()).rejects.toThrow();
  });
});

async function handoffRig() {
  const h = rig();
  const authorization = await h.authorize();
  const deps = {
    ...h.deps,
    receipt: authorization.receipt,
    trustedControllerKey: await h.deps.signer.getPublicKey(),
    readLogin: vi.fn(async () => 'contributor'),
    checkForkReadiness: vi.fn(async () => ({
      kind: 'ready' as const,
      fork: h.deps.fork,
      run: h.store.run,
    })),
    remoteBranchSha: vi.fn(async (): Promise<string | null> => h.deps.bindings.candidateSha),
  };
  return { ...h, authorization, admissionDeps: deps, admission: makeHandoffAdmission(deps) };
}

describe('handoff admission', () => {
  it('requires fresh authenticated facts, accepts the receipt once, and checks verified push read-back', async () => {
    const h = await handoffRig();
    expect(await h.admission.policyFresh()).toBe(true);
    expect(await h.admission.contributorVerified()).toBe(true);
    expect(await h.admission.forkBindingVerified()).toBe(true);
    expect(
      await h.admission.receiptValid(h.deps.bindings.candidateSha, h.authorization.receipt.digest)
    ).toBe(true);
    expect(
      await h.admission.receiptValid(h.deps.bindings.candidateSha, h.authorization.receipt.digest)
    ).toBe(false);
    expect(await h.admission.remoteBranchSha()).toBe(h.deps.bindings.candidateSha);
  });

  it('refuses wrong contributor, unreadable identity, wrong fork and unknown readiness', async () => {
    const h = await handoffRig();
    h.admissionDeps.readLogin.mockResolvedValue('other');
    expect(await h.admission.contributorVerified()).toBe(false);
    h.admissionDeps.readLogin.mockRejectedValue(new Error('unknown'));
    expect(await h.admission.contributorVerified()).toBe(false);
    h.admissionDeps.checkForkReadiness.mockResolvedValue({
      kind: 'ready',
      run: h.store.run,
      fork: { ...h.deps.fork, repositoryId: 23 },
    });
    expect(await h.admission.forkBindingVerified()).toBe(false);
    h.admissionDeps.checkForkReadiness.mockResolvedValue({ kind: 'unknown' } as never);
    expect(await h.admission.forkBindingVerified()).toBe(false);
  });

  it('refuses wrong candidate/digest, invalid signature, expiry, stale policy and concurrent replay', async () => {
    const h = await handoffRig();
    const sha = h.deps.bindings.candidateSha;
    const digest = h.authorization.receipt.digest;
    expect(await h.admission.receiptValid('a'.repeat(40), digest)).toBe(false);
    expect(await h.admission.receiptValid(sha, 'a'.repeat(64))).toBe(false);
    Object.assign(h.admissionDeps, { now: () => Date.parse(TIME) + 900000 });
    expect(await h.admission.receiptValid(sha, digest)).toBe(false);
    Object.assign(h.admissionDeps, { now: h.deps.now, policyFresh: async () => false });
    expect(await h.admission.policyFresh()).toBe(false);
    expect(await h.admission.receiptValid(sha, digest)).toBe(false);
    Object.assign(h.admissionDeps, { policyFresh: h.deps.policyFresh });
    const outcomes = await Promise.all([
      h.admission.receiptValid(sha, digest),
      h.admission.receiptValid(sha, digest),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    h.admissionDeps.receipt.signature.signature = 'invalid';
    expect(await makeHandoffAdmission(h.admissionDeps).receiptValid(sha, digest)).toBe(false);
  });

  it.each([
    'contributor',
    'fork',
    'receipt',
    'remote',
  ])('refuses hostile async mutation during %s admission', async (kind) => {
    const h = await handoffRig();
    const mutate = () => Object.assign(h.deps.bindings, { sessionId: 'other' });
    if (kind === 'contributor') {
      h.admissionDeps.readLogin.mockImplementation(async () => {
        mutate();
        return 'contributor';
      });
      expect(await h.admission.contributorVerified()).toBe(false);
    }
    if (kind === 'fork') {
      h.admissionDeps.checkForkReadiness.mockImplementation(async () => {
        mutate();
        return { kind: 'ready', fork: h.deps.fork, run: h.store.run };
      });
      expect(await h.admission.forkBindingVerified()).toBe(false);
    }
    if (kind === 'receipt') {
      Object.assign(h.admissionDeps, {
        policyFresh: async () => {
          h.admissionDeps.receipt.digest = 'f'.repeat(64);
          return true;
        },
      });
      expect(
        await h.admission.receiptValid(h.deps.bindings.candidateSha, h.authorization.receipt.digest)
      ).toBe(false);
    }
    if (kind === 'remote') {
      h.admissionDeps.remoteBranchSha.mockImplementation(async () => {
        mutate();
        return h.deps.bindings.candidateSha;
      });
      await expect(h.admission.remoteBranchSha()).rejects.toThrow();
    }
  });

  it('refuses missing/unverified remote branches and throwing read-back', async () => {
    const h = await handoffRig();
    h.admissionDeps.remoteBranchSha.mockResolvedValue(null);
    await expect(h.admission.remoteBranchSha()).rejects.toThrow();
    h.admissionDeps.remoteBranchSha.mockRejectedValue(new Error('unverified'));
    await expect(h.admission.remoteBranchSha()).rejects.toThrow('remote_read_unavailable');
    await expect(h.admission.remoteBranchSha()).rejects.not.toThrow('unverified');
  });
});

describe('PR content data', () => {
  it('uses only verified regression evidence and policy-gated baseline/receipt content, with base drift disclosure', async () => {
    const h = rig();
    const { receipt } = await h.authorize();
    const input = {
      intent: {
        ...shippingIntent(h.deps.bindings),
        operationKind: 'pr_create' as const,
        target: 'https://github.com/owner/repo/pulls',
      },
      receipt,
      verification: h.verification,
      candidateReady: { title: 'Fix', cause: 'Untrusted cause', scope: 'Untrusted scope' },
      policy: { receiptBlockAllowed: false, baselineFailuresPermitted: false },
      baselineFailures: ['existing failure'],
      limitations: ['Known limit'],
      template: 'Untrusted template',
      currentBaseSha: 'd'.repeat(40),
    };
    const content = prContentInput(input);
    expect(content.receiptAllowed).toBe(false);
    expect(content.baselineFailures).toBeUndefined();
    expect(content.regression).toEqual({
      command: 'npm test -- test/regression.test.js',
      baseStatus: 'failed',
      candidateStatus: 'passed',
    });
    expect(content.limitations[1]).toBe(
      `Verified on base \`${h.verification.baseSha}\`; upstream is now at \`${input.currentBaseSha}\`; the merge result was not verified`
    );
    expect(content.template).toBe(input.template);
    const hostileText = prContentInput({
      ...input,
      candidateReady: {
        ...input.candidateReady,
        issue: 99,
        intent: { ...input.intent, contributionId: 'other' },
      } as never,
    });
    expect(hostileText.issue).toBe(1);
    expect(hostileText.intent).toEqual(input.intent);
    input.policy.baselineFailuresPermitted = true;
    input.policy.receiptBlockAllowed = true;
    input.currentBaseSha = h.verification.baseSha;
    const allowed = prContentInput(input);
    expect(allowed.baselineFailures).toEqual({ permitted: true, failures: ['existing failure'] });
    expect(allowed.limitations).toEqual(['Known limit']);
    expect(allowed.receiptAllowed).toBe(true);
    input.baselineFailures.push('later');
    expect(allowed.baselineFailures?.failures).toEqual(['existing failure']);
    expect(() => prContentInput({ ...input, intent: shippingIntent(h.deps.bindings) })).toThrow();
    expect(() => prContentInput({ ...input, currentBaseSha: 'unknown' })).toThrow();
    expect(() =>
      prContentInput({
        ...input,
        verification: { ...h.verification, candidateSha: 'b'.repeat(40) },
      })
    ).toThrow();
    const minimal = prContentInput({
      intent: input.intent,
      receipt,
      verification: h.verification,
      candidateReady: input.candidateReady,
      policy: input.policy,
      currentBaseSha: h.verification.baseSha,
    });
    expect(minimal.limitations).toEqual([]);
    expect(minimal.template).toBeUndefined();
    expect(canonicalJson(content.receipt)).toBe(canonicalJson(receipt.receipt));
  });
});
