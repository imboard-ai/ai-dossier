/** Real phase glue. Credential capabilities are constructed only by wiring.ts. */

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AcquiredSource } from '../canonical/acquire';
import { acquireSource, resolveBase } from '../canonical/acquire';
import { CanonicalError, type SourceManifest, sha256, validateManifest } from '../canonical/export';
import type { ContributorApproval } from '../canonical/reconstruct';
import {
  type CandidateAuthority,
  type CandidateRecord,
  createCandidate,
  reconstructCandidate,
} from '../canonical/reconstruct';
import { dataDescriptors } from '../data-descriptors';
import { createLlmDecisionProvider } from '../decision/providers/llm';
import { publishPrivate, readPrivate } from '../durable-fs';
import { buildCommandPlan, type CommandPlan, type ProxyEndpoints } from '../ecosystem/commands';
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
import { HandoffError } from '../github/text';
import type { FeedbackItem } from '../github/track';
import { MutationDeferredError } from '../intents';
import type { Journal } from '../journal';
import type { ModelAdapter } from '../model/adapter';
import { classifyPolicy, type PolicyAssessment, policyDigest } from '../policy/classify';
import { assessPolicy } from '../policy/decide-policy';
import { discoverPolicy } from '../policy/discover';
import { assessIssue, type Eligibility } from '../policy/eligibility';
import { engagementBody } from '../policy/engagement';
import { createFreshnessProbe, type FreshnessReport } from '../policy/freshness';
import { decideGate } from '../policy/gate';
import { checkInvitation, type InvitationEvidence } from '../policy/invitation';
import { policyRegions } from '../policy/regions';
import { canonicalJson, ReceiptError } from '../receipt/schema';
import { assertSecretFree } from '../redaction';
import { isTestPath, reviewCandidate } from '../review/integrity';
import type { RunRecord } from '../state';
import { isRunContinuation, prerequisiteWaitOrigin, ReasonCode } from '../state';
import type { ProxyTarget, VmAdapter } from '../vm/adapter';
import {
  type AgentContinuation,
  type AgentLoopContext,
  type AgentPlan,
  runImplementation,
  runPlanning,
} from './agent-loop';
import { requireAuthorApproval } from './author-approval';
import type {
  ControllerTrackOutcome,
  PhaseContext,
  PhaseSteps,
  ResumeHandoffOutcome,
} from './controller';
import { checkShippingBase } from './drift';
import { latestSourceEdit, sourceEditCount } from './edits';
import {
  baselineEvidence,
  preservedTestsManifest,
  provisionWorkspace,
  type RunLifecycle,
  regressionEvidence,
  releaseWorkspace,
  type WorkspaceEvidence,
} from './evidence-runner';
import { retainVerification } from './export-evidence';
import { assessRevisionFeedback } from './feedback';
import { OutputCollector } from './output-collector';
import type { ShippingAuthorizeDeps } from './shipping';
import {
  alteredEvidenceNotice,
  clearStopNotice,
  driftHandoffNotice,
  freshnessNotice,
  gateHandoffNotice,
  isAlteredEvidence,
  type ReviewHandoffReason,
  recordStopNotice,
  reviewHandoffNotice,
} from './stop-notice';
import { loadVerification, type VerificationRecord } from './verification-record';
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
export function implementationPhaseKey(run: RunRecord): number {
  return run.history.filter(
    (e) =>
      ![ReasonCode.UserPaused, ReasonCode.ResumeImplementing, ReasonCode.ResumeRevising].includes(
        e.reasonCode
      )
  ).length;
}
export function candidateMessage(
  issue: number,
  attempt: number,
  author: ContributorApproval,
  signoffRequired: boolean,
  edit?: { count: number; digest: string }
): string {
  return `fix: issue ${issue} (attempt ${attempt})\n${edit ? `\nUser edit ${edit.count}: ${edit.digest}\n` : ''}${signoffRequired ? `\nSigned-off-by: ${author.name} <${author.email}>\n` : ''}`;
}
export interface Candidate {
  readonly touched: readonly string[];
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

/** Reject contradictory policy bytes at every composed gate/freshness read. */
export function policyReader(read: GitHubRead): GitHubRead {
  return async (request) => {
    const response = await read(request);
    if (request.includes('/contents/') && response.status === 200) {
      const file = response.body as Record<string, unknown> | null;
      if (file?.type === 'file' && file.encoding === 'base64' && typeof file.content === 'string') {
        const bytes = Buffer.from(file.content.replace(/\s/gu, ''), 'base64');
        const digest = createHash('sha1')
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest('hex');
        if (digest !== file.sha) return { status: 502, body: null };
      }
    }
    return response;
  };
}

/** One binding rule for normal execution and recovered shipping, never cached results. */
export function gateFreshness(
  read: GitHubRead,
  config: PhaseContext['store']['config'],
  g: GateRecord,
  ownPr?: { readonly number: number }
) {
  return createFreshnessProbe({
    read: async (request) => {
      const response = await read(request);
      if (
        request === `/repos/${config.upstream.owner}/${config.upstream.repo}` &&
        response.status === 200 &&
        (response.body as { id?: unknown } | null)?.id !== g.eligibility.facts.repositoryId
      )
        return { status: 502, body: null };
      return response;
    },
    upstream: config.upstream,
    contributor: config.contributor,
    ...(ownPr ? { ownPr } : {}),
    gated: {
      policy: g.policy,
      policyDigest: g.policyDigest,
      eligibilityDigest: g.eligibility.evidenceDigest,
      ...(g.invitation ? { invitation: g.invitation } : {}),
    },
  });
}

/** How a stale freshness check surfaces from shipping: the push admission refused its
 * receipt (deferred, nothing sent) or the PR hand-off admission refused its link. */
function isFreshnessRefusal(error: unknown): boolean {
  return (
    error instanceof MutationDeferredError ||
    error instanceof HandoffError ||
    error instanceof ReceiptError
  );
}

export function candidateOverlay(base: SourceManifest, held: Candidate): WorkspaceOverlay {
  const overlay = new WorkspaceOverlay(base);
  if (!Array.isArray(held.touched)) throw new Error('invalid_step_artifact');
  overlay.replaceSource(held.manifest, held.touched);
  if (overlay.manifest().digest !== held.manifest.digest) throw new Error('invalid_step_artifact');
  return overlay;
}

/** Human checkpoint material is derived only from held snapshots, never VM reads. */
export function reviewDiff(base: SourceManifest, next: SourceManifest): Buffer {
  const chunks: string[] = [];
  const beforeEntries = new Map(
    base.entries.filter((e) => e.mode !== '040000').map((e) => [e.path, e])
  );
  const afterEntries = new Map(
    next.entries.filter((e) => e.mode !== '040000').map((e) => [e.path, e])
  );
  for (const name of [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])].sort()) {
    const old = beforeEntries.get(name);
    const entry = afterEntries.get(name);
    if (old?.sha256 === entry?.sha256 && old?.mode === entry?.mode) continue;
    chunks.push(`diff --git a/${name} b/${name}\n`);
    if (!old) chunks.push(`new file mode ${entry?.mode}\n`);
    else if (!entry) chunks.push(`deleted file mode ${old.mode}\n`);
    else if (old.mode !== entry.mode) chunks.push(`old mode ${old.mode}\nnew mode ${entry.mode}\n`);
    if (old?.sha256 === entry?.sha256) continue;
    const before = old ? Buffer.from(old.bytes, 'base64').toString('utf8').split('\n') : [];
    const after = entry ? Buffer.from(entry.bytes, 'base64').toString('utf8').split('\n') : [];
    chunks.push(
      `--- ${old ? `a/${name}` : '/dev/null'}\n+++ ${entry ? `b/${name}` : '/dev/null'}\n@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@\n${before.map((l) => `-${l}\n`).join('')}${after.map((l) => `+${l}\n`).join('')}`
    );
  }
  const bytes = Buffer.from(chunks.join(''));
  assertSecretFree(bytes.toString('utf8'));
  return bytes;
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
  ) => Promise<'contributor_handoff' | 'submitted' | 'blocked' | 'hand_off' | 'waiting'>;
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
  /** Rebases already spent in the current budget session. `rebase_session` is the record;
   * the session-less `rebases` count is kept and read only for first-session runs that
   * predate it. */
  const rebasesForSession = (c: PhaseContext): number => {
    const held = artifacts(c).get<{ sessionId: string; count: number }>('rebase_session');
    if (held?.sessionId === c.sessionId) return held.count;
    return c.sessionId === c.store.budgetSessionId(1)
      ? (artifacts(c).get<number>('rebases') ?? 0)
      : 0;
  };
  const candidate = (c: PhaseContext): Candidate => {
    const edit = latestSourceEdit(c.store);
    const held =
      edit && artifacts(c).get<number>('applied_user_edit') !== sourceEditCount(c.store)
        ? edit.candidate
        : artifacts(c).require<Candidate>('candidate');
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
  const fresh = (c: PhaseContext) =>
    gateFreshness(
      services.read,
      c.store.config,
      gate(c),
      artifacts(c).get<{ number: number }>('tracked_pr')
    );
  const agentContext = (
    c: PhaseContext,
    w: ReturnType<typeof workspace>,
    vm: AgentLoopContext['vm'],
    phase: Parameters<StepServices['model']>[0],
    baseManifest: SourceManifest
  ): AgentLoopContext => ({
    ...w,
    vm,
    model: services.model(phase, c),
    ledger: c.ledger,
    sessionId: c.sessionId,
    rates: c.store.config.modelProfile.rates,
    limits: c.store.config.limits,
    binding: {
      contributionId: c.store.contributionId,
      candidateSha: null,
      publicationTargets: { push_branch: '', pr_create: '', pr_update: '' },
    },
    issue: gate(c),
    baseManifest,
    now: services.now,
    persist: (entry) => artifacts(c).put('transcript', entry),
    assertAdmission: c.assertAdmission,
    continuation: artifacts(c).get<AgentContinuation>(
      phase === 'planning' ? 'planning_continuation' : 'implementation_continuation'
    ),
    saveContinuation: (held) =>
      artifacts(c).put(
        phase === 'planning' ? 'planning_continuation' : 'implementation_continuation',
        held
      ),
  });
  const summary = (e: WorkspaceEvidence) => {
    const r = e.records.find((r) => r.captureReport);
    return r && r.suites !== null && r.tests !== null && r.failures !== null && r.skipped !== null
      ? { suites: r.suites, tests: r.tests, failures: r.failures, skipped: r.skipped }
      : null;
  };
  /** The base's own test tree on the candidate source (#1205), so a deleted, weakened or
   * shadowed original test cannot hide a behaviour change. `null` when the candidate's
   * layout cannot hold that tree: unknown evidence, which review refuses. */
  const preservedEvidence = async (
    c: PhaseContext,
    baseManifest: SourceManifest,
    candidateManifest: SourceManifest,
    plan: CommandPlan
  ): Promise<WorkspaceEvidence | null> => {
    let manifest: SourceManifest;
    try {
      manifest = preservedTestsManifest(baseManifest, candidateManifest);
    } catch (error) {
      if (error instanceof CanonicalError) return null;
      throw error;
    }
    return baselineEvidence({ ...workspace(c), manifest, plan });
  };
  const steps: PhaseSteps = {
    async gate(c) {
      clearStopNotice(artifacts(c));
      const handOff = (...reasons: string[]) => {
        recordStopNotice(artifacts(c), c.run, gateHandoffNotice(reasons), false);
        return { kind: 'hand_off' as const };
      };
      const e = await assessIssue(services.read, c.store.config.upstream, c.run.contributor);
      if (e.kind === 'unknown') return handOff('issue_unknown');
      const baseSha = await resolveBase(services.read, {
        ...c.store.config.upstream,
        defaultBranch: e.facts.defaultBranch,
      });
      const files = await discoverPolicy(services.read, {
        ...c.store.config.upstream,
        ref: baseSha,
      });
      if (files.kind === 'unknown') return handOff('policy_unknown');
      const templates = files.files.filter((file) => /pull_request_template/iu.test(file.path));
      if (templates.length > 1) return handOff('multiple_templates');
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
        return decision.kind === 'hand_off'
          ? handOff(...decision.reasons)
          : { kind: decision.kind };
      c.store.recordUpstreamRepositoryId(e.facts.repositoryId);
      const lines = files.files.flatMap((file) =>
        policyRegions(file).map((r) => r.lines.map((l) => l.text).join(' '))
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
        return handOff('real_name_required');
      const issue = await services.read(
        `/repos/${c.store.config.upstream.owner}/${c.store.config.upstream.repo}/issues/${c.store.config.upstream.issue}`
      );
      const text = issue.body as { title?: unknown; body?: unknown };
      if (
        issue.status !== 200 ||
        typeof text?.title !== 'string' ||
        (text.body !== null && typeof text.body !== 'string')
      )
        return handOff('issue_unreadable');
      const prior = artifacts(c).get<GateRecord>('gate');
      const currentDigest = policyDigest(p, files.files);
      artifacts(c).put('gate', {
        signoffRequired,
        ...(templates[0] ? { template: templates[0].content } : {}),
        policy: p,
        policyDigest: currentDigest,
        ...(prior?.invitation && prior.policyDigest === currentDigest
          ? { invitation: prior.invitation }
          : {}),
        eligibility: e,
        baseSha,
        title: text.title,
        body: text.body ?? '',
      });
      await approval(c);
      if (decision.kind === 'request_permission') {
        if (gate(c).invitation && (await fresh(c).policyFresh())) return { kind: 'proceed' };
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
      let baseline = artifacts(c).get<WorkspaceEvidence>('baseline');
      if (!baseline) {
        baseline = await baselineEvidence({
          ...workspace(c),
          manifest: acquired.manifest,
          plan: buildCommandPlan(selection.manager, services.endpoints),
        });
        artifacts(c).put('baseline', baseline);
      }
      if (baseline.status !== 'passed' && !gate(c).policy.baselineFailuresPermitted)
        return { kind: 'hand_off' };
      return { kind: 'acquired' };
    },
    async plan(c) {
      const w = workspace(c);
      const held = artifacts(c).get<AgentContinuation>('planning_continuation');
      const overlay = new WorkspaceOverlay(source(c).manifest);
      for (const write of held?.writes ?? []) overlay.write(write.path, write.content);
      const vm = await provisionWorkspace({
        ...w,
        manifest: overlay.manifest(),
        plan: buildCommandPlan(profile(c).manager, services.endpoints),
      });
      try {
        const result = await runPlanning(agentContext(c, w, vm.vm, 'planning', source(c).manifest));
        if (result.kind !== 'plan') return { kind: 'hand_off' };
        artifacts(c).put('plan', result);
        c.store.replaceArtifact('plan.txt', Buffer.from(result.text));
        return {
          kind: 'planned',
          bindings: {
            ...bindings(c),
            planDigest: result.digest,
            reviewDigest: sha256(Buffer.from(result.text)),
          },
        };
      } finally {
        await releaseWorkspace(w.adapter, vm, w.lifecycle);
      }
    },
    async implement(c) {
      const author = await approval(c);
      if (c.run.state === 'revising') {
        const assessed = artifacts(c).get<{ sessionId: string; admitted: boolean }>(
          'feedback_decision'
        );
        if (assessed?.sessionId !== c.sessionId) {
          const result = await assessRevisionFeedback(
            artifacts(c).require<FeedbackItem[]>('feedback'),
            gate(c),
            artifacts(c).require<AgentPlan>('plan').text,
            {
              provider: createLlmDecisionProvider({ adapter: services.model('repair', c) }),
              budget: {
                ledger: c.ledger,
                sessionId: c.sessionId,
                rates: c.store.config.modelProfile.rates,
              },
              signal: c.signal,
            }
          );
          artifacts(c).put('feedback_decision', {
            sessionId: c.sessionId,
            admitted: result.admitted,
            verdict: JSON.stringify(result.verdict),
          });
          c.assertAdmission();
          if (!result.admitted) return { kind: 'hand_off' };
        } else if (!assessed.admitted) return { kind: 'hand_off' };
      }
      const phaseKey = implementationPhaseKey(c.run);
      const edit = latestSourceEdit(c.store);
      const completion = artifacts(c).get<{ phaseKey: number; editCount: number }>(
        'user_edit_implementation'
      );
      if (
        edit &&
        (artifacts(c).get<number>('applied_user_edit') !== sourceEditCount(c.store) ||
          (completion?.phaseKey === phaseKey && completion.editCount === sourceEditCount(c.store)))
      ) {
        const held = candidate(c);
        artifacts(c).put('candidate', held);
        const diff = reviewDiff(source(c).manifest, held.manifest);
        c.store.replaceArtifact('candidate.diff', diff);
        artifacts(c).put('user_edit_implementation', {
          phaseKey,
          editCount: sourceEditCount(c.store),
        });
        artifacts(c).put('applied_user_edit', sourceEditCount(c.store));
        return {
          kind: 'candidate',
          bindings: {
            ...bindings(c),
            candidateSha: held.record.candidateSha,
            reviewDigest: sha256(diff),
          },
        };
      }
      if (artifacts(c).get<number>('implementation_finished') === phaseKey) {
        const completed = candidate(c);
        const diff = reviewDiff(source(c).manifest, completed.manifest);
        return {
          kind: 'candidate',
          bindings: {
            ...bindings(c),
            candidateSha: completed.record.candidateSha,
            reviewDigest: sha256(diff),
          },
        };
      }
      const entered = [...c.run.history]
        .reverse()
        .find((e) => e.to === 'implementing' && e.reasonCode !== ReasonCode.ResumeImplementing);
      const priorBasis = artifacts(c).get<{
        phaseKey: number;
        candidate: Candidate | null;
        verification: string | null;
      }>('implementation_basis');
      const old =
        priorBasis?.phaseKey === phaseKey
          ? (priorBasis.candidate ?? undefined)
          : c.run.state === 'revising' || entered?.reasonCode === ReasonCode.RepairRequired
            ? candidate(c)
            : undefined;
      const basisVerification =
        priorBasis?.phaseKey === phaseKey
          ? priorBasis.verification
          : old
            ? artifacts(c).require<string>('verification')
            : null;
      if (priorBasis?.phaseKey !== phaseKey)
        artifacts(c).put('implementation_basis', {
          phaseKey,
          candidate: old ?? null,
          verification: basisVerification,
        });
      // A retained basis holds its candidate and verification together; a torn or corrupt
      // record carrying one without the other is refused, never loaded as unverified.
      let previousVerification: VerificationRecord | undefined;
      if (old) {
        if (typeof basisVerification !== 'string') throw new Error('implementation_basis_invalid');
        previousVerification = loadVerification(
          c.store.storeDirectory('artifacts'),
          old.record.candidateSha,
          { runId: c.run.runId, expectedDigest: basisVerification }
        );
      }
      const base = source(c);
      const w = workspace(c);
      let attemptMetadata = artifacts(c).get<{
        phaseKey: number;
        attempt: number;
        timestamp: string;
      }>('implementation_attempt');
      if (attemptMetadata?.phaseKey !== phaseKey) {
        artifacts(c).put('implementation_continuation', null);
        attemptMetadata = {
          phaseKey,
          attempt: (artifacts(c).get<number>('attempt') ?? 0) + 1,
          timestamp: services
            .now()
            .toISOString()
            .replace(/\.\d{3}Z$/u, 'Z'),
        };
        artifacts(c).put('implementation_attempt', attemptMetadata);
      }
      const held = artifacts(c).get<AgentContinuation>('implementation_continuation');
      const overlay = new WorkspaceOverlay(old?.manifest ?? base.manifest);
      if (held && held.baseDigest === overlay.base.digest)
        for (const write of held.writes) overlay.write(write.path, write.content);
      else if (held) artifacts(c).put('implementation_continuation', null);
      const vm = await provisionWorkspace({
        ...w,
        manifest: overlay.manifest(),
        plan: buildCommandPlan(profile(c).manager, services.endpoints),
      });
      try {
        const result = await runImplementation(
          agentContext(
            c,
            w,
            vm.vm,
            old ? 'repair' : 'implementing',
            old?.manifest ?? base.manifest
          ),
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
        const cumulative = old
          ? candidateOverlay(base.manifest, old)
          : new WorkspaceOverlay(base.manifest);
        cumulative.applyRepair(result.overlay);
        const manifest = result.overlay.manifest();
        const attempt = attemptMetadata.attempt;
        const produced = createCandidate(
          manifest,
          {
            baseSha: gate(c).baseSha,
            author,
            committerTimestamp: attemptMetadata.timestamp,
            message: candidateMessage(
              c.store.config.upstream.issue,
              attempt,
              author,
              gate(c).signoffRequired
            ),
          },
          base.pack
        );
        artifacts(c).put('attempt', attempt);
        artifacts(c).put('candidate', {
          touched: cumulative.touchedPaths(),
          manifest,
          record: produced.record,
          authority: produced.authority,
          meta: result.meta,
        });
        const diff = reviewDiff(base.manifest, manifest);
        c.store.replaceArtifact('candidate.diff', diff);
        artifacts(c).put('implementation_finished', phaseKey);
        return {
          kind: 'candidate',
          bindings: {
            ...bindings(c),
            candidateSha: produced.record.candidateSha,
            reviewDigest: sha256(diff),
          },
        };
      } finally {
        await releaseWorkspace(w.adapter, vm, w.lifecycle);
      }
    },
    async review(c) {
      clearStopNotice(artifacts(c));
      const handOff = (reasons: readonly ReviewHandoffReason[]) => {
        recordStopNotice(artifacts(c), c.run, reviewHandoffNotice(reasons), true);
        return { kind: 'hand_off' as const };
      };
      const held = candidate(c);
      if (
        latestSourceEdit(c.store) &&
        artifacts(c).get<number>('applied_user_edit') !== sourceEditCount(c.store)
      ) {
        artifacts(c).put('candidate', held);
        artifacts(c).put('applied_user_edit', sourceEditCount(c.store));
        c.store.replaceArtifact('candidate.diff', reviewDiff(source(c).manifest, held.manifest));
      }
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
      if (!testFiles.length) return handOff(['no_regression_test']);
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
      if (regression.base.status !== 'failed' || !regression.candidate)
        return handOff(['regression_not_reproduced']);
      // One full-suite plan binds the baseline, candidate and preserved summaries together.
      const fullSuite = buildCommandPlan(profile(c).manager, services.endpoints);
      const suite = await baselineEvidence({
        ...workspace(c),
        manifest: held.manifest,
        plan: fullSuite,
      });
      artifacts(c).put('candidate_checks', suite);
      const preserved = await preservedEvidence(c, base.manifest, held.manifest, fullSuite);
      artifacts(c).put('preserved_checks', preserved);
      const review = reviewCandidate({
        baseManifest: base.manifest,
        candidateManifest: held.manifest,
        baseDiscovery: summary(artifacts(c).require<WorkspaceEvidence>('baseline')),
        candidateDiscovery: summary(suite),
        preservedDiscovery: preserved && summary(preserved),
      });
      artifacts(c).put('review', review);
      if (review.verdict === 'pass') return { kind: 'approved' };
      return handOff(review.findings.map((f) => f.code));
    },
    async verify(c) {
      await approval(c);
      const held = candidate(c);
      const result = await verifyCandidate(
        {
          ...workspace(c),
          endpoints: services.endpoints,
          retainEvidence: (sha, records) => retainVerification(c.store, sha, records),
        },
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
      clearStopNotice(artifacts(c));
      const held = candidate(c);
      const base = source(c);
      const overlay = candidateOverlay(base.manifest, held);
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
          rebases: rebasesForSession(c),
          pushIntentJournaled: artifacts(c).get<boolean>('push_intended') ?? false,
        }
      );
      if (result.kind === 'unchanged') return { kind: 'unchanged' };
      if (result.kind === 'hand_off') {
        artifacts(c).put('drift_handoff', {
          reason: result.reason,
          ...(result.paths ? { paths: result.paths } : {}),
        });
        recordStopNotice(artifacts(c), c.run, driftHandoffNotice(result.reason), true);
      }
      if (result.kind !== 'rebased') return { kind: 'hand_off' };
      const next = nextSources.get(result.candidate.record.baseSha);
      if (!next) return { kind: 'hand_off' };
      artifacts(c).put('source', { manifest: next.manifest, pack: next.pack.toString('base64') });
      artifacts(c).put('gate', { ...gate(c), baseSha: result.candidate.record.baseSha });
      artifacts(c).put('rebases', result.rebases);
      artifacts(c).put('rebase_session', { sessionId: c.sessionId, count: result.rebases });
      artifacts(c).put('candidate', {
        touched: held.touched,
        manifest: result.manifest,
        record: result.candidate.record,
        authority: result.candidate.authority,
        meta: held.meta,
      });
      c.store.replaceArtifact('candidate.diff', reviewDiff(next.manifest, result.manifest));
      return {
        kind: 'advanced',
        bindings: { ...bindings(c), candidateSha: result.candidate.record.candidateSha },
      };
    },
    async ship(c) {
      await approval(c);
      clearStopNotice(artifacts(c));
      const fork = await services.readiness(c);
      if (typeof fork === 'string') return { kind: fork };
      const held = candidate(c);
      const load = () =>
        loadVerification(c.store.storeDirectory('artifacts'), held.record.candidateSha, {
          runId: c.run.runId,
          expectedDigest: artifacts(c).require<string>('verification'),
        });
      // Scenario 10: evidence altered after the verdict (an accidental torn or corrupted
      // write) cannot authorize a receipt. The write-once record cannot be re-verified in
      // place, so the run blocks; a transient read failure is rethrown instead.
      const blockAltered = () => {
        const receiptIssued = artifacts(c).get('receipt') !== undefined;
        recordStopNotice(artifacts(c), c.run, alteredEvidenceNotice(receiptIssued), true);
        return { kind: 'blocked' as const };
      };
      let verification: VerificationRecord;
      try {
        verification = load();
      } catch (error) {
        if (isAlteredEvidence(error)) return blockAltered();
        throw error;
      }
      const targets = artifacts(c).require<string[]>('targets');
      artifacts(c).put('push_intended', true);
      const digest = sha256(Buffer.from(canonicalJson(profile(c))));
      // The first stale freshness observation of this step: the refusal it causes blocks.
      let stale: FreshnessReport | undefined;
      let kind: Awaited<ReturnType<StepServices['ship']>>;
      try {
        kind = await services.ship(
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
              expectedRemoteSha: artifacts(c).get<string>('revision_base_sha') ?? null,
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
              const probe = await fresh(c).check();
              if (!probe.fresh) stale ??= probe;
              return probe.fresh;
            },
          },
          held.meta,
          gate(c).policy
        );
      } catch (error) {
        if (stale && isFreshnessRefusal(error)) {
          // Permission freshness (PRD §5.9): the write is refused and the evidence retained;
          // it is never retried.
          artifacts(c).put('shipping_freshness', stale);
          recordStopNotice(artifacts(c), c.run, freshnessNotice(stale.reasons), true);
          return { kind: 'blocked' };
        }
        try {
          load();
        } catch (reload) {
          if (isAlteredEvidence(reload)) return blockAltered();
        }
        throw error;
      }
      return { kind };
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
