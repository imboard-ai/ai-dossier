/** Controller-only credential composition root. Deliberately absent from index.ts.
 * Scripts import this file; no other production src module may reach it. */
import path from 'node:path';
import { Ed25519Signer, type Signer } from '@ai-dossier/core';
import { BudgetLedger } from '../budget';
import type { BudgetEstimate, BudgetObservation } from '../budget-types';
import { resolveBase } from '../canonical/acquire';
import { readPrivate } from '../durable-fs';
import { AppCredentials, fetchGitHubHttp, fetchOAuthHttp } from '../github/app-auth';
import { ForkCredentialBroker } from '../github/broker';
import {
  ContributorAuthorization,
  installationSource,
  listenLoopback,
} from '../github/contributor';
import { checkForkReadiness, type ForkReady, type ReadinessOutcome } from '../github/fork';
import type { ForkBranch } from '../github/fork-ref';
import { handoffMarker } from '../github/handoff';
import { type HandoffAdmission, HandoffDriver } from '../github/handoff-driver';
import { ForkPusher, type ForkPusherOptions } from '../github/push';
import { anonymousReader, type GitHubRead } from '../github/reconcile';
import { TokenVault } from '../github/token-journal';
import { PrTracker, trackFromHandoff } from '../github/track';
import { IntentDriver } from '../intents';
import { Journal } from '../journal';
import { type ModelAdapter, ModelError } from '../model/adapter';
import { OpenAICompatibleAdapter } from '../model/openai-compatible';
import { assessIssue } from '../policy/eligibility';
import { createFreshnessProbe } from '../policy/freshness';
import { decideGate } from '../policy/gate';
import type { SignedReceipt } from '../receipt/issue';
import { ReceiptNonceStore } from '../receipt/nonces';
import { canonicalJson } from '../receipt/schema';
import { assertSecretFree } from '../redaction';
import {
  isRunContinuation,
  prerequisiteWaitOrigin,
  ReasonCode,
  type RunRecord,
  TERMINAL_STATES,
  transitionRun,
} from '../state';
import {
  UnsupportedEnvironmentError,
  type VmAdapter,
  VmCleanupError,
  type VmHandle,
} from '../vm/adapter';
import { preflightHost } from '../vm/host';
import { LocalQemuAdapter } from '../vm/local-qemu';
import { AuthorApprovalError, requireAuthorApproval } from './author-approval';
import { type RunConfig, runConfigInput, validateRunConfig } from './config';
import {
  type ControllerDependencies,
  ControllerError,
  type PhaseContext,
  RunController,
} from './controller';
import { ProvisioningFailedError } from './evidence-runner';
import { RunStore } from './run-store';
import {
  makeAuthorize,
  makeHandoffAdmission,
  prContentInput,
  type ShippingAuthorizeDeps,
  shippingIntent,
} from './shipping';
import { createSteps, type GateRecord, gateFreshness, policyReader, StepArtifacts } from './steps';
import { loadVerification } from './verification-record';

/** Only physical edges. Never inject a phase, gate, author, ledger or verifier. */
export interface ControllerOverrides {
  readonly vm?: VmAdapter;
  readonly fetch?: typeof fetch;
  readonly read?: GitHubRead;
  readonly models?: Partial<Record<'planning' | 'implementing' | 'repair', ModelAdapter>>;
  readonly gitRemoteUrl?: { readonly upstream: string; readonly fork: string };
  readonly now?: () => Date;
  readonly signer?: Signer;
}

class EdgeForkPusher extends ForkPusher {
  constructor(
    options: ForkPusherOptions,
    private readonly url?: string
  ) {
    super(options);
  }
  protected override remote(at: ForkBranch) {
    if (!this.url) return super.remote(at);
    if (!process.env.VITEST || new URL(this.url).protocol !== 'file:')
      throw new Error('invalid_test_remote');
    return { url: this.url, config: ['protocol.file.allow=always'] };
  }
}
class PrerequisiteError extends Error {
  constructor(readonly kind: 'fork_missing' | 'installation_missing' | 'blocked' | 'hand_off') {
    super('Contributor prerequisite unavailable');
  }
}

function readProxyFile(file: string): unknown {
  try {
    const bytes = readPrivate(file, (stat) => {
      if (stat.size > 16384) throw new Error();
    });
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assertSecretFree(value);
    return value;
  } catch {
    throw new Error('invalid_proxy_file');
  }
}

