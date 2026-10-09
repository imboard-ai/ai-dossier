/** Offline producer-to-shipping integration: real persistence, Git and admission gates. */
import fs from 'node:fs';
import os from 'node:os';
import { Ed25519Signer } from '@ai-dossier/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { candidateInput, harness, removeTemps, TIME } from '../__tests__/verifier-fixture';
import {
  FORK_ID,
  GitHubFake,
  INSTALLATION_ID,
  OWNER,
  UPSTREAM_ID,
} from '../github/__tests__/github-fake';
import { BRANCH, Fork, journal, TARGET, temp } from '../github/__tests__/push-rig';
import { GitPushCredential } from '../github/broker';
import { HandoffDriver } from '../github/handoff-driver';
import { ForkPusher, type ForkPusherOptions } from '../github/push';
import { IntentDriver, MutationUncertainError, WriteBlockedError } from '../intents';
import { Journal } from '../journal';
import { ReceiptNonceStore } from '../receipt/nonces';
import { ReasonCode, transitionRun } from '../state';
import {
  shippingCommandPlan,
  shippingStore,
  shippingVerification,
} from './__tests__/shipping-fixture';
import type { RunStore } from './run-store';
import {
  makeAuthorize,
  makeHandoffAdmission,
  prContentInput,
  type ShippingAuthorization,
  type ShippingAuthorizeDeps,
  shippingIntent,
} from './shipping';
import type { VerificationRecord } from './verification-record';
import { verifyCandidate } from './verifier';

