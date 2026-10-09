/** Credential-free shipping composition. All adapters are supplied by the trusted root. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Signer } from '@ai-dossier/core';
import Ajv from 'ajv';
import type { SourceManifest } from '../canonical/export';
import {
  type CandidateAuthority,
  type CandidateRecord,
  type CanonicalCandidate,
  reconstructCandidate,
} from '../canonical/reconstruct';
import { assertDirectoryAncestors, readPrivate } from '../durable-fs';
import type { CommandPlan } from '../ecosystem/commands';
import type { ForkReady, ReadinessOutcome } from '../github/fork';
import { forkTarget } from '../github/fork-ref';
import { isSafeRef, sameLogin, upstreamIssueBinding } from '../github/handoff';
import type { HandoffAdmission } from '../github/handoff-driver';
import type { PrContentInput } from '../github/pr-body';
import { type IntentInput, idempotencyKey } from '../intents';
import { receiptIntegrity } from '../receipt/integrity';
import { issueReceipt, type SignedReceipt } from '../receipt/issue';
import {
  canonicalJson,
  PROFILE_SCHEMA,
  type Receipt,
  ReceiptError,
  SCHEMA_TYPES,
  snapshotJson,
  strictObject,
} from '../receipt/schema';
import { type ReceiptContext, verifyReceipt } from '../receipt/verify';
import { runBoundaryVerdict } from '../vm/boundary-probe';
import { type BoundaryInput, isCleanHeldVerdict } from '../vm/evidence';
import type { RunStore } from './run-store';
import {
  assertShippableVerification,
  loadVerification,
  REGRESSION_COMMAND_SUFFIX,
  type VerificationRecord,
} from './verification-record';

export interface ShippingBindings {
  readonly contributionId: string;
  readonly forkRepositoryId: number;
  readonly forkOwner: string;
  readonly forkRepo: string;
  readonly branch: string;
  readonly candidateSha: string;
  readonly baseSha: string;
  readonly parentSha: string;
  readonly sessionId: string;
  readonly defaultBranch: string;
  readonly policyDigest: string;
  /** Controller-held digest returned by verifyCandidate, not worker output. */
  readonly verificationDigest: string;
  /** The push ledger's last verified SHA; null for the initial push. */
  readonly expectedRemoteSha: string | null;
}

const positiveId = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const validateBindings = new Ajv({ strict: true }).compile<ShippingBindings>(
  strictObject({
    contributionId: SCHEMA_TYPES.id,
    forkRepositoryId: positiveId,
    forkOwner: SCHEMA_TYPES.text,
    forkRepo: SCHEMA_TYPES.text,
    branch: SCHEMA_TYPES.text,
    candidateSha: SCHEMA_TYPES.sha,
    baseSha: SCHEMA_TYPES.sha,
    parentSha: SCHEMA_TYPES.sha,
    sessionId: SCHEMA_TYPES.id,
    defaultBranch: SCHEMA_TYPES.text,
    policyDigest: SCHEMA_TYPES.digest,
    verificationDigest: SCHEMA_TYPES.digest,
    expectedRemoteSha: { anyOf: [SCHEMA_TYPES.sha, { type: 'null' }] },
  })
);
const validateProfile = new Ajv({ strict: true }).compile(
  strictObject({ digest: SCHEMA_TYPES.digest, binding: PROFILE_SCHEMA })
);

export function shippingIntent(bindings: ShippingBindings): IntentInput {
  const b = snapshotJson(bindings);
  if (!validateBindings(b) || !isSafeRef(b.defaultBranch)) refuse('shipping_identity');
  const input = {
    contributionId: b.contributionId,
    operationKind: 'push_branch' as const,
    target: forkTarget(
      { repositoryId: b.forkRepositoryId, owner: b.forkOwner, repo: b.forkRepo },
      b.branch
    ),
    candidateSha: b.candidateSha,
  };
  idempotencyKey(input);
  return input;
}

