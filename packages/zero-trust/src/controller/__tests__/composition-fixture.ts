/** Offline real composition. Only GitHub transport, model, VM and clock edges are scripted. */

import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BareFork as Fork } from '../../__tests__/bare-fork';
import { type FakeScript, junit } from '../../__tests__/fake-vm';
import {
  BASE_COMMIT,
  CANDIDATE,
  ENDPOINTS,
  fixtureScript,
  removeTemps,
  VerifierFakeVm,
} from '../../__tests__/verifier-fixture';
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
import type { GitHubResponse } from '../../github/reconcile';
import { Journal } from '../../journal';
import {
  type ModelAdapter,
  ModelError,
  type ModelRequest,
  type ModelResult,
} from '../../model/adapter';
import type { ExecRequest, ExecResult } from '../../vm/adapter';
import { validateRunConfig } from '../config';
import { contributionIdOf } from '../ids';
import { RunStore } from '../run-store';
import { StepArtifacts } from '../steps';
import { createController } from '../wiring';

export const TIME = '2026-10-10T00:00:00.000Z';
const POLICY =
  'AI-assisted contributions are welcome. Assignment is not required. Direct pull requests are welcome. Non-draft PRs and verification receipts are allowed. Baseline failures are not allowed.';
// Immutable fixture signing material is shared; each run still owns its key file,
// broker, vault, repositories, journals and single-use receipt authority.
const SIGNER = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
const APP_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();
const UPSTREAM_IDENTITY = {
  GIT_AUTHOR_NAME: 'Upstream',
  GIT_AUTHOR_EMAIL: 'upstream@example.org',
  GIT_COMMITTER_NAME: 'Upstream',
  GIT_COMMITTER_EMAIL: 'upstream@example.org',
};
const dirs: string[] = [];
let instrumentVm: (vm: VerifierFakeVm) => void = () => {};
let setEnv = (key: string, value: string) => {
  process.env[key] = value;
};
export function fixtureInstrumentation(vm: typeof instrumentVm, env: typeof setEnv) {
  instrumentVm = vm;
  setEnv = env;
}
export function cleanupComposition() {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  removeTemps();
}

export interface RigOptions {
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
  beforeRead?: (path: string) => Promise<void>;
  /** Called before each credentialed GitHub/OAuth request reaches the fake server. */
  beforeFetch?: (url: URL) => Promise<void>;
  beforeModel?: (request: ModelRequest) => Promise<void>;
  beforeExec?: () => Promise<void>;
  tokenLimit?: number;
  implementationUsage?: number;
  modelPrice?: number;
  ceilingMinor?: number;
  oauthExpiresIn?: number;
  oauthRefreshExpiresIn?: number;
  root?: string;
  persistent?: boolean;
  activeMinutes?: number;
}

