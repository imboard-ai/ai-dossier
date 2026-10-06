/** Contributor fork prerequisites (#1065, PRD §5.7, §5.9 "Discover fork"/"Create fork").
 * Discovery is credential-free and binds by repository id; creating the fork and installing
 * the App on it are one-time manual steps the run waits for durably. Nothing here polls or
 * reminds: an explicit resume re-checks. Installation facts come from the credential side
 * through `InstallationSource`, so this module never holds or reaches a credential. */
import { assertNoSecrets } from '../redaction';
import {
  isRecord,
  prerequisiteWaitOrigin,
  ReasonCode,
  type RunRecord,
  transitionRun,
} from '../state';
import { HandoffError, isGitHubLogin, sameLogin, upstreamIssueBinding } from './handoff';
import type { GitHubRead } from './reconcile';

export const FORK_ERRORS = Object.freeze([
  'invalid_binding',
  'invalid_app',
  'admission_state',
] as const);
export type ForkErrorCode = (typeof FORK_ERRORS)[number];

/** Fixed message: never echoes the run, a repository name or a GitHub response. */
export class ForkError extends Error {
  constructor(readonly code: ForkErrorCode) {
    super(`Zero-trust fork check rejected: ${code}`);
    this.name = 'ForkError';
  }
}

const PAGE_SIZE = 100;
/** Newest forks first: a fork the contributor just created is on the first page. */
export const MAX_FORK_PAGES = 10;
const FULL_NAME = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/u;

export const UNREADABLE_ACTION =
  'GitHub could not be read, so nothing was recorded. Resume the run to check again.';

export interface UpstreamRepository {
  readonly owner: string;
  readonly repo: string;
  /** Recorded when the run was gated; the only identity a fork's parent is checked against. */
  readonly repositoryId: number;
}
export interface ForkRepository {
  readonly repositoryId: number;
  readonly owner: string;
  /** The fork's own repository name (it may differ from the upstream's). */
  readonly repo: string;
  readonly fullName: string;
}

export const FORK_BLOCK_REASONS = Object.freeze([
  /** In the upstream's fork network, but forked from another fork, not the upstream. */
  'fork_wrong_parent',
  /** The repository read back is owned by another account (transferred or redirected). */
  'fork_wrong_owner',
  /** The fork this run bound earlier was deleted or replaced by another repository. */
  'fork_replaced',
] as const);
export type ForkBlockReason = (typeof FORK_BLOCK_REASONS)[number];

export type ForkDiscovery =
  | { readonly kind: 'found'; readonly fork: ForkRepository }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: ForkBlockReason; readonly fullName: string }
  | { readonly kind: 'unknown' };

export const isPositiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const enc = encodeURIComponent;

type Read = { ok: true; status: number; body: unknown } | { ok: false };
async function get(read: GitHubRead, path: string): Promise<Read> {
  try {
    const response = await read(path);
    return { ok: true, status: response.status, body: response.body };
  } catch {
    return { ok: false };
  }
}

/** A credential-side read that throws counts as unreadable. */
async function settle<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

type Verdict =
  | { kind: 'fork'; fork: ForkRepository }
  | { kind: 'unrelated' }
  | { kind: 'invalid'; reason: ForkBlockReason; fullName: string };

/** Identity only: id, `fork:true`, `parent.id`, owner. A matching name proves nothing. */
function verdict(body: unknown, upstream: UpstreamRepository, contributor: string): Verdict {
  if (!isRecord(body)) return { kind: 'unrelated' };
  const owner = isRecord(body.owner) ? body.owner.login : undefined;
  const parent = isRecord(body.parent) ? body.parent.id : undefined;
  const source = isRecord(body.source) ? body.source.id : undefined;
  const name = typeof body.full_name === 'string' ? FULL_NAME.exec(body.full_name) : null;
  if (
    body.fork !== true ||
    !isPositiveId(body.id) ||
    !name ||
    !isGitHubLogin(owner) ||
    !sameLogin(name[1] as string, owner)
  )
    return { kind: 'unrelated' };
  const fullName = name[0];
  // Another project of the same name is simply not the fork; only the upstream's own
  // network can hold a wrong-parent fork.
  if (parent !== upstream.repositoryId && source !== upstream.repositoryId)
    return { kind: 'unrelated' };
  if (!sameLogin(owner, contributor))
    return { kind: 'invalid', reason: 'fork_wrong_owner', fullName };
  if (parent !== upstream.repositoryId)
    return { kind: 'invalid', reason: 'fork_wrong_parent', fullName };
  return {
    kind: 'fork',
    fork: Object.freeze({ repositoryId: body.id, owner, repo: name[2] as string, fullName }),
  };
}