export interface ReceiptContextDeps {
  readonly store: Pick<
    RunStore,
    'validateEvidence' | 'withPinnedDirectory' | 'contributionId' | 'upstreamRepositoryId'
  >;
  /** Authenticated checkForkReadiness result retained by the controller. */
  readonly fork: ForkReady;
  readonly bindings: ShippingBindings;
  readonly profile: { readonly digest: string; readonly binding: Receipt['profile'] };
  /** Trusted profile plan, including controller-chosen regression commands. */
  readonly commandPlan: CommandPlan;
  readonly policyFresh: () => Promise<boolean>;
}

function refuse(code: string): never {
  throw new ReceiptError(code);
}

/** Detached full inputs, including bindings not carried in the receipt projection. */
const snapshots = new WeakMap<ReceiptContext, string>();

/** Read under the lifetime fence. Every VM counts, including earlier failed VMs. */
function facts(deps: ReceiptContextDeps): ReceiptContext {
  const b = snapshotJson(deps.bindings);
  const fork = snapshotJson(deps.fork);
  const profile = snapshotJson(deps.profile);
  if (!validateProfile(profile)) refuse('shipping_identity');
  const plan = snapshotJson(deps.commandPlan);
  const run = snapshotJson(deps.store.validateEvidence());
  if (run.state !== 'shipping' && run.state !== 'revising') refuse('shipping_state');
  const upstreamId = deps.store.upstreamRepositoryId;
  if (
    deps.store.contributionId !== b.contributionId ||
    !Number.isSafeInteger(upstreamId) ||
    (upstreamId as number) <= 0 ||
    fork.repositoryId !== b.forkRepositoryId ||
    fork.owner !== b.forkOwner ||
    fork.repo !== b.forkRepo ||
    fork.repositoryId === upstreamId ||
    !Number.isSafeInteger(fork.installationId) ||
    fork.installationId <= 0 ||
    !sameLogin(fork.owner, run.contributor) ||
    fork.fullName !== `${fork.owner}/${fork.repo}`
  )
    refuse('shipping_identity');
  const requiredCommands = plan.verification
    .filter((c) => c.required && c.captureReport)
    .map((c) => {
      if (c.phase !== 'verification' || c.network !== 'none' || !c.argv.length)
        refuse('required_commands_mismatch');
      return { id: c.id, command: c.argv.join(' ') };
    });
  if (
    !requiredCommands.length ||
    new Set(requiredCommands.map((c) => c.id)).size !== requiredCommands.length
  )
    refuse('required_commands_mismatch');
  const boundaryEvidence = deps.store.withPinnedDirectory((directory) => {
    const artifacts = path.join(fs.realpathSync(directory), 'artifacts');
    assertDirectoryAncestors(artifacts);
    const names = fs.readdirSync(artifacts).filter((name) => name.startsWith('boundary-'));
    if (!names.length) refuse('boundary_evidence_missing');
    const inputs = names.sort().map((name) => {
      if (!/^boundary-[a-f0-9]{32}\.json$/u.test(name)) refuse('boundary_not_held');
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(readPrivate(path.join(artifacts, name)))
      ) as BoundaryInput;
    });
    return runBoundaryVerdict(inputs, run.runId);
  });
  if (!isCleanHeldVerdict(boundaryEvidence) || boundaryEvidence.runId !== run.runId)
    refuse('boundary_not_held');
  shippingIntent(b);
  const context: ReceiptContext = snapshotJson({
    contributionId: deps.store.contributionId,
    runId: run.runId,
    sessionId: b.sessionId,
    contributor: run.contributor,
    upstreamRepositoryId: upstreamId as number,
    forkRepositoryId: fork.repositoryId,
    issue: upstreamIssueBinding(run.upstreamIssue).issue,
    defaultBranch: b.defaultBranch,
    baseSha: b.baseSha,
    parentSha: b.parentSha,
    candidateSha: b.candidateSha,
    profileDigest: profile.digest,
    policyDigest: b.policyDigest,
    profile: profile.binding,
    networkPolicy: {
      acquisition: 'controller',
      provisioning: 'package_proxy',
      verification: 'none',
      shipping: 'controller',
    },
    requiredCommands,
    policyPermitsShipping: false,
    allowedShippingOperations: [
      {
        kind: 'push_branch',
        target: forkTarget(fork, b.branch),
        expectedRemoteSha: b.expectedRemoteSha,
      },
    ],
    boundaryEvidence,
  });
  snapshots.set(context, canonicalJson({ b, fork, profile, plan, run }));
  return context;
}

