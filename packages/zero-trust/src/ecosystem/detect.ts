/** Pure ecosystem detection over source bytes. Nothing is installed or executed:
 * the controller reads files from the exported canonical snapshot. */
import { parse as parseToml } from 'smol-toml';
import type { SourceManifest } from '../canonical/export';
import { ReasonCode } from '../state';

export type Ecosystem = 'node' | 'python';
export type PackageManager = 'npm' | 'pip' | 'uv';
/** Root-relative path to UTF-8 text. Only root-level files are consulted. */
export type SourceFiles = ReadonlyMap<string, string>;

export type UnsupportedReason =
  | 'no_supported_ecosystem'
  | 'mixed_ecosystems'
  | 'ambiguous_manager'
  | 'unsupported_manager'
  | 'manifest_invalid'
  | 'lockfile_missing'
  | 'lockfile_invalid'
  | 'lockfile_version'
  | 'non_registry_dependency'
  | 'missing_hashes'
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
export interface UnsupportedDetection {
  readonly supported: false;
  readonly reasonCode: ReasonCode.UnsupportedEnvironment;
  readonly reason: UnsupportedReason;
  /** Bounded, controller-generated detail (a file, option or package name). */
  readonly detail?: string;
}
export type Detection = SupportedDetection | UnsupportedDetection;

export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const PYPI_SIMPLE = 'https://pypi.org/simple';

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
const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';
const SHA256_HASH = /^--hash=sha256:[a-f0-9]{64}$/;
const PEP503_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Decodes the root-level files of an exported canonical snapshot. */
export function sourceFilesFromManifest(manifest: SourceManifest): SourceFiles {
  const files = new Map<string, string>();
  for (const entry of manifest.entries) {
    if (entry.mode !== '040000' && !entry.path.includes('/'))
      files.set(entry.path, Buffer.from(entry.bytes, 'base64').toString('utf8'));
  }
  return files;
}

function unsupported(reason: UnsupportedReason, detail?: string): UnsupportedDetection {
  return Object.freeze({
    supported: false,
    reasonCode: ReasonCode.UnsupportedEnvironment,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function detectEcosystem(files: SourceFiles): Detection {
  const node = NODE_FILES.some((name) => files.has(name));
  const python = PYTHON_FILES.some((name) => files.has(name));
  if (node && python) return unsupported('mixed_ecosystems');
  if (!node && !python) return unsupported('no_supported_ecosystem');
  for (const [name, manager] of Object.entries(UNSUPPORTED_MANAGER_FILES)) {
    if (files.has(name)) return unsupported('unsupported_manager', manager);
  }
  return node ? detectNpm(files) : detectPython(files);
}

function detectNpm(files: SourceFiles): Detection {
  const manifestText = files.get('package.json');
  if (manifestText === undefined) return unsupported('manifest_invalid', 'package.json');
  const manifest = parseJson(manifestText);
  if (!isObject(manifest)) return unsupported('manifest_invalid', 'package.json');
  const packageManager = manifest.packageManager;
  if (packageManager !== undefined) {
    const name = typeof packageManager === 'string' ? packageManager.split('@')[0] : '';
    if (name !== 'npm') return unsupported('unsupported_manager', name || 'packageManager');
  }
  const lockText = files.get('package-lock.json');
  if (lockText === undefined) return unsupported('lockfile_missing', 'package-lock.json');
  const lock = parseJson(lockText);
  if (!isObject(lock) || !isObject(lock.packages))
    return unsupported('lockfile_invalid', 'package-lock.json');
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3)
    return unsupported('lockfile_version', 'package-lock.json');
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '') continue;
    if (!isObject(entry)) return unsupported('lockfile_invalid', 'package-lock.json');
    // Workspace links are local source; bundled packages ship inside their parent tarball.
    if (entry.link === true || entry.inBundle === true) continue;
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(NPM_REGISTRY))
      return unsupported('non_registry_dependency', key);
    if (
      typeof entry.integrity !== 'string' ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)
    )
      return unsupported('missing_hashes', key);
  }
  const scripts = manifest.scripts;
  const test = isObject(scripts) ? scripts.test : undefined;
  if (typeof test !== 'string' || test.trim() === '' || test.trim() === NPM_DEFAULT_TEST)
    return unsupported('test_runner_missing', 'scripts.test');
  const declarations: RuntimeDeclaration[] = [];
  const engines = manifest.engines;
  if (isObject(engines) && engines.node !== undefined) {
    if (typeof engines.node !== 'string')
      return unsupported('manifest_invalid', 'package.json#engines.node');
    declarations.push({ source: 'package.json#engines.node', value: engines.node });
  }
  declarations.push(...versionFile(files, '.nvmrc'), ...versionFile(files, '.node-version'));
  return supported('node', 'npm', 'package-lock.json', declarations);
}

