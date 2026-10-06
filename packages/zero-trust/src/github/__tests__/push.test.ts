/** #1066: verified expected-SHA (CAS) push. Git mechanics run against a local bare
 * repository standing in for the fork; ref reads go through an HTTP fake that answers
 * from that repository. No network, no real credentials. */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Ed25519Signer } from '@ai-dossier/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManifest, sha256 } from '../../canonical/export';
import { type CanonicalCandidate, createCandidate } from '../../canonical/reconstruct';
import { TrustedGit } from '../../canonical/trusted-git';
import {
  type Intent,
  IntentDriver,
  type IntentInput,
  idempotencyKey,
  MutationUncertainError,
  replayIntents,
  WriteBlockedError,
} from '../../intents';
import { Journal } from '../../journal';
import { issueReceipt, type ReceiptInput, type SignedReceipt } from '../../receipt/issue';
import { ReceiptNonceStore } from '../../receipt/nonces';
import type { ReceiptContext } from '../../receipt/verify';
import { createRun, ReasonCode, transitionRun } from '../../state';
import { AppCredentials } from '../app-auth';
import { ForkCredentialBroker } from '../broker';
import { ForkRefError, forkTarget, parseForkTarget, readForkBranch } from '../fork-ref';
import type { HandoffAdmission } from '../handoff-driver';
import { ForkPushError, ForkPusher, replayPushes, type ShippingAuthorization } from '../push';
import type { GitHubRead, GitHubResponse } from '../reconcile';
import { CLIENT_ID, FORK_ID, GitHubFake, INSTALLATION_ID, OWNER, UPSTREAM_ID } from './github-fake';

