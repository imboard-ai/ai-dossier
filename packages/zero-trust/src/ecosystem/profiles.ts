/** Versioned runtime profile manifest. Selection never substitutes a version the
 * project did not ask for; the selected profile is recorded once per run. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import semver from 'semver';
import { sha256 } from '../canonical/export';
import { readPrivate, syncDirectory } from '../durable-fs';
import { canonicalJson, snapshotJson } from '../receipt/schema';
import type { Accelerator } from '../vm/adapter';
import {
  type Ecosystem,
  type PackageManager,
  type RuntimeDeclaration,
  type SupportedDetection,
  type UnsupportedEnvironment,
  unsupportedEnvironment,
} from './detect';
import manifestJson from './profiles.json';

export const PROFILE_MANIFEST_VERSION = 'ztfc-profiles-v1' as const;
export const PROFILE_RECORD_VERSION = 'ztfc-profile-record-v1' as const;

export interface RuntimeProfile {
  readonly id: string;
  readonly ecosystem: Ecosystem;
  readonly runtimeVersion: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly managers: readonly PackageManager[];
}
export interface ProfileManifest {
  readonly schemaVersion: typeof PROFILE_MANIFEST_VERSION;
  readonly manifestVersion: string;
  readonly profiles: readonly RuntimeProfile[];
}

export type ProfileErrorCode =
  | 'invalid_manifest'
  /** No record was ever written for this run. */
  | 'record_missing'
  /** A record exists but is not a valid record for this run. */
  | 'invalid_record'
  /** A different selection is already recorded for this run. */
  | 'record_mismatch'
  /** The trusted manifest changed since the record was made (e.g. a profiles.json edit). */
  | 'manifest_changed'
  /** The recorded profile (image, version) differs from the manifest's entry. */
  | 'profile_changed';
export class ProfileError extends Error {
  constructor(readonly code: ProfileErrorCode) {
    super(`Zero-trust profile rejected: ${code}`);
    this.name = 'ProfileError';
  }
}

const RUNTIME_VERSION = { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' };
const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'ecosystem', 'runtimeVersion', 'image', 'imageDigest', 'managers'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]{0,63}$' },
    ecosystem: { enum: ['node', 'python'] },
    runtimeVersion: RUNTIME_VERSION,
    image: { type: 'string', pattern: '^[a-z0-9.-]+(?::\\d+)?(?:/[a-z0-9._-]+)+$' },
    imageDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    managers: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: ['npm', 'pip', 'uv'] },
    },
  },
};
const MANIFEST_VERSION = { type: 'string', pattern: '^\\d{4}\\.\\d{1,2}\\.\\d+$' };
const MANIFEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'manifestVersion', 'profiles'],
  properties: {
    schemaVersion: { const: PROFILE_MANIFEST_VERSION },
    manifestVersion: MANIFEST_VERSION,
    profiles: { type: 'array', minItems: 1, maxItems: 64, items: PROFILE_SCHEMA },
  },
};
const RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'runId',
    'manifestVersion',
    'manifestDigest',
    'manager',
    'profile',
    'declarations',
  ],
  properties: {
    schemaVersion: { const: PROFILE_RECORD_VERSION },
    runId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
    manifestVersion: MANIFEST_VERSION,
    manifestDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    manager: { enum: ['npm', 'pip', 'uv'] },
    profile: PROFILE_SCHEMA,
    declarations: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'value'],
        properties: {
          source: {
            enum: [
              'package.json#engines.node',
              '.nvmrc',
              '.node-version',
              'pyproject.toml#project.requires-python',
              '.python-version',
              'uv.lock#requires-python',
            ],
          },
          value: { type: 'string', maxLength: 256 },
        },
      },
    },
  },
};
const ajv = new Ajv({ allErrors: false, strict: true });
const isManifestShape = ajv.compile<ProfileManifest>(MANIFEST_SCHEMA);
const isRecordShape = ajv.compile<ProfileRecord>(RECORD_SCHEMA);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Validates a manifest (schema, unique ids, one profile per ecosystem/runtime). */
export function validateProfileManifest(value: unknown): ProfileManifest {
  if (!isManifestShape(value)) throw new ProfileError('invalid_manifest');
  const manifest = snapshotJson(value);
  const ids = new Set<string>();
  const runtimes = new Set<string>();
  for (const profile of manifest.profiles) {
    const runtime = `${profile.ecosystem}@${profile.runtimeVersion}`;
    if (ids.has(profile.id) || runtimes.has(runtime)) throw new ProfileError('invalid_manifest');
    ids.add(profile.id);
    runtimes.add(runtime);
  }
  return deepFreeze(manifest);
}

