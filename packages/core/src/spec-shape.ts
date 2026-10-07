/**
 * Spec-shape adapter: the Agent Skills frontmatter layout for dossiers (#1088).
 *
 * A dossier can sit on disk in two shapes that mean the same thing:
 *
 * - **Legacy shape** — every Dossier field flat at the top level.
 * - **Spec shape** — only the Agent Skills fields (`name`, `description`, and the
 *   optional `license`, `compatibility`, `allowed-tools`) at the top level; every
 *   other Dossier field lives under `metadata` as `dossier.<field>`, including the
 *   signature and checksum blocks.
 *
 * Both are read into the same flat *logical* frontmatter, so code that reads
 * `risk_level`, `requires_approval`, `inputs`, … does not care which shape a file
 * was written in. Signature v3 covers the on-disk spec-shaped object instead (see
 * `signing-payload.ts`), so the parse here is deliberately strict: anything that
 * would let two different on-disk objects decode to one logical object, or let a
 * field sit somewhere the signature scheme does not expect, is rejected rather
 * than normalized.
 */

import { stableStringify } from './utils/canonical-json';

/** Top-level fields the Agent Skills spec defines. Everything else goes under `metadata`. */
export const SPEC_TOP_LEVEL_FIELDS = [
  'name',
  'description',
  'license',
  'compatibility',
  'allowed-tools',
] as const;

/** Prefix of the `metadata` keys that carry Dossier fields. */
export const DOSSIER_METADATA_PREFIX = 'dossier.';

/** Which on-disk layout a dossier's frontmatter uses. */
export type FrontmatterShape = 'legacy' | 'spec';

/** A spec-shaped frontmatter that cannot be read without guessing, or a value that cannot be encoded losslessly. */
export class SpecShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecShapeError';
  }
}

const SPEC_TOP_LEVEL = new Set<string>(SPEC_TOP_LEVEL_FIELDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reject anything canonical JSON would not reproduce exactly. `stableStringify`
 * turns a Date into `{}`, NaN into `null` and drops `undefined` array slots to
 * `null`, so encoding those would not round-trip — fail loudly instead.
 */
function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SpecShapeError(`${path}: ${value} has no JSON representation`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      if (item === undefined) {
        throw new SpecShapeError(`${path}[${i}]: undefined has no JSON representation`);
      }
      assertJsonValue(item, `${path}[${i}]`);
    });
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        assertJsonValue(item, `${path}.${key}`);
      }
    }
    return;
  }
  const kind = value instanceof Date ? 'a Date (quote it as a string)' : typeof value;
  throw new SpecShapeError(`${path}: ${kind} cannot be stored losslessly in metadata`);
}

/**
 * Encode one Dossier field value as a `metadata` string.
 *
 * A string is stored as-is unless it would itself parse as JSON (`"true"`,
 * `"123"`, `"[1]"`, `"\"x\""`), in which case it is stored JSON-quoted; any other
 * value is stored as canonical JSON. `decodeSpecValue` inverts this without a
 * schema lookup.
 */
export function encodeSpecValue(value: unknown, path = 'value'): string {
  if (typeof value === 'string') {
    return parsesAsJson(value) ? JSON.stringify(value) : value;
  }
  assertJsonValue(value, path);
  return stableStringify(value);
}

/** Decode a `metadata` string: its JSON value if it parses, otherwise the string itself. */
export function decodeSpecValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Whether parsed frontmatter is spec-shaped: a `metadata` map carrying at least
 * one `dossier.*` key. A legacy dossier never has one, since no legacy field is
 * named `metadata` with dotted keys.
 */
export function isSpecShapedFrontmatter(frontmatter: unknown): boolean {
  if (!isPlainObject(frontmatter)) {
    return false;
  }
  const metadata = frontmatter.metadata;
  return (
    isPlainObject(metadata) &&
    Object.keys(metadata).some((key) => key.startsWith(DOSSIER_METADATA_PREFIX))
  );
}

/**
 * Convert flat logical frontmatter to the spec shape.
 *
 * Agent Skills fields stay at the top level and must be strings; every other
 * field is encoded under `metadata` as `dossier.<field>`. `metadata` is omitted
 * when empty — strict YAML readers reject an empty flow map.
 */
