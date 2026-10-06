/** Typed command plans for the worker. This module only BUILDS argv data; it has no
 * process API. The isolated worker executes plans under the phase's network policy. */
import { validateSourcePath } from '../canonical/export';
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
}
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
}

export class CommandPlanError extends Error {
  constructor(readonly code: 'invalid_endpoint' | 'invalid_target' | 'invalid_timeout') {
    super(`Zero-trust command plan rejected: ${code}`);
    this.name = 'CommandPlanError';
  }
}

const DEFAULT_PROVISIONING_MS = 10 * 60 * 1000;
const DEFAULT_VERIFICATION_MS = 15 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Offline phases must not discover a network path through tool defaults. */
const OFFLINE_ENV = Object.freeze({
  npm_config_offline: 'true',
  PIP_NO_INDEX: '1',
  UV_OFFLINE: '1',
  NO_PROXY: '*',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
});

function endpoint(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CommandPlanError('invalid_endpoint');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !parsed.pathname.endsWith('/')
  )
    throw new CommandPlanError('invalid_endpoint');
  return parsed.href;
}

function timeout(value: number | undefined, fallback: number): number {
  const ms = value ?? fallback;
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > MAX_TIMEOUT_MS)
    throw new CommandPlanError('invalid_timeout');
  return ms;
}

function targets(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((target) => {
    try {
      validateSourcePath(target);
    } catch {
      throw new CommandPlanError('invalid_target');
    }
    // An argv entry starting with `-` would be parsed as an option, not a path.
    if (target.startsWith('-')) throw new CommandPlanError('invalid_target');
    return target;
  });
}

function command(
  id: string,
  phase: CommandPhase,
  argv: string[],
  env: Record<string, string>,
  timeoutMs: number
): PlannedCommand {
  return Object.freeze({
    id,
    phase,
    network: phase === 'provisioning' ? 'package_proxy' : 'none',
    argv: Object.freeze(argv),
    env: Object.freeze(phase === 'provisioning' ? env : { ...env, ...OFFLINE_ENV }),
    timeoutMs,
    required: true,
  });
}

/** Builds the plan for a supported manager. Provisioning never runs package lifecycle
 * scripts or builds sdists with network access; install scripts run later, offline. */
export function buildCommandPlan(
  manager: PackageManager,
  proxy: ProxyEndpoints,
  options: PlanOptions = {}
): CommandPlan {
  const provisionMs = timeout(options.provisioningTimeoutMs, DEFAULT_PROVISIONING_MS);
  const verifyMs = timeout(options.verificationTimeoutMs, DEFAULT_VERIFICATION_MS);
  const tests = targets(options.testTargets);
  // Both endpoints are validated whatever the manager: a bad deployment fails closed early.
  const npmRegistry = endpoint(proxy.npmRegistry);
  const pypiIndex = endpoint(proxy.pypiIndex);
  let provisioning: PlannedCommand[];
  let verification: PlannedCommand[];
  if (manager === 'npm') {
    const env = { npm_config_registry: npmRegistry, npm_config_audit: 'false' };
    provisioning = [
      command(
        'npm-ci',
        'provisioning',
        ['npm', 'ci', '--ignore-scripts', '--no-fund'],
        env,
        provisionMs
      ),
    ];
    verification = [
      command('npm-rebuild', 'verification', ['npm', 'rebuild'], env, verifyMs),
      command(
        'npm-test',
        'verification',
        tests.length ? ['npm', 'test', '--', ...tests] : ['npm', 'test'],
        env,
        verifyMs
      ),
    ];
  } else if (manager === 'pip') {
    const env = { PIP_INDEX_URL: pypiIndex, PIP_DISABLE_PIP_VERSION_CHECK: '1' };
    provisioning = [
      command('venv', 'provisioning', ['python', '-m', 'venv', '.venv'], env, provisionMs),
      command(
        'pip-install',
        'provisioning',
        [
          '.venv/bin/python',
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
        provisionMs
      ),
    ];
    verification = [
      command(
        'pytest',
        'verification',
        ['.venv/bin/python', '-m', 'pytest', ...tests],
        env,
        verifyMs
      ),
    ];
  } else {
    const env = { UV_DEFAULT_INDEX: pypiIndex, UV_NO_BUILD: '1' };
    provisioning = [
      command(
        'uv-sync',
        'provisioning',
        ['uv', 'sync', '--frozen', '--no-build'],
        env,
        provisionMs
      ),
    ];
    verification = [
      command(
        'pytest',
        'verification',
        ['uv', 'run', '--frozen', '--offline', '--no-sync', 'pytest', ...tests],
        env,
        verifyMs
      ),
    ];
  }
  return Object.freeze({
    manager,
    provisioning: Object.freeze(provisioning),
    verification: Object.freeze(verification),
  });
}