function detectPython(files: SourceFiles): Detection {
  let pyproject: Record<string, unknown> | undefined;
  const pyprojectText = files.get('pyproject.toml');
  if (pyprojectText !== undefined) {
    pyproject = parseTomlSafe(pyprojectText);
    if (pyproject === undefined) return unsupported('manifest_invalid', 'pyproject.toml');
    const tool = pyproject.tool;
    if (isObject(tool) && isObject(tool.poetry))
      return unsupported('unsupported_manager', 'poetry');
  }
  const hasUv = files.has('uv.lock');
  const hasRequirements = files.has('requirements.txt');
  if (hasUv && hasRequirements) return unsupported('ambiguous_manager', 'uv.lock,requirements.txt');
  const declarations: RuntimeDeclaration[] = [];
  const project = pyproject?.project;
  if (isObject(project) && project['requires-python'] !== undefined) {
    if (typeof project['requires-python'] !== 'string')
      return unsupported('manifest_invalid', 'pyproject.toml#project.requires-python');
    declarations.push({
      source: 'pyproject.toml#project.requires-python',
      value: project['requires-python'],
    });
  }
  declarations.push(...versionFile(files, '.python-version'));
  if (hasUv) return detectUv(files, pyproject, declarations);
  if (hasRequirements) return detectPip(files.get('requirements.txt') as string, declarations);
  return unsupported('lockfile_missing', pyproject ? 'pyproject.toml' : 'setup.py');
}

function detectUv(
  files: SourceFiles,
  pyproject: Record<string, unknown> | undefined,
  declarations: RuntimeDeclaration[]
): Detection {
  if (pyproject === undefined) return unsupported('manifest_invalid', 'pyproject.toml');
  const lock = parseTomlSafe(files.get('uv.lock') as string);
  if (lock === undefined || !Array.isArray(lock.package))
    return unsupported('lockfile_invalid', 'uv.lock');
  if (lock.version !== 1) return unsupported('lockfile_version', 'uv.lock');
  let pytest = false;
  for (const pkg of lock.package as unknown[]) {
    if (!isObject(pkg) || typeof pkg.name !== 'string' || !isObject(pkg.source))
      return unsupported('lockfile_invalid', 'uv.lock');
    const source = pkg.source;
    // The project itself is local source; every other package must come from PyPI.
    if (source.editable === '.' || source.virtual === '.') continue;
    if (source.registry !== PYPI_SIMPLE) return unsupported('non_registry_dependency', pkg.name);
    const artifacts = [...(isObject(pkg.sdist) ? [pkg.sdist] : []), ...asArray(pkg.wheels)];
    if (
      artifacts.length === 0 ||
      !artifacts.every(
        (a) =>
          isObject(a) &&
          typeof a.url === 'string' &&
          typeof a.hash === 'string' &&
          /^sha256:[a-f0-9]{64}$/.test(a.hash)
      )
    )
      return unsupported('missing_hashes', pkg.name);
    if (normalizeName(pkg.name) === 'pytest') pytest = true;
  }
  if (!pytest) return unsupported('test_runner_missing', 'pytest');
  if (typeof lock['requires-python'] === 'string')
    declarations.push({ source: 'uv.lock#requires-python', value: lock['requires-python'] });
  return supported('python', 'uv', 'uv.lock', declarations);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** PEP 503 normalization. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export interface PinnedRequirement {
  readonly name: string;
  readonly version: string;
  readonly hashes: readonly string[];
}

/** Parses a fully pinned, hash-locked requirements file (`pip install --require-hashes`).
 * Any include, index, URL or unpinned line is rejected rather than interpreted. */
export function parseHashedRequirements(text: string): PinnedRequirement[] | UnsupportedDetection {
  const requirements: PinnedRequirement[] = [];
  const logical = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const raw of logical) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') continue;
    if (line.startsWith('-')) {
      if (line === '--require-hashes') continue;
      return unsupported('unsupported_requirement_option', line.split(/[\s=]/)[0]);
    }
    const tokens = line.split(/\s+/);
    const hashAt = tokens.findIndex((t) => t.startsWith('-'));
    const spec = (hashAt === -1 ? tokens : tokens.slice(0, hashAt)).join(' ');
    const options = hashAt === -1 ? [] : tokens.slice(hashAt);
    const requirement = spec.split(';')[0].trim();
    if (requirement.includes('@') || requirement.includes('://'))
      return unsupported('non_registry_dependency', requirement.split(/[\s@]/)[0]);
    const match =
      /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9._,\s-]*\])?\s*==\s*([A-Za-z0-9.+!-]+)$/.exec(
        requirement
      );
    if (!match || !PEP503_NAME.test(match[1]))
      return unsupported('unpinned_requirement', requirement.split(/[\s<>=!~[]/)[0] || line);
    const bad = options.find((o) => !SHA256_HASH.test(o));
    if (bad !== undefined) return unsupported('unsupported_requirement_option', bad.split('=')[0]);
    if (options.length === 0) return unsupported('missing_hashes', match[1]);
    requirements.push(
      Object.freeze({
        name: normalizeName(match[1]),
        version: match[2],
        hashes: Object.freeze(options.map((o) => o.slice('--hash=sha256:'.length))),
      })
    );
  }
  return requirements;
}

function detectPip(text: string, declarations: RuntimeDeclaration[]): Detection {
  const parsed = parseHashedRequirements(text);
  if (!Array.isArray(parsed)) return parsed;
  if (parsed.length === 0) return unsupported('lockfile_invalid', 'requirements.txt');
  if (!parsed.some((r) => r.name === 'pytest')) return unsupported('test_runner_missing', 'pytest');
  return supported('python', 'pip', 'requirements.txt', declarations);
}
