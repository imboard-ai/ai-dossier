import type { LintRule } from '../types';

const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;

export const semverVersionRule: LintRule = {
  id: 'semver-version',
  description: 'Version field must be valid semver',
  defaultSeverity: 'error',
  run(context) {
    const version = context.frontmatter.version;

    if (!version) {
      return [
        {
          ruleId: 'semver-version',
          severity: 'error',
          message: 'Missing version field',
          field: 'version',
        },
      ];
    }

    if (!SEMVER_REGEX.test(version)) {
      return [
        {
          ruleId: 'semver-version',
          severity: 'error',
          message: `Invalid semver version: "${version}"`,
          field: 'version',
        },
      ];
    }

    return [];
  },
};