/** Credential-free discovery: the contributor's same-name repository first, then the
 * upstream's fork listing filtered by owner; every candidate is re-read and bound by id.
 * Absence is reported only when the reads prove it; otherwise the answer is `unknown`. */
export async function discoverFork(
  read: GitHubRead,
  upstream: UpstreamRepository,
  contributor: string,
  expectedForkId?: number
): Promise<ForkDiscovery> {
  if (!isGitHubLogin(contributor) || !isPositiveId(upstream.repositoryId))
    throw new ForkError('invalid_binding');
  const judge = (v: Verdict): ForkDiscovery | null => {
    if (v.kind === 'invalid') return { kind: 'invalid', reason: v.reason, fullName: v.fullName };
    if (v.kind !== 'fork') return null;
    if (expectedForkId !== undefined && v.fork.repositoryId !== expectedForkId)
      return { kind: 'invalid', reason: 'fork_replaced', fullName: v.fork.fullName };
    return { kind: 'found', fork: v.fork };
  };

  // A renamed fork answers the old name with a redirect; the listing below still finds it.
  const direct = await get(read, `/repos/${enc(contributor)}/${enc(upstream.repo)}`);
  const directAnswered = direct.ok && (direct.status === 200 || direct.status === 404);
  if (direct.ok && direct.status === 200) {
    const found = judge(verdict(direct.body, upstream, contributor));
    if (found) return found;
  }

  const listing = `/repos/${enc(upstream.owner)}/${enc(upstream.repo)}/forks?sort=newest`;
  let complete = false;
  for (let page = 1; page <= MAX_FORK_PAGES && !complete; page++) {
    const response = await get(read, `${listing}&per_page=${PAGE_SIZE}&page=${page}`);
    if (!response.ok || response.status !== 200 || !Array.isArray(response.body))
      return { kind: 'unknown' };
    for (const item of response.body) {
      const owner = isRecord(item) && isRecord(item.owner) ? item.owner.login : undefined;
      const name =
        isRecord(item) && typeof item.full_name === 'string'
          ? FULL_NAME.exec(item.full_name)
          : null;
      if (typeof owner !== 'string' || !sameLogin(owner, contributor) || !name) continue;
      const candidate = await get(
        read,
        `/repos/${enc(name[1] as string)}/${enc(name[2] as string)}`
      );
      if (!candidate.ok || candidate.status !== 200) return { kind: 'unknown' };
      const found = judge(verdict(candidate.body, upstream, contributor));
      if (found) return found;
    }
    complete = response.body.length < PAGE_SIZE;
  }
  // Not found. A complete listing proves it. A capped listing proves nothing about a bound
  // fork (it may be older or renamed), and nothing at all when the direct read failed too;
  // a first-time contributor with no same-name repository is still told to fork.
  if (!complete && (expectedForkId !== undefined || !directAnswered)) return { kind: 'unknown' };
  return expectedForkId === undefined
    ? { kind: 'missing' }
    : // The bound fork is gone: deleted forks block (PRD §5.9 permission freshness).
      { kind: 'invalid', reason: 'fork_replaced', fullName: `${contributor}/${upstream.repo}` };
}

export const PERMISSION_LEVELS = Object.freeze(['read', 'write', 'admin'] as const);
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

/** An installation of the App as `GET /repos/{owner}/{repo}/installation` reports it. */
export interface InstallationSummary {
  readonly id: number;
  /** The account the App is installed on. */
  readonly account: string;
  readonly repositorySelection: string;
  readonly permissions: Readonly<Record<string, string>>;
  readonly suspended: boolean;
}

/** Credential-side reads, implemented next to the broker (`contributor.ts`). */
export interface InstallationSource {
  /** App JWT: the installation covering a repository; `none` when the App is not installed
   * there; null when GitHub could not be read. */
  installationFor(repository: {
    readonly owner: string;
    readonly repo: string;
  }): Promise<InstallationSummary | 'none' | null>;
  /** The installation's selected repository ids, read with the contributor's user token;
   * `authorize` when no live user token is held; null when GitHub could not be read. */
  selectedRepositories(installationId: number): Promise<readonly number[] | 'authorize' | null>;
}

export type TooBroadDetail =
  | 'all_repositories'
  | 'extra_repositories'
  | 'extra_permissions'
  | 'upstream_installation';
