/** Versioned runtime profile manifest. Selection never substitutes a version the
 * project did not ask for; the selected profile is recorded once per run. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import Ajv from 'ajv';
import semver from 'semver';
import { publishPrivate, readPrivate } from '../durable-fs';
import { canonicalJson } from '../receipt/schema';
import { ReasonCode } from '../state';
import type { Ecosystem, PackageManager, RuntimeDeclaration, SupportedDetection } from './detect';
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

export class ProfileError extends Error {
  constructor(readonly code: 'invalid_manifest' | 'invalid_record' | 'record_mismatch') {
    super(`Zero-trust profile rejected: ${code}`);
    this.name = 'ProfileError';
  }
}

const version = { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' };
const MANIFEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'manifestVersion', 'profiles'],
  properties: {
    schemaVersion: { const: PROFILE_MANIFEST_VERSION },
    manifestVersion: { type: 'string', pattern: '^\\d{4}\\.\\d{1,2}\\.\\d+$' },
    profiles: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'ecosystem', 'runtimeVersion', 'image', 'imageDigest', 'managers'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]{0,63}$' },
          ecosystem: { enum: ['node', 'python'] },
          runtimeVersion: version,
          image: { type: 'string', pattern: '^[a-z0-9.-]+(?::\\d+)?(?:/[a-z0-9._-]+)+$' },
          imageDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
          managers: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { enum: ['npm', 'pip', 'uv'] },
          },
        },
      },
    },
  },
} as const;
const validateManifestShape = new Ajv({ allErrors: false, strict: true }).compile(MANIFEST_SCHEMA);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Validates a manifest (schema, unique ids, one profile per ecosystem/runtime). */
export function validateProfileManifest(value: unknown): ProfileManifest {
  if (!validateManifestShape(value)) throw new ProfileError('invalid_manifest');
  const manifest = JSON.parse(canonicalJson(value)) as ProfileManifest;
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

export function profileManifestDigest(manifest: ProfileManifest): string {
  return createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex');
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
  | {
      readonly ok: false;
      readonly reasonCode: ReasonCode.UnsupportedEnvironment;
      readonly reason: SelectionFailure;
      readonly detail?: string;
    };

type Matcher = (runtimeVersion: string) => boolean;

/** Node declarations are npm semver ranges (`.nvmrc` may carry a leading `v`). */
function nodeMatcher(value: string): Matcher | undefined {
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

/** A deliberately narrow PEP 440 specifier subset for `X[.Y[.Z]]` runtime versions.
 * Anything outside it (pre-releases, `===`, local versions) is invalid, never guessed. */
function pythonMatcher(value: string, bare: boolean): Matcher | undefined {
  if (bare) {
    if (!/^\d+(\.\d+){0,2}$/.test(value.trim())) return undefined;
    const prefix = tuple(value.trim());
    return (v) => prefixMatch(tuple(v), prefix);
  }
  const clauses = value.split(',').map((c) => c.trim());
  const matchers: Matcher[] = [];
  for (const clause of clauses) {
    const m = /^(~=|==|!=|<=|>=|<|>)\s*(\d+(?:\.\d+){0,2})(\.\*)?$/.exec(clause);
    if (!m) return undefined;
    const [, op, text, wildcard] = m;
    const spec = tuple(text);
    if (wildcard && op !== '==' && op !== '!=') return undefined;
    if (op === '~=' && spec.length < 2) return undefined;
    matchers.push((v) => {
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
        default:
          return c >= 0 && prefixMatch(rt, spec.slice(0, -1));
      }
    });
  }
  return (v) => matchers.every((m) => m(v));
}

function matcherFor(declaration: RuntimeDeclaration): Matcher | undefined {
  switch (declaration.source) {
    case 'package.json#engines.node':
    case '.nvmrc':
    case '.node-version':
      return nodeMatcher(declaration.value);
    case '.python-version':
      return pythonMatcher(declaration.value, true);
    default:
      return pythonMatcher(declaration.value, false);
  }
}

function fail(reason: SelectionFailure, detail?: string): ProfileSelection {
  return Object.freeze({
    ok: false,
    reasonCode: ReasonCode.UnsupportedEnvironment,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
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
  const file = recordFile(directory, runId);
  try {
    publishPrivate(file, Buffer.from(`${canonicalJson(record)}\n`, 'utf8'));
  } catch (error) {
    if ((error as Error).message === 'Controller storage unavailable')
      throw new ProfileError('record_mismatch');
    throw error;
  }
  return deepFreeze(JSON.parse(canonicalJson(record)) as ProfileRecord);
}

/** Reads a run's record and verifies, before execution, that its profile is still
 * byte-identical in the trusted manifest (same digest, same image). */
export function loadProfileRecord(
  directory: string,
  runId: string,
  manifest: ProfileManifest = PROFILE_MANIFEST
): ProfileRecord {
  let record: ProfileRecord;
  try {
    record = JSON.parse(readPrivate(recordFile(directory, runId)).toString('utf8'));
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw new ProfileError('invalid_record');
  }
  if (record?.schemaVersion !== PROFILE_RECORD_VERSION || record.runId !== runId)
    throw new ProfileError('invalid_record');
  const current = manifest.profiles.find((p) => p.id === record.profile?.id);
  if (
    record.manifestDigest !== profileManifestDigest(manifest) ||
    current === undefined ||
    canonicalJson(current) !== canonicalJson(record.profile)
  )
    throw new ProfileError('record_mismatch');
  return deepFreeze(record);
}

/** The receipt fields (`profileDigest`, `profile`) bound to this exact record. */
export function profileReceiptBinding(record: ProfileRecord): {
  profileDigest: string;
  profile: { name: string; runtime: string; imageDigest: string };
} {
  return {
    profileDigest: createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex'),
    profile: {
      name: record.profile.id,
      runtime: `${record.profile.ecosystem}@${record.profile.runtimeVersion}`,
      imageDigest: record.profile.imageDigest,
    },
  };
}
