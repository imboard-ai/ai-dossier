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
import { isGitHubLogin } from './handoff';
import type { GitHubRead } from './reconcile';

export class ForkError extends Error {
  constructor(readonly code: string) {
    super(`Zero-trust fork check rejected: ${code}`);
    this.name = 'ForkError';
  }
}

const PAGE_SIZE = 100;
/** Newest forks first: a fork the contributor just created is on the first page. */
export const MAX_FORK_PAGES = 10;

export interface UpstreamRepository {
  readonly owner: string;
  readonly repo: string;
  /** Recorded when the run was gated; the only identity a fork's parent is checked against. */
  readonly repositoryId: number;
}
export interface ForkRepository {
  readonly repositoryId: number;
  readonly owner: string;
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

const sameLogin = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const positiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const enc = encodeURIComponent;

type Read = { ok: true; status: number; body: unknown } | { ok: false };
/** A credential-side read that throws counts as unreadable. */
async function settle<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

async function get(read: GitHubRead, path: string): Promise<Read> {
  try {
    const response = await read(path);
    return { ok: true, status: response.status, body: response.body };
  } catch {
    return { ok: false };
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
  const fullName = body.full_name;
  if (
    body.fork !== true ||
    !positiveId(body.id) ||
    typeof fullName !== 'string' ||
    !isGitHubLogin(owner)
  )
    return { kind: 'unrelated' };
  // Another project of the same name is simply not the fork; only the upstream's own
  // network can hold a wrong-parent fork.
  if (parent !== upstream.repositoryId && source !== upstream.repositoryId)
    return { kind: 'unrelated' };
  if (!sameLogin(owner, contributor))
    return { kind: 'invalid', reason: 'fork_wrong_owner', fullName };
  if (parent !== upstream.repositoryId)
    return { kind: 'invalid', reason: 'fork_wrong_parent', fullName };
  return { kind: 'fork', fork: Object.freeze({ repositoryId: body.id, owner, fullName }) };
}

/** Credential-free discovery: the contributor's same-name repository first, then the
 * upstream's fork listing filtered by owner; every candidate is re-read and bound by id. */
export async function discoverFork(
  read: GitHubRead,
  upstream: UpstreamRepository,
  contributor: string,
  expectedForkId?: number
): Promise<ForkDiscovery> {
  if (!isGitHubLogin(contributor) || !positiveId(upstream.repositoryId))
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
  if (direct.ok && direct.status === 200) {
    const found = judge(verdict(direct.body, upstream, contributor));
    if (found) return found;
  }

  const listing = `/repos/${enc(upstream.owner)}/${enc(upstream.repo)}/forks?sort=newest`;
  for (let page = 1; page <= MAX_FORK_PAGES; page++) {
    const response = await get(read, `${listing}&per_page=${PAGE_SIZE}&page=${page}`);
    if (!response.ok || response.status !== 200 || !Array.isArray(response.body))
      return { kind: 'unknown' };
    for (const item of response.body) {
      const owner = isRecord(item) && isRecord(item.owner) ? item.owner.login : undefined;
      const fullName = isRecord(item) ? item.full_name : undefined;
      if (typeof owner !== 'string' || !sameLogin(owner, contributor)) continue;
      if (typeof fullName !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(fullName))
        continue;
      const [name, repo] = fullName.split('/') as [string, string];
      const candidate = await get(read, `/repos/${enc(name)}/${enc(repo)}`);
      if (!candidate.ok || candidate.status !== 200) return { kind: 'unknown' };
      const found = judge(verdict(candidate.body, upstream, contributor));
      if (found) return found;
    }
    if (response.body.length < PAGE_SIZE) break;
  }
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
  | { readonly kind: 'missing' }
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
 * everything except the selected set. */
export function checkInstallation(
  installation: InstallationSummary | 'none',
  fork: ForkRepository,
  declared: Readonly<Record<string, PermissionLevel>>,
  repositoryIds?: readonly number[]
): InstallationCheck {
  if (
    installation === 'none' ||
    installation.suspended ||
    !sameLogin(installation.account, fork.owner)
  )
    return { kind: 'missing' };
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
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/[1-9][0-9]{0,15}$/u.exec(
    run.upstreamIssue
  );
  if (
    !match ||
    !isGitHubLogin(match[1]) ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(match[2] as string) ||
    !positiveId(upstreamId)
  )
    throw new ForkError('invalid_binding');
  return Object.freeze({ owner: match[1], repo: match[2] as string, repositoryId: upstreamId });
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;
const checked = (text: string): string => {
  assertNoSecrets(text);
  return text;
};

export function forkLink(upstream: UpstreamRepository): string {
  return checked(`https://github.com/${enc(upstream.owner)}/${enc(upstream.repo)}/fork`);
}
export function installLink(appSlug: string): string {
  if (!SLUG.test(appSlug)) throw new ForkError('invalid_app');
  return checked(`https://github.com/apps/${appSlug}/installations/new`);
}

/** Status text for a persisted fork/installation wait, re-derived from the run alone. The
 * action is one line and carries the exact link, since status shows only that line. */
export function prerequisiteAction(
  run: RunRecord,
  upstream: UpstreamRepository,
  appSlug: string,
  forkName?: string
): { readonly link: string; readonly nextPermittedAction: string } | null {
  if (prerequisiteWaitOrigin(run) === null) return null;
  const repo = `${upstream.owner}/${upstream.repo}`;
  if (run.reasonCode === ReasonCode.ForkMissing) {
    const link = forkLink(upstream);
    return {
      link,
      nextPermittedAction: checked(
        `Fork ${repo} into your own account (${run.contributor}) at ${link}, then resume the ` +
          'run. Forking is a one-time manual step; nothing runs until you resume.'
      ),
    };
  }
  const link = installLink(appSlug);
  const target = forkName ?? `your fork of ${repo}`;
  return {
    link,
    nextPermittedAction: checked(
      `Install the ${appSlug} GitHub App on your account (${run.contributor}) at ${link}, ` +
        `choosing "Only select repositories" with only ${target}, then resume the run.`
    ),
  };
}

const TOO_BROAD: Readonly<Record<TooBroadDetail, string>> = Object.freeze({
  all_repositories: 'it has access to all repositories',
  extra_repositories: 'it selects repositories besides the fork',
  extra_permissions: 'it grants permissions beyond those the App declares',
  upstream_installation: 'the App is installed on the upstream repository',
});

function blockedAction(
  reason: ReadinessBlock,
  upstream: UpstreamRepository,
  contributor: string,
  appSlug: string,
  fullName: string,
  detail?: TooBroadDetail,
  installationId?: number
): { link: string; nextPermittedAction: string } {
  const repo = `${upstream.owner}/${upstream.repo}`;
  if (detail === 'upstream_installation') {
    const link = checked(`https://github.com/${enc(upstream.owner)}/${enc(upstream.repo)}`);
    return {
      link,
      nextPermittedAction: checked(
        `The ${appSlug} GitHub App is installed on ${repo} (${link}); it may only ever be ` +
          "installed on the contributor's fork. Its owner must uninstall it before a new run."
      ),
    };
  }
  if (reason === 'installation_too_broad') {
    const link = checked(
      installationId === undefined
        ? 'https://github.com/settings/installations'
        : `https://github.com/settings/installations/${installationId}`
    );
    return {
      link,
      nextPermittedAction: checked(
        `The ${appSlug} installation on ${contributor} is broader than the fork: ` +
          `${TOO_BROAD[detail as TooBroadDetail]}. At ${link}, choose "Only select ` +
          `repositories" with only ${fullName} and accept no extra permissions, then start a new run.`
      ),
    };
  }
  const because =
    reason === 'fork_wrong_parent'
      ? `${fullName} is a fork of another fork, not of ${repo}`
      : reason === 'fork_wrong_owner'
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
 * durable wait; the caller persists the returned run. Never schedules anything. */
export async function checkForkReadiness(
  input: ReadinessInput,
  deps: ReadinessDeps
): Promise<ReadinessOutcome> {
  const { run, appSlug } = input;
  const origin = prerequisiteWaitOrigin(run);
  if (origin === null && run.state !== 'gating' && run.state !== 'shipping')
    throw new ForkError('admission_state');
  installLink(appSlug);
  const upstream = upstreamOf(run, input.upstreamId);
  const move = (reason: ReasonCode) => transitionRun(run, reason, deps.now());
  const unknown = (): ReadinessOutcome => ({
    kind: 'unknown',
    run,
    nextPermittedAction:
      'GitHub could not be read, so nothing was recorded. Resume the run to check again.',
  });
  const wait = (reason: WaitReason, forkName?: string): ReadinessOutcome => {
    const code =
      reason === 'fork_missing' ? ReasonCode.ForkMissing : ReasonCode.InstallationMissing;
    // The same wait observed again records nothing new.
    const next = origin !== null && run.reasonCode === code ? run : move(code);
    const action = prerequisiteAction(next, upstream, appSlug, forkName);
    return {
      kind: 'awaiting_contributor',
      run: next,
      reason,
      ...(action as NonNullable<typeof action>),
    };
  };
  const block = (
    reason: ReadinessBlock,
    fullName: string,
    detail?: TooBroadDetail,
    installationId?: number
  ): ReadinessOutcome => ({
    kind: 'blocked',
    run: move(
      reason === 'installation_too_broad'
        ? ReasonCode.InstallationTooBroad
        : ReasonCode.PolicyBlocked
    ),
    reason,
    ...(detail ? { detail } : {}),
    ...blockedAction(reason, upstream, run.contributor, appSlug, fullName, detail, installationId),
  });

  const discovery = await discoverFork(deps.read, upstream, run.contributor, input.expectedForkId);
  if (discovery.kind === 'unknown') return unknown();
  if (discovery.kind === 'invalid') return block(discovery.reason, discovery.fullName);
  if (discovery.kind === 'missing') return wait('fork_missing');
  const { fork } = discovery;

  const declared = input.declaredPermissions;
  const source = deps.installations;
  const onUpstream = await settle(() => source.installationFor(upstream));
  if (onUpstream === null) return unknown();
  if (onUpstream !== 'none') {
    // Any installation on the upstream is too broad, whoever made it (PRD §5.9).
    return block('installation_too_broad', fork.fullName, 'upstream_installation');
  }
  const summary = await settle(() =>
    source.installationFor({ owner: fork.owner, repo: fork.fullName.split('/')[1] as string })
  );
  if (summary === null) return unknown();
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
  if (installation.kind === 'missing') return wait('installation_missing', fork.fullName);
  if (installation.kind === 'too_broad')
    return block(
      'installation_too_broad',
      fork.fullName,
      installation.detail,
      installation.installationId
    );
  if (installation.kind !== 'limited') return unknown();
  const ready = Object.freeze({ ...fork, installationId: installation.installationId });
  return {
    kind: 'ready',
    run:
      origin === null
        ? run
        : move(origin === 'gating' ? ReasonCode.ResumeGating : ReasonCode.ResumeShipping),
    fork: ready,
  };
}
