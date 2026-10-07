import type { ErrorObject } from 'ajv';
import dossierSchema from '../../schema/dossier-schema.json';
import { compileSchema } from '../../utils/ajv';
import type { LintDiagnostic, LintRule } from '../types';

/** The Agent Skills layout (#1088): what `skills-ref validate` and skills runtimes read. */
const validateSpecShape = compileSchema({
  ...dossierSchema.definitions.specShape,
  definitions: dossierSchema.definitions,
});

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

const NAME_RULE = 'lowercase letters, digits and single hyphens, at most 64 characters';

function toDiagnostic(err: ErrorObject): LintDiagnostic {
  const field = (err.instancePath || '').replace(/^\//, '').replace(/\//g, '.') || undefined;
  let message: string;
  if (err.keyword === 'required') {
    message = `Missing required field: ${field ? `${field}.` : ''}${err.params.missingProperty}`;
  } else if (err.keyword === 'additionalProperties') {
    message = `Unexpected top-level field "${err.params.additionalProperty}"; Dossier fields belong under metadata as "dossier.${err.params.additionalProperty}"`;
  } else if (field === 'name' && (err.keyword === 'pattern' || err.keyword === 'maxLength')) {
    message = `name must be ${NAME_RULE}`;
  } else {
    message = `${field ?? 'frontmatter'}: ${err.message}`;
  }
  return { ruleId: 'spec-shape', severity: 'error', message, field };
}

/** A spec-shaped dossier must pass the Agent Skills layout checks as written. */
export const specShapeRule: LintRule = {
  id: 'spec-shape',
  description: 'Spec-shaped frontmatter follows the Agent Skills layout',
  defaultSeverity: 'error',
  run(context) {
    if (context.shape !== 'spec' || !context.rawFrontmatter) {
      return [];
    }
    if (validateSpecShape(context.rawFrontmatter)) {
      return [];
    }
    return (validateSpecShape.errors || []).map(toDiagnostic);
  },
};

/**
 * A legacy dossier is still read, but writers now emit the Agent Skills layout.
 * Flags the file, and anything that would make its converted form invalid.
 */
export const legacyLayoutRule: LintRule = {
  id: 'legacy-layout',
  description: 'Legacy frontmatter layout; writers now emit the Agent Skills layout',
  defaultSeverity: 'info',
  run(context) {
    if (context.shape !== 'legacy') {
      return [];
    }
    const diagnostics: LintDiagnostic[] = [
      {
        ruleId: 'legacy-layout',
        severity: 'info',
        message:
          "Legacy frontmatter layout; 'ai-dossier sign' (or 'ai-dossier format' when unsigned) writes the Agent Skills layout",
      },
    ];

    const { name, description, objective } = context.frontmatter as Record<string, unknown>;
    if (
      typeof name === 'string' &&
      (!SKILL_NAME.test(name) || name.length > MAX_SKILL_NAME_LENGTH)
    ) {
      diagnostics.push({
        ruleId: 'legacy-layout',
        severity: 'info',
        message: `name "${name}" is not a valid Agent Skills name (${NAME_RULE})`,
        field: 'name',
      });
    }
    const summary = description ?? objective;
    if (typeof summary === 'string' && summary.length > MAX_DESCRIPTION_LENGTH) {
      diagnostics.push({
        ruleId: 'legacy-layout',
        severity: 'info',
        message: `${description === undefined ? 'objective' : 'description'} is ${summary.length} characters; an Agent Skills description allows at most ${MAX_DESCRIPTION_LENGTH}`,
        field: description === undefined ? 'objective' : 'description',
      });
    }
    return diagnostics;
  },
};