const FORK = Object.freeze({ repositoryId: FORK_ID, owner: OWNER, name: 'fixture' });
const BRANCH = 'fix-1066';
const TARGET = `fork:${FORK_ID}:branch:${BRANCH}`;
const DIGEST = 'c'.repeat(64);
const MINT = `POST /app/installations/${INSTALLATION_ID}/access_tokens`;
const iso = () => new Date().toISOString();
const author = Object.freeze({
  login: OWNER,
  name: 'Fixture Contributor',
  email: 'contributor@example.org',
  timestamp: '2026-10-06T10:00:00Z',
});
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const app = new AppCredentials({
  appId: '12345',
  clientId: CLIENT_ID,
  clientSecret: 'fixture-client-secret',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

const temps: string[] = [];
const journals: Journal[] = [];
function temp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}
function journal(dir: string): Journal {
  const j = new Journal(dir);
  journals.push(j);
  return j;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const j of journals.splice(0)) j.close();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Upstream base commit and its pack, built with trusted Git. */
function baseline(): { baseSha: string; pack: Buffer } {
  const git = new TrustedGit();
  try {
    const blob = git.run(['hash-object', '-w', '--stdin'], 'base\n').toString().trim();
    const tree = git
      .run(['mktree', '-z'], Buffer.from(`100644 blob ${blob}\tbase.txt\u0000`))
      .toString()
      .trim();
    const date = '1791194400 +0000';
    const baseSha = git
      .run(['commit-tree', tree], 'baseline\n', {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_COMMITTER_DATE: date,
      })
      .toString()
      .trim();
    return { baseSha, pack: git.run(['pack-objects', '--stdout', '--revs'], `${baseSha}\n`) };
  } finally {
    git.close();
  }
}
const BASE = baseline();
function candidateWith(content: string): CanonicalCandidate {
  const bytes = Buffer.from(content);
  return createCandidate(
    createManifest([
      {
        path: 'base.txt',
        mode: '100644',
        bytes: Buffer.from('base\n').toString('base64'),
        sha256: sha256('base\n'),
      },
      { path: 'fix.txt', mode: '100644', bytes: bytes.toString('base64'), sha256: sha256(bytes) },
    ]),
    {
      baseSha: BASE.baseSha,
      author,
      committerTimestamp: '2026-10-06T10:01:00Z',
      message: 'fix: verified contribution\n',
    },
    BASE.pack
  );
}
const C1 = candidateWith('first\n');
const C2 = candidateWith('rebased revision\n');
const SHA1 = C1.record.candidateSha;
const SHA2 = C2.record.candidateSha;

/** The contributor fork: a local bare repository. */
class Fork {
  readonly dir = temp('zt-fork-');
  constructor() {
    this.git(['init', '--bare', '--quiet']);
  }
  git(args: string[], input?: Buffer): string {
    return execFileSync('/usr/bin/git', ['--git-dir', this.dir, ...args], {
      input,
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    })
      .toString()
      .trim();
  }
  sha(branch = BRANCH): string | null {
    try {
      return this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    } catch {
      return null;
    }
  }
  /** Someone else moves the branch: a commit of their own on top of `base`. */
  outOfBand(branch = BRANCH): string {
    this.git(['index-pack', '--stdin'], BASE.pack);
    const tree = this.git(['rev-parse', `${BASE.baseSha}^{tree}`]);
    const sha = execFileSync(
      '/usr/bin/git',
      ['--git-dir', this.dir, 'commit-tree', tree, '-p', BASE.baseSha],
      {
        input: 'out of band\n',
        env: {
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_AUTHOR_NAME: 'Other',
          GIT_AUTHOR_EMAIL: 'other@example.org',
          GIT_COMMITTER_NAME: 'Other',
          GIT_COMMITTER_EMAIL: 'other@example.org',
        },
      }
    )
      .toString()
      .trim();
    this.git(['update-ref', `refs/heads/${branch}`, sha]);
    return sha;
  }
  /** Credential-free API fake answering from the bare repository. */
  readonly reads: string[] = [];
  readonly overrides: ((path: string) => GitHubResponse | 'throw' | undefined)[] = [];
  readonly read: GitHubRead = async (p) => {
    this.reads.push(p);
    for (const override of this.overrides) {
      const answer = override(p);
      if (answer === 'throw') throw new Error('synthetic transport failure');
      if (answer) return answer;
    }
    if (p === `/repos/${OWNER}/fixture`) return { status: 200, body: { id: FORK_ID, fork: true } };
    const prefix = `/repos/${OWNER}/fixture/git/ref/heads/`;
    if (p.startsWith(prefix)) {
      const branch = decodeURIComponent(p.slice(prefix.length));
      const sha = this.sha(branch);
      return sha
        ? { status: 200, body: { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } } }
        : { status: 404, body: { message: 'Not Found' } };
    }
    return { status: 404, body: null };
  };
  refReads(): number {
    return this.reads.filter((p) => p.includes('/git/ref/')).length;
  }
}

const shipping = [
  ReasonCode.GatePassed,
  ReasonCode.PlanApproved,
  ReasonCode.CandidateReady,
  ReasonCode.VerificationPassed,
].reduce(
  (run, reason) => transitionRun(run, reason, iso()),
  createRun(
    { runId: 'run-1', contributor: OWNER, upstreamIssue: 'https://github.com/o/r/issues/8' },
    iso()
  )
);
const pushOf = (candidateSha: string): IntentInput => ({
  contributionId: 'contribution-1',
  target: TARGET,
  operationKind: 'push_branch',
  candidateSha,
});

