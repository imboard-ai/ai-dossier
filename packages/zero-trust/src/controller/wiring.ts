/** Controller-only credential composition root. Deliberately absent from index.ts.
 * Scripts import this file; no other production src module may reach it. */

import fs from 'node:fs';
import path from 'node:path';
import { Ed25519Signer, type Signer } from '@ai-dossier/core';
import { BudgetLedger, conservativeHoldObservation } from '../budget';
import type { BudgetEstimate, BudgetObservation } from '../budget-types';
import { resolveBase } from '../canonical/acquire';
import { assertDirectoryAncestors, readPrivate, replacePrivate } from '../durable-fs';
import { AppCredentials, fetchGitHubHttp, fetchOAuthHttp } from '../github/app-auth';
import { ForkCredentialBroker } from '../github/broker';
import {
  ContributorAuthError,
  ContributorAuthorization,
  installationSource,
  listenLoopback,
} from '../github/contributor';
import { checkForkReadiness, type ForkReady, type ReadinessOutcome } from '../github/fork';
import { type ForkBranch, readForkBranch } from '../github/fork-ref';
import { bodyDigest, handoffMarker, prTitle } from '../github/handoff';
import { type HandoffAdmission, HandoffDriver } from '../github/handoff-driver';
import { ForkPusher, type ForkPusherOptions } from '../github/push';
import { anonymousReader, type GitHubRead, tokenReader } from '../github/reconcile';
import { TokenJournal, TokenVault, UNRESOLVED } from '../github/token-journal';
import { PrTracker, TrackError, trackFromHandoff } from '../github/track';
import { IntentDriver, WriteBlockedError, WriteRefusedError } from '../intents';
import { Journal } from '../journal';
import { StoreLockedError } from '../lock';
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
  isTrackerPhase,
  prerequisiteWaitOrigin,
  ReasonCode,
  type RunRecord,
  sameRunRecord,
  TERMINAL_STATES,
  TRACKING_STATES,
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
import { teardownVm } from '../vm/teardown';
import { AuthorApprovalError, requireAuthorApproval } from './author-approval';
import { validateCheckpointReview } from './checkpoints';
import { type RunConfig, runConfigInput, validateRunConfig } from './config';
import {
  type ControllerDependencies,
  ControllerError,
  type PhaseContext,
  RunController,
  type TrackerActionResult,
} from './controller';
import { ProvisioningFailedError } from './evidence-runner';
import { retainPortfolio, retainReceipt } from './export-evidence';
import { readOutcomeBudget } from './outcome-records';
import { RunStore } from './run-store';
import {
  makeAuthorize,
  makeHandoffAdmission,
  prContentInput,
  type ShippingAuthorizeDeps,
  shippingIntent,
} from './shipping';
import { createSteps, type GateRecord, gateFreshness, policyReader, StepArtifacts } from './steps';
import { clearStopNotice, recordStopNotice, writeBlockedNotice } from './stop-notice';
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
  /** Immediate production UI notification, never a credential or provider response. */
  readonly onAuthorizationUrl?: (url: string) => void;
}