/** Revocation is independent of guest availability; join every obligation before refusing. */
async function stopResources(vm: VmAdapter, runId: string, revoke: () => Promise<void>) {
  const failures: unknown[] = [];
  await Promise.all([
    revoke().catch((error: unknown) => {
      failures.push(error);
    }),
    (async () => {
      try {
        const handles = await vm.listByRun(runId);
        for (const handle of handles) {
          try {
            await vm.destroy(handle);
          } catch (error) {
            failures.push(error);
          }
        }
      } catch (error) {
        failures.push(error);
      }
    })(),
  ]);
  if (failures.length) throw new Error('cleanup_incomplete');
}

/** Configuration is validated once here and independently by RunStore at start/resume.
 * OAuth consent remains the real loopback flow. authorizationUrl is a read-only UI edge
 * for the start script while start/resume is awaiting the contributor's browser. */
export function createController(
  input: RunConfig,
  overrides: ControllerOverrides = {}
): RunController & { readonly authorizationUrl: string | null } {
  if (
    Object.keys(overrides).some(
      (k) => !['vm', 'fetch', 'read', 'models', 'gitRemoteUrl', 'now', 'signer'].includes(k)
    )
  )
    throw new Error('invalid_controller_override');
  const config = validateRunConfig(runConfigInput(input));
  if (!config.authorApproval) throw new AuthorApprovalError('author_approval_missing');
  const now = overrides.now ?? (() => new Date());
  const fetcher = overrides.fetch ?? fetch;
  const read = policyReader(overrides.read ?? anonymousReader(fetcher));
  const signer = overrides.signer ?? new Ed25519Signer(config.signerKeyFile);
  const root = path.join(config.executionProfile.stateDir, 'runs');
  // Closed proxy configuration. Command builders validate URLs; the VM broker validates
  // the physical IP/port before provisioning. No repository input can select endpoints.
  const proxy = readProxyFile(config.executionProfile.proxyEndpointsFile);
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy))
    throw new Error('invalid_proxy_file');
  const p = proxy as Record<string, unknown>;
  if (Object.keys(p).sort().join(',') !== 'endpoints,target') throw new Error('invalid_proxy_file');
  const endpoints = p.endpoints as { npmRegistry: string; pypiIndex: string };
  const proxyTarget = p.target as { host: string; port: number };
  if (
    !endpoints ||
    Object.keys(endpoints).sort().join(',') !== 'npmRegistry,pypiIndex' ||
    typeof endpoints.npmRegistry !== 'string' ||
    typeof endpoints.pypiIndex !== 'string' ||
    !proxyTarget ||
    Object.keys(proxyTarget).sort().join(',') !== 'host,port' ||
    !/^\d{1,3}(\.\d{1,3}){3}$/u.test(proxyTarget.host) ||
    !Number.isInteger(proxyTarget.port) ||
    proxyTarget.port < 1 ||
    proxyTarget.port > 65535
  )
    throw new Error('invalid_proxy_file');
  const models = new Map<string, ModelAdapter>();
  let activeContext: PhaseContext | undefined;
  const model = (
    phase: 'planning' | 'implementing' | 'repair',
    context: PhaseContext
  ): ModelAdapter => {
    activeContext = context;
    const held = models.get(phase);
    if (held) return held;
    const selected = config.modelProfile.phases[phase] ?? config.modelProfile.phases.implementing;
    if (!overrides.models?.[phase] && selected.adapter !== 'openai-compatible')
      throw new ModelError('model_unavailable');
    const adapter =
      overrides.models?.[phase] ?? new OpenAICompatibleAdapter({ ...selected, fetch: fetcher });
    if (adapter.id !== selected.model) throw new Error('model_profile_mismatch');
    const guarded: ModelAdapter = {
      id: adapter.id,
      cacheIdentity: adapter.cacheIdentity,
      complete: async (request) => {
        const context = activeContext;
        if (!context || context.signal.aborted) throw new ModelError('model_aborted');
        const result = await adapter.complete({
          ...request,
          signal: request.signal
            ? AbortSignal.any([request.signal, context.signal])
            : context.signal,
        });
        if (context.signal.aborted)
          return { kind: 'malformed', reason: 'invalid_response', usage: result.usage };
        return result;
      },
    };
    models.set(phase, guarded);
    return guarded;
  };
  const journals = new Map<string, Journal>();
  let activeStore: RunStore | undefined;
  let heldArtifacts: StepArtifacts | undefined;
  let rawVm: VmAdapter | undefined = overrides.vm;
  let broker: ForkCredentialBroker | undefined;
  let contributor: ContributorAuthorization | undefined;
  let pusher: ForkPusher | undefined;
  let intents: IntentDriver | undefined;
  let handoff: HandoffDriver | undefined;
  let handoffMode: 'contact' | 'shipping' | undefined;
  let tracker: PrTracker | undefined;
  let app: AppCredentials | undefined;
  let shipping: ShippingAuthorizeDeps | undefined;
  let receipt: SignedReceipt | undefined;
  let authUrl: string | null = null;
  const vault = new TokenVault();
  const elapsed = new Map<string, number>();
  const journal = (c: PhaseContext, name: string) => {
    if (activeStore && activeStore !== c.store) throw new Error('controller_store_changed');
    activeStore = c.store;
    let held = journals.get(name);
    if (!held) {
      held = new Journal(
        path.join(
          c.store.storeDirectory(
            name === 'steps' ? 'control' : (name as Parameters<RunStore['storeDirectory']>[0])
          ),
          ...(name === 'steps' ? ['steps'] : [])
        )
      );
      journals.set(name, held);
    }
    return held;
  };
  const artifacts = (c: PhaseContext) => {
    activeContext = c;
    heldArtifacts ??= new StepArtifacts(journal(c, 'steps'), c.run.runId);
    return heldArtifacts;
  };
  const localVm = (c?: PhaseContext): VmAdapter => {
    if (!rawVm) {
      if (!c) throw new Error('vm_not_initialized');
      rawVm = new LocalQemuAdapter({
        stateDir: path.join(config.executionProfile.stateDir, 'vms'),
        profileDir: config.executionProfile.profileDir,
        accelerator: config.executionProfile.accelerator,
        journal: journal(c, 'vm'),
        now,
      });
    }
    return rawVm;
  };
  const vm: ControllerDependencies['vm'] = {
    async create(spec) {
      if (!overrides.vm) preflightHost(config.executionProfile.accelerator);
      const at = now().getTime();
      const handle = await localVm().create(spec);
      elapsed.set(handle.vmId, Math.max(0, now().getTime() - at));
      return handle;
    },
    async destroy(handle) {
      const at = now().getTime();
      await localVm().destroy(handle);
      elapsed.set(handle.vmId, Math.max(0, now().getTime() - at));
    },
    listByRun: async (id) => (rawVm ? rawVm.listByRun(id) : []),
  };
  // Local QEMU has no provider charge. Duration is observed, never replaced by an
  // estimate; interrupted operations retain unknown holds across process restarts.
  const estimate = (purpose: 'work' | 'teardown'): BudgetEstimate => ({
    money: { currency: config.budget.currency, minor: 0 },
    tokens: 0,
    timeMs: purpose === 'teardown' ? 5000 : 60_000,
    rates: config.modelProfile.rates.filter(
      (r) => r.resource === 'local-qemu' && r.unit === 'millisecond' && r.price === 0
    ),
  });
  const observation = (handle: Pick<VmHandle, 'vmId'>): BudgetObservation | null => {
    const timeMs = elapsed.get(handle.vmId);
    return timeMs === undefined
      ? null
      : {
          money: { currency: config.budget.currency, minor: 0 },
          tokens: 0,
          timeMs,
          source: 'local-qemu-observed',
        };
  };
  const adapter = (c: PhaseContext): VmAdapter => {
    const raw = localVm(c);
    const a: VmAdapter = {
      create: async (spec) => {
        return c.createVm({ scope: spec.scope, phase: spec.phase, proxyTarget: spec.proxyTarget });
      },
      exec: raw.exec.bind(raw),
      putFile: raw.putFile.bind(raw),
      getFile: raw.getFile.bind(raw),
      endProvisioning: raw.endProvisioning.bind(raw),
      listByRun: raw.listByRun.bind(raw),
      destroy: async (handle) => {
        const hold = c.ledger.reserve(c.sessionId, estimate('teardown'), 'teardown');
        const at = now().getTime();
        try {
          await raw.destroy(handle);
          c.ledger.settle(hold.id, {
            money: { currency: config.budget.currency, minor: 0 },
            tokens: 0,
            timeMs: Math.max(0, now().getTime() - at),
            source: 'local-qemu-observed',
          });
        } catch (error) {
          c.ledger.settle(hold.id, null);
          throw error;
        }
      },
    };
    return a;
  };
  const appCredentials = () => {
    app ??= new AppCredentials({
      appId: String(config.githubApp.appId),
      clientId: config.githubApp.clientId,
      privateKey: process.env[config.githubApp.privateKeyEnv] ?? '',
      clientSecret: process.env[config.githubApp.clientSecretEnv] ?? '',
    });
    return app;
  };
  const http = fetchGitHubHttp(undefined, fetcher);
  const checkFork = (c: PhaseContext): Promise<ReadinessOutcome> => {
    const stored = artifacts(c).get<ForkReady>('fork');
    return checkForkReadiness(
      {
        run: c.store.run,
        upstreamId: c.store.upstreamRepositoryId as number,
        readOnly:
          prerequisiteWaitOrigin(c.store.run) === null &&
          !['gating', 'shipping'].includes(c.store.run.state),
        appSlug: config.githubApp.slug,
        declaredPermissions: { contents: 'write', metadata: 'read' },
        ...(stored ? { expectedForkId: stored.repositoryId } : {}),
      },
      {
        read,
        installations: installationSource({
          http,
          app: appCredentials(),
          contributor,
          now: () => now().getTime(),
        }),
        now: () => now().toISOString(),
      }
    );
  };
  const credentials = async (c: PhaseContext) => {
    if (broker && contributor) return;
    const stored = artifacts(c).get<ForkReady>('fork');
    const result = stored ? undefined : await checkFork(c);
    if (result && result.kind !== 'ready' && result.kind !== 'authorization_required')
      throw new PrerequisiteError(
        result.kind === 'awaiting_contributor'
          ? result.reason
          : result.kind === 'blocked'
            ? 'blocked'
            : 'hand_off'
      );
    const fork =
      stored ??
      (result as Extract<ReadinessOutcome, { kind: 'ready' | 'authorization_required' }>).fork;
    if (stored && stored.repositoryId !== fork.repositoryId) throw new Error('fork_replaced');
    artifacts(c).put('fork', fork);
    broker = new ForkCredentialBroker({
      store: journal(c, 'tokens'),
      http,
      app: appCredentials(),
      fork,
      vault,
      intents: () => {
        if (!intents) throw new Error('intents_not_ready');
        return intents.snapshot();
      },
      now: () => now().getTime(),
      onCleanupBlocked: () => {
        const current = c.store.run;
        if (!TERMINAL_STATES.includes(current.state) && current.state !== 'blocked_cleanup')
          c.store.persistRun(transitionRun(current, ReasonCode.CleanupFailed, now().toISOString()));
      },
    });
    contributor = new ContributorAuthorization({
      app: appCredentials(),
      http,
      oauth: fetchOAuthHttp(undefined, fetcher),
      broker,
      contributor: config.contributor,
      appSlug: config.githubApp.slug,
      now: () => now().getTime(),
    });
    await broker.recover();
  };
  const identity = async (c: PhaseContext) => {
    c.store.validateEvidence();
    if (!c.store.config.authorApproval) throw new AuthorApprovalError('author_approval_missing');
    await credentials(c);
    c.signal.throwIfAborted();
    if (!contributor) throw new Error('authorization_unavailable');
    let bound = await contributor.bindLogin(c.store.run, c.store.config.authorApproval?.userId);
    c.signal.throwIfAborted();
    if (bound.kind === 'reauthorize') {
      const receiver = await listenLoopback({
        isExpected: (state) => contributor?.matchesPending(state) ?? false,
      });
      const aborted = () => receiver.close();
      c.signal.addEventListener('abort', aborted, { once: true });
      try {
        if (c.signal.aborted) receiver.close();
        c.signal.throwIfAborted();
        authUrl = contributor.begin(receiver.redirectUri).url;
        bound = await contributor.complete(
          await receiver.callback,
          c.store.run,
          c.store.config.authorApproval?.userId
        );
      } finally {
        authUrl = null;
        receiver.close();
        c.signal.removeEventListener('abort', aborted);
      }
    }
    c.signal.throwIfAborted();
    if (bound.kind === 'unknown' || bound.kind === 'reauthorize') {
      artifacts(c).put('refusal', 'contributor_authorization_unavailable');
      throw new Error('contributor_authorization_unavailable');
    }
    if (bound.kind !== 'bound') {
      artifacts(c).put('refusal', 'author_approval_mismatch');
      if (!TERMINAL_STATES.includes(c.store.run.state) && c.store.run.state !== 'blocked_cleanup')
        c.store.persistRun(
          transitionRun(c.store.run, ReasonCode.PolicyBlocked, now().toISOString())
        );
      throw new AuthorApprovalError('author_approval_mismatch');
    }
    requireAuthorApproval(c.store.config, bound);
    c.store.validateEvidence();
    c.signal.throwIfAborted();
    return bound;
  };
  const readiness = async (c: PhaseContext) => {
    let result = await checkFork(c);
    if (result.kind === 'authorization_required' || result.kind === 'ready') {
      await identity(c);
      result = await checkFork(c);
    }
    if (result.kind === 'ready') {
      artifacts(c).put('fork', result.fork);
      return result.fork;
    }
    if (result.kind === 'awaiting_contributor') return result.reason;
    return result.kind === 'blocked' ? ('blocked' as const) : ('hand_off' as const);
  };
  const contactAdmission = (c: PhaseContext): HandoffAdmission => ({
    prBindingVerified: async () => false,
    commitPr: async () => false,
    finalizePr: () => false,
    forkBindingVerified: async () => false,
    receiptValid: async () => false,
    remoteBranchSha: async () => null,
    contributorVerified: async () => {
      await identity(c);
      return true;
    },
    policyFresh: async () => {
      const g = artifacts(c).require<GateRecord>('gate');
      const eligibility = await assessIssue(read, config.upstream, config.contributor);
      if (eligibility.kind === 'unknown') return false;
      const decision = decideGate(g.policy, eligibility, c.run.contributor);
      const check = await createFreshnessProbe({
        read,
        upstream: config.upstream,
        contributor: config.contributor,
        gated: {
          policy: g.policy,
          policyDigest: g.policyDigest,
          eligibilityDigest: g.eligibility.evidenceDigest,
        },
      }).check();
      return (
        decision.kind === 'request_permission' &&
        check.policyDigest === g.policyDigest &&
        check.reasons.every((r) => r === 'policy_changed' || r === 'assignment_changed')
      );
    },
  });
  const openHandoff = (
    c: PhaseContext,
    admission: HandoffAdmission,
    mode: 'contact' | 'shipping' = 'contact'
  ) => {
    // Reconstruct against the same durable history when authority mode changes.
    // The journal is retained; drivers bind their admission functions once.
    if (handoff && handoffMode !== mode) {
      journals.get('handoff')?.close();
      journals.delete('handoff');
      handoff = undefined;
    }
    if (!handoff)
      handoff = new HandoffDriver(
        journal(c, 'handoff'),
        {
          read,
          admission,
          bodyDirectory: c.store.storeDirectory('bodies'),
          now: () => now().toISOString(),
        },
        { run: c.store.run, contributionId: c.store.contributionId }
      );
    handoffMode = mode;
    return handoff;
  };
  const buildShipping = async (c: PhaseContext, deps: Omit<ShippingAuthorizeDeps, 'signer'>) => {
    await identity(c);
    shipping = { ...deps, signer };
    const nonces = new ReceiptNonceStore(c.store.storeDirectory('nonces'));
    if (!artifacts(c).get<boolean>('nonces_initialized')) {
      const recovering = artifacts(c).get<boolean>('nonces_initializing') === true;
      artifacts(c).put('nonces_initializing', true);
      try {
        nonces.initialize();
      } catch (error) {
        // Before root completion no consumption can have occurred. Accept only
        // the exact completed initial header, never missing/corrupt established history.
        if (
          !recovering ||
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 'store_exists' ||
          !readPrivate(path.join(c.store.storeDirectory('nonces'), 'events.jsonl')).equals(
            Buffer.from('{"v":1,"type":"receipt-nonces"}\n')
          )
        )
          throw error;
      }
      artifacts(c).put('nonces_initialized', true);
    }
    pusher ??= new EdgeForkPusher(
      {
        broker: broker as ForkCredentialBroker,
        read,
        fork: deps.fork,
        ledger: journal(c, 'push-ledger'),
        trustedControllerKey: await signer.getPublicKey(),
        nonces,
        authorize: async (intent) => {
          await identity(c);
          if (!shipping || !pusher) throw new Error('shipping_unavailable');
          const authorization = await makeAuthorize({
            ...shipping,
            bindings: { ...shipping.bindings, expectedRemoteSha: pusher.expectedRemoteSha(intent) },
          })(intent);
          receipt = authorization.receipt;
          artifacts(c).put('receipt', receipt);
          return authorization;
        },
        now: () => now().getTime(),
      },
      overrides.gitRemoteUrl?.fork
    );
    intents ??= new IntentDriver(
      journal(c, 'intents'),
      pusher,
      { run: c.store.run, contributionId: c.store.contributionId },
      () => now().toISOString()
    );
  };
  const shippingAdmission = async (c: PhaseContext) => {
    if (!shipping || !pusher || !receipt) throw new Error('shipping_unavailable');
    return makeHandoffAdmission({
      ...shipping,
      receipt,
      trustedControllerKey: await signer.getPublicKey(),
      readLogin: async () => (await identity(c)).login,
      checkForkReadiness: () => checkFork(c),
      remoteBranchSha: pusher.handoffReadBack(shippingIntent(shipping.bindings).target),
    });
  };
  const openTracker = async (c: PhaseContext) => {
    if (tracker) return tracker;
    if (!handoff) openHandoff(c, contactAdmission(c));
    const rows = handoff?.snapshot();
    const record = [...(rows?.handoffs.values() ?? [])].find(
      (r) => r.status === 'observed' && r.input.operationKind === 'pr_create'
    );
    if (!record) throw new Error('tracked_pr_missing');
    const { pr } = trackFromHandoff(record, artifacts(c).require<ForkReady>('fork'));
    if (!pr || !record.headSha) throw new Error('tracked_pr_missing');
    const admission = shipping ? await shippingAdmission(c) : contactAdmission(c);
    tracker = new PrTracker(
      journal(c, 'track'),
      {
        read,
        admission,
        bodyDirectory: c.store.storeDirectory('bodies'),
        now: () => now().toISOString(),
        retainedIdentity: {
          upstreamRepositoryId: c.store.upstreamRepositoryId as number,
          forkRepositoryId: artifacts(c).require<ForkReady>('fork').repositoryId,
        },
      },
      { run: c.store.run, contributionId: c.store.contributionId, pr, headSha: record.headSha }
    );
    return tracker;
  };
  const steps = createSteps(
    {
      read,
      now,
      model,
      endpoints,
      proxyTarget,
      sourceRemote: overrides.gitRemoteUrl?.upstream,
      adapter,
      vmJournal: (c) => journal(c, 'vm'),
      identity,
      readiness,
      engage: async (c, body) => {
        const intent = {
          contributionId: c.store.contributionId,
          operationKind: 'engagement_comment' as const,
          target: `${c.run.upstreamIssue}/comments`,
          candidateSha: null,
        };
        return openHandoff(c, contactAdmission(c)).issueEngagement({
          intent,
          binding: { upstream: config.upstream, issue: config.upstream.issue },
          body: `${body}\n\n${handoffMarker(intent)}`,
        });
      },
      handoff: async (c) => {
        const driver = openHandoff(
          c,
          shipping && receipt ? await shippingAdmission(c) : contactAdmission(c),
          shipping && receipt ? 'shipping' : 'contact'
        );
        const result = await driver.resume();
        if (result?.kind === 'observed' && result.operation === 'pr_create')
          artifacts(c).put('publication', {
            url: result.url,
            ci: result.ci,
            headSha: result.headSha,
          });
        return result;
      },
      ship: async (c, deps, meta, policy) => {
        const { store: _store, now: _now, policyFresh: _fresh, basePack, ...persisted } = deps;
        artifacts(c).put('shipping', { ...persisted, basePack: basePack.toString('base64') });
        await buildShipping(c, deps);
        if (!intents || !shipping) throw new Error('shipping_unavailable');
        if (artifacts(c).get('publication')) {
          const t = await openTracker(c);
          const result = await t.shipRevision({
            candidateSha: deps.bindings.candidateSha,
            push: async (intent) => {
              if (!intents) throw new Error('intents_not_ready');
              return intents.execute(intent);
            },
          });
          artifacts(c).put('tracking', t.status());
          return result.kind === 'revised'
            ? 'submitted'
            : result.kind === 'blocked'
              ? 'blocked'
              : 'hand_off';
        }
        await intents.execute(shippingIntent(shipping.bindings));
        receipt ??= artifacts(c).require<SignedReceipt>('receipt');
        const record = loadVerification(
          c.store.storeDirectory('artifacts'),
          deps.bindings.candidateSha,
          { runId: c.run.runId, expectedDigest: deps.bindings.verificationDigest }
        );
        const input = {
          ...shippingIntent(deps.bindings),
          operationKind: 'pr_create' as const,
          target: `https://github.com/${config.upstream.owner}/${config.upstream.repo}/pulls`,
        };
        const currentBaseSha = await resolveBase(read, {
          ...config.upstream,
          defaultBranch: deps.bindings.defaultBranch,
        });
        artifacts(c).put('shipping_base', {
          verifiedBase: deps.bindings.baseSha,
          currentBase: currentBaseSha,
        });
        const g = artifacts(c).require<GateRecord>('gate');
        const baseline = artifacts(c).require<{ records: { status: string; argv: string }[] }>(
          'baseline'
        );
        const result = await openHandoff(c, await shippingAdmission(c), 'shipping').issuePr({
          binding: {
            upstream: config.upstream,
            base: deps.bindings.defaultBranch,
            headOwner: deps.fork.owner,
            branch: deps.bindings.branch,
          },
          content: prContentInput({
            intent: input,
            receipt,
            verification: record,
            candidateReady: meta,
            policy,
            currentBaseSha,
            limitations: [
              ...meta.limitations,
              ...(policy.draftRequired
                ? ['Upstream requires a draft PR; select Create draft PR when submitting.']
                : []),
            ],
            baselineFailures: baseline.records
              .filter((r) => r.status === 'failed')
              .map((r) => r.argv),
            ...(g.template ? { template: g.template } : {}),
          }),
        });
        return result.kind === 'blocked'
          ? 'blocked'
          : result.kind === 'observed'
            ? 'submitted'
            : 'contributor_handoff';
      },
      track: async (c) => {
        await identity(c);
        const t = await openTracker(c);
        let result = await t.resume();
        if (result.kind === 'tracking' && (result.status.feedback ?? 0) > 0)
          result = await t.beginRevision();
        artifacts(c).put('tracking', t.status());
        if (result.kind === 'merged' || result.kind === 'declined' || result.kind === 'blocked')
          return { kind: result.kind };
        if (result.kind === 'revising') {
          artifacts(c).put('feedback', result.feedback);
          artifacts(c).put('push_intended', false);
          return { kind: 'revision' };
        }
        if (
          result.kind === 'tracking' &&
          result.status.state === 'awaiting_review' &&
          c.run.state === 'submitted'
        )
          return { kind: 'awaiting_review' };
        return { kind: 'waiting' };
      },
    },
    artifacts
  );
  const diagnose = (
    c: PhaseContext,
    phase: keyof typeof steps | 'recovery',
    error: unknown
  ): never => {
    if (error instanceof AuthorApprovalError) throw error;
    const code =
      error instanceof Error &&
      [
        'contributor_authorization_unavailable',
        'invalid_step_artifact',
        'missing_step_artifact',
      ].includes(error.message)
        ? (error.message as
            | 'contributor_authorization_unavailable'
            | 'invalid_step_artifact'
            | 'missing_step_artifact')
        : 'producer_unavailable';
    artifacts(c).put('diagnostic', {
      runId: c.run.runId,
      phase,
      operation: `${phase}_producer`,
      code,
      next: 'Inspect retained evidence and explicitly resume after correcting the unavailable input.',
    });
    throw new ControllerError(phase === 'recovery' ? 'recovery_failed' : 'step_failed', {
      phase,
      code,
    });
  };
  const recoverWithDiagnostic = async <T>(c: PhaseContext, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      return diagnose(c, 'recovery', error);
    }
  };
  for (const phase of Object.keys(steps) as (keyof typeof steps)[]) {
    const invoke = steps[phase].bind(steps);
    const wrapped = async (c: PhaseContext) => {
      try {
        return await invoke(c);
      } catch (error) {
        if (error instanceof PrerequisiteError)
          return { kind: phase === 'gate' ? error.kind : 'hand_off' };
        if (
          error instanceof UnsupportedEnvironmentError ||
          error instanceof ProvisioningFailedError
        )
          return { kind: 'unsupported' };
        if (error instanceof VmCleanupError) {
          if (
            !TERMINAL_STATES.includes(c.store.run.state) &&
            c.store.run.state !== 'blocked_cleanup'
          )
            c.store.persistRun(
              transitionRun(c.store.run, ReasonCode.CleanupFailed, now().toISOString())
            );
          return { kind: 'hand_off' };
        }
        return diagnose(c, phase, error);
      }
    };
    // Each wrapper preserves its real phase's outcome; only shared failure mapping is added.
    Object.defineProperty(steps, phase, { value: wrapped });
  }
  const recoverShipping = async (c: PhaseContext) => {
    const held = artifacts(c).get<
      Omit<ShippingAuthorizeDeps, 'store' | 'signer' | 'now' | 'policyFresh' | 'basePack'> & {
        basePack: string;
      }
    >('shipping');
    if (!held) return;
    const g = artifacts(c).require<GateRecord>('gate');
    await buildShipping(c, {
      ...held,
      store: c.store,
      basePack: Buffer.from(held.basePack, 'base64'),
      now: () => now().getTime(),
      policyFresh: async () => {
        await identity(c);
        return gateFreshness(read, config, g).policyFresh();
      },
    });
    receipt = artifacts(c).get<SignedReceipt>('receipt');
  };
  const controller = new RunController({
    root,
    steps,
    vm,
    now,
    estimateVm: (_spec, purpose) => estimate(purpose),
    observeVm: async (_hold, handle) => observation(handle),
    drivers: [
      {
        observeRun: (run: RunRecord) => {
          for (const driver of [intents, handoff, tracker]) {
            if (driver && isRunContinuation(driver.snapshot().run, run)) driver.observeRun(run);
          }
        },
      },
    ],
    recovery: {
      openStore: (r, id) => {
        const store = RunStore.open(r, id);
        const { resumeRunId: _storedResume, ...storedInput } = runConfigInput(store.config);
        const { resumeRunId: _requestedResume, ...requestedInput } = runConfigInput(config);
        if (
          canonicalJson(storedInput, 1024 * 1024) !== canonicalJson(requestedInput, 1024 * 1024)
        ) {
          store.close();
          throw new Error('resume_identity_mismatch');
        }
        return store;
      },
      openBudget: (store) =>
        new BudgetLedger(
          path.join(store.storeDirectory('budget'), 'ledger.json'),
          store.contributionId
        ),
      reconcileHold: async () => null,
      reconcileCleanup: async (vmId, c) => {
        const remaining = await localVm(c).listByRun(c.run.runId);
        return remaining.some((v) => v.vmId === vmId) ? null : 'local-qemu-unbilled-guest-absent';
      },
      reconcileVms: async (c, cleanup) => {
        localVm(c);
        await cleanup();
      },
      recoverCredentials: async (c) =>
        recoverWithDiagnostic(c, async () => {
          if (!TERMINAL_STATES.includes(c.run.state) && c.run.state !== 'blocked_cleanup') {
            if (prerequisiteWaitOrigin(c.run) && !artifacts(c).get('fork')) return;
            await identity(c);
            await recoverShipping(c);
          }
        }),
      resumeIntents: async () => {
        await intents?.resume();
        return intents?.snapshot().run;
      },
      resumeHandoff: async (c) => {
        const driver = openHandoff(
          c,
          shipping && receipt ? await shippingAdmission(c) : contactAdmission(c),
          shipping && receipt ? 'shipping' : 'contact'
        );
        return driver.snapshot().run;
      },
      resumeTracker: async (c) => (await openTracker(c)).snapshot().run,
      killAll: async (c) => {
        await stopResources(localVm(c), c.run.runId, async () => {
          await broker?.killAll();
        });
      },
    },
    release: async () => {
      try {
        if (activeStore && TERMINAL_STATES.includes(activeStore.run.state))
          await broker?.endRun(activeStore.run.state === 'cancelled' ? 'cancelled' : 'completed');
      } finally {
        broker?.close();
        for (const j of journals.values()) j.close();
        journals.clear();
        activeStore = undefined;
        activeContext = undefined;
        heldArtifacts = undefined;
        broker = undefined;
        contributor = undefined;
        pusher = undefined;
        intents = undefined;
        handoff = undefined;
        handoffMode = undefined;
        tracker = undefined;
        shipping = undefined;
        receipt = undefined;
        app = undefined;
        if (!overrides.vm) rawVm = undefined;
      }
    },
  });
  const start = controller.start.bind(controller);
  Object.defineProperty(controller, 'start', {
    value: (next: RunConfig) => {
      if (
        canonicalJson(runConfigInput(next), 1024 * 1024) !==
        canonicalJson(runConfigInput(config), 1024 * 1024)
      )
        throw new Error('controller_config_mismatch');
      return start(config);
    },
  });
  return Object.defineProperty(controller, 'authorizationUrl', {
    get: () => authUrl,
  }) as RunController & { readonly authorizationUrl: string | null };
}
