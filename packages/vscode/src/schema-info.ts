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
const required = new Set((schema as { required?: string[] }).required ?? []);

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
