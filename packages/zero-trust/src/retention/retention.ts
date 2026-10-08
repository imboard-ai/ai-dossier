import fs from 'node:fs';
import path from 'node:path';
import { RunStore } from '../controller/run-store';
import { assertDirectoryAncestors, publishPrivate } from '../durable-fs';
import { assertSecretFree } from '../redaction';
import { maintenanceBoundary } from './errors';
import { contributionEvidence } from './evidence';
import {
  digest,
  directoryEntries,
  jsonRecord,
  optionalBytes,
  refuse,
  SUMMARY_BYTES,
} from './files';
import { deleteArtifact, inventory, withQuarantine } from './sweep-files';

export interface SweepFile {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}
export interface SweepContribution {
  readonly runId: string;
  readonly dev: number;
  readonly ino: number;
  readonly retentionDays: number;
  readonly activity: number;
  readonly protectedDigest: string;
  readonly evidenceDigest: string;
  readonly files: readonly SweepFile[];
}
export interface SweepPlan {
  readonly root: string;
  readonly now: string;
  readonly retentionDays?: number;
  readonly contributions: readonly SweepContribution[];
}
export interface ContributionSummary {
  readonly schemaVersion: 'ztfc-summary-v1';
  readonly runId: string;
  readonly snapshotExpired: true;
  readonly facts: ReturnType<typeof contributionEvidence>;
  readonly sweep: SweepContribution;
}
const issuedPlans = new WeakMap<SweepPlan, string>();
export function readContributionSummary(store: RunStore): ContributionSummary | null {
  return maintenanceBoundary('summary', () =>
    store.withPinnedDirectory((root) => {
      const invalidSummary = (): never => refuse('invalid-summary', 'summary');
      const bytes = optionalBytes(root, 'summary.json', SUMMARY_BYTES);
      if (!bytes) {
        if (optionalBytes(root, '.snapshot-expired')) invalidSummary();
        return null;
      }
      let parsed: unknown;
      try {
        parsed = jsonRecord(bytes, SUMMARY_BYTES);
      } catch (error) {
        if (error instanceof Error && error.name === 'MaintenanceError')
          refuse('invalid-summary', 'summary');
        throw error;
      }
      const raw = parsed as ContributionSummary;
      if (
        raw.schemaVersion !== 'ztfc-summary-v1' ||
        raw.runId !== store.runId ||
        raw.snapshotExpired !== true ||
        !raw.sweep ||
        raw.sweep.runId !== store.runId ||
        !Array.isArray(raw.sweep.files) ||
        !raw.facts
      )
        invalidSummary();
      if (
        !Number.isSafeInteger(raw.sweep.retentionDays) ||
        raw.sweep.retentionDays < 1 ||
        !Number.isFinite(raw.sweep.activity) ||
        !Number.isSafeInteger(raw.sweep.dev) ||
        !Number.isSafeInteger(raw.sweep.ino) ||
        !/^[a-f0-9]{64}$/u.test(raw.sweep.protectedDigest) ||
        !/^[a-f0-9]{64}$/u.test(raw.sweep.evidenceDigest)
      )
        invalidSummary();
      const paths = new Set<string>();
      for (const file of raw.sweep.files) {
        if (
          !/^artifacts\/(?!.*(?:^|\/)\.\.?\/)[^\\]+$/u.test(file.path) ||
          file.path.split('/').some((c: string) => !c || c === '.' || c === '..') ||
          !/^[a-f0-9]{64}$/u.test(file.sha256) ||
          ![file.dev, file.ino, file.size].every((n) => Number.isSafeInteger(n) && n >= 0) ||
          !Number.isFinite(file.mtimeMs)
        )
          invalidSummary();
        if (paths.has(file.path)) invalidSummary();
        paths.add(file.path);
      }
      if (raw.facts.evidenceDigest !== raw.sweep.evidenceDigest) invalidSummary();
      if (JSON.stringify(raw.facts) !== JSON.stringify(contributionEvidence(store, root)))
        invalidSummary();
      const marker = optionalBytes(root, '.snapshot-expired');
      if (marker) {
        const record = jsonRecord(marker);
        if (
          !record ||
          typeof record !== 'object' ||
          !('runId' in record) ||
          record.runId !== store.runId ||
          !('snapshotExpired' in record) ||
          record.snapshotExpired !== true ||
          !('summaryDigest' in record) ||
          record.summaryDigest !== digest(bytes)
        )
          invalidSummary();
      }
      return raw;
    })
  );
}
/** Dry run only. Explicit days overrides each config; omission uses config's default 30. */
export function planSweep(root: string, now: Date | string, retentionDays?: number): SweepPlan {
  return maintenanceBoundary('input', () => {
    assertDirectoryAncestors(root);
    if (now instanceof Date && !Number.isFinite(now.getTime())) refuse('invalid-input', 'input');
    const at = now instanceof Date ? now.toISOString() : now;
    if (
      !Number.isFinite(Date.parse(at)) ||
      (retentionDays !== undefined && (!Number.isSafeInteger(retentionDays) || retentionDays < 1))
    )
      refuse('invalid-input', 'input');
    root = path.resolve(root);
    const contributions: SweepContribution[] = [];
    let entries = 0;
    for (const name of directoryEntries(root)) {
      if (++entries > 10000) refuse('size-limit', 'inventory');
      if (!/^ztc-[a-f0-9]{16}$/u.test(name)) refuse('invalid-input', 'input');
      const store = RunStore.open(root, `${name}-run-1`, { readOnly: true });
      try {
        if (store.run.state === 'blocked_cleanup') continue;
        store.withPinnedDirectory((directory) => {
          const summary = readContributionSummary(store);
          if (summary) {
            revalidateSweep(store, directory, summary.sweep, summary, at, retentionDays);
            contributions.push(summary.sweep);
            return;
          }
          const scan = inventory(directory);
          const activity = Math.max(Date.parse(store.run.updatedAt), scan.activity);
          const days = retentionDays ?? store.config.retentionDays;
          if (activity >= Date.parse(at) - days * 86400000) return;
          const facts = contributionEvidence(store, directory);
          const stat = fs.statSync(directory);
          const planned: SweepContribution = {
            runId: store.runId,
            dev: stat.dev,
            ino: stat.ino,
            retentionDays: days,
            activity,
            protectedDigest: scan.protectedDigest,
            evidenceDigest: facts.evidenceDigest,
            files: scan.artifacts,
          };
          summaryBytes({
            schemaVersion: 'ztfc-summary-v1',
            runId: store.runId,
            snapshotExpired: true,
            facts,
            sweep: planned,
          });
          contributions.push(planned);
        });
      } finally {
        store.close();
      }
    }
    const plan: SweepPlan = {
      root,
      now: at,
      ...(retentionDays === undefined ? {} : { retentionDays }),
      contributions,
    };
    issuedPlans.set(plan, JSON.stringify(plan));
    return plan;
  });
}
function summaryBytes(summary: ContributionSummary): Buffer {
  assertSecretFree(summary);
  const bytes = Buffer.from(JSON.stringify(summary));
  jsonRecord(bytes, SUMMARY_BYTES);
  return bytes;
}
type FaultPoint = 'summary' | 'expired' | 'quarantined' | 'deleted';
function publishExpiry(
  root: string,
  summary: ContributionSummary,
  notify: (point: FaultPoint) => void
): void {
  const bytes = summaryBytes(summary);
  publishPrivate(path.join(root, 'summary.json'), bytes);
  notify('summary');
  publishPrivate(
    path.join(root, '.snapshot-expired'),
    Buffer.from(
      JSON.stringify({ runId: summary.runId, snapshotExpired: true, summaryDigest: digest(bytes) })
    )
  );
  notify('expired');
}
function revalidateSweep(
  store: RunStore,
  root: string,
  planned: SweepContribution,
  prior: ContributionSummary | null,
  now: string,
  override?: number
) {
  const stat = fs.statSync(root);
  const scan = inventory(root, prior ? planned.files : []);
  const facts = contributionEvidence(store, root);
  const activity = Math.max(Date.parse(store.run.updatedAt), scan.activity);
  if (
    stat.dev !== planned.dev ||
    stat.ino !== planned.ino ||
    store.run.state === 'blocked_cleanup' ||
    (prior &&
      (JSON.stringify(prior.sweep) !== JSON.stringify(planned) ||
        JSON.stringify(prior.facts) !== JSON.stringify(facts))) ||
    scan.protectedDigest !== planned.protectedDigest ||
    facts.evidenceDigest !== planned.evidenceDigest ||
    activity > planned.activity ||
    (!prior && activity !== planned.activity) ||
    (override ?? store.config.retentionDays) !== planned.retentionDays ||
    planned.activity >= Date.parse(now) - planned.retentionDays * 86400000
  )
    refuse('stale-plan', 'revalidate');
  const remaining = new Map(scan.artifacts.map((file) => [file.path, file]));
  for (const file of planned.files) {
    const present = remaining.get(file.path);
    if ((!present && !prior) || (present && JSON.stringify(present) !== JSON.stringify(file)))
      refuse('stale-plan', 'revalidate');
    remaining.delete(file.path);
  }
  if (remaining.size) refuse('stale-plan', 'revalidate');
  return facts;
}
/** Explicit application. The original process-local plan is required; replan after restart.
 * Fault hook is a controller test seam, invoked only at durable crash boundaries. */
