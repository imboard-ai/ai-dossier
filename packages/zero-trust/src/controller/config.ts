import { createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { requireBudgetRates } from '../budget';
import { BudgetError, type BudgetRate } from '../budget-types';
import { isAppSlug } from '../github/fork';
import { isGitHubLogin, upstreamIssueBinding } from '../github/handoff';
import { assertSecretFree } from '../redaction';
import { isRecord } from '../state';
import { DEFAULT_LIMITS, type VmLimits } from '../vm/adapter';
import { contributionIdOf } from './ids';

export type ConfigErrorCode =
  | 'invalid_config'
  | 'unknown_key'
  | 'invalid_issue_url'
  | 'invalid_contributor'
  | 'invalid_author_approval'
  | 'unsupported_environment'
  | 'invalid_model_profile'
  | 'invalid_env_name'
  | 'invalid_budget'
  | 'missing_rate'
  | 'invalid_checkpoints'
  | 'invalid_limits'
  | 'invalid_signer_key'
  | 'invalid_github_app'
  | 'invalid_retention'
  | 'invalid_resume_run_id'
  | 'secret_detected';
export class RunConfigError extends Error {
  constructor(readonly code: ConfigErrorCode) {
    super(`Run configuration refused (${code})`);
    this.name = 'RunConfigError';
  }
}
export interface ModelPhase {
  readonly adapter: string;
  readonly model: string;
  readonly endpoint: string;
  readonly apiKeyEnv: string;
}
export interface RunConfig {
  readonly issueUrl: string;
  readonly upstream: { readonly owner: string; readonly repo: string; readonly issue: number };
  readonly contributor: string;
  readonly authorApproval?: AuthorApproval;
  readonly executionProfile: {
    readonly provider: 'local-qemu';
    readonly profileDir: string;
    readonly stateDir: string;
    readonly accelerator: 'auto' | 'kvm' | 'tcg';
    readonly proxyEndpointsFile: string;
  };
  readonly modelProfile: {
    readonly phases: {
      readonly planning: ModelPhase;
      readonly implementing: ModelPhase;
      readonly repair?: ModelPhase;
    };
    readonly rates: BudgetRate[];
  };
  readonly budget: {
    readonly currency: string;
    readonly ceilingMinor: number;
    readonly cleanupAllowanceMinor: number;
    readonly tokenLimit: number;
    readonly activeMinutes: number;
  };
  readonly checkpoints: readonly ('plan' | 'patch' | 'verification')[];
  readonly limits: VmLimits & { readonly activeMinutes: number };
  readonly signerKeyFile: string;
  readonly githubApp: {
    readonly appId: number;
    readonly clientId: string;
    readonly slug: string;
    readonly privateKeyEnv: string;
    readonly clientSecretEnv: string;
  };
  readonly retentionDays: number;
  readonly resumeRunId?: string;
}

export interface AuthorApproval {
  readonly userId: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
  readonly source: 'default' | 'override';
  readonly approvedAt: string;
}

function authorApproval(raw: unknown, contributor: string): AuthorApproval {
  const a = object(
    raw,
    ['userId', 'login', 'name', 'email', 'source', 'approvedAt'],
    'invalid_author_approval'
  );
  const code = 'invalid_author_approval';
  const userId = positive(a.userId, code);
  const login = text(a.login, code);
  const name = text(a.name, code);
  const email = text(a.email, code);
  const approvedAt = text(a.approvedAt, code);
  if (
    !isGitHubLogin(login) ||
    login.toLowerCase() !== contributor.toLowerCase() ||
    Buffer.byteLength(name) > 256 ||
    /[<>]/u.test(name) ||
    Buffer.byteLength(email) > 256 ||
    !/^[^<>\s@]+@[^<>\s@]+$/u.test(email) ||
    (a.source !== 'default' && a.source !== 'override') ||
    (a.source === 'default' && email !== `${userId}+${login}@users.noreply.github.com`) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(approvedAt) ||
    !Number.isFinite(Date.parse(approvedAt)) ||
    Date.parse(approvedAt) < 0 ||
    new Date(approvedAt).toISOString() !== approvedAt.replace(/(?<!\d{3})Z$/u, '.000Z')
  )
    fail(code);
  return Object.freeze({ userId, login, name, email, source: a.source, approvedAt });
}

function fail(code: ConfigErrorCode): never {
  throw new RunConfigError(code);
}
function object(raw: unknown, keys: string[], code: ConfigErrorCode): Record<string, unknown> {
  if (!isRecord(raw)) fail(code);
  if (Object.keys(raw).some((key) => !keys.includes(key))) fail('unknown_key');
  return raw;
}
function text(raw: unknown, code: ConfigErrorCode): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in controller input.
  if (typeof raw !== 'string' || raw.trim() !== raw || !raw || /[\u0000-\u001f\u007f]/u.test(raw))
    fail(code);
  return raw;
}
function positive(raw: unknown, code: ConfigErrorCode): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) fail(code);
  return raw;
}
function env(raw: unknown): string {
  const value = text(raw, 'invalid_env_name');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) fail('invalid_env_name');
  return value;
}
function phase(raw: unknown): ModelPhase {
  const p = object(raw, ['adapter', 'model', 'endpoint', 'apiKeyEnv'], 'invalid_model_profile');
  const endpoint = text(p.endpoint, 'invalid_model_profile');
  try {
    const url = new URL(endpoint);
    if (
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      ) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail('invalid_model_profile');
  } catch {
    fail('invalid_model_profile');
  }
  return {
    adapter: text(p.adapter, 'invalid_model_profile'),
    model: text(p.model, 'invalid_model_profile'),
    endpoint,
    apiKeyEnv: env(p.apiKeyEnv),
  };
}
function signer(file: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    )
      fail('invalid_signer_key');
    if (stat.size > 16384) fail('invalid_signer_key');
    const key = createPrivateKey(fs.readFileSync(fd));
    if (key.asymmetricKeyType !== 'ed25519') fail('invalid_signer_key');
  } catch {
    fail('invalid_signer_key');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Only trusted controller input; never model/repository input. No environment values read. */
export function validateRunConfig(raw: unknown): RunConfig {
  const config = validateStoredRunConfig(raw);
  signer(config.signerKeyFile);
  return config;
}
/** Pure stored configuration validation; reporting needs no signing readiness. */
export function validateStoredRunConfig(raw: unknown): RunConfig {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(raw);
  } catch {
    fail('invalid_config');
  }
  try {
    assertSecretFree(snapshot);
  } catch {
    fail('secret_detected');
  }
  const r = object(
    snapshot,
    [
      'issueUrl',
      'contributor',
      'authorApproval',
      'executionProfile',
      'modelProfile',
      'budget',
      'checkpoints',
      'limits',
      'signerKeyFile',
      'githubApp',
      'retentionDays',
      'resumeRunId',
    ],
    'invalid_config'
  );
  const issueUrl = text(r.issueUrl, 'invalid_issue_url');
  let binding: ReturnType<typeof upstreamIssueBinding>;
  try {
    binding = upstreamIssueBinding(issueUrl);
  } catch {
    fail('invalid_issue_url');
  }
  if (binding.upstream.owner.length > 39) fail('invalid_issue_url');
  const contributor = text(r.contributor, 'invalid_contributor');
  if (contributor.length > 39 || !isGitHubLogin(contributor)) fail('invalid_contributor');
  const e = object(
    r.executionProfile,
    ['provider', 'profileDir', 'stateDir', 'accelerator', 'proxyEndpointsFile'],
    'unsupported_environment'
  );
  if (
    e.provider !== 'local-qemu' ||
    typeof e.accelerator !== 'string' ||
    !['auto', 'kvm', 'tcg'].includes(e.accelerator)
  )
    fail('unsupported_environment');
  const m = object(r.modelProfile, ['phases', 'rates'], 'invalid_model_profile');
  const phases = object(m.phases, ['planning', 'implementing', 'repair'], 'invalid_model_profile');
  const planning = phase(phases.planning);
  const implementing = phase(phases.implementing);
  const repair = phases.repair === undefined ? undefined : phase(phases.repair);
  const b = object(
    r.budget,
    ['currency', 'ceilingMinor', 'cleanupAllowanceMinor', 'tokenLimit', 'activeMinutes'],
    'invalid_budget'
  );
  const currency = text(b.currency, 'invalid_budget');
  if (!/^[A-Z]{3}$/u.test(currency)) fail('invalid_budget');
  const budget = {
    currency,
    ceilingMinor: positive(b.ceilingMinor, 'invalid_budget'),
    cleanupAllowanceMinor: positive(b.cleanupAllowanceMinor, 'invalid_budget'),
    tokenLimit: positive(b.tokenLimit, 'invalid_budget'),
    activeMinutes: positive(b.activeMinutes, 'invalid_budget'),
  };
  if (budget.cleanupAllowanceMinor > budget.ceilingMinor) fail('invalid_budget');
  const rates = m.rates as BudgetRate[];
  try {
    if (!Array.isArray(rates)) fail('missing_rate');
    if (Object.keys(rates).some((key) => !/^(0|[1-9][0-9]*)$/u.test(key))) fail('unknown_key');
    for (const rate of rates) {
      object(
        rate,
        ['resource', 'currency', 'unit', 'price', 'units', 'source', 'fx'],
        'invalid_budget'
      );
      object(rate.fx, ['currency', 'numerator', 'denominator', 'timestamp'], 'invalid_budget');
      if (rate.fx.currency !== currency) fail('invalid_budget');
    }
    requireBudgetRates(rates, [
      ...new Set([planning.model, implementing.model, ...(repair ? [repair.model] : [])]),
    ]);
  } catch (error) {
    if (error instanceof RunConfigError) throw error;
    fail(
      error instanceof BudgetError && error.code === 'missing_rate'
        ? 'missing_rate'
        : 'invalid_budget'
    );
  }
  const checkpoints = r.checkpoints === undefined ? [] : r.checkpoints;
  if (
    !Array.isArray(checkpoints) ||
    Object.keys(checkpoints).length !== checkpoints.length ||
    Object.keys(checkpoints).some((key) => !/^(0|[1-9][0-9]*)$/u.test(key)) ||
    checkpoints.some((c) => !['plan', 'patch', 'verification'].includes(c)) ||
    new Set(checkpoints).size !== checkpoints.length
  )
    fail('invalid_checkpoints');
  const caps = { ...DEFAULT_LIMITS, activeMinutes: 120 };
  const l = object(r.limits === undefined ? {} : r.limits, Object.keys(caps), 'invalid_limits');
  const limits = { ...caps };
  for (const key of Object.keys(caps) as (keyof typeof caps)[]) {
    if (l[key] !== undefined) limits[key] = positive(l[key], 'invalid_limits');
    if (limits[key] > caps[key]) fail('invalid_limits');
  }
  if (budget.activeMinutes > limits.activeMinutes) fail('invalid_limits');
  const g = object(
    r.githubApp,
    ['appId', 'clientId', 'slug', 'privateKeyEnv', 'clientSecretEnv'],
    'invalid_github_app'
  );
  const slug = text(g.slug, 'invalid_github_app');
  if (!isAppSlug(slug)) fail('invalid_github_app');
  const githubApp = {
    appId: positive(g.appId, 'invalid_github_app'),
    clientId: text(g.clientId, 'invalid_github_app'),
    slug,
    privateKeyEnv: env(g.privateKeyEnv),
    clientSecretEnv: env(g.clientSecretEnv),
  };
  const retentionDays = positive(
    r.retentionDays === undefined ? 30 : r.retentionDays,
    'invalid_retention'
  );
  if (retentionDays > 3650) fail('invalid_retention');
  const resumeRunId =
    r.resumeRunId === undefined ? undefined : text(r.resumeRunId, 'invalid_resume_run_id');
  if (resumeRunId !== undefined && !contributionIdOf(resumeRunId)) fail('invalid_resume_run_id');
  const signerKeyFile = path.resolve(text(r.signerKeyFile, 'invalid_signer_key'));
  return {
    issueUrl,
    upstream: { ...binding.upstream, issue: binding.issue },
    contributor,
    ...(r.authorApproval === undefined
      ? {}
      : { authorApproval: authorApproval(r.authorApproval, contributor) }),
    executionProfile: {
      provider: 'local-qemu',
      profileDir: path.resolve(text(e.profileDir, 'unsupported_environment')),
      stateDir: path.resolve(text(e.stateDir, 'unsupported_environment')),
      accelerator: e.accelerator as 'auto' | 'kvm' | 'tcg',
      proxyEndpointsFile: path.resolve(text(e.proxyEndpointsFile, 'unsupported_environment')),
    },
    modelProfile: { phases: { planning, implementing, ...(repair ? { repair } : {}) }, rates },
    budget,
    checkpoints,
    limits,
    signerKeyFile,
    githubApp,
    retentionDays,
    ...(resumeRunId === undefined ? {} : { resumeRunId }),
  };
}

/** Remove derived fields before revalidation or persistence. */
export function runConfigInput(config: RunConfig): Omit<RunConfig, 'upstream'> {
  const { upstream: _upstream, ...input } = config;
  return input;
}