export type InstallationCheck =
  | { readonly kind: 'limited'; readonly installationId: number }
  /** Selection and permissions are fine; the repository set still needs the user token. */
  | { readonly kind: 'unconfirmed'; readonly installationId: number }
  /** `suspendedId`: installed on the fork's account but suspended. */
  | { readonly kind: 'missing'; readonly suspendedId?: number }
  | {
      readonly kind: 'too_broad';
      readonly detail: TooBroadDetail;
      readonly installationId: number;
    };

function exceeds(
  granted: Readonly<Record<string, string>>,
  declared: Readonly<Record<string, PermissionLevel>>
): boolean {
  return Object.entries(granted).some(([name, level]) => {
    const allowed = Object.hasOwn(declared, name) ? declared[name] : undefined;
    const rank = PERMISSION_LEVELS.indexOf(level as PermissionLevel);
    return allowed === undefined || rank < 0 || rank > PERMISSION_LEVELS.indexOf(allowed);
  });
}

/** The installation on the fork must select exactly the fork and grant no more than the App
 * declares. Pure: the reads happen on the credential side. Without `repositoryIds` it checks
 * everything except the selected set. None, a suspended installation, or one on another
 * account than the fork owner's counts as missing. */
export function checkInstallation(
  installation: InstallationSummary | 'none',
  fork: ForkRepository,
  declared: Readonly<Record<string, PermissionLevel>>,
  repositoryIds?: readonly number[]
): InstallationCheck {
  if (installation === 'none' || !sameLogin(installation.account, fork.owner))
    return { kind: 'missing' };
  if (installation.suspended) return { kind: 'missing', suspendedId: installation.id };
  const installationId = installation.id;
  if (installation.repositorySelection !== 'selected')
    return { kind: 'too_broad', detail: 'all_repositories', installationId };
  if (exceeds(installation.permissions, declared))
    return { kind: 'too_broad', detail: 'extra_permissions', installationId };
  if (repositoryIds === undefined) return { kind: 'unconfirmed', installationId };
  if (repositoryIds.some((id) => id !== fork.repositoryId))
    return { kind: 'too_broad', detail: 'extra_repositories', installationId };
  return repositoryIds.includes(fork.repositoryId)
    ? { kind: 'limited', installationId }
    : { kind: 'missing' };
}

/** The verified fork binding the broker (#1064) is constructed with. */
export interface ForkReady extends ForkRepository {
  readonly installationId: number;
}

export interface ReadinessInput {
  readonly run: RunRecord;
  /** Recorded upstream id; owner and repository come from the run's own issue URL. */
  readonly upstreamId: number;
  readonly appSlug: string;
  readonly declaredPermissions: Readonly<Record<string, PermissionLevel>>;
  /** The fork bound earlier in this run, if any; a different repository blocks. */
  readonly expectedForkId?: number;
}
export interface ReadinessDeps {
  /** Anonymous reader: discovery never sends a credential. */
  readonly read: GitHubRead;
  readonly installations: InstallationSource;
  readonly now: () => string;
}

export type WaitReason = 'fork_missing' | 'installation_missing';
export type ReadinessBlock = ForkBlockReason | 'installation_too_broad';
export type ReadinessOutcome =
  | { readonly kind: 'ready'; readonly run: RunRecord; readonly fork: ForkReady }
  | {
      readonly kind: 'awaiting_contributor';
      readonly run: RunRecord;
      readonly reason: WaitReason;
      readonly link: string;
      readonly nextPermittedAction: string;
    }
  /** The run records `installation_too_broad`, or `policy_blocked` for a fork reason. */
  | {
      readonly kind: 'blocked';
      readonly run: RunRecord;
      readonly reason: ReadinessBlock;
      readonly detail?: TooBroadDetail;
      readonly link: string;
      readonly nextPermittedAction: string;
    }
  /** Everything checkable without the contributor's user token passed; `fork` is the binding
   * the broker is built with. Nothing recorded: the contributor authorizes, then resumes. */
  | {
      readonly kind: 'authorization_required';
      readonly run: RunRecord;
      readonly fork: ForkReady;
      readonly nextPermittedAction: string;
    }
  /** GitHub could not be read: nothing recorded; an explicit resume checks again. */
  | { readonly kind: 'unknown'; readonly run: RunRecord; readonly nextPermittedAction: string };

/** The upstream comes from the run's own issue URL, never from the caller. */
export function upstreamOf(run: RunRecord, upstreamId: number): UpstreamRepository {
  let upstream: { owner: string; repo: string };
  try {
    upstream = upstreamIssueBinding(run.upstreamIssue).upstream;
  } catch (error) {
    if (error instanceof HandoffError) throw new ForkError('invalid_binding');
    throw error;
  }
  if (!isPositiveId(upstreamId)) throw new ForkError('invalid_binding');
  return Object.freeze({ owner: upstream.owner, repo: upstream.repo, repositoryId: upstreamId });
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;
export function isAppSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value);
}
const checked = (text: string): string => {
  assertNoSecrets(text);
  return text;
};

