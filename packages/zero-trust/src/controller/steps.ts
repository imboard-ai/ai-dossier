/** Real phase glue. Credential capabilities are constructed only by wiring.ts. */
import path from 'node:path';
import type { AcquiredSource } from '../canonical/acquire';
import { acquireSource, resolveBase } from '../canonical/acquire';
import { type SourceManifest, sha256, validateManifest } from '../canonical/export';
import {
  type CandidateAuthority,
  type CandidateRecord,
  createCandidate,
  reconstructCandidate,
} from '../canonical/reconstruct';
import { dataDescriptors } from '../data-descriptors';
import { createLlmDecisionProvider } from '../decision/providers/llm';
import { publishPrivate, readPrivate } from '../durable-fs';
import { buildCommandPlan, type ProxyEndpoints } from '../ecosystem/commands';
import { detectEcosystem, sourceFilesFromManifest } from '../ecosystem/detect';
import {
  loadProfileRecord,
  type ProfileRecord,
  recordProfileSelection,
  selectProfile,
} from '../ecosystem/profiles';
import type { ForkReady } from '../github/fork';
import type { HandoffOutcome } from '../github/handoff-driver';
import type { GitHubRead } from '../github/reconcile';
import type { Journal } from '../journal';
import type { ModelAdapter } from '../model/adapter';
import { classifyPolicy, type PolicyAssessment, policyDigest } from '../policy/classify';
import { assessPolicy } from '../policy/decide-policy';
import { discoverPolicy } from '../policy/discover';
import { assessIssue, type Eligibility } from '../policy/eligibility';
import { engagementBody } from '../policy/engagement';
import { createFreshnessProbe } from '../policy/freshness';
import { decideGate } from '../policy/gate';
import { checkInvitation, type InvitationEvidence } from '../policy/invitation';
import { policyRegions } from '../policy/regions';
import { canonicalJson } from '../receipt/schema';
import { assertSecretFree } from '../redaction';
import { isTestPath, reviewCandidate } from '../review/integrity';
import { isRunContinuation, prerequisiteWaitOrigin, ReasonCode } from '../state';
import type { ProxyTarget, VmAdapter } from '../vm/adapter';
import { type AgentPlan, runImplementation, runPlanning } from './agent-loop';
import { requireAuthorApproval } from './author-approval';
import type {
  ControllerTrackOutcome,
  PhaseContext,
  PhaseSteps,
  ResumeHandoffOutcome,
} from './controller';
import { checkShippingBase } from './drift';
import {
  baselineEvidence,
  provisionWorkspace,
  type RunLifecycle,
  regressionEvidence,
  releaseWorkspace,
  type WorkspaceEvidence,
} from './evidence-runner';
import { OutputCollector } from './output-collector';
import type { ShippingAuthorizeDeps } from './shipping';
import { loadVerification } from './verification-record';
import { verificationPlan, verifyCandidate } from './verifier';
import { WorkspaceOverlay } from './workspace-overlay';

