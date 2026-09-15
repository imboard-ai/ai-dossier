import Ajv, { type ValidateFunction } from 'ajv';

/** Shared Ajv config for compiling dossier-family JSON Schemas (draft-07, permissive). */
export function compileSchema<T = unknown>(schema: object): ValidateFunction<T> {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  return ajv.compile<T>(schema);
}
