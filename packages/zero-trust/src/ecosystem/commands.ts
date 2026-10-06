/** Typed command plans for the worker. This module only BUILDS argv data; it has no
 * process API. The isolated worker executes plans under the phase's network policy. */
import { validateSourcePath } from '../canonical/export';
import { ENVIRONMENT_ROOT, REPORT_DIR, REPORT_FILE } from '../vm/adapter';
import type { PackageManager } from './detect';

export type CommandPhase = 'provisioning' | 'verification';
/** `package_proxy`: egress only to the enforced package proxy. `none`: no network. */
export type CommandNetwork = 'package_proxy' | 'none';

export interface PlannedCommand {
  readonly id: string;
  readonly phase: CommandPhase;
  readonly network: CommandNetwork;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly required: boolean;
  /** The supervisor gives this command a fresh report directory (`REPORT_DIR`) and
   * classifies it from the junit report it reads back from `REPORT_PATH`. */
  readonly captureReport: boolean;
}
/** Where a test command writes its junit report: inside the supervisor's per-command
 * report directory, outside the repository (vm/adapter `REPORT_DIR`/`REPORT_FILE`). */
export const REPORT_PATH = `${REPORT_DIR}/${REPORT_FILE}`;
export interface CommandPlan {
  readonly manager: PackageManager;
  readonly provisioning: readonly PlannedCommand[];
  readonly verification: readonly PlannedCommand[];
}
export interface ProxyEndpoints {
  /** Verdaccio registry URL on the isolated network, e.g. `http://npm-proxy:4873/`. */
  readonly npmRegistry: string;
  /** proxpi simple index URL on the isolated network, e.g. `http://pypi-proxy:5000/index/`. */
  readonly pypiIndex: string;
}
export interface PlanOptions {
  /** Controller-chosen test paths (e.g. the regression test); default: whole suite. */
  readonly testTargets?: readonly string[];
  readonly provisioningTimeoutMs?: number;
  readonly verificationTimeoutMs?: number;
  /** The profile image's interpreter (absolute). Default: the devcontainer location. */
  readonly python?: string;
  /** Python environment directory OUTSIDE the repository (absolute). */
  readonly environmentDir?: string;
  /** uv only: where the lock is exported as hashed requirements, OUTSIDE the repository. */
  readonly exportFile?: string;
  /** Where test commands write junit (absolute; default `REPORT_PATH`, the VM supervisor's). */
  readonly reportFile?: string;
}

export type PlanField =
  | 'npmRegistry'
  | 'pypiIndex'
  | 'testTargets'
  | 'provisioningTimeoutMs'
  | 'verificationTimeoutMs'
  | 'python'
  | 'environmentDir'
  | 'exportFile'
  | 'reportFile';
export class CommandPlanError extends Error {
  constructor(
    readonly code: 'invalid_endpoint' | 'invalid_target' | 'invalid_timeout' | 'invalid_path',
    /** Which input was rejected; the value itself is never echoed. */
    readonly field: PlanField
  ) {
    super(`Zero-trust command plan rejected: ${code} (${field})`);
    this.name = 'CommandPlanError';
  }
}

const DEFAULT_PROVISIONING_MS = 10 * 60 * 1000;
const DEFAULT_VERIFICATION_MS = 15 * 60 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_PYTHON = '/usr/local/bin/python';
const DEFAULT_ENVIRONMENT = `${ENVIRONMENT_ROOT}/env`;
const DEFAULT_EXPORT = `${ENVIRONMENT_ROOT}/uv-requirements.txt`;
/** Test runners write junit to the supervisor's report path. Node's test runner takes
 * reporters from NODE_OPTIONS whatever `scripts.test` says; pytest from PYTEST_ADDOPTS.
 * A runner that ignores them writes no report, which is inconclusive, never a pass. */
const nodeReportEnv = (file: string) =>
  Object.freeze({
    NODE_OPTIONS: `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${file}`,
  });
const pytestReportEnv = (file: string) => Object.freeze({ PYTEST_ADDOPTS: `--junitxml=${file}` });
const ABSOLUTE_PATH = /^(\/[A-Za-z0-9._-]+)+$/;
/** Offline phases must not discover a network path through tool defaults. */
const OFFLINE_ENV = Object.freeze({
  npm_config_offline: 'true',
  PIP_NO_INDEX: '1',
  UV_OFFLINE: '1',
  NO_PROXY: '*',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
});

