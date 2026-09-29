import { describe, expect, it } from 'vitest';
import {
  assetName,
  expectedAssets,
  isSupportedTarget,
  missingAssets,
  parseVersionOutput,
  releaseTag,
  versionFromTag,
  versionMatches,
} from './sea-platform.mjs';

describe('sea-platform', () => {
  it('names assets per platform/arch, with .exe on windows only', () => {
    expect(assetName('linux', 'x64')).toBe('ai-dossier-linux-x64');
    expect(assetName('darwin', 'arm64')).toBe('ai-dossier-darwin-arm64');
    expect(assetName('win32', 'x64')).toBe('ai-dossier-win32-x64.exe');
  });

  it('rejects unsupported targets', () => {
    expect(isSupportedTarget('win32', 'arm64')).toBe(false);
    expect(() => assetName('freebsd', 'x64')).toThrow(/Unsupported/);
  });

  it('round-trips release tags', () => {
    expect(releaseTag('0.72.0')).toBe('cli-v0.72.0');
    expect(versionFromTag('cli-v0.72.0')).toBe('0.72.0');
    expect(versionFromTag('cli-v1.0.0-rc.1')).toBe('1.0.0-rc.1');
    expect(versionFromTag('v0.72.0')).toBeNull();
    expect(versionFromTag('cli-v1.2')).toBeNull();
  });

  it('checks --version output against the package version', () => {
    expect(parseVersionOutput('0.72.0\n')).toBe('0.72.0');
    expect(parseVersionOutput('ai-dossier 0.72.0')).toBeNull();
    expect(versionMatches('0.72.0\n', '0.72.0')).toBe(true);
    expect(versionMatches('0.71.0\n', '0.72.0')).toBe(false);
  });

  it('reports which release assets are missing', () => {
    expect(expectedAssets()).toHaveLength(6);
    expect(missingAssets(expectedAssets())).toEqual([]);
    expect(missingAssets(['SHA256SUMS', 'ai-dossier-linux-x64'])).toContain(
      'ai-dossier-win32-x64.exe'
    );
  });
});
