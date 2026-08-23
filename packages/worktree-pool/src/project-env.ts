import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PackageManager, ProjectEnv } from './types';

/**
 * Lockfile names per package manager. The first entry is the canonical
 * lockfile (what `lockfileFor()` returns); later entries are alternates that
 * detection also accepts (bun writes `bun.lockb` or, since 1.2, `bun.lock`).
 */
const LOCKFILES: Record<PackageManager, readonly string[]> = {
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lockb', 'bun.lock'],
  npm: ['package-lock.json'],
};

/** Order in which lockfiles are probed when there is no `packageManager` field. */
const DETECTION_ORDER: readonly PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm'];

/**
 * Install command used when the expected lockfile is present. These are the
 * frozen/immutable variants: a warm worktree should never silently drift from
 * the committed lockfile.
 */
const FROZEN_INSTALL: Record<PackageManager, readonly string[]> = {
  pnpm: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'],
  yarn: ['yarn', 'install', '--immutable'],
  bun: ['bun', 'install'],
  npm: ['npm', 'ci'],
};

/**
 * Install command used when no lockfile exists yet. `npm ci`,
 * `pnpm --frozen-lockfile` and `yarn --immutable` all hard-fail without one,
 * so fall back to a plain install.
 */
const LOOSE_INSTALL: Record<PackageManager, readonly string[]> = {
  pnpm: ['pnpm', 'install', '--prefer-offline'],
  yarn: ['yarn', 'install'],
  bun: ['bun', 'install'],
  npm: ['npm', 'install'],
};

/** Build scripts tried in order; the first one defined in package.json wins. */
const BUILD_SCRIPTS: readonly string[] = ['build:libs', 'build'];

/** The canonical lockfile name for a package manager. */
export function lockfileFor(pm: PackageManager): string {
  return LOCKFILES[pm][0];
}

function isPackageManager(value: string): value is PackageManager {
  return value === 'pnpm' || value === 'yarn' || value === 'bun' || value === 'npm';
}

interface PackageJsonShape {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
}

function readPackageJson(dir: string): PackageJsonShape | null {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as PackageJsonShape;
  } catch {
    // corrupt package.json — treat as absent
    return null;
  }
}

/** Parse the corepack `packageManager` field (`"pnpm@9.1.0"` -> `"pnpm"`). */
function pmFromField(field: unknown): PackageManager | null {
  if (typeof field !== 'string') return null;
  const name = field.trim().split('@')[0].trim().toLowerCase();
  return isPackageManager(name) ? name : null;
}

/** First lockfile that actually exists in `dir`, for the given manager. */
function existingLockfile(dir: string, pm: PackageManager): string | null {
  for (const name of LOCKFILES[pm]) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return null;
}

/**
 * Detect the package manager and warm-up commands for a project directory.
 *
 * Precedence: the `packageManager` field in package.json wins over lockfile
 * probing; probing order is pnpm, yarn, bun, npm; npm is the final fallback.
 */
export function detectProjectEnv(dir: string): ProjectEnv {
  const pkg = readPackageJson(dir);

  let pm = pmFromField(pkg?.packageManager);
  if (!pm) {
    for (const candidate of DETECTION_ORDER) {
      if (existingLockfile(dir, candidate)) {
        pm = candidate;
        break;
      }
    }
  }
  if (!pm) pm = 'npm';

  const found = existingLockfile(dir, pm);
  const lockfile = found ?? lockfileFor(pm);
  const installCmd = [...(found ? FROZEN_INSTALL[pm] : LOOSE_INSTALL[pm])];

  const scripts = pkg?.scripts;
  let buildCmd: string[] | null = null;
  if (scripts && typeof scripts === 'object') {
    for (const script of BUILD_SCRIPTS) {
      if (typeof (scripts as Record<string, unknown>)[script] === 'string') {
        buildCmd = [pm, 'run', script];
        break;
      }
    }
  }

  return { pm, lockfile, installCmd, buildCmd };
}

/**
 * Absolute directory the warm commands run in: the worktree root, or
 * `<worktree>/<project_subdir>` for repos whose package root is nested.
 */
export function resolveProjectDir(worktreeAbsPath: string, projectSubdir?: string): string {
  if (!projectSubdir) return worktreeAbsPath;
  return path.resolve(worktreeAbsPath, projectSubdir);
}

/**
 * Warm commands for a project directory. Explicit `warm_commands` from
 * `.worktree-pool.json` always win over detection; otherwise it is
 * install (+ build, when the project defines one).
 */
export function resolveWarmCommands(
  projectDir: string,
  cfg?: { warm_commands?: string[][] }
): string[][] {
  const explicit = cfg?.warm_commands;
  if (explicit && explicit.length > 0) {
    return explicit.map((cmd) => [...cmd]);
  }
  const env = detectProjectEnv(projectDir);
  return env.buildCmd ? [env.installCmd, env.buildCmd] : [env.installCmd];
}

/**
 * Repo-root-relative path of the lockfile, matching how `git diff --name-only`
 * reports paths (always POSIX separators).
 */
export function lockfilePathFor(env: ProjectEnv, projectSubdir?: string): string {
  if (!projectSubdir) return env.lockfile;
  const normalized = projectSubdir
    .split(path.sep)
    .join('/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') return env.lockfile;
  return `${normalized}/${env.lockfile}`;
}

/** True when `git diff --name-only` output touched the project's lockfile. */
export function lockfileChangedInDiff(diffOutput: string, lockfilePath: string): boolean {
  return diffOutput
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === lockfilePath);
}