let template: VerificationRecord;
let sourceArtifacts: string;
const stores: RunStore[] = [];
beforeAll(async () => {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    fixture: [
      { address: '127.0.0.1', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
    ],
  });
  const h = harness();
  const result = await verifyCandidate(h.deps(), candidateInput());
  if (result.kind !== 'verified') throw new Error('verification fixture failed');
  template = result.record;
  sourceArtifacts = h.artifactsDir;
  vi.restoreAllMocks();
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
afterAll(removeTemps);

class LocalForkPusher extends ForkPusher {
  constructor(
    options: ForkPusherOptions,
    private readonly bare: string
  ) {
    super(options);
  }
  protected override remote(): { url: string; config: readonly string[] } {
    return { url: `file://${this.bare}`, config: ['protocol.file.allow=always'] };
  }
}

async function rig() {
  const root = temp('zt-shipping-integration-');
  const { store, keyFile } = shippingStore(
    root,
    'https://github.com/o/r/issues/1',
    OWNER,
    UPSTREAM_ID,
    TIME
  );
  stores.push(store);
  const {
    dir: artifacts,
    boundaryFile,
    input: boundary,
    verification,
  } = shippingVerification(store, sourceArtifacts, template);
  const candidate = candidateInput();
  const deps: ShippingAuthorizeDeps = {
    store,
    fork: {
      repositoryId: FORK_ID,
      owner: OWNER,
      repo: 'fixture',
      fullName: `${OWNER}/fixture`,
      installationId: INSTALLATION_ID,
    },
    bindings: {
      contributionId: store.contributionId,
      forkRepositoryId: FORK_ID,
      forkOwner: OWNER,
      forkRepo: 'fixture',
      branch: BRANCH,
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
    commandPlan: shippingCommandPlan(),
    manifest: structuredClone(candidate.manifest),
    record: structuredClone(candidate.record),
    authority: structuredClone(candidate.authority),
    basePack: Buffer.from(candidate.basePack),
    signer: new Ed25519Signer(keyFile),
    now: () => Date.parse(TIME),
    policyFresh: vi.fn(async () => true),
  };
  const fork = new Fork();
  const ledger = journal(temp('zt-shipping-ledger-'));
  const nonceDir = temp('zt-shipping-nonces-');
  const nonces = new ReceiptNonceStore(nonceDir);
  nonces.initialize();
  // Nonce consumption opens its own journal; observers must release the writer fence.
  const nonceJournal = {
    read: () => {
      const rows = new Journal(nonceDir);
      try {
        return rows.read();
      } finally {
        rows.close();
      }
    },
  };
  const consume = vi.spyOn(nonces, 'consume');
  const broker: ForkPusherOptions['broker'] = {
    withForkPush: async (intent, target, operation) => {
      expect(intent.status).toBe('attempted');
      expect(target).toMatchObject({ repositoryId: FORK_ID });
      return operation(new GitPushCredential('fixture-local-only'), new AbortController().signal);
    },
  };
  const mint = vi.spyOn(broker, 'withForkPush');
  let authorization: ShippingAuthorization | undefined;
  const authorize = vi.fn(async (intent: Parameters<ForkPusherOptions['authorize']>[0]) => {
    authorization = await makeAuthorize(deps)(intent);
    return authorization;
  });
  const pusher = new LocalForkPusher(
    {
      broker,
      read: fork.read,
      fork: deps.fork,
      ledger,
      trustedControllerKey: await deps.signer.getPublicKey(),
      nonces,
      authorize,
      now: deps.now,
    },
    fork.dir
  );
  const driver = new IntentDriver(
    journal(temp('zt-shipping-intents-')),
    pusher,
    { run: store.run, contributionId: store.contributionId },
    () => TIME
  );
  const input = shippingIntent(deps.bindings);
  const editBoundary = (change: Record<string, unknown>) =>
    fs.writeFileSync(boundaryFile, JSON.stringify({ ...boundary, ...change }), { mode: 0o600 });
  const noPushEffects = () => {
    expect(consume).not.toHaveBeenCalled();
    expect(nonceJournal.read()).toHaveLength(1);
    expect(mint).not.toHaveBeenCalled();
    expect(ledger.read()).toEqual([]);
    expect(fork.sha()).toBeNull();
  };
  return {
    deps,
    store,
    verification,
    artifacts,
    boundaryFile,
    editBoundary,
    fork,
    ledger,
    nonces,
    nonceJournal,
    consume,
    broker,
    mint,
    authorize,
    pusher,
    driver,
    input,
    noPushEffects,
    authorization: () => {
      if (!authorization) throw new Error('no authorization');
      return authorization;
    },
  };
}

async function handoff(h: Awaited<ReturnType<typeof rig>>, receipt = h.authorization().receipt) {
  const fake = new GitHubFake(h.deps.now);
  fake.publicResponses.set(
    `/repos/o/r/pulls?state=all&head=${encodeURIComponent(`${OWNER}:${BRANCH}`)}&base=main&per_page=100&page=1`,
    { status: 200, body: [] }
  );
  const admissionDeps = {
    ...h.deps,
    receipt,
    trustedControllerKey: await h.deps.signer.getPublicKey(),
    readLogin: vi.fn(async () => fake.login),
    checkForkReadiness: vi.fn(async () => ({
      kind: 'ready' as const,
      fork: h.deps.fork,
      run: h.store.run,
    })),
    remoteBranchSha: vi.fn(h.pusher.handoffReadBack(TARGET)),
  };
  const admission = makeHandoffAdmission(admissionDeps);
  const rows = journal(temp('zt-shipping-handoffs-'));
  const bodyDirectory = temp('zt-shipping-bodies-');
  const driver = new HandoffDriver(
    rows,
    { read: fake.read, admission, bodyDirectory, now: () => TIME },
    { run: h.store.run, contributionId: h.store.contributionId }
  );
  const content = prContentInput({
    intent: { ...h.input, operationKind: 'pr_create', target: 'https://github.com/o/r/pulls' },
    receipt,
    verification: h.verification,
    candidateReady: {
      title: 'Fix duration rounding',
      cause: 'Duration rounds incorrectly',
      scope: 'Correct duration calculation',
    },
    policy: { receiptBlockAllowed: true, baselineFailuresPermitted: false },
    currentBaseSha: h.verification.baseSha,
  });
  const request = {
    binding: {
      upstream: { owner: 'o', repo: 'r' },
      base: 'main',
      headOwner: OWNER,
      branch: BRANCH,
    },
    content,
  };
  return { fake, admissionDeps, admission, rows, bodyDirectory, driver, request };
}

describe('persisted verification to real local shipping (#1105)', () => {
  it('detaches queued PR provenance before caller mutation and persists the rendered candidate', async () => {
    const h = await rig();
    await h.driver.execute(h.input);
    const p = await handoff(h);
    const pending = p.driver.issuePr(p.request);
    Object.assign(p.request.content.intent, { candidateSha: 'f'.repeat(40) });
    p.request.binding.branch = 'unverified-other';
    p.request.content.title = 'Replacement title';
    await expect(pending).resolves.toMatchObject({ kind: 'awaiting_contributor' });
    expect(p.rows.read()).toMatchObject([
      { type: 'handoff_run' },
      {
        type: 'link_issued',
        input: { candidateSha: h.input.candidateSha },
        binding: { branch: BRANCH },
        title: 'Fix duration rounding',
      },
    ]);
    expect(p.driver.status()?.link).toContain(`/compare/main...${OWNER}:${BRANCH}`);
    const status = p.driver.status();
    if (!status) throw new Error('no status');
    expect(fs.readFileSync(status.bodyFile, 'utf8')).toContain(h.input.candidateSha);
  });

  it.each([
    'contributor',
    'fork',
    'remote',
  ])('refreshes %s after the final PR read and releases refused admission', async (kind) => {
    const h = await rig();
    await h.driver.execute(h.input);
    const p = await handoff(h);
    const get = p.fake.publicResponses.get.bind(p.fake.publicResponses);
    const probe = vi.spyOn(p.fake.publicResponses, 'get').mockImplementation((route) => {
      if (kind === 'contributor') p.fake.login = 'other';
      if (kind === 'fork')
        p.admissionDeps.checkForkReadiness.mockResolvedValue({
          kind: 'ready',
          run: h.store.run,
          fork: { ...h.deps.fork, repositoryId: FORK_ID + 1 },
        });
      if (kind === 'remote') h.fork.git(['update-ref', '-d', `refs/heads/${BRANCH}`]);
      return get(route);
    });
    await expect(p.driver.issuePr(p.request)).rejects.toThrow('admission_commit');
    expect(p.rows.read()).toHaveLength(1);
    expect(fs.readdirSync(p.bodyDirectory)).toEqual([]);
    probe.mockRestore();
    p.fake.login = OWNER;
    p.admissionDeps.checkForkReadiness.mockResolvedValue({
      kind: 'ready',
      run: h.store.run,
      fork: h.deps.fork,
    });
    if (kind === 'remote')
      h.fork.git(['update-ref', `refs/heads/${BRANCH}`, h.deps.bindings.candidateSha]);
    await expect(p.driver.issuePr(p.request)).resolves.toMatchObject({
      kind: 'awaiting_contributor',
    });
  });

  it('rolls back a final reservation on a legitimate pause and admits a resumed retry', async () => {
    const h = await rig();
    await h.driver.execute(h.input);
    const p = await handoff(h);
    const get = p.fake.publicResponses.get.bind(p.fake.publicResponses);
    const probe = vi.spyOn(p.fake.publicResponses, 'get').mockImplementation((route) => {
      h.store.persistRun(transitionRun(h.store.run, ReasonCode.UserPaused, TIME));
      return get(route);
    });
    await expect(p.driver.issuePr(p.request)).rejects.toThrow('admission_commit');
    expect(p.rows.read()).toHaveLength(1);
    expect(fs.readdirSync(p.bodyDirectory)).toEqual([]);
    probe.mockRestore();
    h.store.persistRun(transitionRun(h.store.run, ReasonCode.ResumeShipping, TIME));
    p.driver.observeRun(h.store.run);
    // Probe reservation availability without driver cleanup: commitPr releases its own hold.
    const sha = h.deps.bindings.candidateSha;
    const digest = h.authorization().receipt.digest;
    expect(await p.admission.receiptValid(sha, digest)).toBe(true);
    h.store.persistRun(transitionRun(h.store.run, ReasonCode.UserPaused, TIME));
    expect(await p.admission.commitPr(sha, digest)).toBe(false);
    h.store.persistRun(transitionRun(h.store.run, ReasonCode.ResumeShipping, TIME));
    p.driver.observeRun(h.store.run);
    await expect(p.driver.issuePr(p.request)).resolves.toMatchObject({
      kind: 'awaiting_contributor',
    });
  });

  it.each([
    'policy',
    'boundary',
    'cancelled',
  ])('refuses %s revoked during final PR reconciliation', async (kind) => {
    const h = await rig();
    await h.driver.execute(h.input);
    const p = await handoff(h);
    const get = p.fake.publicResponses.get.bind(p.fake.publicResponses);
    vi.spyOn(p.fake.publicResponses, 'get').mockImplementation((route) => {
      if (kind === 'policy') vi.mocked(h.deps.policyFresh).mockResolvedValue(false);
      if (kind === 'boundary') fs.rmSync(h.boundaryFile);
      if (kind === 'cancelled')
        h.store.persistRun(transitionRun(h.store.run, ReasonCode.UserCancelled, TIME));
      return get(route);
    });
    await expect(p.driver.issuePr(p.request)).rejects.toThrow('admission_commit');
    expect(p.rows.read()).toHaveLength(1);
    expect(fs.readdirSync(p.bodyDirectory)).toEqual([]);
    expect(h.mint).toHaveBeenCalledTimes(1);
  });
  it('cannot replace read-back or controller key while contributor admission awaits', async () => {
    const h = await rig();
    await h.driver.execute(h.input);
    const p = await handoff(h);
    p.admissionDeps.remoteBranchSha.mockRejectedValue(new Error('no verified push'));
    p.admissionDeps.readLogin.mockImplementation(async () => {
      Object.assign(p.admissionDeps, {
        remoteBranchSha: async () => h.input.candidateSha,
        trustedControllerKey: 'replacement-key',
      });
      return OWNER;
    });
    await expect(p.driver.issuePr(p.request)).rejects.toThrow('admission_contributor');
    expect(Object.isFrozen(p.admission)).toBe(true);
    expect(p.rows.read()).toHaveLength(1);
    expect(fs.readdirSync(p.bodyDirectory)).toEqual([]);
  });
  it.each([
    'branch',
    'base',
  ])('refuses substituted PR %s before publishing any link', async (field) => {
    const h = await rig();
    await h.driver.execute(h.input);
    const p = await handoff(h);
    Object.assign(p.request.binding, { [field]: 'unverified-other' });
    const before = p.rows.read();
    await expect(p.driver.issuePr(p.request)).rejects.toThrow('admission_pr_binding');
    expect(p.rows.read()).toEqual(before);
    expect(fs.readdirSync(p.bodyDirectory)).toEqual([]);
    expect(p.fake.calls).toEqual([]);
    expect(h.mint).toHaveBeenCalledTimes(1);
  });
  it('retries the same handoff admission after transient read-back and reconciliation failures', async () => {
    const h = await rig();
    await h.driver.execute(h.input);
    const p = await handoff(h);
    p.admissionDeps.remoteBranchSha.mockRejectedValueOnce(new Error('temporary'));
    await expect(p.driver.issuePr(p.request)).rejects.toThrow('admission_remote_sha');
    const route = [...p.fake.publicResponses.keys()][0];
    if (!route) throw new Error('missing route');
    p.fake.publicResponses.set(route, { status: 503, body: {} });
    await expect(p.driver.issuePr(p.request)).rejects.toThrow('reconciliation_unavailable');
    expect(p.rows.read()).toHaveLength(1);
    expect(fs.readdirSync(p.bodyDirectory)).toEqual([]);
    p.fake.publicResponses.set(route, { status: 200, body: [] });
    await expect(p.driver.issuePr(p.request)).resolves.toMatchObject({
      kind: 'awaiting_contributor',
    });
    expect(
      p.rows.read().filter((row) => (row as { type: string }).type === 'link_issued')
    ).toHaveLength(1);
  });
  it('pushes the reconstructed candidate and issues a compare link only after verified read-back', async () => {
    const h = await rig();
    const prepared = await makeAuthorize(h.deps)(h.input);
    const receipt = prepared.receipt;
    const before = await handoff(h, receipt);
    await expect(before.driver.issuePr(before.request)).rejects.toThrow('admission_remote_sha');
    expect(before.rows.read()).toHaveLength(1);
    expect(fs.readdirSync(before.bodyDirectory)).toEqual([]);
    h.noPushEffects();
    // A matching ref alone cannot stand in for the controller's verified push ledger.
    h.fork.git(['index-pack', '--stdin'], prepared.candidate.pack);
    h.fork.git(['update-ref', `refs/heads/${BRANCH}`, h.deps.bindings.candidateSha]);
    const unverified = await handoff(h, receipt);
    await expect(unverified.driver.issuePr(unverified.request)).rejects.toThrow(
      'admission_remote_sha'
    );
    expect(unverified.rows.read()).toHaveLength(1);
    expect(fs.readdirSync(unverified.bodyDirectory)).toEqual([]);
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
    h.fork.git(['update-ref', '-d', `refs/heads/${BRANCH}`]);
    await expect(h.driver.execute(h.input)).resolves.toBe(`${TARGET}@${h.input.candidateSha}`);
    expect(h.fork.sha()).toBe(h.input.candidateSha);
    expect(await h.pusher.handoffReadBack(TARGET)()).toBe(h.input.candidateSha);
    expect(h.ledger.read()).toMatchObject([
      { type: 'push_intended', expectedRemoteSha: null },
      { type: 'push_verified', remoteSha: h.input.candidateSha },
    ]);
    expect(h.consume).toHaveBeenCalledTimes(1);
    expect(h.nonceJournal.read()).toHaveLength(2);
    expect(h.mint).toHaveBeenCalledTimes(1);
    const after = await handoff(h);
    const result = await after.driver.issuePr(after.request);
    expect(result.kind).toBe('awaiting_contributor');
    expect(after.driver.status()?.link).toContain(`/compare/main...${OWNER}:${BRANCH}`);
    expect(after.rows.read()).toMatchObject([{ type: 'handoff_run' }, { type: 'link_issued' }]);
    expect(after.fake.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(h.mint).toHaveBeenCalledTimes(1);
  });

  it.each([
    'missing',
    'breached',
  ])('scenario 4: %s persisted boundary refuses before nonce/token/ref effects', async (kind) => {
    const h = await rig();
    if (kind === 'missing') fs.rmSync(h.boundaryFile);
    else h.editBoundary({ listenerConnections: 1 });
    await expect(h.driver.execute(h.input)).rejects.toThrow();
    expect(h.deps.policyFresh).not.toHaveBeenCalled();
    h.noPushEffects();
  });

  it.each([
    'SHA',
    'manifest',
  ])('scenario 10: changed %s after verification refuses without effects', async (kind) => {
    const h = await rig();
    if (kind === 'SHA') Object.assign(h.deps.bindings, { candidateSha: 'f'.repeat(40) });
    else
      Object.assign(h.deps.manifest.entries[0] as object, {
        bytes: Buffer.from('changed\n').toString('base64'),
      });
    await expect(h.driver.execute(shippingIntent(h.deps.bindings))).rejects.toThrow();
    h.noPushEffects();
  });

  it.each([
    'contributor',
    'fork',
  ])('scenario 17: wrong %s refuses without push effects', async (kind) => {
    const h = await rig();
    if (kind === 'contributor') Object.assign(h.deps.authority.author, { login: 'other' });
    else Object.assign(h.deps.fork, { repositoryId: FORK_ID + 1 });
    await expect(h.driver.execute(h.input)).rejects.toThrow();
    h.noPushEffects();
  });

  it.each([
    'stale',
    'throwing',
    'omitted required command',
  ])('%s refuses before nonce/token/ref effects', async (kind) => {
    const h = await rig();
    if (kind === 'stale') Object.assign(h.deps, { policyFresh: async () => false });
    if (kind === 'throwing')
      Object.assign(h.deps, {
        policyFresh: async () => {
          throw new Error('policy unavailable');
        },
      });
    if (kind === 'omitted required command')
      (h.deps.commandPlan.verification as unknown[]).push({
        ...h.deps.commandPlan.verification[0],
        id: 'required-lint',
        argv: ['npm', 'run', 'lint'],
      });
    await expect(h.driver.execute(h.input)).rejects.toThrow();
    h.noPushEffects();
  });

  it('scenario 17: replayed receipt refuses on retry before another broker lease', async () => {
    const h = await rig();
    h.mint.mockImplementationOnce(async () => {
      throw new Error('lost before local push');
    });
    await expect(h.driver.execute(h.input)).rejects.toThrow(MutationUncertainError);
    const spent = h.authorization();
    expect(h.nonceJournal.read()).toHaveLength(2);
    expect(h.fork.sha()).toBeNull();
    await h.driver.resume();
    h.authorize.mockResolvedValueOnce(spent);
    const before = h.ledger.read();
    const error = await h.driver.execute(h.input).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WriteBlockedError);
    expect((error as Error).cause).toMatchObject({ detail: 'replayed_nonce' });
    expect(h.nonceJournal.read()).toHaveLength(2);
    expect(h.mint).toHaveBeenCalledTimes(1);
    expect(h.ledger.read()).toEqual(before);
    expect(h.fork.sha()).toBeNull();
  });

  it.each([
    'contributor',
    'fork',
    'receipt replay',
  ])('handoff refuses %s without publishing a link', async (kind) => {
    const h = await rig();
    await h.driver.execute(h.input);
    const p = await handoff(h);
    if (kind === 'contributor') p.fake.login = 'other';
    if (kind === 'fork')
      p.admissionDeps.checkForkReadiness.mockResolvedValue({
        kind: 'ready',
        run: h.store.run,
        fork: { ...h.deps.fork, repositoryId: FORK_ID + 1 },
      });
    if (kind === 'receipt replay')
      expect(
        await p.admission.receiptValid(
          h.input.candidateSha as string,
          h.authorization().receipt.digest
        )
      ).toBe(true);
    const nonceRows = h.nonceJournal.read();
    await expect(p.driver.issuePr(p.request)).rejects.toThrow(
      `admission_${kind === 'contributor' ? 'contributor' : kind === 'fork' ? 'fork_binding' : 'receipt'}`
    );
    expect(p.rows.read()).toHaveLength(1);
    expect(fs.readdirSync(p.bodyDirectory)).toEqual([]);
    expect(p.fake.calls).toEqual([]);
    expect(h.nonceJournal.read()).toEqual(nonceRows);
    expect(h.mint).toHaveBeenCalledTimes(1);
    expect(h.fork.sha()).toBe(h.input.candidateSha);
  });
});