export interface GateRecord {
  readonly signoffRequired: boolean;
  readonly template?: string;
  readonly policy: PolicyAssessment;
  readonly policyDigest: string;
  readonly eligibility: Exclude<Eligibility, { kind: 'unknown' }>;
  readonly baseSha: string;
  readonly title: string;
  readonly body: string;
  readonly invitation?: InvitationEvidence;
}
interface Candidate {
  readonly manifest: SourceManifest;
  readonly record: CandidateRecord;
  readonly authority: CandidateAuthority;
  readonly meta: {
    readonly title: string;
    readonly cause: string;
    readonly scope: string;
    readonly limitations: readonly string[];
  };
}
export interface StepServices {
  readonly read: GitHubRead;
  readonly now: () => Date;
  readonly model: (
    phase: 'planning' | 'implementing' | 'repair',
    context: PhaseContext
  ) => ModelAdapter;
  readonly endpoints: ProxyEndpoints;
  readonly proxyTarget: ProxyTarget;
  readonly sourceRemote?: string;
  readonly adapter: (context: PhaseContext) => VmAdapter;
  readonly vmJournal: (context: PhaseContext) => Journal;
  readonly identity: (context: PhaseContext) => Promise<{ login: string; userId: number }>;
  readonly engage: (context: PhaseContext, body: string) => Promise<HandoffOutcome>;
  readonly handoff: (context: PhaseContext) => Promise<HandoffOutcome | null>;
  readonly readiness: (
    context: PhaseContext
  ) => Promise<ForkReady | 'fork_missing' | 'installation_missing' | 'blocked' | 'hand_off'>;
  readonly ship: (
    context: PhaseContext,
    deps: Omit<ShippingAuthorizeDeps, 'signer'>,
    meta: Candidate['meta'],
    policy: PolicyAssessment
  ) => Promise<'contributor_handoff' | 'submitted' | 'blocked' | 'hand_off'>;
  readonly track: (context: PhaseContext) => Promise<ControllerTrackOutcome>;
}

/** Every completed artifact is write-ahead journaled with its exact bytes digest.
 * Replaying validates the complete log and each producer at its consumption boundary. */
export class StepArtifacts {
  private readonly values = new Map<string, string>();
  constructor(
    private readonly journal: Journal,
    readonly runId: string
  ) {
    for (const raw of journal.read()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('invalid_step_artifact');
      const row = raw as Record<string, unknown>;
      assertSecretFree(row);
      if (
        row.type !== 'artifact' ||
        row.runId !== runId ||
        typeof row.key !== 'string' ||
        !/^[a-z_]{1,64}$/u.test(row.key) ||
        Object.keys(row).length !== 5 ||
        row.version !== 1 ||
        typeof row.digest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(row.digest)
      )
        throw new Error('invalid_step_artifact');
      this.values.set(row.key, row.digest);
      this.get(row.key);
    }
  }
  get<T>(key: string): T | undefined {
    const digest = this.values.get(key);
    if (!digest) return undefined;
    const bytes = readPrivate(
      path.join(path.dirname(this.journal.filePath), `${digest}.json`),
      (stat) => {
        if (stat.size > 96 * 1024 * 1024) throw new Error('invalid_step_artifact');
      }
    );
    if (sha256(bytes) !== digest) throw new Error('invalid_step_artifact');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assertSecretFree(value);
    return value as T;
  }
  require<T>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined) throw new Error('missing_step_artifact');
    return value;
  }
  put(key: string, value: unknown): void {
    assertSecretFree(value);
    if (!/^[a-z_]{1,64}$/u.test(key)) throw new Error('invalid_step_artifact');
    let nodes = 0;
    const copy = (v: unknown, depth: number): unknown => {
      if (++nodes > 200000 || depth > 16) throw new Error('invalid_step_artifact');
      if (
        v === null ||
        typeof v === 'string' ||
        typeof v === 'boolean' ||
        (typeof v === 'number' && Number.isSafeInteger(v) && !Object.is(v, -0))
      )
        return v;
      if (typeof v !== 'object') throw new Error('invalid_step_artifact');
      const { descriptors } = dataDescriptors(v);
      if (Array.isArray(v))
        return v.map((_entry, i) => copy(descriptors[String(i)].value, depth + 1));
      return Object.fromEntries(
        Object.keys(descriptors)
          .sort()
          .map((k) => [k, copy(descriptors[k].value, depth + 1)])
      );
    };
    const bytes = Buffer.from(JSON.stringify(copy(value, 0)));
    if (bytes.length > 96 * 1024 * 1024) throw new Error('invalid_step_artifact');
    const digest = sha256(bytes);
    publishPrivate(path.join(path.dirname(this.journal.filePath), `${digest}.json`), bytes);
    this.journal.append({
      type: 'artifact',
      runId: this.runId,
      key,
      version: 1,
      digest,
    });
    this.values.set(key, digest);
  }
}

