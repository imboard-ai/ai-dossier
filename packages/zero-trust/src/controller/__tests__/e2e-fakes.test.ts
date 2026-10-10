/** Offline vertical slice: real controller/producers, only transport/VM/model edges fake. */
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { junit } from '../../__tests__/fake-vm';
import {
  BASE_COMMIT,
  CANDIDATE,
  ENDPOINTS,
  fixtureScript,
  removeTemps,
  VerifierFakeVm,
} from '../../__tests__/verifier-fixture';
import { TrustedGit } from '../../canonical/trusted-git';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  FORK_ID,
  GitHubFake,
  INSTALLATION_ID,
  OWNER,
  UPSTREAM_ID,
  USER_ID,
} from '../../github/__tests__/github-fake';
import { Fork } from '../../github/__tests__/push-rig';
import { ForkCredentialBroker } from '../../github/broker';
import { Journal } from '../../journal';
import {
  type ModelAdapter,
  ModelError,
  type ModelRequest,
  type ModelResult,
} from '../../model/adapter';
import { discoverPolicy } from '../../policy/discover';
import { assessIssue } from '../../policy/eligibility';
import * as receipts from '../../receipt/issue';
import { ReceiptNonceStore } from '../../receipt/nonces';
import { ReasonCode, transitionRun } from '../../state';
import { approveCheckpoint } from '../checkpoints';
import { validateRunConfig } from '../config';
import { readControlRequests, requestControl } from '../control';
import { readOutcomeBudget } from '../outcome-records';
import { RunStore } from '../run-store';
import { StepArtifacts } from '../steps';
import { loadVerification } from '../verification-record';
import { createController } from '../wiring';

const TIME = '2026-10-10T00:00:00.000Z';
const POLICY =
  'AI-assisted contributions are welcome. Assignment is not required. Direct pull requests are welcome. Non-draft PRs and verification receipts are allowed. Baseline failures are not allowed.';