let signer: Ed25519Signer;
let publicKey: string;
beforeEach(async () => {
  const keys = generateKeyPairSync('ed25519');
  const keyFile = path.join(temp('zt-key-'), 'controller.pem');
  fs.writeFileSync(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  signer = new Ed25519Signer(keyFile);
  publicKey = await signer.getPublicKey();
});

interface Grant {
  candidate: CanonicalCandidate;
  expected: string | null;
  nonce: string;
  receipt?: Partial<ReceiptInput>;
  context?: Partial<ReceiptContext>;
}
function receiptInput(g: Grant): ReceiptInput {
  const input = pushOf(g.candidate.record.candidateSha);
  return {
    contributionId: input.contributionId,
    runId: 'run-1',
    sessionId: 'session-1',
    contributor: OWNER,
    upstreamRepositoryId: UPSTREAM_ID,
    forkRepositoryId: FORK_ID,
    issue: 8,
    defaultBranch: 'main',
    baseSha: BASE.baseSha,
    parentSha: BASE.baseSha,
    candidateSha: g.candidate.record.candidateSha,
    profileDigest: DIGEST,
    policyDigest: DIGEST,
    profile: { name: 'node-22', runtime: '22.0.0', imageDigest: `sha256:${DIGEST}` },
    commands: [
      {
        id: 'regression',
        command: 'npm test',
        required: true,
        status: 'passed',
        exitStatus: 0,
        suites: 3,
        sanitizedLogDigest: DIGEST,
      },
    ],
    networkPolicy: {
      acquisition: 'github-public',
      provisioning: 'package-proxy',
      verification: 'offline',
      shipping: 'github-clean',
    },
    permittedShippingOperations: [
      {
        kind: 'push_branch',
        target: TARGET,
        operationKey: idempotencyKey(input),
        nonce: g.nonce,
        expectedRemoteSha: g.expected,
      },
    ],
    ...g.receipt,
  };
}
async function authorization(g: Grant): Promise<ShippingAuthorization> {
  const input = receiptInput({ ...g, receipt: undefined });
  const receipt: SignedReceipt = await issueReceipt({ ...input, ...g.receipt }, signer, Date.now);
  const { commands: _c, permittedShippingOperations: _p, ...bindings } = input;
  const context: ReceiptContext = {
    ...bindings,
    requiredCommands: [{ id: 'regression', command: 'npm test' }],
    policyPermitsShipping: true,
    allowedShippingOperations: [
      { kind: 'push_branch', target: TARGET, expectedRemoteSha: g.expected },
    ],
    ...g.context,
  };
  return { receipt, context, candidate: g.candidate };
}

/** One controller process: intent journal, broker, nonce store, push ledger, pusher. */
class Rig {
  readonly fork: Fork;
  readonly fake = new GitHubFake(Date.now);
  readonly dirs: { intents: string; tokens: string; nonces: string; pushes: string };
  readonly grants: Grant[] = [];
  readonly sleeps: number[] = [];
  driver!: IntentDriver;
  broker!: ForkCredentialBroker;
  pusher!: ForkPusher;
  ledger!: Journal;
  /** Wraps the broker, e.g. to lose the push response. */
  wrap: (inner: ForkCredentialBroker['withForkPush']) => ForkCredentialBroker['withForkPush'] = (
    inner
  ) => inner;
  constructor(previous?: Rig) {
    this.fork = previous?.fork ?? new Fork();
    this.dirs = previous?.dirs ?? {
      intents: temp('zt-intents-'),
      tokens: temp('zt-tokens-'),
      nonces: temp('zt-nonces-'),
      pushes: temp('zt-pushes-'),
    };
    if (!previous) new ReceiptNonceStore(this.dirs.nonces).initialize();
  }
  async start(): Promise<this> {
    const tokens = journal(this.dirs.tokens);
    this.broker = new ForkCredentialBroker({
      store: tokens,
      http: this.fake.http,
      app,
      fork: { repositoryId: FORK_ID, installationId: INSTALLATION_ID, owner: OWNER },
      intents: () => this.driver.snapshot(),
    });
    expect((await this.broker.recover()).admitted).toBe(true);
    this.ledger = journal(this.dirs.pushes);
    this.pusher = new ForkPusher({
      broker: {
        withForkPush: (...args) =>
          this.wrap(this.broker.withForkPush.bind(this.broker) as never)(...args),
      },
      read: this.fork.read,
      fork: FORK,
      ledger: this.ledger,
      trustedControllerKey: publicKey,
      nonces: new ReceiptNonceStore(this.dirs.nonces),
      authorize: async () => {
        const grant = this.grants.shift();
        if (!grant) throw new Error('no authorization prepared');
        return authorization(grant);
      },
      sleep: async (ms) => {
        this.sleeps.push(ms);
      },
      localRemote: this.fork.dir,
    });
    this.driver = new IntentDriver(
      journal(this.dirs.intents),
      this.pusher,
      { run: shipping, contributionId: 'contribution-1' },
      iso
    );
    return this;
  }
  /** A restart: the old process is gone; journals, nonces and the fork survive. */
  async restart(): Promise<Rig> {
    this.broker.close();
    for (const j of journals.splice(0)) j.close();
    return new Rig(this).start();
  }
  mints(): number {
    return this.fake.count(MINT);
  }
  events(): string[] {
    return this.ledger.read().map((e) => (e as { type: string }).type);
  }
}
const rig = () => new Rig().start();

describe('verified CAS push to the fork (#1066)', () => {
  it('pushes exactly the candidate under a fork-only lease, persisting expected first (AC2/AC4)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    let ledgerAtPreflight: string[] = [];
    r.fork.overrides.push((p) => {
      if (p.includes('/git/ref/') && r.fork.refReads() === 1) ledgerAtPreflight = r.events();
      return undefined;
    });
    const exec = vi.spyOn(TrustedGit.prototype, 'exec');
    expect(r.pusher.expectedRemoteSha(pushOf(SHA1))).toBeNull();
    const ref = await r.driver.execute(pushOf(SHA1));
    expect(ref).toBe(`${TARGET}@${SHA1}`);
    expect(r.fork.sha()).toBe(SHA1);
    expect(ledgerAtPreflight).toEqual(['push_intended']);
    expect(r.events()).toEqual(['push_intended', 'push_verified']);
    expect(r.ledger.read()[0]).toMatchObject({
      branch: BRANCH,
      candidateSha: SHA1,
      expectedRemoteSha: null,
      attempt: 1,
    });
    const push = exec.mock.calls.map(([args]) => args).find((args) => args[0] === 'push') ?? [];
    expect(push).toEqual([
      'push',
      '--porcelain',
      '--no-verify',
      '--no-follow-tags',
      `--force-with-lease=refs/heads/${BRANCH}:`,
      `file://${r.fork.dir}`,
      `${SHA1}:refs/heads/${BRANCH}`,
    ]);
    expect(push.some((arg) => arg === '--force' || arg === '-f' || arg.startsWith('+'))).toBe(
      false
    );
    // One fork-limited token, revoked after use.
    expect(r.mints()).toBe(1);
    expect(r.broker.status().tokens.map((t) => t.status)).toEqual(['revoked']);
    expect(r.driver.snapshot().intents.get(idempotencyKey(pushOf(SHA1)))?.status).toBe('confirmed');
    // Idempotent: a confirmed push is never repeated.
    expect(await r.driver.execute(pushOf(SHA1))).toBe(ref);
    expect(r.mints()).toBe(1);
  });

  it('confirms without a token when the remote already holds the candidate', async () => {
    const r = await rig();
    r.fork.git(['index-pack', '--stdin'], C1.pack);
    r.fork.git(['update-ref', `refs/heads/${BRANCH}`, SHA1]);
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    expect(await r.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
    expect(r.mints()).toBe(0);
    expect(r.events()).toEqual(['push_intended', 'push_verified']);
  });

  it('blocks remote_diverged at preflight and pushes nothing (scenario 18, AC3)', async () => {
    const r = await rig();
    const other = r.fork.outOfBand();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(WriteBlockedError);
    expect(r.driver.snapshot().blockedReason).toBe('remote_diverged');
    expect(r.fork.sha()).toBe(other);
    expect(r.mints()).toBe(0);
    expect(replayIntents(journals[2]?.read() ?? [])).toEqual(r.driver.snapshot());
  });

  it('a stale lease is rejected when the branch moves after preflight (decision row 4b)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    let other = '';
    r.wrap = (inner) => async (intent, target, operation, cancel) =>
      inner(
        intent,
        target,
        async (credential, signal) => {
          // Out-of-band commit between the preflight read and the push.
          other = r.fork.outOfBand();
          return operation(credential, signal);
        },
        cancel
      );
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(WriteBlockedError);
    expect(r.driver.snapshot().blockedReason).toBe('remote_diverged');
    // The lease held: the remote stays at the out-of-band SHA.
    expect(r.fork.sha()).toBe(other);
    expect(r.mints()).toBe(1);
    expect(r.broker.status().tokens.map((t) => t.status)).toEqual(['revoked']);
  });

  it('push-then-crash before the journal write reconciles as done (AC5)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.wrap =
      (inner) =>
      async (...args) => {
        await inner(...args);
        throw new Error('controller lost the push response');
      };
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    expect(r.fork.sha()).toBe(SHA1);
    expect(r.events()).toEqual(['push_intended']);
    const restarted = await r.restart();
    await restarted.driver.resume();
    expect(restarted.driver.snapshot().intents.get(idempotencyKey(pushOf(SHA1)))?.status).toBe(
      'confirmed'
    );
    expect(await restarted.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
    expect(restarted.events()).toEqual(['push_intended', 'push_verified']);
    // No second push: the restarted broker never minted.
    expect(restarted.mints()).toBe(0);
  });

  it('remote still at expected after a lost response retries once, with a fresh receipt (AC5)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.wrap = () => async () => {
      throw new Error('transport failed before the push');
    };
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    const restarted = await r.restart();
    await restarted.driver.resume();
    const intent = restarted.driver.snapshot().intents.get(idempotencyKey(pushOf(SHA1))) as Intent;
    expect(intent).toMatchObject({ status: 'ambiguous', retryReady: true, attempts: 1 });
    restarted.grants.push({ candidate: C1, expected: null, nonce: 'nonce-2' });
    expect(await restarted.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
    expect(restarted.fork.sha()).toBe(SHA1);
    expect(restarted.ledger.read()).toMatchObject([
      { type: 'push_intended', attempt: 1, expectedRemoteSha: null },
      { type: 'push_intended', attempt: 2, expectedRemoteSha: null },
      { type: 'push_verified', remoteSha: SHA1 },
    ]);
  });

  it('a retry with the already-consumed receipt is a replay and is refused before minting', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.wrap = () => async () => {
      throw new Error('transport failed before the push');
    };
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    r.wrap = (inner) => inner;
    await r.driver.resume();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(WriteBlockedError);
    expect(r.driver.snapshot().blockedReason).toBe('authorization_refused');
    expect(r.fork.sha()).toBeNull();
    expect(r.mints()).toBe(0);
  });

  it('a lost response with unexpected remote content blocks on resume (scenario 18)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.wrap = () => async () => {
      throw new Error('lost');
    };
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    r.fork.outOfBand();
    const restarted = await r.restart();
    await expect(restarted.driver.resume()).rejects.toThrow(WriteBlockedError);
    expect(restarted.driver.snapshot().blockedReason).toBe('remote_diverged');
  });

  it('rewrites a revision with the same CAS against the previously verified SHA (AC6)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await r.driver.execute(pushOf(SHA1));
    // The rebased revision expects exactly the previously verified SHA.
    expect(r.pusher.expectedRemoteSha(pushOf(SHA2))).toBe(SHA1);
    const exec = vi.spyOn(TrustedGit.prototype, 'exec');
    r.grants.push({ candidate: C2, expected: SHA1, nonce: 'nonce-2' });
    expect(await r.driver.execute(pushOf(SHA2))).toBe(`${TARGET}@${SHA2}`);
    expect(r.fork.sha()).toBe(SHA2);
    const push = exec.mock.calls.map(([args]) => args).find((args) => args[0] === 'push');
    expect(push).toContain(`--force-with-lease=refs/heads/${BRANCH}:${SHA1}`);
    expect(r.pusher.expectedRemoteSha({ ...pushOf(SHA1), candidateSha: 'd'.repeat(40) })).toBe(
      SHA2
    );
  });

  it('refuses a rewrite whose receipt does not bind the previously verified SHA (no blind force)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await r.driver.execute(pushOf(SHA1));
    r.grants.push({ candidate: C2, expected: null, nonce: 'nonce-2' });
    await expect(r.driver.execute(pushOf(SHA2))).rejects.toThrow(WriteBlockedError);
    expect(r.driver.snapshot().blockedReason).toBe('authorization_refused');
    expect(r.fork.sha()).toBe(SHA1);
    expect(r.mints()).toBe(1);
  });

  it.each<[string, (g: Grant) => Grant]>([
    ['wrong parent', (g) => ({ ...g, receipt: { parentSha: 'e'.repeat(40) } })],
    ['wrong contributor', (g) => ({ ...g, receipt: { contributor: 'mallory' } })],
    ['changed candidate SHA', (g) => ({ ...g, candidate: C2 })],
    ['candidate on another parent', (g) => ({ ...g, context: { parentSha: 'e'.repeat(40) } })],
    ['wrong fork', (g) => ({ ...g, receipt: { forkRepositoryId: FORK_ID + 1 } })],
    ['wrong upstream', (g) => ({ ...g, receipt: { upstreamRepositoryId: UPSTREAM_ID + 1 } })],
    [
      'unverified candidate (failed check)',
      (g) => ({
        ...g,
        receipt: {
          commands: [
            {
              id: 'regression',
              command: 'npm test',
              required: true,
              status: 'failed',
              exitStatus: 1,
              suites: 3,
              sanitizedLogDigest: DIGEST,
            },
          ],
        },
      }),
    ],
    ['policy denies shipping', (g) => ({ ...g, context: { policyPermitsShipping: false } })],
  ])('refuses %s before minting a token (scenarios 10/17, AC1/AC7)', async (_name, mutate) => {
    const r = await rig();
    r.grants.push(mutate({ candidate: C1, expected: null, nonce: 'nonce-1' }));
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(WriteBlockedError);
    expect(r.driver.snapshot().blockedReason).toBe('authorization_refused');
    expect(r.mints()).toBe(0);
    expect(r.fork.sha()).toBeNull();
    expect(r.events()).toEqual([]);
  });

  it('consumes the single-use nonce for the journaled attempt (AC1)', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await r.driver.execute(pushOf(SHA1));
    const rows = new Journal(r.dirs.nonces);
    journals.push(rows);
    expect(rows.read().slice(1)).toEqual([
      expect.objectContaining({
        nonce: 'nonce-1',
        operationKey: idempotencyKey(pushOf(SHA1)),
        attempt: 1,
      }),
    ]);
  });

  it('rides out a trailing read-back, then fails closed if it never shows the candidate', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    let lag = 1;
    r.fork.overrides.push((p) =>
      p.includes('/git/ref/') && r.fork.refReads() > 1 && lag-- > 0
        ? { status: 404, body: null }
        : undefined
    );
    expect(await r.driver.execute(pushOf(SHA1))).toBe(`${TARGET}@${SHA1}`);
    expect(r.sleeps).toEqual([1000]);

    const stuck = await rig();
    stuck.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    stuck.fork.overrides.push((p) =>
      p.includes('/git/ref/') ? { status: 404, body: null } : undefined
    );
    await expect(stuck.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    expect(stuck.sleeps).toEqual([1000, 3000]);
    expect(stuck.events()).toEqual(['push_intended']);
  });

  it('never pushes to a repository whose id is not the bound fork', async () => {
    const r = await rig();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    r.fork.overrides.push((p) =>
      p === `/repos/${OWNER}/fixture` ? { status: 200, body: { id: FORK_ID + 1 } } : undefined
    );
    await expect(r.driver.execute(pushOf(SHA1))).rejects.toThrow(MutationUncertainError);
    expect(r.mints()).toBe(0);
    expect(r.fork.sha()).toBeNull();
  });

  it('provides the hand-off read-back: verified SHA, null when absent, refused otherwise', async () => {
    const r = await rig();
    const admission: HandoffAdmission['remoteBranchSha'] = () => r.pusher.remoteBranchSha(TARGET);
    expect(await admission()).toBeNull();
    r.grants.push({ candidate: C1, expected: null, nonce: 'nonce-1' });
    await r.driver.execute(pushOf(SHA1));
    expect(await admission()).toBe(SHA1);
    r.fork.outOfBand();
    await expect(admission()).rejects.toThrow(ForkPushError);
    await expect(r.pusher.remoteBranchSha(`fork:${FORK_ID + 1}:branch:${BRANCH}`)).rejects.toThrow(
      ForkRefError
    );
  });

  it('only handles push_branch and rejects a corrupt ledger', async () => {
    const r = await rig();
    expect(() =>
      r.pusher.expectedRemoteSha({ ...pushOf(SHA1), operationKind: 'pr_update' })
    ).toThrow(ForkPushError);
    expect(() =>
      replayPushes([
        {
          v: 1,
          type: 'push_intended',
          key: 'k',
          attempt: 1,
          branch: BRANCH,
          candidateSha: SHA1,
          expectedRemoteSha: null,
        },
        { v: 1, type: 'push_verified', key: 'k', branch: BRANCH, remoteSha: SHA2 },
      ])
    ).toThrow(ForkPushError);
    expect(() => replayPushes([{ v: 1, type: 'push_forced', key: 'k' }])).toThrow(ForkPushError);
  });
});