function unchanged(deps: ReceiptContextDeps, held: ReceiptContext): void {
  const fresh = facts(deps);
  if (
    canonicalJson(fresh) !== canonicalJson({ ...held, policyPermitsShipping: false }) ||
    snapshots.get(fresh) !== snapshots.get(held)
  )
    refuse('shipping_identity_changed');
}

export async function buildReceiptContext(deps: ReceiptContextDeps): Promise<ReceiptContext> {
  const held = facts(deps);
  if ((await deps.policyFresh()) !== true) refuse('policy_denied');
  unchanged(deps, held);
  return snapshotJson({ ...held, policyPermitsShipping: true });
}

export interface ShippingReceiptDeps extends ReceiptContextDeps {
  readonly signer: Signer;
}

function verificationFor(deps: ReceiptContextDeps, b: ShippingBindings): VerificationRecord {
  return deps.store.withPinnedDirectory((directory) =>
    loadVerification(path.join(fs.realpathSync(directory), 'artifacts'), b.candidateSha, {
      runId: deps.store.validateEvidence().runId,
      expectedDigest: b.verificationDigest,
    })
  );
}

function matchVerification(record: VerificationRecord, context: ReceiptContext): void {
  assertShippableVerification(record);
  for (const field of [
    'runId',
    'candidateSha',
    'baseSha',
    'parentSha',
    'profileDigest',
    'profile',
  ] as const)
    if (canonicalJson(record[field]) !== canonicalJson(context[field]))
      refuse('verification_binding_mismatch');
  if (
    record.networkPolicy.provisioning !== context.networkPolicy.provisioning ||
    record.networkPolicy.verification !== context.networkPolicy.verification
  )
    refuse('verification_binding_mismatch');
  const required = record.commands
    .filter((c) => c.required)
    .map(({ id, command }) => ({ id, command }));
  const sorted = (commands: typeof required) =>
    [...commands].sort((a, b) => a.id.localeCompare(b.id));
  if (canonicalJson(sorted(required)) !== canonicalJson(sorted(context.requiredCommands)))
    refuse('required_commands_mismatch');
}

export async function issueShippingReceipt(
  deps: ShippingReceiptDeps,
  verification: VerificationRecord,
  bindings: ShippingBindings,
  now: () => number
): Promise<SignedReceipt> {
  const b = snapshotJson(bindings);
  const supplied = snapshotJson(verification);
  const signer = deps.signer;
  if (canonicalJson(b) !== canonicalJson(deps.bindings)) refuse('shipping_identity');
  const held = facts(deps);
  const record = verificationFor(deps, b);
  if (canonicalJson(record) !== canonicalJson(supplied)) refuse('verification_binding_mismatch');
  matchVerification(record, held);
  const context = await buildReceiptContext(deps);
  unchanged(deps, held);
  const {
    requiredCommands: _,
    policyPermitsShipping: __,
    allowedShippingOperations: ___,
    boundaryEvidence: ____,
    ...identity
  } = context;
  const intent = shippingIntent(b);
  const receipt = await issueReceipt(
    {
      ...identity,
      commands: snapshotJson([...record.commands]),
      permittedShippingOperations: [
        {
          kind: 'push_branch',
          target: intent.target,
          operationKey: idempotencyKey(intent),
          nonce: randomUUID(),
          expectedRemoteSha: b.expectedRemoteSha,
        },
      ],
    },
    signer,
    now
  );
  unchanged(deps, held);
  if (canonicalJson(deps.bindings) !== canonicalJson(b) || deps.signer !== signer)
    refuse('shipping_identity_changed');
  verificationFor(deps, b);
  return receipt;
}

