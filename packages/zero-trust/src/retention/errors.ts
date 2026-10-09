import { RunStoreError } from '../controller/run-store';
import { StoreLockedError } from '../lock';
import { SecretRedactionError } from '../redaction';

export type MaintenanceCode =
  | 'invalid-input'
  | 'stale-plan'
  | 'invalid-evidence'
  | 'invalid-summary'
  | 'size-limit'
  | 'io-error';
export type MaintenanceStage =
  | 'input'
  | 'read'
  | 'inventory'
  | 'evidence'
  | 'summary'
  | 'revalidate'
  | 'delete'
  | 'export';
export class MaintenanceError extends Error {
  constructor(
    readonly code: MaintenanceCode,
    readonly stage: MaintenanceStage
  ) {
    super(`Contribution maintenance refused (${code}, ${stage})`);
    this.name = 'MaintenanceError';
  }
}
export function maintenanceBoundary<T>(
  stage: MaintenanceStage,
  work: () => T,
  passthrough?: (error: unknown) => boolean
): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof StoreLockedError) throw new MaintenanceError('stale-plan', 'revalidate');
    if (
      error instanceof MaintenanceError ||
      error instanceof RunStoreError ||
      error instanceof SecretRedactionError ||
      passthrough?.(error)
    )
      throw error;
    const io =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^E[A-Z]+$/u.test(error.code);
    throw new MaintenanceError(
      io
        ? 'io-error'
        : stage === 'summary'
          ? 'invalid-summary'
          : stage === 'input'
            ? 'invalid-input'
            : 'invalid-evidence',
      stage
    );
  }
}