/** The repository's current, validated profile manifest. */
export const PROFILE_MANIFEST: ProfileManifest = validateProfileManifest(manifestJson);

/** SHA-256 of the canonical manifest JSON. Any manifest change invalidates existing
 * profile records (`manifest_changed`), so in-flight runs re-select. */
export function profileManifestDigest(manifest: ProfileManifest): string {
  return sha256(canonicalJson(manifest));
}

export type SelectionFailure =
  | 'runtime_unspecified'
  | 'runtime_declaration_invalid'
  | 'runtime_version_unsupported'
  | 'runtime_conflict'
  | 'manager_unsupported';
export type ProfileSelection =
  | {
      readonly ok: true;
      readonly profile: RuntimeProfile;
      readonly manager: PackageManager;
      readonly manifestVersion: string;
      readonly manifestDigest: string;
      readonly declarations: readonly RuntimeDeclaration[];
    }
  | ({ readonly ok: false } & UnsupportedEnvironment<SelectionFailure>);

type Matcher = (runtimeVersion: string) => boolean;

/** Node declarations are npm semver ranges (`.nvmrc` may carry a leading `v`). */
function nodeRangeMatcher(value: string): Matcher | undefined {
  const range = semver.validRange(value.trim().replace(/^v(?=\d)/, ''));
  return range === null ? undefined : (v) => semver.satisfies(v, range);
}