export interface ShippingAuthorizeDeps extends ShippingReceiptDeps {
  readonly manifest: SourceManifest;
  readonly record: CandidateRecord;
  readonly authority: CandidateAuthority;
  readonly basePack: Buffer;
  readonly now: () => number;
}
/** Local structural shape: importing even types from a credential module is forbidden. */
export interface ShippingAuthorization {
  readonly receipt: SignedReceipt;
  readonly context: ReceiptContext;
  readonly candidate: CanonicalCandidate;
}

export function makeAuthorize(
  deps: ShippingAuthorizeDeps
): (intent: IntentInput) => Promise<ShippingAuthorization> {
  return async (input) => {
    const intent = snapshotJson(input);
    const b = snapshotJson(deps.bindings);
    const manifest = snapshotJson(deps.manifest);
    const record = snapshotJson(deps.record);
    const authority = snapshotJson(deps.authority);
    const pack = Buffer.from(deps.basePack);
    const held = facts(deps);
    const expected = shippingIntent(b);
    if (
      intent.contributionId !== expected.contributionId ||
      intent.operationKind !== expected.operationKind ||
      intent.target !== expected.target ||
      intent.candidateSha !== expected.candidateSha
    )
      refuse('operation_denied');
    const verification = verificationFor(deps, b);
    matchVerification(verification, held);
    if (
      record.candidateSha !== b.candidateSha ||
      authority.author.login !== held.contributor ||
      record.baseSha !== b.baseSha
    )
      refuse('verification_binding_mismatch');
    const candidate = reconstructCandidate(manifest, record, authority, pack);
    const receipt = await issueShippingReceipt(deps, verification, b, deps.now);
    const context = await buildReceiptContext(deps);
    unchanged(deps, held);
    if (
      canonicalJson(deps.bindings) !== canonicalJson(b) ||
      canonicalJson(deps.manifest) !== canonicalJson(manifest) ||
      canonicalJson(deps.record) !== canonicalJson(record) ||
      canonicalJson(deps.authority) !== canonicalJson(authority) ||
      !pack.equals(deps.basePack)
    )
      refuse('candidate_changed');
    verificationFor(deps, b);
    return { receipt, context, candidate };
  };
}

export interface ShippingHandoffDeps extends ReceiptContextDeps {
  readonly receipt: SignedReceipt;
  readonly trustedControllerKey: string;
  readonly now: () => number;
  readonly readLogin: () => Promise<string>;
  /** Adapter calls the real checkForkReadiness with the persisted upstream/fork binding. */
  readonly checkForkReadiness: () => Promise<ReadinessOutcome>;
  /** Adapter supplies ForkPusher.handoffReadBack, which requires a verified push. */
  readonly remoteBranchSha: () => Promise<string | null>;
}

export function makeHandoffAdmission(deps: ShippingHandoffDeps): HandoffAdmission {
  const used = new Set<string>();
  const check = async (probe: () => Promise<boolean>) => {
    try {
      return (await probe()) === true;
    } catch {
      return false;
    }
  };
  return {
    policyFresh: () =>
      check(async () => {
        await buildReceiptContext(deps);
        return true;
      }),
    contributorVerified: () =>
      check(async () => {
        const held = facts(deps);
        const login = await deps.readLogin();
        unchanged(deps, held);
        return typeof login === 'string' && sameLogin(login, held.contributor);
      }),
    forkBindingVerified: () =>
      check(async () => {
        const held = facts(deps);
        const fork = snapshotJson(deps.fork);
        const result = await deps.checkForkReadiness();
        unchanged(deps, held);
        return (
          result.kind === 'ready' &&
          canonicalJson(result.fork) === canonicalJson(fork) &&
          result.run.runId === held.runId &&
          sameLogin(result.run.contributor, held.contributor)
        );
      }),
    receiptValid: (candidateSha, digest) =>
      check(async () => {
        const envelope = snapshotJson(deps.receipt);
        const key = deps.trustedControllerKey;
        const held = facts(deps);
        if (used.has(digest) || envelope.digest !== digest || candidateSha !== held.candidateSha)
          return false;
        const context = await buildReceiptContext(deps);
        const receipt = await verifyReceipt(envelope, key, context, deps.now);
        unchanged(deps, held);
        const verification = verificationFor(deps, snapshotJson(deps.bindings));
        matchVerification(verification, context);
        if (
          canonicalJson(receipt.commands) !== canonicalJson(verification.commands) ||
          canonicalJson(deps.receipt) !== canonicalJson(envelope) ||
          deps.trustedControllerKey !== key ||
          receipt.permittedShippingOperations.length !== 1 ||
          canonicalJson(
            receipt.permittedShippingOperations.map(({ kind, target, expectedRemoteSha }) => ({
              kind,
              target,
              expectedRemoteSha,
            }))
          ) !== canonicalJson(context.allowedShippingOperations) ||
          used.has(digest)
        )
          return false;
        used.add(digest);
        return true;
      }),
    remoteBranchSha: async () => {
      const held = facts(deps);
      const sha = await deps.remoteBranchSha();
      unchanged(deps, held);
      if (sha !== held.candidateSha) refuse('remote_sha_mismatch');
      return sha;
    },
  };
}

