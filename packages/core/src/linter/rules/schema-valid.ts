import Ajv from 'ajv';
import dossierSchema from '../../schema/dossier-schema.json';
import type { LintRule } from '../types';

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile(dossierSchema);

export const schemaValidRule: LintRule = {
  id: 'schema-valid',
  description: 'Validate frontmatter against the full JSON Schema',
  defaultSeverity: 'error',
  run(context) {
    const valid = validate(context.frontmatter);
    if (valid) {
      return [];
    }

    return (validate.errors || []).map((err) => {
      const path = err.instancePath || '';
      const field = path.replace(/^\//, '').replace(/\//g, '.');

      // Simplify oneOf errors for signature field
      if (err.keyword === 'oneOf' && field === 'signature') {
        return {
          ruleId: 'schema-valid',
          severity: 'error',
          message: 'signature must match either AWS KMS (ecdsa-sha256) or Ed25519 format',
          field: 'signature',
        };
      }

      let message: string;
      if (err.keyword === 'required') {
        message = `Missing required field: ${err.params.missingProperty}`;
      } else if (err.keyword === 'enum') {
        message = `${field || 'value'} must be one of: ${err.params.allowedValues.join(', ')}`;
      } else if (err.keyword === 'const') {
        message = `${field || 'value'} must be ${JSON.stringify(err.params.allowedValue)}`;
      } else if (err.keyword === 'minLength') {
        message = `${field || 'value'} is too short (minimum ${err.params.limit} characters)`;
      } else if (err.keyword === 'maxLength') {
        message = `${field || 'value'} is too long (maximum ${err.params.limit} characters)`;
      } else if (err.keyword === 'pattern') {
        message = `${field || 'value'} does not match expected pattern`;
      } else {
        message = `${field || 'value'}: ${err.message}`;
      }

      return {
        ruleId: 'schema-valid',
        severity: 'error' as const,
        message,
        field: field || undefined,
      };
    });
  },
};
