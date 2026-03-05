/**
 * verify_dossier tool - Security verification for dossiers
 * Thin wrapper around `ai-dossier verify --json <path>`
 */

import { CliNotFoundError, execCli } from '../utils/cli-wrapper';
import { logger } from '../utils/logger';

export interface VerifyDossierInput {
  path: string;
}

export interface VerificationStage {
  stage: number;
  name: string;
  passed?: boolean;
  skipped?: boolean;
  demo?: boolean;
}

export interface VerifyDossierOutput {
  passed: boolean;
  stages: VerificationStage[];
}

/**
 * Verify dossier security via CLI
 */
export async function verifyDossier(input: VerifyDossierInput): Promise<VerifyDossierOutput> {
  const { path } = input;

  logger.info('Starting dossier verification via CLI', { dossierFile: path });

  try {
    const result = await execCli<VerifyDossierOutput>('verify', [path, '--json']);

    logger.info('Verification completed', {
      dossierFile: path,
      passed: result.passed,
    });

    return result;
  } catch (error) {
    if (error instanceof CliNotFoundError) {
      return {
        passed: false,
        stages: [{ stage: 0, name: 'CLI Check', passed: false }],
      };
    }
    throw error;
  }
}