export function toSpecFrontmatter(logical: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(logical)) {
    throw new SpecShapeError('Frontmatter must be a plain object');
  }

  const spec: Record<string, unknown> = {};
  for (const field of SPEC_TOP_LEVEL_FIELDS) {
    const value = logical[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new SpecShapeError(`${field} must be a string in the spec shape`);
    }
    spec[field] = value;
  }

  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(logical)) {
    if (SPEC_TOP_LEVEL.has(key) || value === undefined) {
      continue;
    }
    if (!key || key === '__proto__') {
      throw new SpecShapeError(`"${key}" is not a valid field name`);
    }
    metadata[`${DOSSIER_METADATA_PREFIX}${key}`] = encodeSpecValue(value, key);
  }
  if (Object.keys(metadata).length > 0) {
    spec.metadata = metadata;
  }

  return spec;
}

/**
 * Read spec-shaped frontmatter back into the flat logical object.
 *
 * Strict by design, because the v3 signature covers the on-disk shape and every
 * consumer reads the logical one — any ambiguity between them is a place to hide
 * a field from one side:
 *
 * - a top-level key outside the Agent Skills fields is rejected (a Dossier field
 *   sitting next to `metadata` would otherwise be a second copy of it);
 * - `dossier.<agent-skills-field>` is rejected (those live at the top level only);
 * - spec top-level values and every `metadata` value must be strings, as the spec
 *   requires — this also keeps the v3 canonical form free of values that canonical
 *   JSON cannot represent;
 * - `metadata` keys outside the `dossier.` namespace belong to other tools: they
 *   are covered by the v3 signature but are not part of the logical object.
 */
export function fromSpecFrontmatter(spec: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(spec)) {
    throw new SpecShapeError('Frontmatter must be a plain object');
  }

  const logical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'metadata') {
      continue;
    }
    if (!SPEC_TOP_LEVEL.has(key)) {
      throw new SpecShapeError(
        `Unexpected top-level field "${key}" in spec-shaped frontmatter; Dossier fields belong under metadata as "${DOSSIER_METADATA_PREFIX}${key}"`
      );
    }
    if (typeof value !== 'string') {
      throw new SpecShapeError(`Top-level field "${key}" must be a string`);
    }
    logical[key] = value;
  }

  const metadata = spec.metadata;
  if (!isPlainObject(metadata)) {
    throw new SpecShapeError('Spec-shaped frontmatter must have a metadata map');
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string') {
      throw new SpecShapeError(
        `metadata "${key}" must be a string; encode non-string values as JSON text`
      );
    }
    if (!key.startsWith(DOSSIER_METADATA_PREFIX)) {
      continue;
    }

    const field = key.slice(DOSSIER_METADATA_PREFIX.length);
    if (!field) {
      throw new SpecShapeError(`metadata "${key}" names no field`);
    }
    if (field === '__proto__') {
      throw new SpecShapeError(`metadata "${key}" is not a valid field name`);
    }
    if (SPEC_TOP_LEVEL.has(field)) {
      throw new SpecShapeError(
        `metadata "${key}" duplicates the top-level "${field}" field; it may only appear at the top level`
      );
    }
    if (Object.hasOwn(logical, field)) {
      throw new SpecShapeError(`Field "${field}" appears more than once`);
    }
    logical[field] = decodeSpecValue(value);
  }

  // `dossier.metadata` may legitimately hold a map, but not one that makes the
  // logical object itself look spec-shaped: every reader of the logical view
  // (the linter's schema check included) would then take it for on-disk spec
  // shape, while the real Dossier fields sat one level down unchecked.
  if (isSpecShapedFrontmatter(logical)) {
    throw new SpecShapeError(
      `metadata "${DOSSIER_METADATA_PREFIX}metadata" must not itself carry "${DOSSIER_METADATA_PREFIX}*" keys`
    );
  }

  return logical;
}

/**
 * Whether YAML front matter uses a merge key (`<<:`). YAML parsers disagree on
 * merges — the one dossiers are parsed with applies them, others (including the
 * Agent Skills tooling's) do not — so a spec-shaped file using one could be
 * signed as one thing and read by a skills runtime as another.
 */
export function hasYamlMergeKey(frontmatterText: string): boolean {
  return /(^|[\s{,[])<<\s*:/m.test(frontmatterText);
}
