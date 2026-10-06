import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReasonCode } from '../state';
import type { RuntimeDeclaration, SupportedDetection } from './detect';
import {
  loadProfileRecord,
  PROFILE_MANIFEST,
  ProfileError,
  type ProfileManifest,
  type ProfileSelection,
  profileManifestDigest,
  profileReceiptBinding,
  recordProfileSelection,
  selectProfile,
  validateProfileManifest,
} from './profiles';
import manifestJson from './profiles.json';

const detection = (
  manager: SupportedDetection['manager'],
  declarations: RuntimeDeclaration[]
): SupportedDetection => ({
  supported: true,
  ecosystem: manager === 'npm' ? 'node' : 'python',
  manager,
  lockfile:
    manager === 'npm' ? 'package-lock.json' : manager === 'pip' ? 'requirements.txt' : 'uv.lock',
  declarations,
});
const node = (...values: [RuntimeDeclaration['source'], string][]) =>
  detection(
    'npm',
    values.map(([source, value]) => ({ source, value }))
  );
const py = (...values: [RuntimeDeclaration['source'], string][]) =>
  detection(
    'uv',
    values.map(([source, value]) => ({ source, value }))
  );
const picked = (s: ProfileSelection) => (s.ok ? s.profile.id : `${s.reason}:${s.detail}`);
const ok = (s: ProfileSelection) => {
  if (!s.ok) throw new Error(`unexpected ${s.reason}`);
  return s;
};

const hardening = manifestJson.workerHardening;

