import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PUBLISHABLE_PACKAGES = [
  'packages/core',
  'packages/worktree-pool',
  'packages/sched',
  'cli',
  'mcp-server',
];

function packagePath(repoRoot, dir) {
  return join(repoRoot, dir, 'package.json');
}

function readPackage(repoRoot, dir) {
  return JSON.parse(readFileSync(packagePath(repoRoot, dir), 'utf8'));
}

function writePackage(repoRoot, dir, pkg) {
  writeFileSync(packagePath(repoRoot, dir), `${JSON.stringify(pkg, null, 2)}\n`);
}

export function nextVersion(version, runNumber) {
  if (!/^\d+(?:\.\d+)*$/.test(String(runNumber))) {
    throw new Error(
      `GitHub run identifier must contain only numeric segments, got ${String(runNumber)}.`
    );
  }

  const stableVersion = version.split('-', 1)[0];
  if (!/^\d+\.\d+\.\d+$/.test(stableVersion)) {
    throw new Error(`Package version must be MAJOR.MINOR.PATCH, got ${version}.`);
  }

  return `${stableVersion}-next.${runNumber}`;
}

/** Prepare a coherent prerelease cohort without changing committed package manifests. */
export function prepareNextRelease(repoRoot, runNumber) {
  const packages = PUBLISHABLE_PACKAGES.map((dir) => ({ dir, pkg: readPackage(repoRoot, dir) }));
  const nextVersions = new Map(
    packages.map(({ pkg }) => [pkg.name, nextVersion(pkg.version, runNumber)])
  );

  for (const { dir, pkg } of packages) {
    pkg.version = nextVersions.get(pkg.name);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(pkg[field] ?? {})) {
        const next = nextVersions.get(dependency);
        if (next) pkg[field][dependency] = next;
      }
    }
    writePackage(repoRoot, dir, pkg);
  }

  return Object.fromEntries(nextVersions);
}

function main() {
  const runIndex = process.argv.indexOf('--run-number');
  const runNumber = runIndex === -1 ? undefined : process.argv[runIndex + 1];
  if (!runNumber || process.argv.length !== 4) {
    throw new Error(
      'Usage: node scripts/prepare-next-release.mjs --run-number <github-run-number>'
    );
  }

  const versions = prepareNextRelease(resolve(import.meta.dirname, '..'), runNumber);
  for (const [name, version] of Object.entries(versions)) console.log(`${name}@${version}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
