import type { LintRule } from '../types';
import { checksumValidRule } from './checksum-valid';
import { externalReferencesDeclaredRule } from './external-references-declared';
import { objectiveQualityRule } from './objective-quality';
import { requiredSectionsRule } from './required-sections';
import { riskLevelConsistencyRule } from './risk-level-consistency';
import { schemaValidRule } from './schema-valid';
import { semverVersionRule } from './semver-version';
import { toolsCheckCommandRule } from './tools-check-command';

export {
  checksumValidRule,
  externalReferencesDeclaredRule,
  objectiveQualityRule,
  requiredSectionsRule,
  riskLevelConsistencyRule,
  schemaValidRule,
  semverVersionRule,
  toolsCheckCommandRule,
};

export const defaultRules: LintRule[] = [
  schemaValidRule,
  checksumValidRule,
  semverVersionRule,
  riskLevelConsistencyRule,
  toolsCheckCommandRule,
  objectiveQualityRule,
  requiredSectionsRule,
  externalReferencesDeclaredRule,
];