export function createSteps(
  services: StepServices,
  artifacts: (context: PhaseContext) => StepArtifacts
): PhaseSteps {
  const profile = (c: PhaseContext): ProfileRecord =>
    loadProfileRecord(c.store.storeDirectory('profile'), c.run.runId);
  const source = (c: PhaseContext): AcquiredSource => {
    const held = artifacts(c).require<{ manifest: SourceManifest; pack: string }>('source');
    return { manifest: validateManifest(held.manifest), pack: Buffer.from(held.pack, 'base64') };
  };
  const gate = (c: PhaseContext) => artifacts(c).require<GateRecord>('gate');
  const candidate = (c: PhaseContext): Candidate => {
    const held = artifacts(c).require<Candidate>('candidate');
    const author = c.store.config.authorApproval;
    if (
      !author ||
      canonicalJson(held.authority.author) !==
        canonicalJson(
          requireAuthorApproval(c.store.config, { login: author.login, userId: author.userId })
        )
    )
      throw new Error('author_approval_mismatch');
    reconstructCandidate(held.manifest, held.record, held.authority, source(c).pack);
    return held;
  };
  const approval = async (c: PhaseContext) =>
    requireAuthorApproval(c.store.config, await services.identity(c));
  const lifecycle = (c: PhaseContext): RunLifecycle => ({
    run: c.store.run,
    now: services.now,
    journal: services.vmJournal(c),
    observeRun: (run) => {
      // Retain the real producer's continuation; the core applies its outcome once.
      // Cleanup fencing is immediate, including when a producer subsequently throws.
      if (!isRunContinuation(c.store.run, run)) throw new Error('producer_run_diverged');
      artifacts(c).put('producer_run', run);
      if (run.state === 'blocked_cleanup') c.store.persistRun(run);
    },
    retryDelayMs: 0,
  });
  const workspace = (c: PhaseContext) => ({
    adapter: services.adapter(c),
    runId: c.run.runId,
    limits: c.store.config.limits,
    profileRecord: profile(c),
    proxyTarget: services.proxyTarget,
    collector: new OutputCollector(),
    lifecycle: lifecycle(c),
    artifactsDir: c.store.storeDirectory('artifacts'),
  });
  const bindings = (c: PhaseContext) => ({
    policyDigest: gate(c).policyDigest,
    budgetSessionId: c.sessionId,
  });
  const fresh = (c: PhaseContext) => {
    const g = gate(c);
    return createFreshnessProbe({
      read: services.read,
      upstream: c.store.config.upstream,
      contributor: c.run.contributor,
      gated: {
        policy: g.policy,
        policyDigest: g.policyDigest,
        eligibilityDigest: g.eligibility.evidenceDigest,
        ...(g.invitation ? { invitation: g.invitation } : {}),
      },
    });
  };
  const summary = (e: WorkspaceEvidence) => {
    const r = e.records.find((r) => r.captureReport);
    return r && r.suites !== null && r.tests !== null && r.failures !== null && r.skipped !== null
      ? { suites: r.suites, tests: r.tests, failures: r.failures, skipped: r.skipped }
      : null;
  };
  const steps: PhaseSteps = {
    async gate(c) {
      const e = await assessIssue(services.read, c.store.config.upstream, c.run.contributor);
      if (e.kind === 'unknown') return { kind: 'hand_off' };
      const baseSha = await resolveBase(services.read, {
        ...c.store.config.upstream,
        defaultBranch: e.facts.defaultBranch,
      });
      const files = await discoverPolicy(services.read, {
        ...c.store.config.upstream,
        ref: baseSha,
      });
      if (files.kind === 'unknown') return { kind: 'hand_off' };
      const templates = files.files.filter((file) => /pull_request_template/iu.test(file.path));
      if (templates.length > 1) return { kind: 'hand_off' };
      // Restrictions remain a deterministic floor even if paid assessment cannot complete.
      const floor = classifyPolicy(files.files);
      const p =
        floor.ai === 'banned'
          ? floor
          : await assessPolicy(files.files, {
              provider: createLlmDecisionProvider({ adapter: services.model('planning', c) }),
              budget: {
                ledger: c.ledger,
                sessionId: c.sessionId,
                rates: c.store.config.modelProfile.rates,
              },
              signal: c.signal,
            });
      const decision = decideGate(p, e, c.run.contributor);
      if (
        decision.kind === 'terminate' ||
        decision.kind === 'ineligible' ||
        decision.kind === 'hand_off'
      )
        return { kind: decision.kind };
      c.store.recordUpstreamRepositoryId(e.facts.repositoryId);
      const lines = files.files.flatMap((file) =>
        policyRegions(file).flatMap((r) => r.lines.map((l) => l.text))
      );
      const signoffRequired = lines.some(
        (line) =>
          /\b(?:DCO|sign[- ]off|signed-off-by)\b/iu.test(line) &&
          /\b(?:required|require|must)\b/iu.test(line)
      );
      if (
        lines.some(
          (line) => /\breal name\b/iu.test(line) && /\b(?:required|require|must)\b/iu.test(line)
        ) &&
        c.store.config.authorApproval?.name.toLowerCase() === c.run.contributor.toLowerCase()
      )
        return { kind: 'hand_off' };
      const issue = await services.read(
        `/repos/${c.store.config.upstream.owner}/${c.store.config.upstream.repo}/issues/${c.store.config.upstream.issue}`
      );
      const text = issue.body as { title?: unknown; body?: unknown };
      if (
        issue.status !== 200 ||
        typeof text?.title !== 'string' ||
        (text.body !== null && typeof text.body !== 'string')
      )
        return { kind: 'hand_off' };
      artifacts(c).put('gate', {
        signoffRequired,
        ...(templates[0] ? { template: templates[0].content } : {}),
        policy: p,
        policyDigest: policyDigest(p, files.files),
        eligibility: e,
        baseSha,
        title: text.title,
        body: text.body ?? '',
      });
      await approval(c);
      if (decision.kind === 'request_permission') {
        const result = await services.engage(c, engagementBody({}));
        return {
          kind:
            result.kind === 'blocked'
              ? 'blocked'
              : result.kind === 'observed'
                ? 'request_permission'
                : 'contributor_handoff',
        };
      }
      return { kind: 'proceed' };
    },
    async acquire(c) {
      await approval(c);
      if (!(await fresh(c).policyFresh())) return { kind: 'blocked' };
      let acquired: AcquiredSource;
      if (artifacts(c).get('source')) acquired = source(c);
      else {
        acquired = acquireSource(
          { ...c.store.config.upstream, baseSha: gate(c).baseSha },
          { remoteUrlForTest: services.sourceRemote }
        );
        artifacts(c).put('source', {
          manifest: acquired.manifest,
          pack: acquired.pack.toString('base64'),
        });
      }
      const detection = detectEcosystem(sourceFilesFromManifest(acquired.manifest));
      if (!detection.supported) return { kind: 'unsupported' };
      const selection = selectProfile(detection);
      if (!selection.ok) return { kind: 'unsupported' };
      recordProfileSelection(c.store.storeDirectory('profile'), c.run.runId, selection);
      buildCommandPlan(selection.manager, services.endpoints);
      if (!artifacts(c).get('baseline')) {
        const baseline = await baselineEvidence({
          ...workspace(c),
          manifest: acquired.manifest,
          plan: buildCommandPlan(selection.manager, services.endpoints),
        });
        artifacts(c).put('baseline', baseline);
        if (baseline.status !== 'passed' && !gate(c).policy.baselineFailuresPermitted)
          return { kind: 'hand_off' };
      }
      return { kind: 'acquired' };
    },
    async plan(c) {
      const w = workspace(c);
      const vm = await provisionWorkspace({
        ...w,
        manifest: source(c).manifest,
        plan: buildCommandPlan(profile(c).manager, services.endpoints),
      });
      try {
        const result = await runPlanning({
          ...w,
          vm: vm.vm,
          model: services.model('planning', c),
          ledger: c.ledger,
          sessionId: c.sessionId,
          rates: c.store.config.modelProfile.rates,
          limits: c.store.config.limits,
          binding: {
            contributionId: c.store.contributionId,
            candidateSha: null,
            publicationTargets: {
              push_branch: '',
              pr_create: '',
              pr_update: '',
            },
          },
          issue: gate(c),
          baseManifest: source(c).manifest,
          now: services.now,
          persist: (entry) => artifacts(c).put('transcript', entry),
        });
        if (result.kind !== 'plan') return { kind: 'hand_off' };
        artifacts(c).put('plan', result);
        return { kind: 'planned', bindings: { ...bindings(c), planDigest: result.digest } };
      } finally {
        await releaseWorkspace(w.adapter, vm, w.lifecycle);
      }
    },
    async implement(c) {
      const author = await approval(c);
      const old =
        c.run.state === 'revising' || c.run.reasonCode === ReasonCode.RepairRequired
          ? candidate(c)
          : undefined;
      const previousVerification = old
        ? loadVerification(c.store.storeDirectory('artifacts'), old.record.candidateSha, {
            runId: c.run.runId,
            expectedDigest: artifacts(c).require<string>('verification'),
          })
        : undefined;
      const base = source(c);
      const w = workspace(c);
      const vm = await provisionWorkspace({
        ...w,
        manifest: old?.manifest ?? base.manifest,
        plan: buildCommandPlan(profile(c).manager, services.endpoints),
      });
      try {
        const result = await runImplementation(
          {
            ...w,
            vm: vm.vm,
            model: services.model(old ? 'repair' : 'implementing', c),
            ledger: c.ledger,
            sessionId: c.sessionId,
            rates: c.store.config.modelProfile.rates,
            limits: c.store.config.limits,
            binding: {
              contributionId: c.store.contributionId,
              candidateSha: null,
              publicationTargets: {
                push_branch: '',
                pr_create: '',
                pr_update: '',
              },
            },
            issue: gate(c),
            baseManifest: old?.manifest ?? base.manifest,
            now: services.now,
            persist: (entry) => artifacts(c).put('transcript', entry),
          },
          {
            plan: artifacts(c).require<AgentPlan>('plan'),
            ...(old
              ? {
                  repairOf: JSON.stringify({
                    candidateSha: old.record.candidateSha,
                    verification: {
                      verdict: previousVerification?.verdict,
                      commands: previousVerification?.commands,
                    },
                    feedback: artifacts(c).get('feedback') ?? [],
                  }),
                }
              : {}),
          }
        );
        if (result.kind !== 'candidate') return { kind: 'hand_off' };
        const manifest = result.overlay.manifest();
        const attempt = (artifacts(c).get<number>('attempt') ?? 0) + 1;
        const produced = createCandidate(
          manifest,
          {
            baseSha: gate(c).baseSha,
            author,
            committerTimestamp: services
              .now()
              .toISOString()
              .replace(/\.\d{3}Z$/u, 'Z'),
            message: `fix: issue ${c.store.config.upstream.issue} (attempt ${attempt})\n${gate(c).signoffRequired ? `\nSigned-off-by: ${author.name} <${author.email}>\n` : ''}`,
          },
          base.pack
        );
        artifacts(c).put('attempt', attempt);
        artifacts(c).put('candidate', {
          manifest,
          record: produced.record,
          authority: produced.authority,
          meta: result.meta,
        });
        return {
          kind: 'candidate',
          bindings: { ...bindings(c), candidateSha: produced.record.candidateSha },
        };
      } finally {
        await releaseWorkspace(w.adapter, vm, w.lifecycle);
      }
    },
    async review(c) {
      const held = candidate(c);
      const base = source(c);
      const baseEntries = new Map(base.manifest.entries.map((entry) => [entry.path, entry]));
      const testFiles = held.manifest.entries
        .filter(
          (e) =>
            isTestPath(e.path) &&
            e.mode !== '040000' &&
            baseEntries.get(e.path)?.sha256 !== e.sha256
        )
        .map((e) => e.path);
      if (!testFiles.length) return { kind: 'hand_off' };
      const regression = await regressionEvidence({
        ...workspace(c),
        baseManifest: base.manifest,
        candidateManifest: held.manifest,
        testFiles,
        regressionTargets: testFiles,
        endpoints: services.endpoints,
      });
      artifacts(c).put('regression', regression);
      artifacts(c).put('targets', testFiles);
      if (regression.base.status !== 'failed' || !regression.candidate) return { kind: 'hand_off' };
      const suite = await baselineEvidence({
        ...workspace(c),
        manifest: held.manifest,
        plan: buildCommandPlan(profile(c).manager, services.endpoints),
      });
      artifacts(c).put('candidate_checks', suite);
      const review = reviewCandidate({
        baseManifest: base.manifest,
        candidateManifest: held.manifest,
        baseDiscovery: summary(artifacts(c).require<WorkspaceEvidence>('baseline')),
        candidateDiscovery: summary(suite),
      });
      artifacts(c).put('review', review);
      return { kind: review.verdict === 'pass' ? 'approved' : 'hand_off' };
    },
    async verify(c) {
      await approval(c);
      const held = candidate(c);
      const result = await verifyCandidate(
        { ...workspace(c), endpoints: services.endpoints },
        {
          candidateSha: held.record.candidateSha,
          manifest: held.manifest,
          record: held.record,
          authority: held.authority,
          basePack: source(c).pack,
          regressionTargets: artifacts(c).require<string[]>('targets'),
          regressionBase: 'failed',
        }
      );
      if (result.kind !== 'verified') return { kind: 'blocked' };
      artifacts(c).put('verification', result.record.recordDigest);
      return { kind: 'verified', record: result.record };
    },
    async drift(c) {
      await approval(c);
      const held = candidate(c);
      const base = source(c);
      const overlay = new WorkspaceOverlay(base.manifest);
      for (const e of held.manifest.entries)
        if (
          e.mode !== '040000' &&
          base.manifest.entries.find((b) => b.path === e.path)?.sha256 !== e.sha256
        )
          overlay.write(e.path, Buffer.from(e.bytes, 'base64').toString('utf8'));
      const nextSources = new Map<string, AcquiredSource>();
      const result = await checkShippingBase(
        {
          read: services.read,
          upstream: {
            ...c.store.config.upstream,
            defaultBranch: gate(c).eligibility.facts.defaultBranch,
          },
          now: services.now,
          acquire: (baseSha) => {
            const acquired = acquireSource(
              { ...c.store.config.upstream, baseSha },
              { remoteUrlForTest: services.sourceRemote }
            );
            nextSources.set(baseSha, acquired);
            return acquired;
          },
        },
        {
          run: c.run,
          overlay,
          approval: held.record,
          basePack: base.pack,
          rebases: artifacts(c).get<number>('rebases') ?? 0,
          pushIntentJournaled: artifacts(c).get<boolean>('push_intended') ?? false,
        }
      );
      if (result.kind === 'unchanged') return { kind: 'unchanged' };
      if (result.kind !== 'rebased') return { kind: 'hand_off' };
      const next = nextSources.get(result.candidate.record.baseSha);
      if (!next) return { kind: 'hand_off' };
      artifacts(c).put('source', { manifest: next.manifest, pack: next.pack.toString('base64') });
      artifacts(c).put('gate', { ...gate(c), baseSha: result.candidate.record.baseSha });
      artifacts(c).put('rebases', result.rebases);
      artifacts(c).put('candidate', {
        manifest: result.manifest,
        record: result.candidate.record,
        authority: result.candidate.authority,
        meta: held.meta,
      });
      return {
        kind: 'advanced',
        bindings: { ...bindings(c), candidateSha: result.candidate.record.candidateSha },
      };
    },
    async ship(c) {
      await approval(c);
      const fork = await services.readiness(c);
      if (typeof fork === 'string') return { kind: fork };
      const held = candidate(c);
      const verification = loadVerification(
        c.store.storeDirectory('artifacts'),
        held.record.candidateSha,
        { runId: c.run.runId, expectedDigest: artifacts(c).require<string>('verification') }
      );
      const targets = artifacts(c).require<string[]>('targets');
      artifacts(c).put('push_intended', true);
      const digest = sha256(Buffer.from(canonicalJson(profile(c))));
      return {
        kind: await services.ship(
          c,
          {
            store: c.store,
            fork,
            bindings: {
              contributionId: c.store.contributionId,
              forkRepositoryId: fork.repositoryId,
              forkOwner: fork.owner,
              forkRepo: fork.repo,
              branch: `ztfc/${c.store.contributionId}`,
              candidateSha: held.record.candidateSha,
              baseSha: held.record.baseSha,
              parentSha: held.record.baseSha,
              sessionId: c.sessionId,
              defaultBranch: gate(c).eligibility.facts.defaultBranch,
              policyDigest: gate(c).policyDigest,
              verificationDigest: verification.recordDigest,
              expectedRemoteSha: null,
            },
            profile: { digest, binding: verification.profile },
            commandPlan: verificationPlan(profile(c), services.endpoints, targets),
            manifest: held.manifest,
            record: held.record,
            authority: held.authority,
            basePack: source(c).pack,
            now: () => services.now().getTime(),
            policyFresh: async () => {
              await approval(c);
              return fresh(c).policyFresh();
            },
          },
          held.meta,
          gate(c).policy
        ),
      };
    },
    async resumeHandoff(c): Promise<ResumeHandoffOutcome> {
      const origin = prerequisiteWaitOrigin(c.run);
      if (origin) {
        const fork = await services.readiness(c);
        if (typeof fork !== 'string')
          return { kind: origin === 'gating' ? 'resume_gating' : 'resume_shipping' };
        return { kind: fork === 'blocked' ? 'blocked' : 'waiting' };
      }
      await approval(c);
      if (c.run.state === 'awaiting_maintainer') {
        const engagement = artifacts(c).require<{ url: string; at: string }>('engagement');
        const result = await checkInvitation(
          services.read,
          { upstream: c.store.config.upstream, issue: c.store.config.upstream.issue },
          {
            engagementCommentUrl: engagement.url,
            engagementAt: engagement.at,
            contributor: c.run.contributor,
            issueAuthor: gate(c).eligibility.facts.issue.author.login,
            policy: { digest: gate(c).policyDigest, issueAuthorMayInvite: false },
            persist: (e) => artifacts(c).put('gate', { ...gate(c), invitation: e }),
          }
        );
        return {
          kind: result.kind === 'invited' || result.kind === 'declined' ? result.kind : 'waiting',
        };
      }
      const result = await services.handoff(c);
      if (!result || result.kind === 'awaiting_contributor') return { kind: 'waiting' };
      if (result.kind === 'blocked') return { kind: 'blocked' };
      if (result.operation === 'engagement_comment') {
        artifacts(c).put('engagement', { url: result.url, at: services.now().toISOString() });
        return { kind: 'engagement_observed' };
      }
      return { kind: 'submitted' };
    },
    track: services.track,
  };
  return steps;
}
