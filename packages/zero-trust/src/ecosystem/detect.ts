/** Pure ecosystem detection over source bytes. Nothing is installed or executed:
 * the controller reads files from the exported canonical snapshot. */
import { parse as parseToml } from 'smol-toml';
import type { SourceManifest } from '../canonical/export';
import { assertNoSecrets } from '../redaction';
import { isRecord, ReasonCode } from '../state';
import { pythonArtifactKey } from './proxy';
import { NPM_REGISTRY, NPM_SRI_SHA512, PYPI_SIMPLE, UV_SHA256, uvArtifacts } from './registries';
import { normalizeName, parseHashedRequirements } from './requirements';

export type Ecosystem = 'node' | 'python';
export type PackageManager = 'npm' | 'pip' | 'uv';
/** Root-relative path to UTF-8 text. Only root-level files are consulted. */
export type SourceFiles = ReadonlyMap<string, string>;

export type UnsupportedReason =
  | 'no_supported_ecosystem'
  | 'mixed_ecosystems'
  | 'ambiguous_manager'
  | 'unsupported_manager'
  | 'unsupported_config'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'lockfile_missing'
  | 'lockfile_invalid'
  | 'lockfile_version'
  | 'non_registry_dependency'
  | 'missing_hashes'
  | 'binary_unavailable'
  | 'unpinned_requirement'
  | 'unsupported_requirement_option'
  | 'test_runner_missing';

export type DeclarationSource =
  | 'package.json#engines.node'
  | '.nvmrc'
  | '.node-version'
  | 'pyproject.toml#project.requires-python'
  | '.python-version'
  | 'uv.lock#requires-python';
export interface RuntimeDeclaration {
  readonly source: DeclarationSource;
  readonly value: string;
}

export interface SupportedDetection {
  readonly supported: true;
  readonly ecosystem: Ecosystem;
  readonly manager: PackageManager;
  readonly lockfile: 'package-lock.json' | 'requirements.txt' | 'uv.lock';
  readonly declarations: readonly RuntimeDeclaration[];
}
/** The shared shape of every `unsupported_environment` outcome in this module family. */
export interface UnsupportedEnvironment<R extends string> {
  readonly reasonCode: ReasonCode.UnsupportedEnvironment;
  readonly reason: R;
  /** Bounded identifier (file, field, option or package name); see `safeDetail`. */
  readonly detail?: string;
}
export interface UnsupportedDetection extends UnsupportedEnvironment<UnsupportedReason> {
  readonly supported: false;
}
export type Detection = SupportedDetection | UnsupportedDetection;

const NODE_FILES = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  '.yarnrc.yml',
  'bun.lock',
  'bun.lockb',
];
const PYTHON_FILES = [
  'pyproject.toml',
  'uv.lock',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'poetry.lock',
  'Pipfile',
  'Pipfile.lock',
  'pdm.lock',
];
const UNSUPPORTED_MANAGER_FILES: Readonly<Record<string, string>> = {
  'npm-shrinkwrap.json': 'npm-shrinkwrap',
  'pnpm-lock.yaml': 'pnpm',
  'pnpm-workspace.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  '.yarnrc.yml': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'poetry.lock': 'poetry',
  Pipfile: 'pipenv',
  'Pipfile.lock': 'pipenv',
  'pdm.lock': 'pdm',
};
/** Repository-local tool configuration that can redirect registries, indexes or
 * interpreter downloads. Commands are planned without it, so its presence is unsupported. */
const CONFIG_FILES = ['.npmrc', '.yarnrc', 'pip.conf', 'pip.ini', 'uv.toml'];
/** `[tool.uv]` keys that cannot change where or how packages are fetched. */
const UV_TOOL_KEYS = new Set(['package', 'default-groups']);
const NPM_PACKAGE_MANAGER = /^npm@\d+\.\d+\.\d+(\+sha(256|512)\.[a-f0-9]+)?$/;
const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';
/** npm package names are at most 214 characters; nothing else we echo is longer. */
const DETAIL = /^[A-Za-z0-9@/._+,#-]{1,214}$/;

/** `detail` is bounded and secret-free: repository text outside the narrow identifier
 * alphabet (URLs, credentials, control characters) is dropped, never echoed. */
function safeDetail(detail: string | undefined): string | undefined {
  if (detail === undefined || !DETAIL.test(detail)) return undefined;
  try {
    assertNoSecrets(detail);
    return detail;
  } catch {
    return undefined;
  }
}

export function unsupportedEnvironment<R extends string>(
  reason: R,
  detail?: string
): UnsupportedEnvironment<R> {
  const safe = safeDetail(detail);
  return Object.freeze({
    reasonCode: ReasonCode.UnsupportedEnvironment,
    reason,
    ...(safe === undefined ? {} : { detail: safe }),
  });
}

function unsupported(reason: UnsupportedReason, detail?: string): UnsupportedDetection {
  return Object.freeze({ supported: false, ...unsupportedEnvironment(reason, detail) });
}

/** Decodes the root-level files of an exported canonical snapshot. */
export function sourceFilesFromManifest(manifest: SourceManifest): SourceFiles {
  const files = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (entry.mode !== '040000' && !entry.path.includes('/'))
      files.set(entry.path, Buffer.from(entry.bytes, 'base64').toString('utf8'));
  }
  return files;
}

