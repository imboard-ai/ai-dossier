// Pure helpers shared by build-sea.mjs and the build-binaries workflow: platform
// detection, release asset naming, and version checks. install.sh mirrors the same
// naming table (scripts/install-sh.test.mjs keeps the two in sync).

export const TARGETS = [
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
];

export function isSupportedTarget(platform, arch) {
  return TARGETS.some((t) => t.platform === platform && t.arch === arch);
}

/** Release asset name, e.g. `ai-dossier-linux-x64` or `ai-dossier-win32-x64.exe`. */
export function assetName(platform, arch) {
  if (!isSupportedTarget(platform, arch)) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return `ai-dossier-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

export function releaseTag(version) {
  return `cli-v${version}`;
}

/** `cli-v1.2.3` -> `1.2.3`; null when the tag is not a cli release tag. */
export function versionFromTag(tag) {
  const m = /^cli-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  return m ? m[1] : null;
}

/** Extract the version from `--version` output; the CLI prints the bare semver. */
export function parseVersionOutput(output) {
  const m = /^\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(output);
  return m ? m[1] : null;
}

export function versionMatches(output, expected) {
  return parseVersionOutput(output) === expected;
}

/** Assets a complete release must carry (binaries + checksum manifest). */
export function expectedAssets() {
  return [...TARGETS.map((t) => assetName(t.platform, t.arch)), 'SHA256SUMS'];
}

export function missingAssets(present) {
  const have = new Set(present);
  return expectedAssets().filter((a) => !have.has(a));
}
