/** The #1066 controller rig shared by the push and tracking tests: a local bare
 * repository stands in for the fork, ref reads go through an HTTP fake answering from it,
 * and the broker, nonce store, push ledger and intent journal are real. No network, no
 * real credentials. */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Ed25519Signer } from '@ai-dossier/core';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { createManifest, sha256 } from '../../canonical/export';
import { type CanonicalCandidate, createCandidate } from '../../canonical/reconstruct';
import { TrustedGit } from '../../canonical/trusted-git';
import { IntentDriver, type IntentInput, idempotencyKey } from '../../intents';
import { Journal } from '../../journal';
import { issueReceipt, type ReceiptInput, type SignedReceipt } from '../../receipt/issue';
import { ReceiptNonceStore } from '../../receipt/nonces';
import type { ReceiptContext } from '../../receipt/verify';
import { createRun, ReasonCode, type RunRecord, transitionRun } from '../../state';
import { AppCredentials } from '../app-auth';
import { ForkCredentialBroker } from '../broker';
import { ForkPusher, type ShippingAuthorization } from '../push';
import type { GitHubRead, GitHubResponse } from '../reconcile';
import { CLIENT_ID, FORK_ID, GitHubFake, INSTALLATION_ID, OWNER, UPSTREAM_ID } from './github-fake';

export const FORK = Object.freeze({ repositoryId: FORK_ID, owner: OWNER, repo: 'fixture' });
export const BRANCH = 'fix-1066';
export const TARGET = `fork:${FORK_ID}:branch:${BRANCH}`;
export const DIGEST = 'c'.repeat(64);
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
export const journals: Journal[] = [];
export function temp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}
export function journal(dir: string): Journal {
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
export const BASE = baseline();
export function candidateWith(content: string): CanonicalCandidate {
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
export const C1 = candidateWith('first\n');
export const C2 = candidateWith('rebased revision\n');
export const SHA1 = C1.record.candidateSha;
export const SHA2 = C2.record.candidateSha;

const FORK_GIT_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
/** The contributor fork: a local bare repository. */
export class Fork {
  readonly dir = temp('zt-fork-');
  constructor() {
    this.git(['init', '--bare', '--quiet']);
  }
  git(args: string[], input?: Buffer | string, extraEnv: Record<string, string> = {}): string {
    return execFileSync('/usr/bin/git', ['--git-dir', this.dir, ...args], {
      input,
      env: { ...FORK_GIT_ENV, ...extraEnv },
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
    const sha = this.git(['commit-tree', tree, '-p', BASE.baseSha], 'out of band\n', {
      GIT_AUTHOR_NAME: 'Other',
      GIT_AUTHOR_EMAIL: 'other@example.org',
      GIT_COMMITTER_NAME: 'Other',
      GIT_COMMITTER_EMAIL: 'other@example.org',
    });
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

export const shipping = [
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
export const pushOf = (candidateSha: string): IntentInput => ({
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

export interface Grant {
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
    profile: {
      name: 'node-22',
      runtime: '22.0.0',
      imageDigest: `sha256:${DIGEST}`,
      accelerator: 'kvm',
    },
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
export async function authorization(g: Grant): Promise<ShippingAuthorization> {
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

/** Pushes to the local bare repository instead of github.com; nothing else differs. */
class LocalForkPusher extends ForkPusher {
  constructor(
    options: ConstructorParameters<typeof ForkPusher>[0],
    private readonly bare: string
  ) {
    super(options);
  }
  protected override remote(): { url: string; config: readonly string[] } {
    return { url: `file://${this.bare}`, config: ['protocol.file.allow=always'] };
  }
}

/** One controller process: intent journal, broker, nonce store, push ledger, pusher. */
export class Rig {
  readonly fork: Fork;
  readonly fake = new GitHubFake(Date.now);
  readonly dirs: { intents: string; tokens: string; nonces: string; pushes: string };
  readonly grants: Grant[] = [];
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
  /** `run`: the lifecycle the intent driver starts from (a revision ships later in it). */
  async start(run: RunRecord = shipping): Promise<this> {
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
    this.pusher = new LocalForkPusher(
      {
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
      },
      this.fork.dir
    );
    this.driver = new IntentDriver(
      journal(this.dirs.intents),
      this.pusher,
      { run, contributionId: 'contribution-1' },
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
export const rig = () => new Rig().start();
