/** Offline vertical slice: real controller/producers, only transport/VM/model edges fake. */
import { generateKeyPairSync } from 'node:crypto';
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
import { Journal } from '../../journal';
import {
  type ModelAdapter,
  ModelError,
  type ModelRequest,
  type ModelResult,
} from '../../model/adapter';
import { discoverPolicy } from '../../policy/discover';
import { assessIssue } from '../../policy/eligibility';
import { validateRunConfig } from '../config';
import { RunStore } from '../run-store';
import { StepArtifacts } from '../steps';
import { loadVerification } from '../verification-record';
import { createController } from '../wiring';

const TIME = '2026-10-10T00:00:00.000Z';
const POLICY =
  'AI-assisted contributions are welcome. Assignment is not required. Direct pull requests are welcome. Non-draft PRs and verification receipts are allowed. Baseline failures are not allowed.';
const dirs: string[] = [];
beforeEach(() => {
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
  const policy =
    (options.policy === 'ban'
      ? 'AI contributions are banned.'
      : options.policy === 'permission'
        ? 'AI contributions require maintainer approval. Assignment is not required. Direct pull requests are welcome. Non-draft PRs and verification receipts are allowed. Baseline failures are not allowed.'
        : POLICY) +
    (options.signoff ? '\nA Signed-off-by line is required under the DCO.' : '') +
    (options.realNameOnlyLogin ? '\nYour real name is required for commits.' : '');
  let submitted: Record<string, unknown> | undefined;
  let comment: Record<string, unknown> | undefined;
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
    if (p.startsWith('/repos/upstream/fixture/branches/'))
      return { status: 200, body: { commit: { sha: BASE_COMMIT.baseSha } } };
    if (p.startsWith('/repos/upstream/fixture/git/ref/heads/'))
      return {
        status: 200,
        body: { ref: 'refs/heads/main', object: { type: 'commit', sha: BASE_COMMIT.baseSha } },
      };
    if (p.startsWith('/repos/upstream/fixture/contents/'))
      return p.startsWith('/repos/upstream/fixture/contents/CONTRIBUTING.md?')
        ? {
            status: 200,
            body: {
              path: 'CONTRIBUTING.md',
              type: 'file',
              sha: 'a'.repeat(40),
              size: Buffer.byteLength(policy),
              encoding: 'base64',
              content: Buffer.from(policy).toString('base64'),
            },
          }
        : { status: 404, body: null };
    if (p.includes('/forks?')) return { status: 200, body: [] };
    if (p === `/repos/${OWNER}/fixture` && options.missingFork) return { status: 404, body: null };
    if (p === `/repos/${OWNER}/fixture`)
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
    if (p.includes('/issues/7/comments?')) return { status: 200, body: comment ? [comment] : [] };
    if (p.includes('/actions/runs?')) return { status: 200, body: { workflow_runs: [] } };
    if (p.includes('/check-runs')) return { status: 200, body: { check_runs: [] } };
    if (p.endsWith('/status')) return { status: 200, body: { statuses: [] } };
    if (p.includes('/comments?') || p.includes('/reviews?')) return { status: 200, body: [] };
    return { status: 404, body: null };
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const response =
      url.hostname === 'api.github.com'
        ? await fake.http({
            method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
            path: `${url.pathname}${url.search}`,
            authorization: new Headers(init?.headers).get('Authorization') ?? '',
            ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
          })
        : await fake.oauth(JSON.parse(String(init?.body)) as Record<string, string>);
    return new Response(JSON.stringify(response.json), { status: response.status });
  };
  let seq = 0;
  let implementTurn = 0;
  let planCalls = 0;
  const repairEvidence: string[] = [];
  let reachedPlan!: () => void;
  const planReached = new Promise<void>((resolve) => {
    reachedPlan = resolve;
  });
  const model: ModelAdapter = {
    id: 'fixture',
    async complete(request: ModelRequest): Promise<ModelResult> {
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
        const writes = CANDIDATE.entries.filter((e) =>
          ['test/regression.test.js', 'src/duration.js'].includes(e.path)
        );
        const e = writes[implementTurn++ % 3];
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
  const controller = createController(config, {
    vm,
    read,
    fetch: fetcher,
    models: { planning: model, implementing: model, repair: model },
    now: () => new Date(TIME),
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
  it('uses the persisted approved identity for a required DCO trailer', async () => {
    const h = rig({ signoff: true });
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
  it('hands off an explicit real-name requirement when the approved name is only the login', async () => {
    const h = rig({ realNameOnlyLogin: true });
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