export function rig(options: RigOptions = {}) {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'zt-composition-'));
  dirs.push(root);
  const upstream = new Fork(path.join(root, 'upstream.git'));
  upstream.git(['index-pack', '--stdin'], BASE_COMMIT.pack);
  upstream.git(['update-ref', 'refs/heads/main', BASE_COMMIT.baseSha]);
  const fork = new Fork(path.join(root, 'fork.git'));
  const signerKeyFile = path.join(root, 'signer.pem');
  fs.writeFileSync(signerKeyFile, SIGNER, { mode: 0o600 });
  setEnv('ZT_APP_KEY', APP_KEY);
  setEnv('ZT_APP_SECRET', CLIENT_SECRET);
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
          price: options.modelPrice ?? 0,
          units: 1,
          source: 'fixture',
          fx: { currency: 'USD', numerator: 1, denominator: 1, timestamp: TIME },
        },
      ],
    },
    budget: {
      currency: 'USD',
      ceilingMinor: options.ceilingMinor ?? 1000,
      cleanupAllowanceMinor: 100,
      tokenLimit: options.tokenLimit ?? 1000000,
      activeMinutes: options.activeMinutes ?? 120,
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
  let clock = Date.parse(TIME);
  const fake = new GitHubFake(() => clock);
  const serverFile = path.join(root, 'physical-github.json');
  const expiries = new Map<string, number>();
  const loadServer = () => {
    if (options.persistent && fs.existsSync(serverFile)) {
      const saved = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
      fake.tokens.clear();
      for (const [key, value] of saved.tokens) fake.tokens.set(key, value);
      fake.refreshTokens.clear();
      for (const [key, value] of saved.refreshTokens) fake.refreshTokens.set(key, value);
      expiries.clear();
      for (const [key, value] of saved.expiries) expiries.set(key, value);
      fake.calls.splice(0, fake.calls.length, ...saved.calls);
    }
    for (const [key, expiry] of expiries)
      if (expiry <= clock) {
        const token = fake.tokens.get(key);
        if (token) token.live = false;
        const refresh = fake.refreshTokens.get(key);
        if (refresh) {
          refresh.live = false;
          const parent = fake.tokens.get(refresh.access);
          if (parent) parent.refreshAlive = false;
        }
      }
  };
  const saveServer = () => {
    if (options.persistent)
      fs.writeFileSync(
        serverFile,
        JSON.stringify({
          tokens: [...fake.tokens],
          refreshTokens: [...fake.refreshTokens],
          expiries: [...expiries],
          calls: fake.calls,
        }),
        { mode: 0o600 }
      );
  };
  loadServer();
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
  const policySha = (text: string) =>
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(text)}\0${text}`)
      .digest('hex');
  const originalPolicySha = policySha(policy);
  let submitted: Record<string, unknown> | undefined;
  /** Further marked PRs from the same head: a repeated contributor submission. */
  let resubmitted: Record<string, unknown>[] = [];
  let feedback: Record<string, unknown>[] = [];
  let revisionMode = false;
  let issueState: 'open' | 'closed' = 'open';
  /** Upstream default-branch head; `advanceUpstream` moves it. */
  let head = BASE_COMMIT.baseSha;
  let advances = 0;
  /** Fork commits a scenario wrote out of band; the audit requires them untouched. */
  const foreign = new Set<string>();
  let intercept: ((path: string) => GitHubResponse | undefined) | undefined;
  let report: FakeScript | undefined;
  let comment: Record<string, unknown> | undefined;
  let invitation: Record<string, unknown> | undefined;
  let revocation: Record<string, unknown> | undefined;
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
    await options.beforeRead?.(p);
    const replaced = intercept?.(p);
    if (replaced) return replaced;
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
          state: issueState,
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
      return { status: 200, body: { commit: { sha: head } } };
    }
    if (p.startsWith('/repos/upstream/fixture/git/ref/heads/'))
      return {
        status: 200,
        body: { ref: 'refs/heads/main', object: { type: 'commit', sha: head } },
      };
    if (options.restrictPolicy && planCalls > 0) policy = 'AI contributions are banned.';
    if (p.startsWith('/repos/upstream/fixture/contents/')) {
      const text = options.corruptPolicy && planCalls > 0 ? 'AI contributions are banned.' : policy;
      return p.startsWith('/repos/upstream/fixture/contents/CONTRIBUTING.md?')
        ? {
            status: 200,
            body: {
              path: 'CONTRIBUTING.md',
              type: 'file',
              sha: options.corruptPolicy && planCalls > 0 ? originalPolicySha : policySha(policy),
              size: Buffer.byteLength(text),
              encoding: 'base64',
              content: Buffer.from(text).toString('base64'),
            },
          }
        : { status: 404, body: null };
    }
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
    if (submitted && revisionMode) {
      // A pull request's head follows its fork branch.
      const pr = submitted.head as { ref: string; sha: string };
      pr.sha = fork.sha(pr.ref) ?? pr.sha;
    }
    if (p.startsWith('/repos/upstream/fixture/pulls?'))
      return { status: 200, body: submitted ? [submitted, ...resubmitted] : [] };
    if (p === '/repos/upstream/fixture/pulls/8') return { status: 200, body: submitted };
    if (p.includes('/issues/7/comments?') && options.activeControl === 'engagement' && !blocked) {
      blocked = true;
      controlReached();
      await controlReleased;
    }
    if (p.includes('/issues/7/comments?'))
      return { status: 200, body: [comment, invitation, revocation].filter(Boolean) };
    if (p.endsWith('/issues/comments/10')) return { status: 200, body: invitation };
    if (p.includes('/issues/8/comments?')) return { status: 200, body: feedback };
    if (p.includes('/actions/runs?')) return { status: 200, body: { workflow_runs: [] } };
    if (p.includes('/check-runs')) return { status: 200, body: { check_runs: [] } };
    if (p.endsWith('/status')) return { status: 200, body: { statuses: [] } };
    if (p.includes('/comments?') || p.includes('/reviews?')) return { status: 200, body: [] };
    return { status: 404, body: null };
  };
  const fetcher: typeof fetch = async (input, init) => {
    loadServer();
    const url = new URL(String(input));
    await options.beforeFetch?.(url);
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
    if (
      url.hostname !== 'api.github.com' &&
      (response.json as { error?: string } | null)?.error === 'bad_refresh_token'
    ) {
      const form = JSON.parse(String(init?.body)) as { refresh_token?: string };
      const refresh = form.refresh_token ? fake.refreshTokens.get(form.refresh_token) : undefined;
      if (refresh) {
        refresh.live = false;
        const parent = fake.tokens.get(refresh.access);
        if (parent) parent.refreshAlive = false;
      }
    }
    for (const refresh of fake.refreshTokens.values())
      if (!fake.tokens.get(refresh.access)?.refreshAlive) refresh.live = false;
    if (
      options.oauthExpiresIn &&
      url.hostname !== 'api.github.com' &&
      response.status === 200 &&
      response.json &&
      typeof response.json === 'object' &&
      'access_token' in response.json
    )
      (response.json as Record<string, unknown>).expires_in = options.oauthExpiresIn;
    if (
      options.oauthRefreshExpiresIn &&
      url.hostname !== 'api.github.com' &&
      response.json &&
      typeof response.json === 'object' &&
      'access_token' in response.json
    )
      (response.json as Record<string, unknown>).refresh_token_expires_in =
        options.oauthRefreshExpiresIn;
    if (response.json && typeof response.json === 'object' && 'access_token' in response.json) {
      const pair = response.json as {
        access_token: string;
        expires_in: number;
        refresh_token: string;
        refresh_token_expires_in: number;
      };
      expiries.set(pair.access_token, clock + pair.expires_in * 1000);
      expiries.set(pair.refresh_token, clock + pair.refresh_token_expires_in * 1000);
    }
    saveServer();
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
      await options.beforeModel?.(request);
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
        arguments_ =
          question.id === 'revision-feedback'
            ? {
                value: true,
                citations: [{ sourceId: 'comment:11', line: 1, quote: String(feedback[0]?.body) }],
              }
            : {
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
              content:
                Buffer.from(e.bytes, 'base64').toString('utf8') +
                (revisionMode && e.path === 'src/duration.js'
                  ? '\n// Clarify duration units.\n'
                  : ''),
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
        usage: {
          inputTokens: implementTurn > 0 ? (options.implementationUsage ?? 10) : 10,
          outputTokens: 10,
        },
      };
    },
  };
  const reports = new Map<object, number>();
  const vm = new VerifierFakeVm((request, guest) => {
    const replaced = report?.(request, guest);
    if (replaced) return replaced;
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
  const vmFile = path.join(root, 'physical-vms.json');
  const saveVms = () => {
    if (options.persistent)
      fs.writeFileSync(
        vmFile,
        JSON.stringify({
          calls: vm.calls,
          vms: [...vm.vms].map(([id, guest]) => [
            id,
            {
              ...guest,
              files: [...guest.files].map(([name, file]) => [
                name,
                { ...file, bytes: file.bytes.toString('base64') },
              ]),
            },
          ]),
        }),
        { mode: 0o600 }
      );
  };
  const loadVms = () => {
    if (!options.persistent || !fs.existsSync(vmFile)) return;
    const saved = JSON.parse(fs.readFileSync(vmFile, 'utf8'));
    vm.vms.clear();
    vm.calls.splice(0, vm.calls.length, ...saved.calls);
    for (const [id, guest] of saved.vms)
      vm.vms.set(id, {
        ...guest,
        files: new Map(
          guest.files.map(([name, file]: [string, { bytes: string; executable: boolean }]) => [
            name,
            { ...file, bytes: Buffer.from(file.bytes, 'base64') },
          ])
        ),
      });
  };
  loadVms();
  const createVm = vm.create.bind(vm);
  const listVms = vm.listByRun.bind(vm);
  vm.create = async (spec) => {
    const result = await createVm(spec);
    saveVms();
    return result;
  };
  vm.listByRun = async (id) => {
    loadVms();
    return listVms(id);
  };
  let controlReached!: () => void;
  let releaseControl!: () => void;
  const controlReady = new Promise<void>((resolve) => {
    controlReached = resolve;
  });
  const controlReleased = new Promise<void>((resolve) => {
    releaseControl = resolve;
  });
  let interruptedVm = '';
  let blocked = false;
  const executions: { vmId: string; request: ExecRequest; result: ExecResult }[] = [];
  const originalPut = vm.putFile.bind(vm);
  const originalExec = vm.exec.bind(vm);
  const originalDestroy = vm.destroy.bind(vm);
  vm.putFile = async (...args) => {
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
    const result = await originalPut(...args);
    saveVms();
    return result;
  };
  vm.exec = async (...args) => {
    await options.beforeExec?.();
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
    const result = await originalExec(...args);
    executions.push({
      vmId: args[0].vmId,
      request: { ...args[1], argv: [...args[1].argv] },
      result,
    });
    saveVms();
    return result;
  };
  vm.destroy = async (handle) => {
    if (options.teardownFails && handle.vmId === interruptedVm)
      throw new Error('fixture cleanup failure');
    loadVms();
    await originalDestroy(handle);
    saveVms();
  };
  instrumentVm(vm);
  const edges = {
    vm,
    read,
    fetch: fetcher,
    models: { planning: model, implementing: model, repair: model },
    now: () => new Date(clock),
    gitRemoteUrl: { upstream: `file://${upstream.dir}`, fork: `file://${fork.dir}` },
  };
  const controller = createController(config, edges);
  const authorize = async (task: Promise<unknown>, instance = controller) => {
    let settled = false;
    void task
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    for (let i = 0; i < 1000 && !settled && !instance.authorizationUrl; i++)
      await new Promise((r) => setTimeout(r, 5));
    if (instance.authorizationUrl) {
      const url = new URL(instance.authorizationUrl);
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
    return {
      store,
      dir,
      get: <T>(key: string) => held.get<T>(key) as T,
      events: () => j.read(),
      history: <T>(key: string) =>
        j
          .read()
          .filter((row) => (row as { key?: string }).key === key)
          .map(
            (row) =>
              JSON.parse(
                fs.readFileSync(
                  path.join(path.dirname(j.filePath), `${(row as { digest: string }).digest}.json`),
                  'utf8'
                )
              ) as T
          ),
      put: held.put.bind(held),
      close: () => {
        j.close();
        store.close();
      },
    };
  };
  const linkBody = (runId: string, operationKind: 'pr_create' | 'engagement_comment') => {
    const a = artifacts(runId);
    const hand = new Journal(a.store.storeDirectory('handoff'));
    const row = hand
      .read()
      .find(
        (r) =>
          (r as { type: string }).type === 'link_issued' &&
          (r as { input: { operationKind: string } }).input.operationKind === operationKind
      ) as { body: string };
    hand.close();
    a.close();
    return row.body;
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
    edges,
    executions,
    reopen: () => createController(config, edges),
    foreign,
    /** Answer matching credential-free reads from `fn`; `undefined` falls through. */
    interceptRead(fn: typeof intercept) {
      intercept = fn;
    },
    /** Replace supervised command results while `fn` answers. */
    overrideExec(fn: FakeScript | undefined) {
      report = fn;
    },
    closeIssue() {
      issueState = 'closed';
    },
    banPolicy() {
      policy = 'AI contributions are banned.';
    },
    /** The inviting maintainer later withdraws permission in a new comment. */
    revokeInvitation() {
      // Strictly after the invitation (00:00:01) even while the fixture clock is frozen.
      const at = new Date(Math.max(clock, Date.parse('2026-10-10T00:00:02.000Z'))).toISOString();
      revocation = {
        id: 12,
        html_url: `${config.issueUrl}#issuecomment-12`,
        body: 'Do not proceed.',
        user: { login: 'maintainer', html_url: 'https://github.com/maintainer' },
        author_association: 'MEMBER',
        created_at: at,
        updated_at: at,
      };
    },
    /** Commit an edit of `file` onto the upstream default branch. */
    advanceUpstream(file: string, edit: (text: string) => string) {
      // Upstream commits take time: a rebased candidate gets a later committer timestamp.
      clock += 60000;
      const env = { GIT_INDEX_FILE: path.join(root, `advance-${++advances}.index`) };
      upstream.git(['read-tree', head], undefined, env);
      const blob = upstream.git(
        ['hash-object', '-w', '--stdin'],
        edit(upstream.git(['cat-file', 'blob', `${head}:${file}`]))
      );
      upstream.git(['update-index', '--cacheinfo', `100644,${blob},${file}`], undefined, env);
      const tree = upstream.git(['write-tree'], undefined, env);
      head = upstream.git(['commit-tree', tree, '-p', head], 'advance\n', UPSTREAM_IDENTITY);
      upstream.git(['update-ref', 'refs/heads/main', head]);
      return head;
    },
    /** A contributor commit on the run's fork branch that no verified push left there. */
    writeOutOfBand(runId: string) {
      // Derived, not read: the controller may hold the store while a read is answered.
      const branch = `ztfc/${contributionIdOf(runId)}`;
      if (!fork.sha(branch)) fork.git(['index-pack', '--stdin'], BASE_COMMIT.pack);
      const parent = fork.sha(branch) ?? BASE_COMMIT.baseSha;
      const sha = fork.git(
        ['commit-tree', `${parent}^{tree}`, '-p', parent],
        'contributor edit\n',
        UPSTREAM_IDENTITY
      );
      fork.git(['update-ref', `refs/heads/${branch}`, sha]);
      foreign.add(sha);
      return sha;
    },
    feedback(body = 'Please clarify the duration units in the fix.') {
      revisionMode = true;
      implementTurn = 0;
      feedback = [
        {
          id: 11,
          html_url: 'https://github.com/upstream/fixture/pull/8#issuecomment-11',
          user: { login: 'maintainer', type: 'User' },
          author_association: 'MEMBER',
          updated_at: new Date(clock).toISOString(),
          body,
        },
      ];
    },
    pr: () => submitted,
    forkPresent: () => {
      options.missingFork = false;
    },
    forkMissing: () => {
      options.missingFork = true;
    },
    planCalls: () => planCalls,
    planReached,
    repairEvidence,
    forkReached,
    releaseFork,
    controlReady,
    releaseControl,
    advanceClock: (milliseconds = 60000) => {
      clock += milliseconds;
      loadServer();
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
    submit(runId: string, copies = 1) {
      const body = linkBody(runId, 'pr_create');
      const a = artifacts(runId);
      const held = a.get<{ record: { candidateSha: string } }>('candidate');
      const branch = `ztfc/${a.store.contributionId}`;
      submitted = {
        number: 8,
        title: 'Fix duration conversion',
        html_url: 'https://github.com/upstream/fixture/pull/8',
        state: 'open',
        merged_at: null,
        user: { login: OWNER, html_url: `https://github.com/${OWNER}` },
        body,
        head: {
          sha: held.record.candidateSha,
          ref: branch,
          label: `${OWNER}:${branch}`,
          repo: { id: FORK_ID, full_name: `${OWNER}/fixture`, owner: { login: OWNER } },
          user: { login: OWNER },
        },
        base: { ref: 'main', repo: { id: UPSTREAM_ID, full_name: 'upstream/fixture' } },
      };
      resubmitted = Array.from({ length: copies - 1 }, (_, i) => ({
        ...submitted,
        number: 9 + i,
        html_url: `https://github.com/upstream/fixture/pull/${9 + i}`,
      }));
      a.close();
    },
    submitEngagement(runId: string) {
      comment = {
        id: 9,
        html_url: `${config.issueUrl}#issuecomment-9`,
        body: linkBody(runId, 'engagement_comment'),
        user: { login: OWNER, html_url: `https://github.com/${OWNER}` },
        author_association: 'CONTRIBUTOR',
        created_at: TIME,
        updated_at: TIME,
      };
    },
  };
}