describe('profile manifest', () => {
  it('names one VM profile per ecosystem and pins uv by digest (2026.10.1)', () => {
    expect(PROFILE_MANIFEST.manifestVersion).toBe('2026.10.1');
    expect(PROFILE_MANIFEST.workerHardening).toMatchObject({
      recipe: 'ztfc-worker-hardening-v1',
      vmProfiles: ['node-22', 'python-3.13'],
      uv: {
        image: 'ghcr.io/astral-sh/uv',
        imageDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
  });

  it('ships a valid, frozen manifest with digest-pinned images', () => {
    expect(PROFILE_MANIFEST.schemaVersion).toBe('ztfc-profiles-v1');
    expect(Object.isFrozen(PROFILE_MANIFEST.profiles[0])).toBe(true);
    for (const p of PROFILE_MANIFEST.profiles)
      expect(p.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(profileManifestDigest(PROFILE_MANIFEST)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['unknown schema', { ...manifestJson, schemaVersion: 'v0' }],
    [
      'tag instead of digest',
      { ...manifestJson, profiles: [{ ...manifestJson.profiles[0], imageDigest: 'latest' }] },
    ],
    ['extra field', { ...manifestJson, extra: 1 }],
    [
      'duplicate id',
      {
        ...manifestJson,
        profiles: [manifestJson.profiles[0], { ...manifestJson.profiles[1], id: 'node-20' }],
      },
    ],
    [
      'duplicate runtime',
      {
        ...manifestJson,
        profiles: [manifestJson.profiles[0], { ...manifestJson.profiles[0], id: 'other' }],
      },
    ],
    ['no profiles', { ...manifestJson, profiles: [] }],
    [
      'VM profile that is not in the manifest',
      { ...manifestJson, workerHardening: { ...hardening, vmProfiles: ['node-18'] } },
    ],
    [
      'two VM profiles for one ecosystem',
      { ...manifestJson, workerHardening: { ...hardening, vmProfiles: ['node-20', 'node-22'] } },
    ],
    [
      'uv pinned by tag',
      {
        ...manifestJson,
        workerHardening: { ...hardening, uv: { ...hardening.uv, imageDigest: 'latest' } },
      },
    ],
    ['hardening extra field', { ...manifestJson, workerHardening: { ...hardening, sudo: true } }],
    ['no hardening section', { ...manifestJson, workerHardening: undefined }],
  ])('rejects %s', (_name, value) => {
    expect(() => validateProfileManifest(value)).toThrow(ProfileError);
  });
});

describe('selectProfile', () => {
  it.each<[string, SupportedDetection, string]>([
    [
      'engines range picks the newest satisfying runtime',
      node(['package.json#engines.node', '>=20']),
      'node-22',
    ],
    ['major-only .nvmrc with v prefix', node(['.nvmrc', 'v20']), 'node-20'],
    ['caret range', node(['package.json#engines.node', '^20.10.0']), 'node-20'],
    [
      'all declarations must agree',
      node(['package.json#engines.node', '>=20'], ['.node-version', '20']),
      'node-20',
    ],
    [
      'requires-python lower bound',
      py(['pyproject.toml#project.requires-python', '>=3.11']),
      'python-3.13',
    ],
    [
      'requires-python window',
      py(['pyproject.toml#project.requires-python', '>=3.11,<3.13']),
      'python-3.12',
    ],
    ['compatible release', py(['pyproject.toml#project.requires-python', '~=3.11']), 'python-3.13'],
    [
      'compatible release with patch',
      py(['pyproject.toml#project.requires-python', '~=3.12.0']),
      'python-3.12',
    ],
    ['wildcard equality', py(['uv.lock#requires-python', '==3.11.*']), 'python-3.11'],
    [
      'wildcard exclusion',
      py(['pyproject.toml#project.requires-python', '>=3.11, !=3.13.*']),
      'python-3.12',
    ],
    [
      'exclusion of an exact version',
      py(['pyproject.toml#project.requires-python', '!=3.13.5']),
      'python-3.12',
    ],
    [
      'upper bounds',
      py(['pyproject.toml#project.requires-python', '<=3.12.11,>3.11']),
      'python-3.12',
    ],
    ['.python-version prefix', py(['.python-version', '3.12']), 'python-3.12'],
    ['exact .python-version that is supported', py(['.python-version', '3.11.13']), 'python-3.11'],
  ])('%s', (_name, d, expected) => {
    expect(picked(selectProfile(d))).toBe(expected);
  });

  it.each<[string, SupportedDetection, string]>([
    ['no declaration', node(), 'runtime_unspecified:node'],
    [
      'unsupported node version is not substituted',
      node(['.nvmrc', '18']),
      'runtime_version_unsupported:.nvmrc',
    ],
    [
      'exact pin not in the manifest',
      node(['.nvmrc', '20.11.0']),
      'runtime_version_unsupported:.nvmrc',
    ],
    [
      'unsupported python version',
      py(['.python-version', '3.9']),
      'runtime_version_unsupported:.python-version',
    ],
    [
      'future python',
      py(['pyproject.toml#project.requires-python', '>=3.14']),
      'runtime_version_unsupported:pyproject.toml#project.requires-python',
    ],
    [
      'conflicting declarations',
      node(['package.json#engines.node', '>=22'], ['.nvmrc', '20']),
      'runtime_conflict:package.json#engines.node,.nvmrc',
    ],
    ['nvm alias', node(['.nvmrc', 'lts/*']), 'runtime_declaration_invalid:.nvmrc'],
    [
      'pre-release specifier',
      py(['pyproject.toml#project.requires-python', '>=3.12rc1']),
      'runtime_declaration_invalid:pyproject.toml#project.requires-python',
    ],
    [
      'arbitrary equality',
      py(['pyproject.toml#project.requires-python', '===3.12']),
      'runtime_declaration_invalid:pyproject.toml#project.requires-python',
    ],
    [
      'wildcard on an ordering operator',
      py(['pyproject.toml#project.requires-python', '>=3.*']),
      'runtime_declaration_invalid:pyproject.toml#project.requires-python',
    ],
    [
      'single-segment compatible release',
      py(['pyproject.toml#project.requires-python', '~=3']),
      'runtime_declaration_invalid:pyproject.toml#project.requires-python',
    ],
    [
      'interpreter name in .python-version',
      py(['.python-version', 'pypy3.10']),
      'runtime_declaration_invalid:.python-version',
    ],
  ])('%s fails closed', (_name, d, expected) => {
    const s = selectProfile(d);
    expect(picked(s)).toBe(expected);
    expect(s.ok ? null : s.reasonCode).toBe(ReasonCode.UnsupportedEnvironment);
  });

  it('refuses a manager no profile supports', () => {
    const only: ProfileManifest = validateProfileManifest({
      ...manifestJson,
      workerHardening: { ...hardening, vmProfiles: ['node-22'] },
      profiles: manifestJson.profiles.filter((p) => p.ecosystem === 'node'),
    });
    expect(picked(selectProfile(py(['.python-version', '3.12']), only))).toBe(
      'manager_unsupported:uv'
    );
  });
});

describe('per-run profile record', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-profile-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const selection = () => ok(selectProfile(py(['.python-version', '3.12'])));

  it('records the selection once, idempotently, and reloads it after verification', () => {
    const record = recordProfileSelection(dir, 'run-1', selection());
    expect(recordProfileSelection(dir, 'run-1', selection())).toEqual(record);
    expect(fs.statSync(path.join(dir, 'run-1.profile.json')).mode & 0o777).toBe(0o600);
    expect(loadProfileRecord(dir, 'run-1')).toEqual(record);
    expect(record).toMatchObject({
      schemaVersion: 'ztfc-profile-record-v1',
      runId: 'run-1',
      manager: 'uv',
      manifestVersion: PROFILE_MANIFEST.manifestVersion,
      profile: { id: 'python-3.12' },
    });
  });

  it('refuses to change a recorded selection', () => {
    recordProfileSelection(dir, 'run-1', selection());
    const other = ok(selectProfile(py(['.python-version', '3.11'])));
    expect(() => recordProfileSelection(dir, 'run-1', other)).toThrow(
      expect.objectContaining({ code: 'record_mismatch' })
    );
  });

  it('rejects an unsafe run id', () => {
    expect(() => recordProfileSelection(dir, '../x', selection())).toThrow(
      expect.objectContaining({ code: 'invalid_record' })
    );
  });

  it('propagates storage errors that are not a mismatch', () => {
    expect(() => recordProfileSelection(path.join(dir, 'missing'), 'run-1', selection())).toThrow(
      expect.objectContaining({ code: 'ENOENT' })
    );
  });

  it('fails closed when the record is missing, foreign, malformed or tampered', () => {
    expect(() => loadProfileRecord(dir, 'run-1')).toThrow(
      expect.objectContaining({ code: 'record_missing' })
    );
    expect(() => loadProfileRecord(dir, '../x')).toThrow(
      expect.objectContaining({ code: 'invalid_record' })
    );
    recordProfileSelection(dir, 'run-1', selection());
    fs.copyFileSync(path.join(dir, 'run-1.profile.json'), path.join(dir, 'run-2.profile.json'));
    expect(() => loadProfileRecord(dir, 'run-2')).toThrow(
      expect.objectContaining({ code: 'invalid_record' })
    );
    const file = path.join(dir, 'run-1.profile.json');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{');
    expect(() => loadProfileRecord(dir, 'run-1')).toThrow(
      expect.objectContaining({ code: 'invalid_record' })
    );
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), manager: 'yarn' }));
    expect(() => loadProfileRecord(dir, 'run-1')).toThrow(
      expect.objectContaining({ code: 'invalid_record' })
    );
    const tampered = JSON.parse(original);
    tampered.profile.imageDigest = `sha256:${'0'.repeat(64)}`;
    fs.writeFileSync(file, JSON.stringify(tampered));
    expect(() => loadProfileRecord(dir, 'run-1')).toThrow(
      expect.objectContaining({ code: 'profile_changed' })
    );
  });

  it('propagates storage-integrity failures instead of calling them a mismatch', () => {
    recordProfileSelection(dir, 'run-1', selection());
    fs.chmodSync(path.join(dir, 'run-1.profile.json'), 0o644);
    expect(() => recordProfileSelection(dir, 'run-1', selection())).toThrow(
      'Controller storage unavailable'
    );
    expect(() => loadProfileRecord(dir, 'run-1')).toThrow('Controller storage unavailable');
  });

  it('a racing writer that already linked a different record is a mismatch', () => {
    const file = path.join(dir, 'run-1.profile.json');
    const other = ok(selectProfile(py(['.python-version', '3.11'])));
    // Simulate the race: the file appears between the existence check and link(2).
    const link = fs.linkSync;
    const spy = vi.spyOn(fs, 'linkSync').mockImplementationOnce((src, dest) => {
      recordProfileSelection(dir, 'run-1', other);
      return link(src, dest);
    });
    try {
      expect(() => recordProfileSelection(dir, 'run-1', selection())).toThrow(
        expect.objectContaining({ code: 'record_mismatch' })
      );
    } finally {
      spy.mockRestore();
    }
    expect(loadProfileRecord(dir, 'run-1').profile.id).toBe('python-3.11');
    expect(fs.readdirSync(dir)).toEqual(['run-1.profile.json']);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses a record made under a different manifest', () => {
    recordProfileSelection(dir, 'run-1', selection());
    const bumped = validateProfileManifest({ ...manifestJson, manifestVersion: '2026.11.0' });
    expect(() => loadProfileRecord(dir, 'run-1', bumped)).toThrow(
      expect.objectContaining({ code: 'manifest_changed' })
    );
  });

  it('binds the record into the receipt profile fields', () => {
    const record = recordProfileSelection(dir, 'run-1', selection());
    const binding = profileReceiptBinding(record, 'tcg');
    expect(binding.profile).toEqual({
      name: 'python-3.12',
      runtime: 'python@3.12.11',
      imageDigest: record.profile.imageDigest,
      accelerator: 'tcg',
    });
    expect(binding.profileDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(profileReceiptBinding(loadProfileRecord(dir, 'run-1'), 'tcg')).toEqual(binding);
  });
});
