/**
 * Field metadata derived from dossier-schema.json (bundled by esbuild), so completion and hover
 * follow the schema instead of a hand-maintained list.
 */
import schema from '../../../dossier-schema.json';

export interface FieldInfo {
  name: string;
  type: string;
  description: string;
  required: boolean;
  enum?: string[];
  /** Concrete example, when the schema gives one. */
  example?: unknown;
}

interface SchemaProp {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  examples?: unknown[];
  default?: unknown;
}

const props = (schema as { properties: Record<string, SchemaProp> }).properties;
/**
 * Legacy-shape required fields, which sit under the root `else` since the schema also accepts
 * the spec shape. Throws rather than falling back to a root `required` list or to nothing: a
 * fallback would silently stop marking Dossier fields as required if the schema layout moved.
 */
export function legacyRequiredFields(s: { else?: { required?: string[] } }): Set<string> {
  const required = s.else?.required;
  if (!required || required.length === 0) {
    throw new Error('dossier-schema.json: no legacy-shape required fields under the root "else"');
  }
  return new Set(required);
}

const required = legacyRequiredFields(schema as { else?: { required?: string[] } });

export const FIELDS: FieldInfo[] = Object.entries(props).map(([name, p]) => ({
  name,
  type: Array.isArray(p.type) ? p.type.join(' | ') : (p.type ?? 'any'),
  description: p.description ?? '',
  required: required.has(name),
  enum: p.enum?.map(String),
  example: p.examples?.[0],
}));

const byName = new Map(FIELDS.map((f) => [f.name, f]));

export function getField(name: string): FieldInfo | undefined {
  return byName.get(name);
}