function tuple(text: string): number[] {
  return text.split('.').map(Number);
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function prefixMatch(runtime: number[], prefix: number[]): boolean {
  return prefix.every((part, i) => runtime[i] === part);
}

/** `.python-version`: a bare `X[.Y[.Z]]` prefix of the runtime version. */
function pythonVersionFileMatcher(value: string): Matcher | undefined {
  if (!/^\d+(\.\d+){0,2}$/.test(value.trim())) return undefined;
  const prefix = tuple(value.trim());
  return (v) => prefixMatch(tuple(v), prefix);
}

type Pep440Operator = '~=' | '==' | '!=' | '<=' | '>=' | '<' | '>';

function pep440Clause(op: Pep440Operator, spec: number[], wildcard: boolean): Matcher {
  return (v) => {
    const rt = tuple(v);
    const c = compare(rt, spec);
    switch (op) {
      case '==':
        return wildcard ? prefixMatch(rt, spec) : c === 0;
      case '!=':
        return wildcard ? !prefixMatch(rt, spec) : c !== 0;
      case '<=':
        return c <= 0;
      case '>=':
        return c >= 0;
      case '<':
        return c < 0;
      case '>':
        return c > 0;
      case '~=':
        return c >= 0 && prefixMatch(rt, spec.slice(0, -1));
    }
  };
}

/** A deliberately narrow PEP 440 specifier subset for `X[.Y[.Z]]` runtime versions.
 * Anything outside it (pre-releases, `===`, local versions) is invalid, never guessed. */
function pep440SpecifierMatcher(value: string): Matcher | undefined {
  const matchers: Matcher[] = [];
  for (const clause of value.split(',').map((c) => c.trim())) {
    const m = /^(~=|==|!=|<=|>=|<|>)\s*(\d+(?:\.\d+){0,2})(\.\*)?$/.exec(clause);
    if (!m) return undefined;
    const op = m[1] as Pep440Operator;
    const spec = tuple(m[2]);
    const wildcard = m[3] !== undefined;
    if (wildcard && op !== '==' && op !== '!=') return undefined;
    if (op === '~=' && spec.length < 2) return undefined;
    matchers.push(pep440Clause(op, spec, wildcard));
  }
  return (v) => matchers.every((m) => m(v));
}

function matcherFor(declaration: RuntimeDeclaration): Matcher | undefined {
  switch (declaration.source) {
    case 'package.json#engines.node':
    case '.nvmrc':
    case '.node-version':
      return nodeRangeMatcher(declaration.value);
    case '.python-version':
      return pythonVersionFileMatcher(declaration.value);
    case 'pyproject.toml#project.requires-python':
    case 'uv.lock#requires-python':
      return pep440SpecifierMatcher(declaration.value);
  }
}

function fail(reason: SelectionFailure, detail?: string): ProfileSelection {
  return Object.freeze({ ok: false, ...unsupportedEnvironment(reason, detail) });
}

/** Picks the newest supported runtime that satisfies EVERY project declaration.
 * Missing, unparseable, unsupported or mutually exclusive declarations fail closed. */
export function selectProfile(
  detection: SupportedDetection,
  manifest: ProfileManifest = PROFILE_MANIFEST
): ProfileSelection {
  const candidates = manifest.profiles.filter(
    (p) => p.ecosystem === detection.ecosystem && p.managers.includes(detection.manager)
  );
  if (candidates.length === 0) return fail('manager_unsupported', detection.manager);
  if (detection.declarations.length === 0) return fail('runtime_unspecified', detection.ecosystem);
  let remaining = candidates;
  for (const declaration of detection.declarations) {
    const matcher = matcherFor(declaration);
    if (matcher === undefined) return fail('runtime_declaration_invalid', declaration.source);
    if (!candidates.some((p) => matcher(p.runtimeVersion)))
      return fail('runtime_version_unsupported', declaration.source);
    remaining = remaining.filter((p) => matcher(p.runtimeVersion));
  }
  if (remaining.length === 0)
    return fail('runtime_conflict', detection.declarations.map((d) => d.source).join(','));
  const profile = [...remaining].sort((a, b) =>
    compare(tuple(b.runtimeVersion), tuple(a.runtimeVersion))
  )[0];
  return Object.freeze({
    ok: true,
    profile,
    manager: detection.manager,
    manifestVersion: manifest.manifestVersion,
    manifestDigest: profileManifestDigest(manifest),
    declarations: detection.declarations,
  });
}

export interface ProfileRecord {
  readonly schemaVersion: typeof PROFILE_RECORD_VERSION;
  readonly runId: string;
  readonly manifestVersion: string;
  readonly manifestDigest: string;
  readonly manager: PackageManager;
  readonly profile: RuntimeProfile;
  readonly declarations: readonly RuntimeDeclaration[];
}

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

function recordFile(directory: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new ProfileError('invalid_record');
  return path.join(directory, `${runId}.profile.json`);
}

function readExisting(file: string): Buffer | undefined {
  try {
    return readPrivate(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Write-once publication without a lock: the record is linked into place with
 * `link(2)`, which fails atomically if another writer got there first. Identical
 * bytes are idempotent; different bytes are `record_mismatch`; storage errors propagate. */
function publishOnce(file: string, bytes: Buffer): void {
  const existing = readExisting(file);
  if (existing !== undefined) {
    if (!existing.equals(bytes)) throw new ProfileError('record_mismatch');
    return;
  }
  const directory = path.dirname(file);
  const tmp = path.join(directory, `.zt-profile-${randomUUID()}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.linkSync(tmp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!fs.readFileSync(file).equals(bytes)) throw new ProfileError('record_mismatch');
  } finally {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
  syncDirectory(directory);
}

/** Records the run's selected profile in controller-owned storage. The record is
 * immutable: re-recording the identical selection is idempotent, anything else throws. */
export function recordProfileSelection(
  directory: string,
  runId: string,
  selection: Extract<ProfileSelection, { ok: true }>
): ProfileRecord {
  const record: ProfileRecord = {
    schemaVersion: PROFILE_RECORD_VERSION,
    runId,
    manifestVersion: selection.manifestVersion,
    manifestDigest: selection.manifestDigest,
    manager: selection.manager,
    profile: selection.profile,
    declarations: selection.declarations,
  };
  publishOnce(recordFile(directory, runId), Buffer.from(`${canonicalJson(record)}\n`, 'utf8'));
  return deepFreeze(snapshotJson(record));
}

/** Reads a run's record and verifies, before execution, that its profile is still
 * byte-identical in the trusted manifest (same digest, same image). */
export function loadProfileRecord(
  directory: string,
  runId: string,
  manifest: ProfileManifest = PROFILE_MANIFEST
): ProfileRecord {
  const bytes = readExisting(recordFile(directory, runId));
  if (bytes === undefined) throw new ProfileError('record_missing');
  let record: unknown;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ProfileError('invalid_record');
  }
  if (!isRecordShape(record) || record.runId !== runId) throw new ProfileError('invalid_record');
  if (record.manifestDigest !== profileManifestDigest(manifest))
    throw new ProfileError('manifest_changed');
  const current = manifest.profiles.find((p) => p.id === record.profile.id);
  if (current === undefined || canonicalJson(current) !== canonicalJson(record.profile))
    throw new ProfileError('profile_changed');
  return deepFreeze(record);
}

/** The receipt fields (`profileDigest`, `profile`) bound to this exact record and
 * to the accelerator the VM actually ran with (`VmHandle.accelerator`). */
export function profileReceiptBinding(
  record: ProfileRecord,
  accelerator: Accelerator
): {
  profileDigest: string;
  profile: { name: string; runtime: string; imageDigest: string; accelerator: Accelerator };
} {
  return {
    profileDigest: sha256(canonicalJson(record)),
    profile: {
      name: record.profile.id,
      runtime: `${record.profile.ecosystem}@${record.profile.runtimeVersion}`,
      imageDigest: record.profile.imageDigest,
      accelerator,
    },
  };
}