export function incidentRequested(root: string): boolean {
  try {
    fs.lstatSync(path.join(root, '.incident'));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
/** Durable root-wide stop-only authority, installed before run enumeration. */
export function fenceIncident(root: string, reason: string): void {
  assertSecretFree(reason);
  if (path.basename(path.resolve(root)) !== 'runs') throw new Error('root_mismatch');
  assertDirectoryAncestors(root);
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let parent = fs.openSync('/', flags);
  const children: number[] = [];
  try {
    // Descriptor-relative traversal prevents ancestor swaps from redirecting a
    // stop write after the non-mutating pathname preflight.
    for (const name of path.resolve(root, '..').split(path.sep).filter(Boolean)) {
      const next = fs.openSync(`/proc/self/fd/${parent}/${name}`, flags);
      fs.closeSync(parent);
      parent = next;
    }
    if (fs.fstatSync(parent).uid !== process.getuid?.()) throw new Error('invalid_store');
    const child = (name: string) => {
      const file = `/proc/self/fd/${parent}/${name}`;
      try {
        fs.mkdirSync(file, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const fd = fs.openSync(file, flags);
      children.push(fd);
      if (fs.fstatSync(fd).uid !== process.getuid?.()) throw new Error('invalid_store');
      fs.fchmodSync(fd, 0o700);
      return fd;
    };
    const runFd = child('runs');
    replacePrivate(`/proc/self/fd/${runFd}/.incident`, Buffer.from('incident'));
    const vmFd = child('vms');
    new LocalQemuAdapter({
      stateDir: path.join(path.dirname(root), 'vms'),
      profileDir: '.',
      verifyImage: false,
    }).engageKillSwitch(reason, vmFd);
  } finally {
    for (const fd of children) fs.closeSync(fd);
    fs.closeSync(parent);
  }
}
const ACTION_CANCELLED =
  'The local pending action was cancelled. No upstream change was made. Open the PR to inspect its state; resume explicitly to observe it.';
/** A contributor-action refusal the CLI reports by its fixed code. */
function actionRefused(code: 'action_unavailable' | 'action_pending'): Error {
  return Object.assign(new Error(code), { code });
}
function configuredApp(config: RunConfig): AppCredentials {
  return new AppCredentials({
    appId: String(config.githubApp.appId),
    clientId: config.githubApp.clientId,
    privateKey: process.env[config.githubApp.privateKeyEnv] ?? '',
    clientSecret: process.env[config.githubApp.clientSecretEnv] ?? '',
  });
}
function sameConfig(left: RunConfig, right: RunConfig): boolean {
  const { resumeRunId: _left, ...a } = runConfigInput(left);
  const { resumeRunId: _right, ...b } = runConfigInput(right);
  return canonicalJson(a, 1024 * 1024) === canonicalJson(b, 1024 * 1024);
}

/** Pre-start OAuth identity acquisition: no fabricated fork, run, or durable token. */
export async function prepareAuthor(
  input: RunConfig,
  identity: { readonly name?: string; readonly email?: string; readonly userId?: number } = {},
  edges: Pick<ControllerOverrides, 'fetch' | 'now' | 'onAuthorizationUrl'> = {}
) {
  const config = validateRunConfig(runConfigInput(input));
  const fetcher = edges.fetch ?? fetch;
  const auth = new ContributorAuthorization({
    app: configuredApp(config),
    http: fetchGitHubHttp(undefined, fetcher),
    oauth: fetchOAuthHttp(undefined, fetcher),
    contributor: config.contributor,
    appSlug: config.githubApp.slug,
    now: () => (edges.now?.() ?? new Date()).getTime(),
  });
  const receiver = await listenLoopback({ isExpected: (state) => auth.matchesPending(state) });
  try {
    const url = auth.begin(receiver.redirectUri).url;
    if (!edges.onAuthorizationUrl) throw new Error('authorization_ui_unavailable');
    edges.onAuthorizationUrl(url);
    try {
      return await auth.completeAuthor(await receiver.callback, identity);
    } catch (error) {
      if (error instanceof ContributorAuthError && error.code === 'author_approval_mismatch')
        throw new AuthorApprovalError('author_approval_mismatch');
      throw error;
    }
  } finally {
    receiver.close();
  }
}

/** Incident cleanup opens a dormant run directly. It never authenticates, gates,
 * resumes work or depends on a model/proxy configuration being available. */
export async function stopStoredRun(
  root: string,
  runId: string,
  reason: string,
  edges: Pick<ControllerOverrides, 'fetch' | 'vm' | 'now'> = {}
): Promise<void> {
  assertSecretFree(reason);
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500)
    throw new ControllerError('invalid_outcome');
  let acquired: RunStore | undefined;
  const deadline = Date.now() + 30000;
  while (!acquired) {
    try {
      acquired = RunStore.open(root, runId, { cleanup: true });
    } catch (error) {
      if (!(error instanceof StoreLockedError)) throw error;
      if (!incidentRequested(root) || Date.now() >= deadline) throw new Error('cleanup_incomplete');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const store = acquired;
  const opened: Journal[] = [];
  let broker: ForkCredentialBroker | undefined;
  const journal = (name: Parameters<RunStore['storeDirectory']>[0], child?: string) => {
    const j = new Journal(path.join(store.storeDirectory(name), ...(child ? [child] : [])));
    opened.push(j);
    return j;
  };
  try {
    const config = store.config;
    if (path.resolve(root) !== path.resolve(config.executionProfile.stateDir, 'runs'))
      throw new Error('root_mismatch');
    const now = edges.now ?? (() => new Date());
    const control = journal('control', 'controller');
    control.append({ v: 1, type: 'incident', runId, reason });
    const vm =
      edges.vm ??
      new LocalQemuAdapter({
        stateDir: path.join(config.executionProfile.stateDir, 'vms'),
        profileDir: config.executionProfile.profileDir,
        accelerator: config.executionProfile.accelerator,
        journal: journal('vm'),
        now,
      });
    let failed = false;
    let unfunded = false;
    const incidentVm: Pick<VmAdapter, 'listByRun' | 'destroy'> = {
      listByRun: vm.listByRun.bind(vm),
      destroy: async (handle) => {
        let ledger: BudgetLedger | undefined;
        let hold: ReturnType<BudgetLedger['reserve']> | undefined;
        try {
          ledger = new BudgetLedger(
            path.join(store.storeDirectory('budget'), 'ledger.json'),
            store.contributionId
          );
          const session = ledger.snapshot().sessions.at(-1);
          if (!session) throw new Error('missing_budget_session');
          hold = ledger.reserve(
            session.id,
            {
              money: { currency: config.budget.currency, minor: 0 },
              tokens: 0,
              timeMs: 5000,
              rates: config.modelProfile.rates.filter(
                (r) => r.resource === 'local-qemu' && r.unit === 'millisecond' && r.price === 0
              ),
            },
            'teardown'
          );
        } catch {
          // Incident destruction remains mandatory when accounting is unavailable.
          // Preserve an unfunded obligation rather than claiming free cleanup.
          unfunded = true;
          try {
            control.append({
              v: 1,
              type: 'cleanup',
              runId,
              vmId: handle.vmId,
              kind: 'pending',
              funded: false,
            });
          } catch {
            failed = true;
          }
        }
        const at = now().getTime();
        try {
          const result = await teardownVm(vm, handle, store.run, {
            now,
            reconcileStopped: true,
            retryDelayMs: 0,
          });
          if (result.kind !== 'destroyed') throw new Error('cleanup_incomplete');
        } catch (error) {
          if (hold) ledger?.settle(hold.id, null);
          throw error;
        }
        if (hold)
          ledger?.settle(hold.id, {
            money: { currency: config.budget.currency, minor: 0 },
            tokens: 0,
            timeMs: Math.max(0, now().getTime() - at),
            source: 'local-qemu-observed',
          });
        else
          control.append({
            v: 1,
            type: 'cleanup',
            runId,
            vmId: handle.vmId,
            kind: 'destroyed',
            funded: false,
          });
      },
    };
    try {
      await stopResources(incidentVm, runId, async () => {
        const tokens = journal('tokens');
        const tokenJournal = new TokenJournal(tokens);
        tokenJournal.settleExpired(now().toISOString());
        const ledger = tokenJournal.state;
        if (![...ledger.tokens.values()].some((t) => UNRESOLVED.includes(t.status))) return;
        const fork = new StepArtifacts(journal('control', 'steps'), runId).require<ForkReady>(
          'fork'
        );
        broker = new ForkCredentialBroker({
          store: tokens,
          fork,
          http: fetchGitHubHttp(undefined, edges.fetch ?? fetch),
          app: configuredApp(config),
          intents: () => {
            throw new Error('admission_closed');
          },
          now: () => now().getTime(),
        });
        await broker.killAll();
        if (broker.settleExpired()) throw new Error('cleanup_incomplete');
      });
    } catch {
      failed = true;
    }
    failed ||= unfunded;
    const unresolved = control
      .read()
      .some(
        (event) =>
          event &&
          typeof event === 'object' &&
          'type' in event &&
          event.type === 'cleanup' &&
          'funded' in event &&
          event.funded === false
      );
    if (
      !failed &&
      store.run.state === 'blocked_cleanup' &&
      !unresolved &&
      !readOutcomeBudget(store).reservations.some((r) => r.status === 'reserved')
    )
      store.persistRun(transitionRun(store.run, ReasonCode.CleanupCompleted, now().toISOString()));
    if (!TERMINAL_STATES.includes(store.run.state) && store.run.state !== 'blocked_cleanup')
      store.persistRun(
        transitionRun(
          store.run,
          failed ? ReasonCode.CleanupFailed : ReasonCode.UserCancelled,
          now().toISOString()
        )
      );
    if (failed && store.run.state !== 'blocked_cleanup') throw new Error('cleanup_incomplete');
  } finally {
    broker?.close();
    for (const j of opened) j.close();
    store.close();
  }
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
async function stopResources(
  vm: Pick<VmAdapter, 'listByRun' | 'destroy'>,
  runId: string,
  revoke: () => Promise<void>
) {
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
): RunController & {
  readonly authorizationUrl: string | null;
  readonly nextPermittedAction: 'authorize' | null;
  authorize(runId: string): Promise<void>;
} {
  if (
    Object.keys(overrides).some(
      (k) =>
        ![
          'vm',
          'fetch',
          'read',
          'models',
          'gitRemoteUrl',
          'now',
          'signer',
          'onAuthorizationUrl',
        ].includes(k)
    )
  )
    throw new Error('invalid_controller_override');
  let config = validateRunConfig(runConfigInput(input));
  if (!config.authorApproval) throw new AuthorApprovalError('author_approval_missing');
  const now = overrides.now ?? (() => new Date());
  const fetcher = overrides.fetch ?? fetch;
  const read = policyReader(
    overrides.read ??
      (config.githubReadTokenEnv
        ? tokenReader(process.env[config.githubReadTokenEnv] ?? '', fetcher)
        : anonymousReader(fetcher))
  );
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
    const currentProfile = context.store.config.modelProfile;
    const selected = currentProfile.phases[phase] ?? currentProfile.phases.implementing;
    if (!overrides.models?.[phase] && selected.adapter !== 'openai-compatible')
      throw new ModelError('model_unavailable');
    const adapter =
      overrides.models?.[phase] ?? new OpenAICompatibleAdapter({ ...selected, fetch: fetcher });
    if (adapter.id !== selected.model) throw new Error('model_profile_mismatch');
    const guarded: ModelAdapter = {
      id: adapter.id,
      cacheIdentity: adapter.cacheIdentity,
      complete: async (request) => {
        controller.assertAdmission();
        const context = activeContext;
        if (!context || context.signal.aborted) throw new ModelError('model_aborted');
        const result = await adapter.complete({
          ...request,
          signal: request.signal
            ? AbortSignal.any([request.signal, context.signal])
            : context.signal,
        });
        // Interruption does not invalidate a complete response or its known
        // usage. The loop saves it as data before checking stop admission.
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
  let revisionObservationWaiting = false;
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
    const guard = async <T>(work: () => Promise<T>): Promise<T> => {
      c.assertAdmission();
      let aborted!: () => void;
      const stop = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new ControllerError('admission_closed'));
        c.signal.addEventListener('abort', aborted, { once: true });
      });
      try {
        const result = await Promise.race([work(), stop]);
        c.assertAdmission();
        return result;
      } finally {
        c.signal.removeEventListener('abort', aborted);
      }
    };
    const a: VmAdapter = {
      create: async (spec) => {
        return c.createVm({ scope: spec.scope, phase: spec.phase, proxyTarget: spec.proxyTarget });
      },
      exec: (...args) => guard(() => raw.exec(...args)),
      putFile: (...args) => guard(() => raw.putFile(...args)),
      getFile: (...args) => guard(() => raw.getFile(...args)),
      endProvisioning: (...args) => guard(() => raw.endProvisioning(...args)),
      listByRun: raw.listByRun.bind(raw),
      destroy: async (handle) => {
        // On an external stop the core owns destruction and accounting. Joining
        // its completion precedes the final pause/cancel snapshot.
        if (c.signal.aborted) return;
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
    app ??= configuredApp(config);
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
  const openBroker = (c: PhaseContext, fork: ForkReady) =>
    new ForkCredentialBroker({
      assertAdmission: controller.assertAdmission.bind(controller),
      store: journal(c, 'tokens'),
      http,
      app: appCredentials(),
      fork,
      vault,
      intents: () => {
        controller.assertAdmission();
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
  const cleanupCredentials = async (c: PhaseContext) => {
    const fork = artifacts(c).get<ForkReady>('fork');
    if (!fork) return;
    if (!broker) {
      const retained = new TokenJournal(journal(c, 'tokens'));
      retained.settleExpired(now().toISOString());
      if (![...retained.state.tokens.values()].some((token) => UNRESOLVED.includes(token.status)))
        return;
      broker = openBroker(c, fork);
    }
    const result = await broker.recover();
    if (result.report) throw new Error('cleanup_incomplete');
  };
  const credentials = async (c: PhaseContext) => {
    controller.assertAdmission();
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
    controller.assertAdmission();
    if (stored && stored.repositoryId !== fork.repositoryId) throw new Error('fork_replaced');
    artifacts(c).put('fork', fork);
    broker ??= openBroker(c, fork);
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
  class AuthorizationRequired extends Error {}
  let authorizationRequired = false;
  const requireAuthorization = (c: PhaseContext): never => {
    authorizationRequired = true;
    artifacts(c).put('authorization_required', { nextPermittedAction: 'authorize' });
    artifacts(c).put('diagnostic', {
      runId: c.run.runId,
      phase: 'authorization',
      operation: 'contributor_refresh',
      code: 'reauthorize',
      next: 'authorize',
    });
    throw new AuthorizationRequired();
  };
  const identity = async (c: PhaseContext) => {
    controller.assertAdmission();
    c.store.validateEvidence();
    if (!c.store.config.authorApproval) throw new AuthorApprovalError('author_approval_missing');
    await credentials(c);
    // Cleanup recovery precedes an authorization fence: a crash may have left
    // journaled credentials whose values the new process cannot revoke.
    if (artifacts(c).get('authorization_required')) requireAuthorization(c);
    controller.assertAdmission();
    c.signal.throwIfAborted();
    if (!contributor) throw new Error('authorization_unavailable');
    const parent = broker
      ?.status()
      .tokens.filter((token) => token.kind === 'user' && token.status === 'live')
      .at(-1);
    if (parent?.expiresAt && Date.parse(parent.expiresAt) <= now().getTime()) {
      const refreshed = await contributor.refresh();
      controller.assertAdmission();
      if (refreshed.kind === 'reauthorize') requireAuthorization(c);
      if (refreshed.kind !== 'refreshed') throw new Error('contributor_authorization_unavailable');
    }
    let bound = await contributor.bindLogin(c.store.run, c.store.config.authorApproval?.userId);
    controller.assertAdmission();
    c.signal.throwIfAborted();
    if (bound.kind === 'reauthorize') {
      // A once-bound identity losing its authority requires an explicit user
      // authorize command, never automatic interactive renewal inside shipping.
      if (parent) requireAuthorization(c);
      const receiver = await listenLoopback({
        isExpected: (state) => contributor?.matchesPending(state) ?? false,
      });
      const aborted = () => receiver.close();
      c.signal.addEventListener('abort', aborted, { once: true });
      try {
        controller.assertAdmission();
        if (c.signal.aborted) receiver.close();
        c.signal.throwIfAborted();
        authUrl = contributor.begin(receiver.redirectUri).url;
        overrides.onAuthorizationUrl?.(authUrl);
        const callback = await receiver.callback;
        controller.assertAdmission();
        bound = await contributor.complete(
          callback,
          c.store.run,
          c.store.config.authorApproval?.userId
        );
        controller.assertAdmission();
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
          assertAdmission: controller.assertAdmission.bind(controller),
          bodyDirectory: c.store.storeDirectory('bodies'),
          now: () => now().toISOString(),
          remoteShaRetryMs: [1000, 2000, 4000],
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
    await bindPushDrivers(c, deps.fork, async (intent) => {
      await identity(c);
      if (!shipping || !pusher) throw new Error('shipping_unavailable');
      const authorization = await makeAuthorize({
        ...shipping,
        bindings: { ...shipping.bindings, expectedRemoteSha: pusher.expectedRemoteSha(intent) },
      })(intent);
      controller.assertAdmission();
      receipt = authorization.receipt;
      retainReceipt(c.store, receipt);
      artifacts(c).put('receipt', receipt);
      return authorization;
    });
  };
  const bindPushDrivers = async (
    c: PhaseContext,
    fork: ForkPusherOptions['fork'],
    authorize: ForkPusherOptions['authorize']
  ) => {
    pusher ??= new EdgeForkPusher(
      {
        broker: broker as ForkCredentialBroker,
        read,
        fork,
        ledger: journal(c, 'push-ledger'),
        trustedControllerKey: await signer.getPublicKey(),
        nonces: new ReceiptNonceStore(c.store.storeDirectory('nonces')),
        authorize,
        signal: c.signal,
        assertAdmission: c.assertAdmission,
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
    const admission = makeHandoffAdmission({
      ...shipping,
      receipt,
      trustedControllerKey: await signer.getPublicKey(),
      readLogin: async () => (await identity(c)).login,
      checkForkReadiness: () => checkFork(c),
      remoteBranchSha: pusher.handoffReadBack(shippingIntent(shipping.bindings).target),
    });
    // A pending control file is a stop fence even before its lifecycle snapshot
    // can be committed. Recheck after every awaited admission fact and at the
    // final synchronous publication boundary.
    return Object.fromEntries(
      Object.entries(admission).map(([key, fn]) => [
        key,
        (...args: unknown[]) => {
          controller.assertAdmission();
          const result = (fn as (...a: unknown[]) => unknown)(...args);
          if (result instanceof Promise)
            return result.then((value) => {
              controller.assertAdmission();
              return value;
            });
          controller.assertAdmission();
          return result;
        },
      ])
    ) as unknown as HandoffAdmission;
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
    artifacts(c).put('tracked_pr', { number: pr.number });
    const admission = {
      policyFresh: async () => {
        c.assertAdmission();
        const probe = await gateFreshness(read, config, artifacts(c).require<GateRecord>('gate'), {
          number: tracker?.snapshot().pr.number ?? pr.number,
        }).check();
        artifacts(c).put('revision_freshness', probe);
        c.assertAdmission();
        return probe.fresh;
      },
      contributorVerified: async () => {
        await identity(c);
        c.assertAdmission();
        return true;
      },
      forkBindingVerified: async () => {
        const result = await checkFork(c);
        c.assertAdmission();
        return result.kind === 'ready';
      },
    };
    tracker = new PrTracker(
      journal(c, 'track'),
      {
        read,
        admission,
        retainRevisionFeedback: (feedback) => artifacts(c).put('feedback', feedback),
        bodyDirectory: c.store.storeDirectory('bodies'),
        now: () => now().toISOString(),
        reviewers: c.reviewers,
        retainedIdentity: {
          upstreamRepositoryId: c.store.upstreamRepositoryId as number,
          forkRepositoryId: artifacts(c).require<ForkReady>('fork').repositoryId,
        },
      },
      { run: c.store.run, contributionId: c.store.contributionId, pr, headSha: record.headSha }
    );
    return tracker;
  };
  /** Tracker owns observation transitions. Publish its exact history, then notify
   * all other drivers before another capability can run. */
  const syncTracker = async (c: PhaseContext, t: PrTracker) => {
    artifacts(c).put('tracking', t.status());
    artifacts(c).put('tracked_pr', { number: t.snapshot().pr.number });
    await c.observeRun(t.snapshot().run);
    for (const driver of [intents, handoff]) if (driver) observeDriver(driver, t.snapshot().run);
  };
  const observeDriver = (driver: IntentDriver | HandoffDriver | PrTracker, run: RunRecord) => {
    try {
      driver.observeRun(run);
    } catch (error) {
      // IntentDriver latches all calls after its durable block, including a no-op
      // observation of the identical blocked history. Its own committed transition
      // is already synchronized; any missing or different history still refuses.
      if (
        driver === intents &&
        intents.snapshot().blockedReason &&
        sameRunRecord(intents.snapshot().run, run)
      )
        return;
      throw error;
    }
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
        // An ambiguous match issues no new link: status must not point back at the old one.
        // The run stays waiting (no transition). An unreadable listing decides nothing and
        // keeps the notice; any other answer retires it.
        const waiting = result?.kind === 'awaiting_contributor' ? result.reconciliation : null;
        if (result?.kind === 'awaiting_contributor' && waiting === 'ambiguous')
          recordStopNotice(
            artifacts(c),
            c.store.run,
            {
              state: 'awaiting_contributor',
              reason: `ambiguous:${result.ambiguity}`,
              nextPermittedAction: result.status.nextPermittedAction,
            },
            false
          );
        else if (waiting !== 'unknown') clearStopNotice(artifacts(c));
        if (result?.kind === 'observed' && result.operation === 'pr_create')
          artifacts(c).put('publication', {
            url: result.url,
            ci: result.ci,
            headSha: result.headSha,
          });
        // As in ship: adopt the driver's own transition instead of stamping a second one.
        await c.observeRun(driver.snapshot().run);
        return result;
      },
      ship: async (c, deps, meta, policy) => {
        const { store: _store, now: _now, policyFresh: _fresh, basePack, ...persisted } = deps;
        artifacts(c).put('shipping', { ...persisted, basePack: basePack.toString('base64') });
        await buildShipping(c, deps);
        if (!intents || !shipping) throw new Error('shipping_unavailable');
        if (artifacts(c).get('publication')) {
          retainPortfolio(
            c.store,
            deps.bindings.candidateSha,
            artifacts(c).require<GateRecord>('gate').policy.citations
          );
          const t = await openTracker(c);
          const result = await t.shipRevision({
            candidateSha: deps.bindings.candidateSha,
            push: async (intent) => {
              if (!intents) throw new Error('intents_not_ready');
              return intents.execute(intent);
            },
          });
          await syncTracker(c, t);
          if (result.kind === 'revision_pending' || result.kind === 'action') return 'waiting';
          return result.kind === 'revised'
            ? 'submitted'
            : result.kind === 'blocked'
              ? 'blocked'
              : 'hand_off';
        }
        try {
          await intents.execute(shippingIntent(shipping.bindings));
        } catch (error) {
          // Only a block the intent journal recorded (a diverged remote, a refused receipt)
          // ends shipping; a failed journal write latches without one and is rethrown.
          const reason = intents.snapshot().blockedReason;
          if (!(error instanceof WriteBlockedError) || !reason) throw error;
          const detail = error.cause instanceof WriteRefusedError ? error.cause.detail : undefined;
          artifacts(c).put('shipping_block', { reason, ...(detail ? { detail } : {}) });
          recordStopNotice(artifacts(c), c.store.run, writeBlockedNotice(reason), true);
          // Adopt its durable block, as revision tracking does.
          await c.observeRun(intents.snapshot().run);
          return 'blocked';
        }
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
        const handoff = openHandoff(c, await shippingAdmission(c), 'shipping');
        retainPortfolio(c.store, record.candidateSha, g.policy.citations);
        const result = await handoff.issuePr({
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
              ...(c.store.userChanges.some((change) => change.kind === 'source')
                ? [
                    'Includes contributor edits; every edited candidate was independently re-verified.',
                  ]
                : []),
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
        // Adopt the driver's durable transition: a second one stamped by the controller's
        // clock would make the two journals disagree on the run's history.
        await c.observeRun(handoff.snapshot().run);
        return result.kind === 'blocked'
          ? 'blocked'
          : result.kind === 'observed'
            ? 'submitted'
            : 'contributor_handoff';
      },
      track: async (c) => {
        const t = await openTracker(c);
        let result = await t.resume();
        await syncTracker(c, t);
        if (c.revise && result.kind === 'tracking' && (result.status.feedback ?? 0) > 0) {
          const baseSha = t.snapshot().verifiedSha;
          result = await t.beginRevision();
          if (result.kind === 'revising') {
            artifacts(c).put('revision_base_sha', baseSha);
            artifacts(c).put('push_intended', false);
          }
          await syncTracker(c, t);
        }
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
  const recoverWithDiagnostic = async (
    c: PhaseContext,
    work: () => Promise<void>
  ): Promise<void> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AuthorizationRequired) return;
      return diagnose(c, 'recovery', error);
    }
  };
  for (const phase of Object.keys(steps) as (keyof typeof steps)[]) {
    const invoke = steps[phase].bind(steps);
    const wrapped = async (c: PhaseContext) => {
      try {
        if (artifacts(c).get('authorization_required')) requireAuthorization(c);
        return await invoke(c);
      } catch (error) {
        if (error instanceof AuthorizationRequired) return { kind: 'hand_off' };
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
  const refreshBeforeCleanup = async () => {
    const parent = broker
      ?.status()
      .tokens.filter((t) => t.kind === 'user' && t.status === 'live')
      .at(-1);
    if (!parent?.expiresAt || Date.parse(parent.expiresAt) > now().getTime() || !contributor)
      return;
    const refreshed = await contributor.refresh();
    if (refreshed.kind === 'unavailable') {
      const current = activeStore?.run;
      if (
        current &&
        !TERMINAL_STATES.includes(current.state) &&
        current.state !== 'blocked_cleanup'
      )
        activeStore?.persistRun(
          transitionRun(current, ReasonCode.CleanupFailed, now().toISOString())
        );
      throw new Error('cleanup_incomplete');
    }
  };
  const controller: RunController = new RunController({
    trackerAction: async (c, request) => {
      const t = await openTracker(c);
      let result: Awaited<ReturnType<PrTracker['cancelAction']>>;
      try {
        result =
          request.kind === 'edit'
            ? await t.requestEdit(request)
            : request.kind === 'withdraw'
              ? await t.requestWithdrawal(request)
              : await t.cancelAction();
      } catch (error) {
        // The tracker refused this action in the run's current state (no pending action,
        // an edit outside a revision, a withdrawal during one): a closed CLI code.
        if (error instanceof TrackError) throw actionRefused('action_unavailable');
        throw error;
      }
      await syncTracker(c, t);
      const status = t.status();
      let action: TrackerActionResult;
      if (request.kind === 'cancel-action')
        action = { kind: 'cancel-action', link: status.pr, instructions: ACTION_CANCELLED };
      else {
        if (result.kind !== 'action' || !status.action) throw new Error('action_not_issued');
        // A re-request returns the pending action. A different request must not be answered
        // with another action's link: the contributor cancels the pending one first.
        if (
          status.action.kind !== request.kind ||
          (request.kind === 'edit' &&
            (status.action.title !== prTitle(request.title) ||
              status.action.bodyDigest !== bodyDigest(request.body)))
        )
          throw actionRefused('action_pending');
        action = status.action;
      }
      artifacts(c).put('contributor_action', action);
      return action;
    },
    incidentRequested: () => incidentRequested(root),
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
            if (driver && isRunContinuation(driver.snapshot().run, run)) observeDriver(driver, run);
            else if (driver && !isRunContinuation(run, driver.snapshot().run))
              throw new Error('producer_run_diverged');
          }
        },
      },
    ],
    recovery: {
      endRun: async (c, reason = 'cancelled') => {
        // Dormant cancellation must not perform OAuth to revoke an old lease.
        if (!broker && artifacts(c).get('fork')) {
          broker = new ForkCredentialBroker({
            store: journal(c, 'tokens'),
            http,
            app: appCredentials(),
            fork: artifacts(c).require<ForkReady>('fork'),
            vault,
            intents: () => {
              throw new Error('admission_closed');
            },
            now: () => now().getTime(),
          });
        }
        await refreshBeforeCleanup();
        await broker?.endRun(reason);
      },
      reconcileControl: async (c) => {
        if (!intents && artifacts(c).get('shipping')) {
          const held = artifacts(c).require<ShippingAuthorizeDeps>('shipping');
          // Recovery uses read-back only. The authorize path remains closed.
          await bindPushDrivers(c, held.fork, async () => {
            throw new Error('admission_closed');
          });
        }
        await intents?.resume();
        const driver = openHandoff(c, contactAdmission(c));
        const observed = await driver.resume();
        if (observed?.kind === 'observed' && observed.operation === 'pr_create')
          artifacts(c).put('publication', {
            url: observed.url,
            ci: observed.ci,
            headSha: observed.headSha,
          });
        let run = driver.snapshot().run;
        // Completed tracker/intent observations precede stop transitions even
        // when the stop became durable while their read or write was in flight.
        for (const other of [intents, tracker]) {
          if (!other) continue;
          const observedRun = other.snapshot().run;
          if (isRunContinuation(run, observedRun)) run = observedRun;
          else if (!isRunContinuation(observedRun, run)) throw new Error('producer_run_diverged');
        }
        return run;
      },
      prepareCancellation: async (c) => {
        if (artifacts(c).get('publication') && TRACKING_STATES.includes(c.store.run.state)) {
          const t = await openTracker(c);
          await t.requestWithdrawal({
            reason: 'user_instruction',
            explanation: 'The contributor cancelled this run.',
          });
          artifacts(c).put('withdrawal', t.status().nextPermittedAction);
        }
      },
      openStore: (r, id) => {
        const store = RunStore.open(r, id);
        if (!sameConfig(store.config, config)) {
          const { modelProfile: _oldModel, checkpoints: _oldPoints, ...oldIdentity } = config;
          const { modelProfile: _newModel, checkpoints: _newPoints, ...newIdentity } = store.config;
          if (
            !store.userChanges.length ||
            canonicalJson(oldIdentity, 1024 * 1024) !== canonicalJson(newIdentity, 1024 * 1024)
          ) {
            store.close();
            throw new Error('resume_identity_mismatch');
          }
          config = validateRunConfig(runConfigInput(store.config));
        }
        return store;
      },
      openBudget: (store) =>
        new BudgetLedger(
          path.join(store.storeDirectory('budget'), 'ledger.json'),
          store.contributionId
        ),
      reconcileHold: async (hold) => conservativeHoldObservation(hold),
      reconcileCleanup: async (vmId, c) => {
        const remaining = await localVm(c).listByRun(c.run.runId);
        return remaining.some((v) => v.vmId === vmId) ? null : 'local-qemu-unbilled-guest-absent';
      },
      reconcileVms: async (c, cleanup) => {
        localVm(c);
        await cleanup();
      },
      cleanupCredentials,
      recoverCredentials: async (c) =>
        recoverWithDiagnostic(c, async () => {
          for (const point of ['plan', 'patch'] as const) {
            const checkpoint = c.store.checkpoint(point);
            if (checkpoint?.status === 'open') validateCheckpointReview(c.store, checkpoint);
          }
          if (!TERMINAL_STATES.includes(c.run.state) && c.run.state !== 'blocked_cleanup') {
            // Explicit observation and link issuance need no paid computation or OAuth.
            if (TRACKING_STATES.includes(c.run.state)) return;
            if (prerequisiteWaitOrigin(c.run) && !artifacts(c).get('fork')) return;
            // Before gating binds the upstream no fork check or credential can exist.
            if (c.store.upstreamRepositoryId === undefined && !artifacts(c).get('fork')) return;
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
      resumeTracker: async (c) => {
        if (!artifacts(c).get('publication')) return undefined;
        if (
          !isTrackerPhase(c.store.run) &&
          !fs.existsSync(path.join(c.store.storeDirectory('track'), 'events.jsonl'))
        )
          return undefined;
        const t = await openTracker(c);
        if (t.snapshot().revision) {
          artifacts(c).put('revision_base_sha', t.snapshot().verifiedSha);
          if (!t.snapshot().revision?.candidateSha) artifacts(c).put('push_intended', false);
        }
        revisionObservationWaiting = false;
        if (
          c.store.run.state === 'shipping' &&
          (t.snapshot().revision?.candidateSha || t.snapshot().action?.kind === 'reopen')
        ) {
          const result = await t.resume();
          artifacts(c).put('tracking', t.status());
          if (result.kind === 'revision_pending') {
            const state = t.snapshot();
            try {
              revisionObservationWaiting =
                (await readForkBranch(read, {
                  fork: state.pr.fork,
                  branch: state.pr.binding.branch,
                })) === result.candidateSha;
            } catch {
              // Fail closed: an unreadable fork branch is still an unconfirmed push; status
              // keeps the tracker's pending-revision text recorded just above.
              revisionObservationWaiting = true;
            }
          } else
            revisionObservationWaiting = ['unknown', 'handoff', 'action'].includes(result.kind);
        }
        return t.snapshot().run;
      },
      revisionWaiting: () => revisionObservationWaiting,
      killAll: async (c) => {
        await stopResources(localVm(c), c.run.runId, async () => {
          await refreshBeforeCleanup();
          await broker?.killAll();
        });
      },
    },
    release: async () => {
      try {
        await refreshBeforeCleanup();
        if (activeStore && TERMINAL_STATES.includes(activeStore.run.state))
          await broker?.endRun(activeStore.run.state === 'cancelled' ? 'cancelled' : 'completed');
        else if (broker) {
          // A dormant controller has no operation that needs a credential. Sweep
          // held values before stopping lease timers, without closing resumable
          // admission permanently as endRun would do.
          const recovered = await broker.recover();
          if (!recovered.admitted && recovered.report) throw new Error('cleanup_incomplete');
        }
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
        revisionObservationWaiting = false;
        shipping = undefined;
        receipt = undefined;
        app = undefined;
        models.clear();
        if (!overrides.vm) rawVm = undefined;
      }
    },
  });
  const start = controller.start.bind(controller);
  const authorize = async (runId: string) => {
    const store = RunStore.open(root, runId);
    try {
      if (!sameConfig(store.config, config)) throw new Error('resume_identity_mismatch');
      const approval = store.config.authorApproval;
      if (!approval) throw new AuthorApprovalError('author_approval_missing');
      await prepareAuthor(store.config, { userId: approval.userId }, overrides);
      store.validateEvidence();
      const j = new Journal(path.join(store.storeDirectory('control'), 'steps'));
      try {
        const held = new StepArtifacts(j, runId);
        held.put('authorization_required', null);
        authorizationRequired = false;
      } finally {
        j.close();
      }
    } finally {
      store.close();
    }
  };
  Object.defineProperty(controller, 'authorize', { value: authorize });
  Object.defineProperty(controller, 'nextPermittedAction', {
    get: () => (authorizationRequired ? 'authorize' : null),
  });
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
  }) as RunController & {
    readonly authorizationUrl: string | null;
    readonly nextPermittedAction: 'authorize' | null;
    authorize(runId: string): Promise<void>;
  };
}
