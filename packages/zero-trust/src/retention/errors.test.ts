import { expect, it } from 'vitest';
import { RunStoreError } from '../controller/run-store';
import { SecretRedactionError } from '../redaction';
import { MaintenanceError, maintenanceBoundary } from './errors';

it('translates boundary failures into fixed stage/code diagnostics and preserves known-safe codes', () => {
  for (const error of [
    new RunStoreError('snapshot_expired'),
    new SecretRedactionError(),
    new MaintenanceError('stale-plan', 'revalidate'),
  ]) {
    expect(() =>
      maintenanceBoundary('export', () => {
        throw error;
      })
    ).toThrow(error);
  }
  expect(() =>
    maintenanceBoundary('summary', () => {
      throw new Error('ghp_raw');
    })
  ).toThrow('invalid-summary');
  expect(() =>
    maintenanceBoundary('evidence', () => {
      throw new Error('ghp_raw');
    })
  ).toThrow('invalid-evidence');
  expect(() =>
    maintenanceBoundary('export', () => {
      throw Object.assign(new Error('ghp_raw'), { code: 'EEXIST' });
    })
  ).toThrow('io-error');
  const fault = new Error('intentional test fault');
  expect(() =>
    maintenanceBoundary(
      'delete',
      () => {
        throw fault;
      },
      (error) => error === fault
    )
  ).toThrow(fault);
  expect(maintenanceBoundary('input', () => true)).toBe(true);
});