function supported(
  ecosystem: Ecosystem,
  manager: PackageManager,
  lockfile: SupportedDetection['lockfile'],
  declarations: RuntimeDeclaration[]
): SupportedDetection {
  return Object.freeze({
    supported: true,
    ecosystem,
    manager,
    lockfile,
    declarations: Object.freeze(declarations.map((d) => Object.freeze({ ...d }))),
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseTomlSafe(text: string): Record<string, unknown> | undefined {
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function versionFile(
  files: SourceFiles,
  name: '.nvmrc' | '.node-version' | '.python-version'
): RuntimeDeclaration[] {
  const text = files.get(name);
  if (text === undefined) return [];
  const value = text.split(/\r?\n/)[0]?.trim() ?? '';
  return [{ source: name, value }];
}

/** Classifies the snapshot's root-level files as exactly one supported manager and
 * lockfile, or `unsupported_environment` with a specific reason. Reads text only. */
export function detectEcosystem(files: SourceFiles): Detection {
  const node = NODE_FILES.some((name) => files.has(name));
  const python = PYTHON_FILES.some((name) => files.has(name));
  if (node && python) return unsupported('mixed_ecosystems');
  if (!node && !python) return unsupported('no_supported_ecosystem');
  for (const [name, manager] of Object.entries(UNSUPPORTED_MANAGER_FILES)) {
    if (files.has(name)) return unsupported('unsupported_manager', manager);
  }
  const config = CONFIG_FILES.find((name) => files.has(name));
  if (config !== undefined) return unsupported('unsupported_config', config);
  return node ? detectNpm(files) : detectPython(files);
}

/** `node_modules/a/node_modules/b` is nested; `node_modules/b` is top-level. */
function nestedKey(key: string): boolean {
  return key.indexOf('/node_modules/') > 0;
}

/** Every package npm will fetch must come from the registry with a sha512 integrity. */
function checkNpmLock(lock: Record<string, unknown>): UnsupportedDetection | undefined {
  if (!isRecord(lock.packages)) return unsupported('lockfile_invalid', 'package-lock.json');
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3)
    return unsupported('lockfile_version', 'package-lock.json');
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue;
    if (!isRecord(entry)) return unsupported('lockfile_invalid', 'package-lock.json');
    // A package bundled INSIDE another package's tarball has no fetch of its own. A
    // root-level `inBundle` entry, or one with its own `resolved`, is fetched by npm.
    if (entry.inBundle === true && nestedKey(key) && entry.resolved === undefined) continue;
    if (entry.link === true) return unsupported('non_registry_dependency', key);
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(NPM_REGISTRY))
      return unsupported('non_registry_dependency', key);
    if (typeof entry.integrity !== 'string' || !NPM_SRI_SHA512.test(entry.integrity))
      return unsupported('missing_hashes', key);
  }
  return undefined;
}

function detectNpm(files: SourceFiles): Detection {
  const manifestText = files.get('package.json');
  if (manifestText === undefined) return unsupported('manifest_missing', 'package.json');
  const manifest = parseJson(manifestText);
  if (!isRecord(manifest)) return unsupported('manifest_invalid', 'package.json');
  const packageManager = manifest.packageManager;
  if (
    packageManager !== undefined &&
    (typeof packageManager !== 'string' || !NPM_PACKAGE_MANAGER.test(packageManager))
  ) {
    const name = typeof packageManager === 'string' ? packageManager.split('@')[0] : '';
    return unsupported('unsupported_manager', name || 'packageManager');
  }
  const lockText = files.get('package-lock.json');
  if (lockText === undefined) return unsupported('lockfile_missing', 'package-lock.json');
  const lock = parseJson(lockText);
  if (!isRecord(lock)) return unsupported('lockfile_invalid', 'package-lock.json');
  const rejected = checkNpmLock(lock);
  if (rejected) return rejected;
  const scripts = manifest.scripts;
  const test = isRecord(scripts) ? scripts.test : undefined;
  if (typeof test !== 'string' || test.trim() === '' || test.trim() === NPM_DEFAULT_TEST)
    return unsupported('test_runner_missing', 'scripts.test');
  const declarations: RuntimeDeclaration[] = [];
  const engines = manifest.engines;
  if (isRecord(engines) && engines.node !== undefined) {
    if (typeof engines.node !== 'string')
      return unsupported('manifest_invalid', 'package.json#engines.node');
    declarations.push({ source: 'package.json#engines.node', value: engines.node });
  }
  declarations.push(...versionFile(files, '.nvmrc'), ...versionFile(files, '.node-version'));
  return supported('node', 'npm', 'package-lock.json', declarations);
}

function checkPyproject(pyproject: Record<string, unknown>): UnsupportedDetection | undefined {
  const tool = pyproject.tool;
  if (!isRecord(tool)) return undefined;
  if (isRecord(tool.poetry)) return unsupported('unsupported_manager', 'poetry');
  if (
    tool.uv !== undefined &&
    (!isRecord(tool.uv) || Object.keys(tool.uv).some((key) => !UV_TOOL_KEYS.has(key)))
  )
    return unsupported('unsupported_config', 'pyproject.toml#tool.uv');
  return undefined;
}

function detectPython(files: SourceFiles): Detection {
  let pyproject: Record<string, unknown> | undefined;
  const pyprojectText = files.get('pyproject.toml');
  if (pyprojectText !== undefined) {
    pyproject = parseTomlSafe(pyprojectText);
    if (pyproject === undefined) return unsupported('manifest_invalid', 'pyproject.toml');
    const rejected = checkPyproject(pyproject);
    if (rejected) return rejected;
  }
  const uvLock = files.get('uv.lock');
  const requirements = files.get('requirements.txt');
  if (uvLock !== undefined && requirements !== undefined)
    return unsupported('ambiguous_manager', 'uv.lock,requirements.txt');
  const declarations: RuntimeDeclaration[] = [];
  const project = pyproject?.project;
  if (isRecord(project) && project['requires-python'] !== undefined) {
    if (typeof project['requires-python'] !== 'string')
      return unsupported('manifest_invalid', 'pyproject.toml#project.requires-python');
    declarations.push({
      source: 'pyproject.toml#project.requires-python',
      value: project['requires-python'],
    });
  }
  declarations.push(...versionFile(files, '.python-version'));
  if (uvLock !== undefined) {
    if (pyproject === undefined) return unsupported('manifest_missing', 'pyproject.toml');
    return detectUv(uvLock, declarations);
  }
  if (requirements !== undefined) return detectPip(requirements, declarations);
  return unsupported(
    'lockfile_missing',
    PYTHON_FILES.find((name) => files.has(name))
  );
}

/** One registry package of a uv lock: PyPI-only, every artifact hashed and a PyPI file
 * of THIS name and version (`uv sync --frozen` downloads these exact URLs), and at
 * least one wheel, because provisioning never builds an sdist. */
function checkUvPackage(
  pkg: Record<string, unknown>,
  name: string
): UnsupportedDetection | undefined {
  const source = pkg.source as Record<string, unknown>;
  if (source.registry !== PYPI_SIMPLE) return unsupported('non_registry_dependency', name);
  const artifacts = uvArtifacts(pkg);
  if (
    artifacts.length === 0 ||
    !artifacts.every((a) => isRecord(a) && typeof a.hash === 'string' && UV_SHA256.test(a.hash))
  )
    return unsupported('missing_hashes', name);
  const expected = `${normalizeName(name)}==${String(pkg.version)}`;
  if (
    !artifacts.every(
      (a) => isRecord(a) && typeof a.url === 'string' && pythonArtifactKey(a.url) === expected
    )
  )
    return unsupported('non_registry_dependency', name);
  if (!Array.isArray(pkg.wheels) || pkg.wheels.length === 0)
    return unsupported('binary_unavailable', name);
  return undefined;
}

function detectUv(text: string, declarations: RuntimeDeclaration[]): Detection {
  const lock = parseTomlSafe(text);
  if (lock === undefined || !Array.isArray(lock.package))
    return unsupported('lockfile_invalid', 'uv.lock');
  if (lock.version !== 1) return unsupported('lockfile_version', 'uv.lock');
  let pytest = false;
  for (const pkg of lock.package as unknown[]) {
    if (!isRecord(pkg) || typeof pkg.name !== 'string' || !isRecord(pkg.source))
      return unsupported('lockfile_invalid', 'uv.lock');
    // The project itself is local source; every other package must come from PyPI.
    if (pkg.source.editable === '.' || pkg.source.virtual === '.') continue;
    const rejected = checkUvPackage(pkg, pkg.name);
    if (rejected) return rejected;
    if (normalizeName(pkg.name) === 'pytest') pytest = true;
  }
  if (!pytest) return unsupported('test_runner_missing', 'pytest');
  if (typeof lock['requires-python'] === 'string')
    declarations.push({ source: 'uv.lock#requires-python', value: lock['requires-python'] });
  return supported('python', 'uv', 'uv.lock', declarations);
}

function detectPip(text: string, declarations: RuntimeDeclaration[]): Detection {
  const parsed = parseHashedRequirements(text);
  if (!Array.isArray(parsed)) return unsupported(parsed.reason, parsed.detail);
  if (parsed.length === 0) return unsupported('lockfile_invalid', 'requirements.txt');
  if (!parsed.some((r) => r.name === 'pytest')) return unsupported('test_runner_missing', 'pytest');
  return supported('python', 'pip', 'requirements.txt', declarations);
}