function endpoint(url: string, field: PlanField): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CommandPlanError('invalid_endpoint', field);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !parsed.pathname.endsWith('/')
  )
    throw new CommandPlanError('invalid_endpoint', field);
  return parsed.href;
}

function absolutePath(value: string, field: PlanField): string {
  if (!ABSOLUTE_PATH.test(value) || value.split('/').some((p) => p === '.' || p === '..'))
    throw new CommandPlanError('invalid_path', field);
  return value;
}

function timeout(value: number | undefined, fallback: number, field: PlanField): number {
  const ms = value ?? fallback;
  if (!Number.isSafeInteger(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS)
    throw new CommandPlanError('invalid_timeout', field);
  return ms;
}

function targets(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((target) => {
    try {
      validateSourcePath(target);
    } catch {
      throw new CommandPlanError('invalid_target', 'testTargets');
    }
    // An argv entry starting with `-` would be parsed as an option, not a path.
    if (target.startsWith('-')) throw new CommandPlanError('invalid_target', 'testTargets');
    return target;
  });
}

function command(
  id: string,
  phase: CommandPhase,
  argv: string[],
  env: Record<string, string>,
  timeoutMs: number,
  report?: Readonly<Record<string, string>>
): PlannedCommand {
  return Object.freeze({
    id,
    phase,
    network: phase === 'provisioning' ? 'package_proxy' : 'none',
    argv: Object.freeze(argv),
    env: Object.freeze(
      phase === 'provisioning' ? env : { ...env, ...(report ?? {}), ...OFFLINE_ENV }
    ),
    timeoutMs,
    required: true,
    captureReport: report !== undefined,
  });
}

interface PlanContext {
  readonly npmRegistry: string;
  readonly pypiIndex: string;
  readonly tests: readonly string[];
  readonly python: string;
  readonly environment: string;
  readonly exportFile: string;
  readonly reportFile: string;
  readonly provisionMs: number;
  readonly verifyMs: number;
}
type Phases = Pick<CommandPlan, 'provisioning' | 'verification'>;

function npmPlan(c: PlanContext): Phases {
  const env = {
    npm_config_registry: c.npmRegistry,
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
  };
  const test = c.tests.length ? ['npm', 'test', '--', ...c.tests] : ['npm', 'test'];
  return {
    provisioning: [
      command(
        'npm-ci',
        'provisioning',
        ['npm', 'ci', '--ignore-scripts', '--no-fund'],
        env,
        c.provisionMs
      ),
    ],
    verification: [
      command('npm-rebuild', 'verification', ['npm', 'rebuild'], env, c.verifyMs),
      command('npm-test', 'verification', test, env, c.verifyMs, nodeReportEnv(c.reportFile)),
    ],
  };
}

/** The venv lives in a controller-chosen directory outside the repository, and the
 * provisioning interpreter runs isolated (`-I`), so a committed `.venv`, `venv.py`,
 * `pip.py` or `.pth` file cannot run while the package proxy is reachable. */
function pipPlan(c: PlanContext): Phases {
  const env: Record<string, string> = {
    PIP_INDEX_URL: c.pypiIndex,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_CONFIG_FILE: '/dev/null',
  };
  // pip ignores a plain-HTTP index unless its host is trusted. The mirror sits on the
  // isolated provisioning network; artifact integrity comes from --require-hashes.
  const index = new URL(c.pypiIndex);
  if (index.protocol === 'http:') env.PIP_TRUSTED_HOST = index.hostname;
  const venvPython = `${c.environment}/bin/python`;
  return {
    provisioning: [
      command(
        'venv',
        'provisioning',
        [c.python, '-I', '-m', 'venv', '--clear', c.environment],
        env,
        c.provisionMs
      ),
      command(
        'pip-install',
        'provisioning',
        [
          venvPython,
          '-I',
          '-m',
          'pip',
          'install',
          '--require-hashes',
          '--no-deps',
          '--only-binary=:all:',
          '-r',
          'requirements.txt',
        ],
        env,
        c.provisionMs
      ),
    ],
    verification: [
      command(
        'pytest',
        'verification',
        [venvPython, '-m', 'pytest', ...c.tests],
        env,
        c.verifyMs,
        pytestReportEnv(c.reportFile)
      ),
    ],
  };
}

/** uv ignores repository config (`--no-config`), never downloads an interpreter, uses
 * the profile's interpreter, and keeps its environment outside the repository.
 *
 * Provisioning does NOT use `uv sync --frozen`: that downloads the artifact URLs
 * recorded in `uv.lock` (files.pythonhosted.org) directly and ignores the configured
 * index, so it would bypass the mirror (#1010). Instead the lock is exported offline
 * as hashed requirements and installed from the mirror with every hash enforced. */
function uvPlan(c: PlanContext): Phases {
  const env = {
    UV_DEFAULT_INDEX: c.pypiIndex,
    UV_NO_BUILD: '1',
    UV_PROJECT_ENVIRONMENT: c.environment,
  };
  const noConfig = ['--no-config', '--no-python-downloads'];
  const common = ['--frozen', ...noConfig, '--python', c.python];
  return {
    provisioning: [
      command(
        'uv-export',
        'provisioning',
        [
          'uv',
          'export',
          '--frozen',
          '--offline',
          ...noConfig,
          '--format',
          'requirements.txt',
          '--no-emit-project',
          '--no-header',
          '--output-file',
          c.exportFile,
        ],
        env,
        c.provisionMs
      ),
      command(
        'uv-venv',
        'provisioning',
        ['uv', 'venv', ...noConfig, '--python', c.python, c.environment],
        env,
        c.provisionMs
      ),
      command(
        'uv-install',
        'provisioning',
        [
          'uv',
          'pip',
          'install',
          ...noConfig,
          '--python',
          `${c.environment}/bin/python`,
          '--require-hashes',
          '--no-deps',
          '--only-binary',
          ':all:',
          '--index-url',
          c.pypiIndex,
          '-r',
          c.exportFile,
        ],
        env,
        c.provisionMs
      ),
    ],
    verification: [
      command(
        'pytest',
        'verification',
        ['uv', 'run', ...common, '--offline', '--no-sync', 'pytest', ...c.tests],
        env,
        c.verifyMs,
        pytestReportEnv(c.reportFile)
      ),
    ],
  };
}

const PLANNERS: Readonly<Record<PackageManager, (c: PlanContext) => Phases>> = {
  npm: npmPlan,
  pip: pipPlan,
  uv: uvPlan,
};

/** Builds the plan for a supported manager. Provisioning never runs package lifecycle
 * scripts, sdist builds or repository code with network access; install scripts run
 * later, offline. */
export function buildCommandPlan(
  manager: PackageManager,
  proxy: ProxyEndpoints,
  options: PlanOptions = {}
): CommandPlan {
  const phases = PLANNERS[manager]({
    // Both endpoints are validated whatever the manager: a bad deployment fails closed early.
    npmRegistry: endpoint(proxy.npmRegistry, 'npmRegistry'),
    pypiIndex: endpoint(proxy.pypiIndex, 'pypiIndex'),
    tests: targets(options.testTargets),
    python: absolutePath(options.python ?? DEFAULT_PYTHON, 'python'),
    environment: absolutePath(options.environmentDir ?? DEFAULT_ENVIRONMENT, 'environmentDir'),
    exportFile: absolutePath(options.exportFile ?? DEFAULT_EXPORT, 'exportFile'),
    reportFile: absolutePath(options.reportFile ?? REPORT_PATH, 'reportFile'),
    provisionMs: timeout(
      options.provisioningTimeoutMs,
      DEFAULT_PROVISIONING_MS,
      'provisioningTimeoutMs'
    ),
    verifyMs: timeout(
      options.verificationTimeoutMs,
      DEFAULT_VERIFICATION_MS,
      'verificationTimeoutMs'
    ),
  });
  return Object.freeze({
    manager,
    provisioning: Object.freeze([...phases.provisioning]),
    verification: Object.freeze([...phases.verification]),
  });
}