const dirs: string[] = [];
let issued: ReturnType<typeof vi.spyOn>;
let syncGit: ReturnType<typeof vi.spyOn>;
let asyncGit: ReturnType<typeof vi.spyOn>;
function pushCalls() {
  return [...syncGit.mock.calls, ...asyncGit.mock.calls].filter((call) => call[0][0] === 'push');
}
function noShipping() {
  expect(issued.mock.calls).toHaveLength(0);
  expect(pushCalls()).toHaveLength(0);
}
beforeEach(() => {
  issued = vi.spyOn(receipts, 'issueReceipt');
  syncGit = vi.spyOn(TrustedGit.prototype, 'exec');
  asyncGit = vi.spyOn(TrustedGit.prototype, 'execAsync');
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    fixture: [
      { address: '127.0.0.1', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(removeTemps);

function rig(
  options: {
    policy?: 'permission' | 'ban';
    failVerification?: boolean;
    breach?: boolean;
    wrongUser?: boolean;
    missingFork?: boolean;
    missingInstallation?: boolean;
    signoff?: boolean;
    realNameOnlyLogin?: boolean;
    cancelDuringPlan?: boolean;
    checkpoint?: 'plan' | 'patch' | 'verification';
    failBaseline?: boolean;
    wrappedPolicy?: boolean;
    userUnavailable?: boolean;
    baseUnavailable?: boolean;
    driftTouch?: boolean;
    corruptPolicy?: boolean;
    restrictPolicy?: boolean;
    delayFork?: boolean;
    activeControl?: 'write' | 'exec' | 'model' | 'mint' | 'engagement';
    onlyRepair?: boolean;
    teardownFails?: boolean;
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-composition-'));
  dirs.push(root);
  const upstream = new Fork();
  upstream.git(['index-pack', '--stdin'], BASE_COMMIT.pack);
  upstream.git(['update-ref', 'refs/heads/main', BASE_COMMIT.baseSha]);
  const fork = new Fork();
  const signerKeyFile = path.join(root, 'signer.pem');
  fs.writeFileSync(
    signerKeyFile,
    generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }),
    { mode: 0o600 }
  );
  vi.stubEnv(
    'ZT_APP_KEY',
    generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString()
  );
  vi.stubEnv('ZT_APP_SECRET', CLIENT_SECRET);
  const proxyEndpointsFile = path.join(root, 'proxy.json');
  fs.writeFileSync(
    proxyEndpointsFile,
    JSON.stringify({ endpoints: ENDPOINTS, target: { host: '10.0.0.2', port: 4873 } }),
    { mode: 0o600 }
  );
  const phase = {
    adapter: 'openai-compatible',
    model: 'fixture',
    endpoint: 'https://model.example/v1',
    apiKeyEnv: 'ZT_MODEL_KEY',
  };
  const config = validateRunConfig({
    issueUrl: 'https://github.com/upstream/fixture/issues/7',
    contributor: OWNER,
    authorApproval: {
      userId: USER_ID,
      login: OWNER,
      name: options.realNameOnlyLogin ? OWNER : 'Approved Contributor',
      email: `${USER_ID}+${OWNER}@users.noreply.github.com`,
      source: 'default',
      approvedAt: TIME,
    },
    executionProfile: {
      provider: 'local-qemu',
      stateDir: root,
      profileDir: path.join(root, 'profile'),
      accelerator: 'tcg',
      proxyEndpointsFile,
    },
    modelProfile: {
      phases: { planning: phase, implementing: phase, repair: phase },
      rates: [
        {
          resource: 'fixture',
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
      ceilingMinor: 1000,
      cleanupAllowanceMinor: 100,
      tokenLimit: 1000000,
      activeMinutes: 120,
    },
    signerKeyFile,
    githubApp: {
      appId: 1,
      clientId: CLIENT_ID,
      slug: 'fixture',
      privateKeyEnv: 'ZT_APP_KEY',
      clientSecretEnv: 'ZT_APP_SECRET',
    },
    checkpoints: options.checkpoint ? [options.checkpoint] : [],
  });
  config.modelProfile.rates.push({
    resource: 'local-qemu',
    currency: 'USD',
    unit: 'millisecond',
    price: 0,
    units: 1,
    source: 'local-unbilled',
    fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: TIME },
  });
  const fake = new GitHubFake(() => Date.parse(TIME));
  if (options.wrongUser) fake.userId++;
  fake.appInstallations.set(`${OWNER}/fixture`, {
    id: INSTALLATION_ID,
    account: { login: OWNER },
    repository_selection: 'selected',
    permissions: { contents: 'write', metadata: 'read' },
    suspended_at: null,
  });
  fake.selected.set(INSTALLATION_ID, [FORK_ID]);
  if (options.missingInstallation) fake.appInstallations.clear();
  let policy =
    (options.policy === 'ban'
      ? 'AI contributions are banned.'
      : options.policy === 'permission'
        ? 'AI contributions require maintainer approval. Assignment is not required. Direct pull requests are welcome. Non-draft PRs and verification receipts are allowed. Baseline failures are not allowed.'
        : POLICY) +
    (options.signoff
      ? options.wrappedPolicy
        ? '\n## DCO\nAll commits must include a\nSigned-off-by trailer.'
        : '\nA Signed-off-by line is required under the DCO.'
      : '') +
    (options.realNameOnlyLogin
      ? options.wrappedPolicy
        ? '\nA real name\nis required on commits.'
        : '\nYour real name is required for commits.'
      : '');
  const originalPolicySha = createHash('sha1')
    .update(`blob ${Buffer.byteLength(policy)}\0${policy}`)
    .digest('hex');
  let submitted: Record<string, unknown> | undefined;
  let comment: Record<string, unknown> | undefined;
  let invitation: Record<string, unknown> | undefined;
  let branchReads = 0;
  let advanced: string | undefined;
  let releaseFork!: () => void;
  let reachedFork!: () => void;
  const forkReached = new Promise<void>((resolve) => {
    reachedFork = resolve;
  });
  const forkReleased = new Promise<void>((resolve) => {
    releaseFork = resolve;
  });
  const read: NonNullable<Parameters<typeof createController>[1]>['read'] = async (p) => {
    if (p === '/repos/upstream/fixture')
      return {
        status: 200,
        body: {
          id: UPSTREAM_ID,
          full_name: 'upstream/fixture',
          default_branch: 'main',
          private: false,
          archived: false,
          disabled: false,
        },
      };
    if (p === '/repos/upstream/fixture/issues/7')
      return {
        status: 200,
        body: {
          number: 7,
          html_url: config.issueUrl,
          state: 'open',
          locked: false,
          user: { login: 'reporter', html_url: 'https://github.com/reporter' },
          author_association: 'CONTRIBUTOR',
          labels: [{ name: 'bug' }],
          assignees: [],
          created_at: TIME.replace('.000', ''),
          title: 'Duration uses wrong units',
          body: 'Convert milliseconds into seconds.',
        },
      };
    if (p.includes('/timeline?')) return { status: 200, body: [] };
    if (p.startsWith('/repos/upstream/fixture/branches/')) {
      if (options.baseUnavailable) return { status: 503, body: null };
      if (options.driftTouch && ++branchReads > 1) {
        if (!advanced) {
          const entry = CANDIDATE.entries.find((e) => e.path === 'package.json');
          if (!entry) throw new Error('fixture missing package');
          const bytes = JSON.stringify({
            ...JSON.parse(Buffer.from(entry.bytes, 'base64').toString()),
            description: 'upstream change',
          });
          const blob = upstream.git(['hash-object', '-w', '--stdin'], bytes);
          const tree = upstream.git(
            ['mktree'],
            `${upstream.git(['ls-tree', BASE_COMMIT.baseSha]).replace(/blob [a-f0-9]{40}\tpackage.json/u, `blob ${blob}\tpackage.json`)}\n`
          );
          advanced = upstream.git(['commit-tree', tree, '-p', BASE_COMMIT.baseSha], 'advance\n', {
            GIT_AUTHOR_NAME: 'Upstream',
            GIT_AUTHOR_EMAIL: 'upstream@example.org',
            GIT_COMMITTER_NAME: 'Upstream',
            GIT_COMMITTER_EMAIL: 'upstream@example.org',
          });
          upstream.git(['update-ref', 'refs/heads/main', advanced]);
        }
        return { status: 200, body: { commit: { sha: advanced } } };
      }
      return { status: 200, body: { commit: { sha: BASE_COMMIT.baseSha } } };
    }
    if (p.startsWith('/repos/upstream/fixture/git/ref/heads/'))
      return {
        status: 200,
        body: { ref: 'refs/heads/main', object: { type: 'commit', sha: BASE_COMMIT.baseSha } },
      };
    if (options.restrictPolicy && planCalls > 0) policy = 'AI contributions are banned.';
    if (p.startsWith('/repos/upstream/fixture/contents/'))
      return p.startsWith('/repos/upstream/fixture/contents/CONTRIBUTING.md?')
        ? {
            status: 200,
            body: {
              path: 'CONTRIBUTING.md',
              type: 'file',
              sha:
                options.corruptPolicy && planCalls > 0
                  ? originalPolicySha
                  : createHash('sha1')
                      .update(`blob ${Buffer.byteLength(policy)}\0${policy}`)
                      .digest('hex'),
              size: Buffer.byteLength(
                options.corruptPolicy && planCalls > 0 ? 'AI contributions are banned.' : policy
              ),
              encoding: 'base64',
              content: Buffer.from(
                options.corruptPolicy && planCalls > 0 ? 'AI contributions are banned.' : policy
              ).toString('base64'),
            },
          }
        : { status: 404, body: null };
    if (p.includes('/forks?')) return { status: 200, body: [] };
    if (p === `/repos/${OWNER}/fixture` && options.missingFork) return { status: 404, body: null };
    if (p === `/repos/${OWNER}/fixture`) {
      if (options.delayFork) {
        reachedFork();
        await forkReleased;
      }
      return {
        status: 200,
        body: {
          id: FORK_ID,
          full_name: `${OWNER}/fixture`,
          fork: true,
          parent: { id: UPSTREAM_ID },
          source: { id: UPSTREAM_ID },
          owner: { login: OWNER },
        },
      };
    }
    if (p.startsWith(`/repos/${OWNER}/fixture/git/ref/heads/`)) {
      const branch = decodeURIComponent(p.split('/heads/')[1]);
      const sha = fork.sha(branch);
      return sha
        ? { status: 200, body: { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } } }
        : { status: 404, body: null };
    }
    if (p.startsWith('/repos/upstream/fixture/pulls?'))
      return { status: 200, body: submitted ? [submitted] : [] };
    if (p === '/repos/upstream/fixture/pulls/8') return { status: 200, body: submitted };
    if (p.includes('/issues/7/comments?') && options.activeControl === 'engagement' && !blocked) {
      blocked = true;
      controlReached();
      await controlReleased;
    }
    if (p.includes('/issues/7/comments?'))
      return { status: 200, body: [comment, invitation].filter(Boolean) };
    if (p.endsWith('/issues/comments/10')) return { status: 200, body: invitation };
    if (p.includes('/actions/runs?')) return { status: 200, body: { workflow_runs: [] } };
    if (p.includes('/check-runs')) return { status: 200, body: { check_runs: [] } };
    if (p.endsWith('/status')) return { status: 200, body: { statuses: [] } };
    if (p.includes('/comments?') || p.includes('/reviews?')) return { status: 200, body: [] };
    return { status: 404, body: null };
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (options.activeControl === 'mint' && url.pathname.endsWith('/access_tokens') && !blocked) {
      blocked = true;
      controlReached();
      await controlReleased;
    }
    if (options.userUnavailable && url.pathname === '/user')
      return new Response('{}', { status: 503 });
    const response =
      url.hostname === 'api.github.com'
        ? await fake.http({
            method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
            path: `${url.pathname}${url.search}`,
            authorization: new Headers(init?.headers).get('Authorization') ?? '',
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          })
        : await fake.oauth(JSON.parse(String(init?.body)) as Record<string, string>);
    return new Response(response.status === 204 ? null : JSON.stringify(response.json), {
      status: response.status,
    });
  };
  let seq = 0;
  let modelRequests = 0;
  let implementTurn = 0;
  let planCalls = 0;
  const repairEvidence: string[] = [];
  let touched = false;
  let reachedPlan!: () => void;
  const planReached = new Promise<void>((resolve) => {
    reachedPlan = resolve;
  });
  const model: ModelAdapter = {
    id: 'fixture',
    async complete(request: ModelRequest): Promise<ModelResult> {
      modelRequests++;
      for (const message of request.messages)
        if (message.role === 'user' && message.content.includes('repair_evidence')) {
          const frame = JSON.parse(message.content) as { label: string; data: string };
          if (frame.label === 'repair_evidence') repairEvidence.push(frame.data);
        }
      let name = 'propose_action';
      let arguments_: unknown;
      if (request.tools[0]?.function.name === 'report_decision') {
        name = 'report_decision';
        const question = JSON.parse(request.system.split('\n').at(-1) ?? '{}') as { id: string };
        const values: Record<string, string | boolean> = {
          'policy-ai': options.policy === 'permission' ? 'requires_approval' : 'welcomed',
          'policy-assignment': 'not_required',
          'policy-direct-pr': 'welcomed',
          'policy-non-draft': true,
          'policy-receipt': true,
          'policy-baseline': false,
        };
        arguments_ = {
          value: values[question.id],
          citations: [{ sourceId: 'CONTRIBUTING.md', line: 1, quote: policy.split('\n')[0] }],
        };
      } else if (JSON.stringify(request.tools).includes('submit_plan')) {
        planCalls++;
        if (options.cancelDuringPlan) {
          reachedPlan();
          return new Promise<never>((_resolve, reject) => {
            const abort = () => reject(new ModelError('model_aborted'));
            if (request.signal?.aborted) abort();
            else request.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        arguments_ = {
          kind: 'submit_plan',
          text: 'Add a regression for milliseconds, then correct the conversion.',
        };
      } else {
        if (options.activeControl === 'model' && implementTurn === 1 && !blocked) {
          blocked = true;
          interruptedVm = (await vm.listByRun(controller.snapshot().runId)).at(-1)?.vmId ?? '';
          controlReached();
          await controlReleased;
        }
        if (options.activeControl === 'exec' && implementTurn === 2) {
          implementTurn++;
          return {
            kind: 'tool_calls',
            calls: [
              {
                id: `call-${seq++}`,
                name,
                arguments: { kind: 'worker_exec', profile: 'node', argv: ['npm', 'test'] },
              },
            ],
            usage: { inputTokens: 10, outputTokens: 10 },
          };
        }
        const writes = CANDIDATE.entries.filter((e) =>
          ['test/regression.test.js', 'src/duration.js'].includes(e.path)
        );
        let e: (typeof CANDIDATE.entries)[number] | undefined;
        if (options.driftTouch && !touched) {
          touched = true;
          e = CANDIDATE.entries.find((entry) => entry.path === 'package.json');
        } else e = writes[implementTurn++ % 3];
        arguments_ = e
          ? {
              kind: 'worker_write_file',
              path: e.path,
              content: Buffer.from(e.bytes, 'base64').toString('utf8'),
            }
          : {
              kind: 'candidate_ready',
              title: 'Fix duration conversion',
              cause: 'Milliseconds treated as seconds',
              scope: 'Duration conversion and regression',
              limitations: [],
            };
      }
      return {
        kind: 'tool_calls',
        calls: [{ id: `call-${seq++}`, name, arguments: arguments_ }],
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  };
  const reports = new Map<object, number>();
  const vm = new VerifierFakeVm((request, guest) => {
    if (options.failBaseline && request.report && !guest.files.has('test/regression.test.js'))
      return { exitCode: 1, report: junit(1, true) };
    if (request.report) reports.set(guest, (reports.get(guest) ?? 0) + 1);
    if (
      options.failVerification &&
      request.report &&
      guest.files.has('test/regression.test.js') &&
      guest.files.get('src/duration.js')?.bytes.toString().includes('millis / 1000') &&
      request.argv.includes('test/regression.test.js') &&
      (reports.get(guest) ?? 0) > 1
    )
      return { exitCode: 1, report: junit(1, true) };
    return fixtureScript(request, guest);
  });
  vm.acceptAbuse = options.breach ?? false;
  let controlReached!: () => void;
  const controlReady = new Promise<void>((resolve) => {
    controlReached = resolve;
  });
  let interruptedVm = '';
  let blocked = false;
  let releaseControl!: () => void;
  const controlReleased = new Promise<void>((resolve) => {
    releaseControl = resolve;
  });
  const originalPut = vm.putFile.bind(vm);
  const originalExec = vm.exec.bind(vm);
  const originalDestroy = vm.destroy.bind(vm);
  vi.spyOn(vm, 'putFile').mockImplementation(async (...args) => {
    if (
      options.activeControl === 'write' &&
      args[1] === 'test/regression.test.js' &&
      !blocked &&
      (!options.onlyRepair || repairEvidence.length > 0)
    ) {
      blocked = true;
      interruptedVm = args[0].vmId;
      controlReached();
      return new Promise<void>(() => {});
    }
    return originalPut(...args);
  });
  vi.spyOn(vm, 'exec').mockImplementation(async (...args) => {
    if (
      options.activeControl === 'exec' &&
      args[1].argv.join(' ') === 'npm test' &&
      !blocked &&
      implementTurn === 3
    ) {
      blocked = true;
      interruptedVm = args[0].vmId;
      controlReached();
      return new Promise<never>(() => {});
    }
    return originalExec(...args);
  });
  vi.spyOn(vm, 'destroy').mockImplementation(async (handle) => {
    if (options.teardownFails && handle.vmId === interruptedVm)
      throw new Error('fixture cleanup failure');
    return originalDestroy(handle);
  });
  let clock = Date.parse(TIME);
  const controller = createController(config, {
    vm,
    read,
    fetch: fetcher,
    models: { planning: model, implementing: model, repair: model },
    now: () => new Date(clock),
    gitRemoteUrl: { upstream: `file://${upstream.dir}`, fork: `file://${fork.dir}` },
  });
  const authorize = async (task: Promise<unknown>) => {
    let settled = false;
    void task
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    for (let i = 0; i < 1000 && !settled && !controller.authorizationUrl; i++)
      await new Promise((r) => setTimeout(r, 5));
    if (controller.authorizationUrl) {
      const url = new URL(controller.authorizationUrl);
      const redirect = new URL(url.searchParams.get('redirect_uri') as string);
      redirect.searchParams.set('state', url.searchParams.get('state') as string);
      redirect.searchParams.set('code', fake.grantCode());
      await fetch(redirect);
    }
    return task;
  };
  const artifacts = (runId: string) => {
    const store = RunStore.open(path.join(root, 'runs'), runId);
    const dir = store.storeDirectory('artifacts');
    const j = new Journal(path.join(store.storeDirectory('control'), 'steps'));
    const held = new StepArtifacts(j, runId);
    const get = <T>(key: string) => held.get<T>(key) as T;
    return {
      store,
      dir,
      get,
      put: held.put.bind(held),
      close: () => {
        j.close();
        store.close();
      },
    };
  };
  return {
    controller,
    config,
    fake,
    vm,
    fork,
    upstream,
    authorize,
    artifacts,
    read,
    planCalls: () => planCalls,
    planReached,
    repairEvidence,
    forkReached,
    releaseFork,
    controlReady,
    releaseControl,
    advanceClock: () => {
      clock += 60000;
    },
    modelCalls: () => modelRequests,
    interruptedVm: () => interruptedVm,
    identityUnavailable() {
      options.userUnavailable = true;
    },
    invite() {
      invitation = {
        id: 10,
        html_url: `${config.issueUrl}#issuecomment-10`,
        body: 'Go ahead.',
        user: { login: 'maintainer', html_url: 'https://github.com/maintainer' },
        author_association: 'MEMBER',
        created_at: '2026-10-10T00:00:01.000Z',
        updated_at: '2026-10-10T00:00:01.000Z',
      };
    },
    welcome() {
      options.policy = undefined;
      policy = POLICY;
    },
    submit(runId: string) {
      const a = artifacts(runId);
      const held = a.get<{ record: { candidateSha: string } }>('candidate');
      const branch = `ztfc/${a.store.contributionId}`;
      const hand = new Journal(a.store.storeDirectory('handoff'));
      const link = hand.read().find((r) => (r as { type: string }).type === 'link_issued') as {
        body: string;
      };
      hand.close();
      submitted = {
        number: 8,
        title: 'Fix duration conversion',
        html_url: 'https://github.com/upstream/fixture/pull/8',
        state: 'open',
        merged_at: null,
        user: { login: OWNER, html_url: `https://github.com/${OWNER}` },
        body: link.body,
        head: {
          sha: held.record.candidateSha,
          ref: branch,
          label: `${OWNER}:${branch}`,
          repo: { id: FORK_ID, full_name: `${OWNER}/fixture`, owner: { login: OWNER } },
          user: { login: OWNER },
        },
        base: { ref: 'main', repo: { id: UPSTREAM_ID, full_name: 'upstream/fixture' } },
      };
      a.close();
    },
    submitEngagement(runId: string) {
      const a = artifacts(runId);
      const h = new Journal(a.store.storeDirectory('handoff'));
      const row = h.read().find((r) => (r as { type: string }).type === 'link_issued') as {
        body: string;
      };
      h.close();
      comment = {
        id: 9,
        html_url: `${config.issueUrl}#issuecomment-9`,
        body: row.body,
        user: { login: OWNER, html_url: `https://github.com/${OWNER}` },
        author_association: 'CONTRIBUTOR',
        created_at: TIME,
        updated_at: TIME,
      };
      a.close();
    },
  };
}

describe('createController real composition', () => {
  function request(h: ReturnType<typeof rig>, kind: 'pause' | 'cancel') {
    const id = h.controller.snapshot().runId;
    const store = RunStore.open(path.join(h.config.executionProfile.stateDir, 'runs'), id, {
      readOnly: true,
      observe: true,
    });
    try {
      return requestControl(store, { kind, reason: 'User control' }, new Date(TIME));
    } finally {
      store.close();
    }
  }
  it.each([
    'write',
    'exec',
    'model',
  ] as const)('pauses blocked %s and resumes exact held candidate on a fresh VM', async (activeControl) => {
    const uninterrupted = rig();
    const normal = (await uninterrupted.authorize(
      uninterrupted.controller.start(uninterrupted.config)
    )) as { runId: string };
    const expected = uninterrupted.artifacts(normal.runId);
    const sha = expected.get<{ record: { candidateSha: string } }>('candidate').record.candidateSha;
    expected.close();
    const h = rig({ activeControl });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    const calls = vi.mocked(h.vm.exec).mock.calls.length;
    const modelCalls = h.modelCalls();
    const row = request(h, 'pause');
    if (activeControl === 'model') h.releaseControl();
    const run = (await running) as { state: string; runId: string };
    expect(run.state).toBe('paused_user');
    expect(vi.mocked(h.vm.exec).mock.calls.length).toBe(calls);
    expect(h.modelCalls()).toBe(modelCalls);
    expect(h.vm.destroy).toHaveBeenCalledWith(expect.objectContaining({ vmId: h.interruptedVm() }));
    const a = h.artifacts(run.runId);
    expect(readControlRequests(a.store).pending).toHaveLength(0);
    expect(readOutcomeBudget(a.store).reservations.length).toBeGreaterThan(0);
    expect(
      fs.existsSync(path.join(a.store.storeDirectory('control'), 'requests', `${row.id}.json`))
    ).toBe(true);
    a.close();
    h.advanceClock();
    const resumed = (await h.authorize(h.controller.resume(run.runId))) as { state: string };
    expect(resumed.state).toBe('awaiting_contributor');
    const b = h.artifacts(run.runId);
    expect(b.get<{ record: { candidateSha: string } }>('candidate').record.candidateSha).toBe(sha);
    b.close();
    expect(
      vi
        .mocked(h.vm.exec)
        .mock.calls.slice(calls)
        .some((c) => c[0].vmId !== h.interruptedVm())
    ).toBe(true);
  }, 60000);
  it('cancel before shipping revokes the broker without a push', async () => {
    const ended = vi.spyOn(ForkCredentialBroker.prototype, 'endRun');
    const h = rig({ activeControl: 'write' });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    const visible: number[] = [];
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).includes('/requests/') && String(to).endsWith('.json')) {
        visible.push(fs.lstatSync(to).nlink);
        try {
          h.controller.assertAdmission();
        } catch {
          /* Stop-only admission must close here. */
        }
      }
    });
    request(h, 'cancel');
    expect(((await running) as { state: string }).state).toBe('cancelled');
    expect(ended).toHaveBeenCalledWith('cancelled');
    expect(visible).toEqual([1]);
    noShipping();
  }, 60000);
  it.each([
    'pause',
    'cancel',
  ] as const)('%s during token mint never hands credentials to a push', async (kind) => {
    const h = rig({ activeControl: 'mint' });
    const take = vi.spyOn(ForkCredentialBroker.prototype, 'take');
    const revoke = vi.spyOn(ForkCredentialBroker.prototype, 'revoke');
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    request(h, kind);
    h.releaseControl();
    expect(((await running) as { state: string }).state).toBe(
      kind === 'pause' ? 'paused_user' : 'cancelled'
    );
    expect(take).not.toHaveBeenCalled();
    expect(pushCalls()).toHaveLength(0);
    expect(revoke).toHaveBeenCalled();
  }, 60000);
  it.each([
    'pause',
    'cancel',
  ] as const)('%s during engagement reconciliation issues no new contributor capability', async (kind) => {
    const h = rig({ policy: 'permission', activeControl: 'engagement' });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    request(h, kind);
    h.releaseControl();
    const run = (await running) as { runId: string; state: string };
    expect(run.state).toBe(kind === 'pause' ? 'paused_user' : 'cancelled');
    const a = h.artifacts(run.runId);
    const journal = new Journal(a.store.storeDirectory('handoff'));
    expect(
      journal.read().filter((e) => (e as { type: string }).type === 'link_issued')
    ).toHaveLength(0);
    expect(fs.readdirSync(a.store.storeDirectory('bodies'))).toHaveLength(0);
    journal.close();
    a.close();
    noShipping();
  }, 60000);
  it('pause/resume during verification repair retains its failed-candidate basis and repair evidence', async () => {
    const h = rig({ activeControl: 'write', onlyRepair: true, failVerification: true });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    const candidate = h.controller.snapshot().runId;
    request(h, 'pause');
    expect(((await running) as { state: string }).state).toBe('paused_user');
    const a = h.artifacts(candidate);
    const held = a.get<{ baseDigest: string; turn: number }>('implementation_continuation');
    expect(held.baseDigest).toBe(
      a.get<{ manifest: { digest: string } }>('candidate').manifest.digest
    );
    a.close();
    h.advanceClock();
    expect(((await h.authorize(h.controller.resume(candidate))) as { state: string }).state).toBe(
      'failed'
    );
    expect(h.repairEvidence.length).toBeGreaterThan(1);
    noShipping();
  }, 60000);
  it('a legitimate cancel arriving during pause destruction wins and revokes once work is quiesced', async () => {
    const h = rig({ activeControl: 'write' });
    const ended = vi.spyOn(ForkCredentialBroker.prototype, 'endRun');
    const destroy = vi.mocked(h.vm.destroy).getMockImplementation();
    if (!destroy) throw new Error('fixture missing destruction edge');
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(h.vm.destroy).mockImplementation(async (handle) => {
      if (handle.vmId === h.interruptedVm()) {
        arrived();
        await released;
      }
      return destroy(handle);
    });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    request(h, 'pause');
    await reached;
    request(h, 'cancel');
    release();
    expect(((await running) as { state: string }).state).toBe('cancelled');
    expect(ended).toHaveBeenCalledWith('cancelled');
    noShipping();
  }, 60000);
  it.each([
    'pause',
    'cancel',
  ] as const)('%s teardown failure retains blocked_cleanup and cancellation still revokes', async (kind) => {
    const ended = vi.spyOn(ForkCredentialBroker.prototype, 'endRun');
    const h = rig({ activeControl: 'write', teardownFails: true });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    request(h, kind);
    expect(((await running) as { state: string }).state).toBe('blocked_cleanup');
    if (kind === 'cancel') expect(ended).toHaveBeenCalledWith('cancelled');
    noShipping();
  }, 60000);
  it('cancel reconciles a submitted PR behind a pending contributor link before cancellation', async () => {
    const h = rig();
    const run = (await h.authorize(h.controller.start(h.config))) as { runId: string };
    h.submit(run.runId);
    const store = RunStore.open(path.join(h.config.executionProfile.stateDir, 'runs'), run.runId, {
      readOnly: true,
      observe: true,
    });
    requestControl(store, { kind: 'cancel', reason: 'Withdraw my run' }, new Date(TIME));
    store.close();
    const cancelled = await h.controller.resume(run.runId);
    expect(cancelled.state).toBe('cancelled');
    const a = h.artifacts(run.runId);
    expect(a.get<{ url: string }>('publication').url).toBe(
      'https://github.com/upstream/fixture/pull/8'
    );
    expect(a.get<string>('withdrawal')).toContain('then close the pull request');
    a.close();
  }, 60000);
  it.each([
    'torn-request',
    'array-result',
  ] as const)('corrupt control bytes (%s) block the active controller with inspectable evidence', async (damage) => {
    const h = rig({ activeControl: 'write' });
    const running = h.authorize(h.controller.start(h.config));
    await h.controlReady;
    const row = request(h, 'pause');
    const id = h.controller.snapshot().runId;
    const store = RunStore.open(path.join(h.config.executionProfile.stateDir, 'runs'), id, {
      readOnly: true,
      observe: true,
    });
    if (damage === 'array-result')
      fs.writeFileSync(
        path.join(store.storeDirectory('control'), 'requests', `${row.id}.result`),
        JSON.stringify({ v: 1, digest: row.digest, result: ['applied'] }),
        { mode: 0o600 }
      );
    else
      fs.writeFileSync(
        path.join(store.storeDirectory('control'), 'requests', `${row.id}.json`),
        '{"torn":',
        { mode: 0o600 }
      );
    store.close();
    expect(((await running) as { state: string }).state).toBe('blocked');
    const a = h.artifacts(id);
    expect(readControlRequests(a.store).invalid).toBe(true);
    a.close();
    noShipping();
  }, 60000);
  it.each([
    ['plan', 'corrupt'],
    ['plan', 'missing'],
    ['patch', 'corrupt'],
    ['patch', 'missing'],
  ] as const)(
    'refuses %s checkpoint %s review material at approval and resume',
    async (checkpoint, damage) => {
      const h = rig({ checkpoint });
      const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
        ReturnType<typeof h.controller.start>
      >;
      const a = h.artifacts(run.runId);
      const file = path.join(a.dir, checkpoint === 'plan' ? 'plan.txt' : 'candidate.diff');
      const original = fs.readFileSync(file);
      const cp = a.store.checkpoint(checkpoint);
      if (!cp) throw new Error('fixture missing checkpoint');
      if (damage === 'missing') fs.unlinkSync(file);
      else
        fs.writeFileSync(file, 'Nothing needs to change. This candidate is empty.', {
          mode: 0o600,
        });
      expect(() =>
        approveCheckpoint(a.store, a.store.run, { point: checkpoint, digest: cp.digest }, TIME)
      ).toThrow('checkpoint_stale');
      expect(a.store.checkpoint(checkpoint)?.status).toBe('open');
      a.close();
      await expect(h.authorize(h.controller.resume(run.runId))).rejects.toMatchObject({
        code: 'recovery_failed',
      });
      noShipping();
      const b = h.artifacts(run.runId);
      b.store.replaceArtifact(checkpoint === 'plan' ? 'plan.txt' : 'candidate.diff', original);
      approveCheckpoint(b.store, b.store.run, { point: checkpoint, digest: cp.digest }, TIME);
      b.close();
      expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
        'awaiting_contributor'
      );
    },
    60000
  );
  it.each([
    false,
    true,
  ])('carries invitation authority into shipping (policy changed=%s)', async (changed) => {
    const h = rig({ policy: 'permission' });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    h.submitEngagement(run.runId);
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_maintainer'
    );
    h.invite();
    if (changed) h.welcome();
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_contributor'
    );
    const a = h.artifacts(run.runId);
    const journal = new Journal(a.store.storeDirectory('handoff'));
    const links = journal.read().filter((row) => (row as { type: string }).type === 'link_issued');
    expect(links).toHaveLength(2);
    journal.close();
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBe(
      a.get<{ record: { candidateSha: string } }>('candidate').record.candidateSha
    );
    a.close();
  }, 60000);
  it('retains a prohibited baseline refusal on legal continuation', async () => {
    const h = rig({ failBaseline: true });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('paused_user');
    const a = h.artifacts(run.runId);
    a.store.persistRun(transitionRun(a.store.run, ReasonCode.ResumePlanning, TIME));
    a.close();
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'paused_user'
    );
    expect(h.planCalls()).toBe(0);
    noShipping();
  }, 60000);
  it.each([
    'plan',
    'patch',
  ] as const)('publishes held human-readable %s checkpoint evidence', async (checkpoint) => {
    const h = rig({ checkpoint });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('paused_user');
    const a = h.artifacts(run.runId);
    expect(a.store.checkpoint(checkpoint)?.status).toBe('open');
    const bytes = fs.readFileSync(
      path.join(a.dir, checkpoint === 'plan' ? 'plan.txt' : 'candidate.diff'),
      'utf8'
    );
    if (checkpoint === 'plan') expect(bytes).toBe(a.get<{ text: string }>('plan').text);
    else {
      expect(bytes).toContain('+++ b/src/duration.js');
      expect(bytes).toContain('+');
      expect(bytes).toContain('millis / 1000');
    }
    a.close();
    noShipping();
  }, 60000);
  it('reconciles the completed nonce-header crash prefix without resetting history', async () => {
    const h = rig({ checkpoint: 'verification' });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    const a = h.artifacts(run.runId);
    const cp = a.store.checkpoint('verification');
    if (!cp) throw new Error('fixture missing checkpoint');
    approveCheckpoint(a.store, a.store.run, { point: 'verification', digest: cp.digest }, TIME);
    a.put('nonces_initializing', true);
    new ReceiptNonceStore(a.store.storeDirectory('nonces')).initialize();
    a.close();
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_contributor'
    );
    const b = h.artifacts(run.runId);
    expect(b.get('nonces_initialized')).toBe(true);
    expect(
      fs.readFileSync(path.join(b.store.storeDirectory('nonces'), 'events.jsonl'), 'utf8')
    ).toContain('receiptDigest');
    b.close();
  }, 60000);
  it('does not relabel an unavailable authenticated identity as a different account', async () => {
    const h = rig({ userUnavailable: true });
    await expect(h.authorize(h.controller.start(h.config))).rejects.toMatchObject({
      code: 'step_failed',
      diagnostic: { phase: 'gate', code: 'contributor_authorization_unavailable' },
    });
    const a = h.artifacts(h.controller.snapshot().runId);
    expect(a.store.run.state).toBe('gating');
    expect(a.get('refusal')).toBe('contributor_authorization_unavailable');
    a.close();
    noShipping();
  }, 60000);
  it('retains a safe actionable gate diagnostic without external response text', async () => {
    const h = rig({ baseUnavailable: true });
    await expect(h.controller.start(h.config)).rejects.toMatchObject({
      code: 'step_failed',
      diagnostic: { phase: 'gate', code: 'producer_unavailable' },
    });
    const a = h.artifacts(h.controller.snapshot().runId);
    expect(a.get('diagnostic')).toMatchObject({
      phase: 'gate',
      operation: 'gate_producer',
      code: 'producer_unavailable',
      next: expect.stringContaining('explicitly resume'),
    });
    a.close();
  });
  it('refuses contradictory external policy bytes before receipt issuance', async () => {
    const h = rig({ corruptPolicy: true });
    await expect(h.authorize(h.controller.start(h.config))).rejects.toMatchObject({
      code: 'step_failed',
    });
    noShipping();
  }, 60000);
  it('refuses a consistently hashed restrictive policy change before shipping', async () => {
    const h = rig({ restrictPolicy: true });
    await expect(h.authorize(h.controller.start(h.config))).rejects.toMatchObject({
      code: 'step_failed',
    });
    noShipping();
  }, 60000);
  it('retains a closed recovery diagnostic for an identity outage', async () => {
    const h = rig({ checkpoint: 'plan' });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    h.identityUnavailable();
    await expect(h.authorize(h.controller.resume(run.runId))).rejects.toMatchObject({
      code: 'recovery_failed',
      diagnostic: { phase: 'recovery', code: 'contributor_authorization_unavailable' },
    });
    const a = h.artifacts(run.runId);
    // The same unavailable /user probe cannot confirm old-token revocation;
    // retain that cleanup fence, never manufacture an account mismatch.
    expect(a.store.run.state).toBe('blocked_cleanup');
    expect(a.get('diagnostic')).toMatchObject({
      phase: 'recovery',
      operation: 'recovery_producer',
    });
    a.close();
    noShipping();
  }, 60000);
  it('retains byte-identical admitted writes when checking upstream drift', async () => {
    const h = rig({ driftTouch: true });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('paused_user');
    const a = h.artifacts(run.runId);
    expect(a.get<{ touched: string[] }>('candidate').touched).toContain('package.json');
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBeNull();
    a.close();
    noShipping();
  }, 60000);
  it.each([
    'destruction',
    'enumeration',
  ] as const)('revokes credentials even when incident VM %s fails', async (failure) => {
    const h = rig({ cancelDuringPlan: true });
    const task = h.authorize(h.controller.start(h.config));
    await h.planReached;
    if (failure === 'destruction') h.vm.failDestroy = 100;
    else
      vi.spyOn(h.vm, 'listByRun').mockRejectedValue(new Error('external enumeration unavailable'));
    await expect(h.controller.incidentStop('cleanup failure control')).rejects.toThrow();
    await task.catch(() => {});
    expect(h.controller.snapshot().state).toBe('blocked_cleanup');
    expect(h.fake.calls.some((call) => call.method === 'DELETE')).toBe(true);
    expect([...h.fake.tokens.values()].every((token) => !token.live)).toBe(true);
    noShipping();
  }, 60000);
  it('does not open OAuth after cancellation during an external fork read', async () => {
    const h = rig({ delayFork: true });
    const task = h.controller.start(h.config);
    await h.forkReached;
    const stopped = h.controller.incidentStop('delayed read cancellation');
    h.releaseFork();
    await stopped;
    await task;
    expect(h.controller.authorizationUrl).toBeNull();
    expect(h.fake.oauthCalls).toEqual([]);
    noShipping();
  }, 60000);
  it('never echoes malformed credential-shaped proxy bytes', () => {
    const h = rig();
    fs.writeFileSync(
      h.config.executionProfile.proxyEndpointsFile,
      'ghp_sensitive_malformed_fixture',
      { mode: 0o600 }
    );
    expect(() => createController(h.config)).toThrow(/^invalid_proxy_file$/u);
  });
  it('produces a verified fork push and contributor compare handoff, then observes submission honestly', async () => {
    const h = rig();
    expect(
      await assessIssue(
        h.read as NonNullable<typeof h.read>,
        h.config.upstream,
        h.config.contributor
      )
    ).toMatchObject({ kind: 'eligible' });
    expect(
      await discoverPolicy(h.read as NonNullable<typeof h.read>, {
        ...h.config.upstream,
        ref: BASE_COMMIT.baseSha,
      })
    ).toMatchObject({ kind: 'known' });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('awaiting_contributor');
    expect(issued.mock.calls.length).toBeGreaterThan(0);
    expect(pushCalls().length).toBeGreaterThan(0);
    const a = h.artifacts(run.runId);
    const held = a.get<{ record: { candidateSha: string } }>('candidate');
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBe(held.record.candidateSha);
    const handoffJournal = new Journal(a.store.storeDirectory('handoff'));
    expect(
      (
        handoffJournal.read().find((r) => (r as { type: string }).type === 'link_issued') as {
          link: string;
        }
      ).link
    ).toContain(`/compare/main...${OWNER}:ztfc/`);
    handoffJournal.close();
    expect(loadVerification(a.dir, held.record.candidateSha, { runId: run.runId }).verdict).toBe(
      'passed'
    );
    a.close();
    h.submit(run.runId);
    const resumed = (await h.authorize(h.controller.resume(run.runId))) as Awaited<
      ReturnType<typeof h.controller.resume>
    >;
    expect(resumed.state).toBe('submitted');
    const b = h.artifacts(run.runId);
    expect(b.get<{ url: string; ci: string }>('publication')).toMatchObject({
      url: 'https://github.com/upstream/fixture/pull/8',
    });
    expect(['pending', 'unknown', 'awaiting_approval']).toContain(
      b.get<{ ci: string }>('publication').ci
    );
    b.close();
    const tracked = (await h.authorize(h.controller.resume(run.runId))) as Awaited<
      ReturnType<typeof h.controller.resume>
    >;
    expect(tracked.state).toBe('awaiting_review');
    const t = h.artifacts(run.runId);
    expect(t.get<{ ci: string; pr: string }>('tracking').pr).toBe(
      'https://github.com/upstream/fixture/pull/8'
    );
    expect(t.get<{ ci: string }>('tracking').ci).not.toBe('passed');
    const tj = new Journal(t.store.storeDirectory('track'));
    expect(tj.read().length).toBeGreaterThan(1);
    tj.close();
    t.close();
    expect(h.fake.calls.filter((c) => c.method === 'POST' && c.path.includes('/pulls'))).toEqual(
      []
    );
  }, 60000);
  it('requires contributor-confirmed engagement before maintainer waiting and never reissues it', async () => {
    const h = rig({ policy: 'permission' });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('awaiting_contributor');
    expect(h.vm.calls.some((c) => c.op === 'create')).toBe(false);
    h.submitEngagement(run.runId);
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_maintainer'
    );
    expect(((await h.authorize(h.controller.resume(run.runId))) as { state: string }).state).toBe(
      'awaiting_maintainer'
    );
    const a = h.artifacts(run.runId);
    const j = new Journal(a.store.storeDirectory('handoff'));
    expect(j.read().filter((r) => (r as { type: string }).type === 'link_issued')).toHaveLength(1);
    j.close();
    a.close();
  }, 60000);
  it('blocks an AI ban before allocation or authorization', async () => {
    const h = rig({ policy: 'ban' });
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('blocked');
    expect(h.vm.calls).toEqual([]);
    expect(h.fake.oauthCalls).toEqual([]);
  });
  it('blocks a boundary breach with no receipt and untouched fork', async () => {
    const h = rig({ breach: true });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('blocked');
    const a = h.artifacts(run.runId);
    expect(a.get('receipt')).toBeUndefined();
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBeNull();
    noShipping();
    a.close();
  }, 60000);
  it('exhausts exactly two repair attempts after three independent verification failures without pushing', async () => {
    const h = rig({ failVerification: true });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('failed');
    const a = h.artifacts(run.runId);
    expect(a.get('attempt')).toBe(3);
    expect(h.repairEvidence.length).toBeGreaterThan(0);
    expect(JSON.parse(h.repairEvidence[0]).verification.verdict).toBe('failed');
    expect(
      JSON.parse(h.repairEvidence[0]).verification.commands.some(
        (c: { status: string }) => c.status === 'failed'
      )
    ).toBe(true);
    expect(a.get('receipt')).toBeUndefined();
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBeNull();
    noShipping();
    expect(
      fs.readdirSync(path.join(a.dir, 'verification')).filter((name) => name.endsWith('.json'))
    ).toHaveLength(3);
    a.close();
  }, 60000);
  it('refuses a different authenticated numeric account before candidate allocation', async () => {
    const h = rig({ wrongUser: true });
    await expect(h.authorize(h.controller.start(h.config))).rejects.toMatchObject({
      code: 'author_approval_mismatch',
    });
    expect(h.vm.calls).toEqual([]);
  }, 60000);
  it('refuses resumed shipping handoff under a different numeric account', async () => {
    const h = rig();
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    h.fake.userId++;
    await expect(h.authorize(h.controller.resume(run.runId))).rejects.toMatchObject({
      code: 'author_approval_mismatch',
    });
    const a = h.artifacts(run.runId);
    expect(a.store.run.state).toBe('blocked');
    expect(a.get('refusal')).toBe('author_approval_mismatch');
    a.close();
  }, 60000);
  it.each([
    'fork',
    'installation',
  ] as const)('retains an explicit missing %s prerequisite wait without provisioning or posting', async (prerequisite) => {
    const h = rig(prerequisite === 'fork' ? { missingFork: true } : { missingInstallation: true });
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('awaiting_contributor');
    expect(run.reasonCode).toBe(prerequisite === 'fork' ? 'fork_missing' : 'installation_missing');
    expect((await h.controller.resume(run.runId)).state).toBe('awaiting_contributor');
    expect(h.vm.calls).toEqual([]);
    expect(h.fake.oauthCalls).toEqual([]);
  });
  it.each([
    false,
    true,
  ])('uses the persisted approved identity for a required DCO trailer (wrapped=%s)', async (wrappedPolicy) => {
    const h = rig({ signoff: true, wrappedPolicy });
    const run = (await h.authorize(h.controller.start(h.config))) as Awaited<
      ReturnType<typeof h.controller.start>
    >;
    expect(run.state).toBe('awaiting_contributor');
    const a = h.artifacts(run.runId);
    expect(a.get<{ record: { message: string } }>('candidate').record.message).toContain(
      `Signed-off-by: Approved Contributor <${USER_ID}+${OWNER}@users.noreply.github.com>`
    );
    a.close();
  }, 60000);
  it.each([
    false,
    true,
  ])('hands off an explicit real-name requirement when the approved name is only the login (wrapped=%s)', async (wrappedPolicy) => {
    const h = rig({ realNameOnlyLogin: true, wrappedPolicy });
    const run = await h.controller.start(h.config);
    expect(run.state).toBe('gating');
    expect(h.vm.calls).toEqual([]);
    expect(h.fake.oauthCalls).toEqual([]);
  });
  it('refuses missing author approval and closed override violations before creating a run', () => {
    const h = rig();
    expect(() => createController({ ...h.config, authorApproval: undefined })).toThrow(
      'author_approval_missing'
    );
    expect(() => createController(h.config, { phase: {} } as never)).toThrow(
      'invalid_controller_override'
    );
    expect(() => h.controller.start({ ...h.config, contributor: 'other' })).toThrow(
      'controller_config_mismatch'
    );
    expect(h.vm.calls).toEqual([]);
  });
  it('joins legitimate cancellation during a paid model await, revokes credentials and destroys VMs without shipping', async () => {
    const h = rig({ cancelDuringPlan: true });
    const started = h.authorize(h.controller.start(h.config));
    await h.planReached;
    const stopped = await h.controller.incidentStop('user cancellation');
    expect(stopped.state).toBe('cancelled');
    expect(((await started) as { state: string }).state).toBe('cancelled');
    expect(await h.vm.listByRun(stopped.runId)).toEqual([]);
    const a = h.artifacts(stopped.runId);
    expect(a.get('receipt')).toBeUndefined();
    expect(h.fork.sha(`ztfc/${a.store.contributionId}`)).toBeNull();
    a.close();
    expect([...h.fake.tokens.values()].every((t) => !t.live)).toBe(true);
  }, 60000);
});