describe('credential-free fork ref reads', () => {
  const read =
    (answers: Record<string, GitHubResponse>): GitHubRead =>
    async (p) =>
      answers[p] ?? { status: 404, body: null };
  const repo = `/repos/${OWNER}/fixture`;
  const at = { fork: FORK, branch: 'feature/x' };

  it('binds targets to the fork id and safe branch names', () => {
    expect(forkTarget(FORK, 'feature/x')).toBe(`fork:${FORK_ID}:branch:feature/x`);
    expect(parseForkTarget(`fork:${FORK_ID}:branch:feature/x`, FORK)).toEqual(at);
    for (const target of [
      `fork:${FORK_ID + 1}:branch:x`,
      `fork:${FORK_ID}:branch:../x`,
      `fork:${FORK_ID}:branch:x y`,
      `fork:${FORK_ID}:branch:*`,
      'o/r/pulls',
    ])
      expect(() => parseForkTarget(target, FORK)).toThrow(ForkRefError);
  });

  it('reads heads/<branch> and answers sha, null on 404, and throws otherwise', async () => {
    const ok = { status: 200, body: { id: FORK_ID } };
    const ref = `${repo}/git/ref/heads/feature/x`;
    const object = { type: 'commit', sha: SHA1 };
    expect(
      await readForkBranch(
        read({ [repo]: ok, [ref]: { status: 200, body: { ref: 'refs/heads/feature/x', object } } }),
        at
      )
    ).toBe(SHA1);
    expect(await readForkBranch(read({ [repo]: ok }), at)).toBeNull();
    for (const answer of [
      { status: 200, body: { ref: 'refs/heads/feature/y', object } },
      { status: 200, body: { ref: 'refs/heads/feature/x', object: { type: 'tag', sha: SHA1 } } },
      { status: 403, body: { message: 'rate limited' } },
      { status: 409, body: { message: 'Git Repository is empty.' } },
    ])
      await expect(readForkBranch(read({ [repo]: ok, [ref]: answer }), at)).rejects.toThrow(
        ForkRefError
      );
    await expect(
      readForkBranch(read({ [repo]: { status: 200, body: { id: 1 } } }), at)
    ).rejects.toThrow('fork_unverified');
    await expect(
      readForkBranch(async () => {
        throw new Error('down');
      }, at)
    ).rejects.toThrow('ref_unknown');
  });
});