export function applySweep(plan: SweepPlan, fault?: (point: FaultPoint) => void): void {
  let faultError: unknown;
  let faultThrown = false;
  const notify = (point: FaultPoint) => {
    try {
      fault?.(point);
    } catch (error) {
      faultThrown = true;
      faultError = error;
      throw error;
    }
  };
  maintenanceBoundary(
    'delete',
    () => {
      const serialized = issuedPlans.get(plan);
      if (!serialized || serialized !== JSON.stringify(plan)) refuse('stale-plan', 'input');
      // Never reread caller-controlled accessors or arrays after authentication.
      plan = JSON.parse(serialized) as SweepPlan;
      for (const planned of plan.contributions) {
        const store = RunStore.open(plan.root, planned.runId, { readOnly: true });
        try {
          store.withPinnedDirectory((root) => {
            const prior = readContributionSummary(store);
            const facts = revalidateSweep(
              store,
              root,
              planned,
              prior,
              plan.now,
              plan.retentionDays
            );
            const summary: ContributionSummary = prior ?? {
              schemaVersion: 'ztfc-summary-v1',
              runId: store.runId,
              snapshotExpired: true,
              facts,
              sweep: planned,
            };
            publishExpiry(root, summary, notify);
            withQuarantine(root, (quarantine) => {
              for (const file of planned.files) {
                deleteArtifact(root, quarantine, file, prior !== null, () => notify('quarantined'));
                notify('deleted');
              }
            });
          });
        } finally {
          store.close();
        }
      }
    },
    (error) => faultThrown && error === faultError
  );
}
export function assertResumable(store: RunStore): void {
  maintenanceBoundary('summary', () => store.assertResumable());
}