export interface ShippingPrContentDeps {
  readonly intent: IntentInput;
  readonly receipt: SignedReceipt;
  readonly verification: VerificationRecord;
  readonly candidateReady: Pick<PrContentInput, 'title' | 'cause' | 'scope'>;
  readonly policy: {
    readonly receiptBlockAllowed: boolean;
    readonly baselineFailuresPermitted: boolean;
  };
  readonly baselineFailures?: readonly string[];
  readonly limitations?: readonly string[];
  readonly template?: string;
  readonly currentBaseSha: string;
}

export function prContentInput(input: ShippingPrContentDeps): PrContentInput {
  const d = snapshotJson(input);
  receiptIntegrity(d.receipt);
  assertShippableVerification(d.verification);
  for (const field of [
    'runId',
    'candidateSha',
    'baseSha',
    'parentSha',
    'profileDigest',
    'profile',
    'commands',
  ] as const)
    if (canonicalJson(d.verification[field]) !== canonicalJson(d.receipt.receipt[field]))
      refuse('verification_binding_mismatch');
  if (
    d.intent.operationKind !== 'pr_create' ||
    d.intent.contributionId !== d.receipt.receipt.contributionId ||
    d.intent.candidateSha !== d.verification.candidateSha ||
    d.receipt.receipt.candidateSha !== d.verification.candidateSha ||
    canonicalJson(d.receipt.receipt.commands) !== canonicalJson(d.verification.commands) ||
    d.receipt.receipt.baseSha !== d.verification.baseSha ||
    !/^[a-f0-9]{40}$/u.test(d.currentBaseSha)
  )
    refuse('verification_binding_mismatch');
  const regression = d.verification.commands.find(
    (c) => c.id.endsWith(REGRESSION_COMMAND_SUFFIX) && c.status === 'passed'
  );
  if (!regression) refuse('unverified');
  return {
    intent: d.intent,
    issue: d.receipt.receipt.issue,
    title: d.candidateReady.title,
    cause: d.candidateReady.cause,
    scope: d.candidateReady.scope,
    receipt: d.receipt.receipt,
    receiptAllowed: d.policy.receiptBlockAllowed === true,
    regression: {
      command: regression.command,
      baseStatus: 'failed',
      candidateStatus: regression.status,
    },
    ...(d.policy.baselineFailuresPermitted === true && d.baselineFailures
      ? { baselineFailures: { permitted: true, failures: d.baselineFailures } }
      : {}),
    limitations: [
      ...(d.limitations ?? []),
      ...(d.currentBaseSha !== d.verification.baseSha
        ? [
            `Verified on base \`${d.verification.baseSha}\`; upstream is now at \`${d.currentBaseSha}\`; the merge result was not verified`,
          ]
        : []),
    ],
    ...(d.template === undefined ? {} : { template: d.template }),
  };
}