export function forkLink(upstream: UpstreamRepository): string {
  return checked(`https://github.com/${enc(upstream.owner)}/${enc(upstream.repo)}/fork`);
}
export function installLink(appSlug: string): string {
  if (!isAppSlug(appSlug)) throw new ForkError('invalid_app');
  return checked(`https://github.com/apps/${appSlug}/installations/new`);
}
const settingsLink = (installationId?: number) =>
  checked(
    installationId === undefined
      ? 'https://github.com/settings/installations'
      : `https://github.com/settings/installations/${installationId}`
  );

interface Action {
  readonly link: string;
  readonly nextPermittedAction: string;
}

function waitAction(
  reasonCode: ReasonCode,
  contributor: string,
  upstream: UpstreamRepository,
  appSlug: string,
  forkName?: string,
  suspendedId?: number
): Action {
  const repo = `${upstream.owner}/${upstream.repo}`;
  if (reasonCode === ReasonCode.ForkMissing) {
    const link = forkLink(upstream);
    return {
      link,
      nextPermittedAction: checked(
        `Fork ${repo} into your own account (${contributor}) at ${link}, then resume the ` +
          'run. Forking is a one-time manual step; nothing runs until you resume.'
      ),
    };
  }
  if (suspendedId !== undefined) {
    const link = settingsLink(suspendedId);
    return {
      link,
      nextPermittedAction: checked(
        `The ${appSlug} GitHub App installation on ${contributor} is suspended. Unsuspend it ` +
          `at ${link}, then resume the run.`
      ),
    };
  }
  const link = installLink(appSlug);
  const target = forkName ?? `your fork of ${repo}`;
  return {
    link,
    nextPermittedAction: checked(
      `Install the ${appSlug} GitHub App on your account (${contributor}) at ${link}, ` +
        `choosing "Only select repositories" with only ${target}, then resume the run.`
    ),
  };
}

/** Status line for a persisted fork/installation wait, re-derived from the run plus the
 * upstream binding and App slug. The action is one line and carries the exact link, since
 * status shows only that line. Null outside such a wait. */
export function prerequisiteAction(
  run: RunRecord,
  upstream: UpstreamRepository,
  appSlug: string,
  forkName?: string
): Action | null {
  if (prerequisiteWaitOrigin(run) === null) return null;
  return waitAction(run.reasonCode, run.contributor, upstream, appSlug, forkName);
}

const TOO_BROAD: Readonly<Record<Exclude<TooBroadDetail, 'upstream_installation'>, string>> =
  Object.freeze({
    all_repositories: 'it has access to all repositories',
    extra_repositories: 'it selects repositories besides the fork',
    extra_permissions: 'it grants permissions beyond those the App declares',
  });

type Block =
  | { readonly reason: ForkBlockReason; readonly fullName: string }
  | {
      readonly reason: 'installation_too_broad';
      readonly detail: TooBroadDetail;
      readonly fullName: string;
      readonly installationId?: number;
    };

function blockedAction(
  block: Block,
  upstream: UpstreamRepository,
  contributor: string,
  appSlug: string
): Action {
  const repo = `${upstream.owner}/${upstream.repo}`;
  const { fullName } = block;
  if (block.reason === 'installation_too_broad') {
    if (block.detail === 'upstream_installation') {
      const link = checked(`https://github.com/${enc(upstream.owner)}/${enc(upstream.repo)}`);
      return {
        link,
        nextPermittedAction: checked(
          `The ${appSlug} GitHub App is installed on ${repo} (${link}); it may only ever be ` +
            "installed on the contributor's fork. Its owner must uninstall it before a new run."
        ),
      };
    }
    const link = settingsLink(block.installationId);
    return {
      link,
      nextPermittedAction: checked(
        `The ${appSlug} installation on ${contributor} is broader than the fork: ` +
          `${TOO_BROAD[block.detail]}. At ${link}, choose "Only select repositories" with ` +
          `only ${fullName} and accept no extra permissions, then start a new run.`
      ),
    };
  }
  const because =
    block.reason === 'fork_wrong_parent'
      ? `${fullName} is a fork of another fork, not of ${repo}`
      : block.reason === 'fork_wrong_owner'
        ? `${fullName} is not owned by ${contributor}`
        : `the fork bound earlier in this run is gone or was replaced (${fullName})`;
  const link = forkLink(upstream);
  return {
    link,
    nextPermittedAction: checked(
      `The fork cannot be used: ${because}. Fork ${repo} directly into ${contributor} at ` +
        `${link}, then start a new run.`
    ),
  };
}

