import fs from 'node:fs';
import path from 'node:path';
import { RunStore } from '../controller/run-store';
import { assertDirectoryAncestors, publishPrivate } from '../durable-fs';
import { assertSecretFree } from '../redaction';
import { maintenanceBoundary } from './errors';
import { contributionEvidence, type EvidenceSnapshot, historicalEvidence } from './evidence';
import { preflightExport } from './export';
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
  /** Content-addressed later batch; never replaces the first expiry summary. */
  readonly generation?: string;
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
  readonly evidence: EvidenceSnapshot;
}
const issuedPlans = new WeakMap<SweepPlan, string>();
const issuedGenerations = new WeakMap<SweepPlan, Map<string, Buffer>>();
function completionName(planned: SweepContribution): string {
  return `.retention-completed-${digest(JSON.stringify(planned))}.json`;
}
function isCompleted(root: string, planned: SweepContribution): boolean {
  const bytes = optionalBytes(root, completionName(planned));
  if (!bytes) return false;
  if (
    JSON.stringify(jsonRecord(bytes)) !==
    JSON.stringify({ runId: planned.runId, sweepDigest: digest(JSON.stringify(planned)) })
  )
    refuse('invalid-summary', 'summary');
  return true;
}
function complete(root: string, planned: SweepContribution): void {
  publishPrivate(
    path.join(root, completionName(planned)),
    Buffer.from(
      JSON.stringify({
        runId: planned.runId,
        sweepDigest: digest(JSON.stringify(planned)),
      })
    )
  );
}
function generationSummary(
  store: RunStore,
  root: string,
  planned: SweepContribution,
  pending?: Buffer
): ContributionSummary {
  const name = planned.generation;
  if (!name || !/^\.retention-generation-[a-f0-9]{64}\.json$/u.test(name))
    refuse('invalid-summary', 'summary');
  const bytes = optionalBytes(root, name, SUMMARY_BYTES) ?? pending;
  if (!bytes) refuse('invalid-summary', 'summary');
  const value = jsonRecord(bytes, SUMMARY_BYTES) as ContributionSummary;
  const { generation: _name, ...sweep } = planned;
  if (
    name !== `.retention-generation-${digest(bytes)}.json` ||
    value.runId !== store.runId ||
    value.schemaVersion !== 'ztfc-summary-v1' ||
    value.snapshotExpired !== true ||
    JSON.stringify(value.sweep) !== JSON.stringify(sweep) ||
    JSON.stringify(value.facts) !== JSON.stringify(historicalEvidence(store, root, value.evidence))
  )
    refuse('invalid-summary', 'summary');
  return value;
}
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
          !validArtifactPath(file.path) ||
          !/^[a-f0-9]{64}$/u.test(file.sha256) ||
          ![file.dev, file.ino, file.size].every((n) => Number.isSafeInteger(n) && n >= 0) ||
          !Number.isFinite(file.mtimeMs)
        )
          invalidSummary();
        if (paths.has(file.path)) invalidSummary();
        paths.add(file.path);
      }
      if (raw.facts.evidenceDigest !== raw.sweep.evidenceDigest) invalidSummary();
      contributionEvidence(store, root);
      if (
        JSON.stringify(raw.facts) !== JSON.stringify(historicalEvidence(store, root, raw.evidence))
      )
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
    const generations = new Map<string, Buffer>();
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
            const pendingFiles: SweepFile[] = isCompleted(directory, summary.sweep)
              ? []
              : [...summary.sweep.files];
            const batches: { planned: SweepContribution; prior: ContributionSummary }[] = [];
            let pending = !isCompleted(directory, summary.sweep);
            if (pending) contributions.push(summary.sweep);
            for (const name of directoryEntries(directory)) {
              if (!name.startsWith('.retention-generation-')) continue;
              if (!/^\.retention-generation-[a-f0-9]{64}\.json$/u.test(name))
                refuse('invalid-summary', 'summary');
              const bytes = optionalBytes(directory, name, SUMMARY_BYTES);
              if (!bytes) refuse('invalid-summary', 'summary');
              const raw = jsonRecord(bytes, SUMMARY_BYTES) as ContributionSummary;
              const planned = { ...raw.sweep, generation: name };
              const prior = generationSummary(store, directory, planned);
              batches.push({ planned, prior });
              if (!isCompleted(directory, planned)) {
                contributions.push(planned);
                pending = true;
                pendingFiles.push(...planned.files);
              }
            }
            revalidateSweep(
              store,
              directory,
              summary.sweep,
              summary,
              at,
              retentionDays,
              pendingFiles
            );
            for (const { planned, prior } of batches)
              revalidateSweep(store, directory, planned, prior, at, retentionDays, pendingFiles);
            const scan = inventory(directory, pendingFiles);
            const pendingPaths = new Set(pendingFiles.map((file) => file.path));
            const extras = scan.artifacts.filter((file) => !pendingPaths.has(file.path));
            const days = retentionDays ?? store.config.retentionDays;
            const activity = Math.max(Date.parse(store.run.updatedAt), scan.activity);
            if (!pending && extras.length && activity < Date.parse(at) - days * 86400000) {
              const evidence: EvidenceSnapshot = { run: '', sources: {} };
              const facts = contributionEvidence(store, directory, evidence);
              const stat = fs.statSync(directory);
              const sweep: SweepContribution = {
                runId: store.runId,
                dev: stat.dev,
                ino: stat.ino,
                retentionDays: days,
                activity,
                protectedDigest: scan.protectedDigest,
                evidenceDigest: facts.evidenceDigest,
                files: extras,
              };
              const next: ContributionSummary = {
                schemaVersion: 'ztfc-summary-v1',
                runId: store.runId,
                snapshotExpired: true,
                facts,
                sweep,
                evidence,
              };
              const bytes = summaryBytes(next);
              const generation = `.retention-generation-${digest(bytes)}.json`;
              generations.set(generation, bytes);
              contributions.push({ ...sweep, generation });
            }
            return;
          }
          const scan = inventory(directory);
          const activity = Math.max(Date.parse(store.run.updatedAt), scan.activity);
          const days = retentionDays ?? store.config.retentionDays;
          if (activity >= Date.parse(at) - days * 86400000) return;
          const evidence: EvidenceSnapshot = { run: '', sources: {} };
          const facts = contributionEvidence(store, directory, evidence);
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
          const proposed: ContributionSummary = {
            schemaVersion: 'ztfc-summary-v1',
            runId: store.runId,
            snapshotExpired: true,
            facts,
            sweep: planned,
            evidence,
          };
          summaryBytes(proposed);
          preflightExport(store, facts, proposed);
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
    issuedGenerations.set(plan, generations);
    return plan;
  });
}
function summaryBytes(summary: ContributionSummary): Buffer {
  assertSecretFree(summary);
  const paths = new Set<string>();
  for (const file of summary.sweep.files) {
    if (!validArtifactPath(file.path) || paths.has(file.path)) refuse('invalid-summary', 'summary');
    paths.add(file.path);
  }
  const bytes = Buffer.from(JSON.stringify(summary));
  jsonRecord(bytes, SUMMARY_BYTES);
  return bytes;
}
function validArtifactPath(name: string): boolean {
  return (
    typeof name === 'string' &&
    /^artifacts\/[^\\]+$/u.test(name) &&
    !name.split('/').some((part) => !part || part === '.' || part === '..')
  );
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
  override?: number,
  pendingFiles?: readonly SweepFile[]
) {
  const stat = fs.statSync(root);
  const completed = prior !== null && isCompleted(root, planned);
  const scan = inventory(root, pendingFiles ?? (prior ? planned.files : []));
  const facts = contributionEvidence(store, root);
  const activity = Math.max(Date.parse(store.run.updatedAt), scan.activity);
  if (
    stat.dev !== planned.dev ||
    stat.ino !== planned.ino ||
    store.run.state === 'blocked_cleanup' ||
    (prior &&
      JSON.stringify(prior.sweep) !==
        JSON.stringify((({ generation: _name, ...sweep }) => sweep)(planned))) ||
    (!prior &&
      (scan.protectedDigest !== planned.protectedDigest ||
        facts.evidenceDigest !== planned.evidenceDigest ||
        activity !== planned.activity)) ||
    (!prior && (override ?? store.config.retentionDays) !== planned.retentionDays) ||
    (!completed && planned.activity >= Date.parse(now) - planned.retentionDays * 86400000)
  )
    refuse('stale-plan', 'revalidate');
  const remaining = new Map(scan.artifacts.map((file) => [file.path, file]));
  if (completed) return facts;
  for (const file of planned.files) {
    const present = remaining.get(file.path);
    if ((!present && !prior) || (present && JSON.stringify(present) !== JSON.stringify(file)))
      refuse('stale-plan', 'revalidate');
    remaining.delete(file.path);
  }
  if (remaining.size && !prior) refuse('stale-plan', 'revalidate');
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
      const generations = issuedGenerations.get(plan);
      if (!serialized || serialized !== JSON.stringify(plan)) refuse('stale-plan', 'input');
      // Never reread caller-controlled accessors or arrays after authentication.
      plan = JSON.parse(serialized) as SweepPlan;
      for (const planned of plan.contributions) {
        const store = RunStore.open(plan.root, planned.runId, { readOnly: true });
        try {
          store.withPinnedDirectory((root) => {
            const prior = readContributionSummary(store);
            const generation = planned.generation
              ? generationSummary(store, root, planned, generations?.get(planned.generation))
              : null;
            const generationPublished = planned.generation
              ? optionalBytes(root, planned.generation, SUMMARY_BYTES) !== null
              : false;
            const replay = generation ? generationPublished : prior !== null;
            const facts = revalidateSweep(
              store,
              root,
              planned,
              generationPublished ? generation : planned.generation ? null : prior,
              plan.now,
              plan.retentionDays
            );
            const evidence: EvidenceSnapshot = { run: '', sources: {} };
            if (!prior) contributionEvidence(store, root, evidence);
            const summary: ContributionSummary = prior ?? {
              schemaVersion: 'ztfc-summary-v1',
              runId: store.runId,
              snapshotExpired: true,
              facts,
              sweep: planned,
              evidence,
            };
            preflightExport(store, facts, summary);
            if (planned.generation) {
              if (!generation) refuse('invalid-summary', 'summary');
              publishPrivate(path.join(root, planned.generation), summaryBytes(generation));
              notify('summary');
            } else publishExpiry(root, summary, notify);
            if (isCompleted(root, planned)) return;
            withQuarantine(root, (quarantine) => {
              for (const file of planned.files) {
                deleteArtifact(root, quarantine, file, replay, () => notify('quarantined'));
                notify('deleted');
              }
            });
            complete(root, planned);
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
