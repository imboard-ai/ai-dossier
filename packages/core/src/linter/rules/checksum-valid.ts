import { calculateChecksum } from '../../checksum';
import type { LintRule } from '../types';

export const checksumValidRule: LintRule = {
  id: 'checksum-valid',
  description: 'Verify checksum hash matches body content',
  defaultSeverity: 'error',
  run(context) {
    const checksum = context.frontmatter.checksum;

    if (!checksum) {
      return [
        {
          ruleId: 'checksum-valid',
          severity: 'error',
          message: 'Missing checksum field in frontmatter',
          field: 'checksum',
        },
      ];
    }

    const checksumObj = checksum as { algorithm?: string; hash?: string };
    if (!checksumObj.hash) {
      return [
        {
          ruleId: 'checksum-valid',
          severity: 'error',
          message: 'Checksum object missing hash field',
          field: 'checksum.hash',
        },
      ];
    }

    const actualHash = calculateChecksum(context.body);
    if (actualHash !== checksumObj.hash) {
      return [
        {
          ruleId: 'checksum-valid',
          severity: 'error',
          message: `Checksum mismatch: expected ${checksumObj.hash.slice(0, 16)}..., got ${actualHash.slice(0, 16)}...`,
          field: 'checksum.hash',
        },
      ];
    }

    return [];
  },
};