/** One explicit check of every prerequisite. Moves the run into, within, or out of the
 * durable wait; the caller persists the returned run. Never schedules anything. Throws
 * `ForkError`: `admission_state` outside gating, shipping or a fork/installation wait (a
 * pending link hand-off included); `invalid_binding` / `invalid_app` on a bad issue URL,
 * upstream id or App slug. */
export async function checkForkReadiness(
  input: ReadinessInput,
  deps: ReadinessDeps
): Promise<ReadinessOutcome> {
  const { run, appSlug } = input;
  const origin = prerequisiteWaitOrigin(run);
  if (origin === null && run.state !== 'gating' && run.state !== 'shipping')
    throw new ForkError('admission_state');
  if (!isAppSlug(appSlug)) throw new ForkError('invalid_app');
  const upstream = upstreamOf(run, input.upstreamId);
  const move = (reason: ReasonCode) => transitionRun(run, reason, deps.now());
  const unknown = (): ReadinessOutcome => ({
    kind: 'unknown',
    run,
    nextPermittedAction: UNREADABLE_ACTION,
  });
  const wait = (
    code: ReasonCode.ForkMissing | ReasonCode.InstallationMissing,
    fork?: ForkRepository,
    suspendedId?: number
  ): ReadinessOutcome => {
    // The same wait observed again records nothing new.
    const next = origin !== null && run.reasonCode === code ? run : move(code);
    return {
      kind: 'awaiting_contributor',
      run: next,
      reason: code === ReasonCode.ForkMissing ? 'fork_missing' : 'installation_missing',
      ...waitAction(code, run.contributor, upstream, appSlug, fork?.fullName, suspendedId),
    };
  };
  const blocked = (block: Block): ReadinessOutcome => ({
    kind: 'blocked',
    run: move(
      block.reason === 'installation_too_broad'
        ? ReasonCode.InstallationTooBroad
        : ReasonCode.PolicyBlocked
    ),
    reason: block.reason,
    ...('detail' in block ? { detail: block.detail } : {}),
    ...blockedAction(block, upstream, run.contributor, appSlug),
  });

  const discovery = await discoverFork(deps.read, upstream, run.contributor, input.expectedForkId);
  if (discovery.kind === 'unknown') return unknown();
  if (discovery.kind === 'invalid')
    return blocked({ reason: discovery.reason, fullName: discovery.fullName });
  if (discovery.kind === 'missing') return wait(ReasonCode.ForkMissing);
  const { fork } = discovery;
  const tooBroad = (detail: TooBroadDetail, installationId?: number) =>
    blocked({ reason: 'installation_too_broad', detail, fullName: fork.fullName, installationId });

  const source = deps.installations;
  const onUpstream = await settle(() => source.installationFor(upstream));
  if (onUpstream === null) return unknown();
  // Any installation on the upstream is too broad, whoever made it (PRD §5.9).
  if (onUpstream !== 'none') return tooBroad('upstream_installation');
  const summary = await settle(() => source.installationFor(fork));
  if (summary === null) return unknown();
  const declared = input.declaredPermissions;
  let installation = checkInstallation(summary, fork, declared);
  if (installation.kind === 'unconfirmed') {
    const installationId = installation.installationId;
    const ids = await settle(() => source.selectedRepositories(installationId));
    if (ids === null) return unknown();
    if (ids === 'authorize')
      return {
        kind: 'authorization_required',
        run,
        fork: Object.freeze({ ...fork, installationId }),
        nextPermittedAction: checked(
          `Authorize the ${appSlug} GitHub App as ${run.contributor} (the run opens the ` +
            'authorization page), then resume the run.'
        ),
      };
    installation = checkInstallation(summary, fork, declared, ids);
  }
  switch (installation.kind) {
    case 'missing':
      return wait(ReasonCode.InstallationMissing, fork, installation.suspendedId);
    case 'too_broad':
      return tooBroad(installation.detail, installation.installationId);
    case 'unconfirmed':
      // checkInstallation with repository ids never answers `unconfirmed`.
      throw new ForkError('invalid_binding');
    case 'limited':
      return {
        kind: 'ready',
        run:
          origin === null
            ? run
            : move(origin === 'gating' ? ReasonCode.ResumeGating : ReasonCode.ResumeShipping),
        fork: Object.freeze({ ...fork, installationId: installation.installationId }),
      };
  }
}
