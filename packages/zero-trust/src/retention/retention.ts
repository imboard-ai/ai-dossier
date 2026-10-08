import fs from 'node:fs';
import path from 'node:path';
import { RunStore } from '../controller/run-store';
import { assertDirectoryAncestors, publishPrivate, syncDirectory } from '../durable-fs';
import { assertSecretFree } from '../redaction';
import { contributionEvidence } from './evidence';
import { digest, inDirectory, jsonRecord, optionalBytes, refuse } from './files';

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
const maintenance = new Set(['summary.json', '.snapshot-expired']);

function tombstone(file: SweepFile): string {
  return `${path.posix.dirname(file.path)}/.zt-retention-${digest(`${file.path}:${file.dev}:${file.ino}`)}`;
}
function inventory(root: string, pending: readonly SweepFile[] = []) {
  const artifacts: SweepFile[] = [];
  const protectedFiles: Record<string, string> = {};
  let activity = 0;
  function walk(directory: string, prefix: string): void {
    for (const name of fs.readdirSync(directory).sort()) {
      const namedRelative = prefix ? `${prefix}/${name}` : name;
      const relative =
        pending.find((file) => tombstone(file) === namedRelative)?.path ?? namedRelative;
      if (!prefix && maintenance.has(name)) continue;
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) refuse();
      if (stat.isDirectory()) {
        inDirectory(directory, name, (pinned) => walk(pinned, relative));
      } else {
        if (!stat.isFile() || stat.nlink !== 1) refuse();
        const fd = fs.openSync(
          file,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
        let bytes: Buffer;
        try {
          const pinned = fs.fstatSync(fd);
          if (pinned.dev !== stat.dev || pinned.ino !== stat.ino) refuse();
          bytes = fs.readFileSync(fd);
          const after = fs.fstatSync(fd);
          if (
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs
          )
            refuse();
        } finally {
          fs.closeSync(fd);
        }
        const sha256 = digest(bytes);
        if (!name.endsWith('.guard') && !name.endsWith('.lock'))
          activity = Math.max(activity, stat.mtimeMs);
        if (relative.startsWith('artifacts/')) {
          if (artifacts.some((file) => file.path === relative)) refuse();
          artifacts.push({
            path: relative,
            dev: stat.dev,
            ino: stat.ino,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            sha256,
          });
        } else protectedFiles[relative] = sha256;
      }
    }
  }
  walk(root, '');
  return { artifacts, protectedDigest: digest(JSON.stringify(protectedFiles)), activity };
}
export function readContributionSummary(store: RunStore): ContributionSummary | null {
  return store.withPinnedDirectory((root) => {
    const bytes = optionalBytes(root, 'summary.json');
    if (!bytes) {
      if (optionalBytes(root, '.snapshot-expired')) refuse();
      return null;
    }
    const raw = jsonRecord(bytes) as ContributionSummary;
    if (
      raw.schemaVersion !== 'ztfc-summary-v1' ||
      raw.runId !== store.runId ||
      raw.snapshotExpired !== true ||
      !raw.sweep ||
      raw.sweep.runId !== store.runId ||
      !Array.isArray(raw.sweep.files) ||
      !raw.facts
    )
      refuse();
    if (
      !Number.isSafeInteger(raw.sweep.retentionDays) ||
      raw.sweep.retentionDays < 1 ||
      !Number.isFinite(raw.sweep.activity) ||
      !Number.isSafeInteger(raw.sweep.dev) ||
      !Number.isSafeInteger(raw.sweep.ino) ||
      !/^[a-f0-9]{64}$/u.test(raw.sweep.protectedDigest) ||
      !/^[a-f0-9]{64}$/u.test(raw.sweep.evidenceDigest)
    )
      refuse();
    const paths = new Set<string>();
    for (const file of raw.sweep.files) {
      if (
        !/^artifacts\/(?!.*(?:^|\/)\.\.?\/)[^\\]+$/u.test(file.path) ||
        file.path.split('/').some((c: string) => !c || c === '.' || c === '..') ||
        !/^[a-f0-9]{64}$/u.test(file.sha256) ||
        ![file.dev, file.ino, file.size].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        !Number.isFinite(file.mtimeMs)
      )
        refuse();
      if (paths.has(file.path)) refuse();
      paths.add(file.path);
    }
    if (raw.facts.evidenceDigest !== raw.sweep.evidenceDigest) refuse();
    if (JSON.stringify(raw.facts) !== JSON.stringify(contributionEvidence(store, root))) refuse();
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
        refuse();
    }
    return raw;
  });
}
/** Dry run only. Explicit days overrides each config; omission uses config's default 30. */
export function planSweep(root: string, now: Date | string, retentionDays?: number): SweepPlan {
  assertDirectoryAncestors(root);
  const at = now instanceof Date ? now.toISOString() : now;
  if (
    !Number.isFinite(Date.parse(at)) ||
    (retentionDays !== undefined && (!Number.isSafeInteger(retentionDays) || retentionDays < 1))
  )
    refuse();
  root = path.resolve(root);
  const contributions: SweepContribution[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (!/^ztc-[a-f0-9]{16}$/u.test(name)) refuse();
    const store = RunStore.open(root, `${name}-run-1`, { readOnly: true });
    try {
      if (store.run.state === 'blocked_cleanup') continue;
      store.withPinnedDirectory((directory) => {
        const summary = readContributionSummary(store);
        if (summary) {
          const scan = inventory(directory, summary.sweep.files);
          const facts = contributionEvidence(store, directory);
          const stat = fs.statSync(directory);
          if (
            summary.sweep.dev !== stat.dev ||
            summary.sweep.ino !== stat.ino ||
            scan.protectedDigest !== summary.sweep.protectedDigest ||
            JSON.stringify(facts) !== JSON.stringify(summary.facts) ||
            Math.max(Date.parse(store.run.updatedAt), scan.activity) > summary.sweep.activity ||
            (retentionDays ?? store.config.retentionDays) !== summary.sweep.retentionDays ||
            summary.sweep.activity >= Date.parse(at) - summary.sweep.retentionDays * 86400000
          )
            refuse();
          for (const file of scan.artifacts) {
            const planned = summary.sweep.files.find((item) => item.path === file.path);
            if (!planned || JSON.stringify(file) !== JSON.stringify(planned)) refuse();
          }
          contributions.push(summary.sweep);
          return;
        }
        const scan = inventory(directory);
        const activity = Math.max(Date.parse(store.run.updatedAt), scan.activity);
        const days = retentionDays ?? store.config.retentionDays;
        if (activity >= Date.parse(at) - days * 86400000) return;
        const facts = contributionEvidence(store, directory);
        const stat = fs.statSync(directory);
        contributions.push({
          runId: store.runId,
          dev: stat.dev,
          ino: stat.ino,
          retentionDays: days,
          activity,
          protectedDigest: scan.protectedDigest,
          evidenceDigest: facts.evidenceDigest,
          files: scan.artifacts,
        });
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
}
/** Explicit application. The original process-local plan is required; replan after restart.
 * Fault hook is a controller test seam, invoked only at durable crash boundaries. */
export function applySweep(
  plan: SweepPlan,
  fault?: (point: 'summary' | 'expired' | 'quarantined' | 'deleted') => void
): void {
  const serialized = issuedPlans.get(plan);
  if (!serialized || serialized !== JSON.stringify(plan)) refuse();
  // Never reread caller-controlled accessors or arrays after authentication.
  plan = JSON.parse(serialized) as SweepPlan;
  for (const planned of plan.contributions) {
    const store = RunStore.open(plan.root, planned.runId, { readOnly: true });
    try {
      store.withPinnedDirectory((root) => {
        const stat = fs.statSync(root);
        if (
          stat.dev !== planned.dev ||
          stat.ino !== planned.ino ||
          store.run.state === 'blocked_cleanup'
        )
          refuse();
        const prior = readContributionSummary(store);
        if (prior && JSON.stringify(prior.sweep) !== JSON.stringify(planned)) refuse();
        const scan = inventory(root, prior ? planned.files : []);
        const facts = contributionEvidence(store, root);
        if (prior && JSON.stringify(prior.facts) !== JSON.stringify(facts)) refuse();
        if (
          scan.protectedDigest !== planned.protectedDigest ||
          facts.evidenceDigest !== planned.evidenceDigest ||
          Math.max(Date.parse(store.run.updatedAt), scan.activity) > planned.activity ||
          (!prior && Math.max(Date.parse(store.run.updatedAt), scan.activity) !== planned.activity)
        )
          refuse();
        if (
          (plan.retentionDays ?? store.config.retentionDays) !== planned.retentionDays ||
          planned.activity >= Date.parse(plan.now) - planned.retentionDays * 86400000
        )
          refuse();
        const remaining = new Map(scan.artifacts.map((file) => [file.path, file]));
        for (const file of planned.files) {
          const present = remaining.get(file.path);
          if ((!present && !prior) || (present && JSON.stringify(present) !== JSON.stringify(file)))
            refuse();
          remaining.delete(file.path);
        }
        if (remaining.size) refuse();
        const summary: ContributionSummary = prior ?? {
          schemaVersion: 'ztfc-summary-v1',
          runId: store.runId,
          snapshotExpired: true,
          facts,
          sweep: planned,
        };
        assertSecretFree(summary);
        publishPrivate(path.join(root, 'summary.json'), Buffer.from(JSON.stringify(summary)));
        fault?.('summary');
        publishPrivate(
          path.join(root, '.snapshot-expired'),
          Buffer.from(
            JSON.stringify({
              runId: store.runId,
              snapshotExpired: true,
              summaryDigest: digest(JSON.stringify(summary)),
            })
          )
        );
        fault?.('expired');
        for (const file of planned.files) {
          inDirectory(root, path.posix.dirname(file.path), (parent) => {
            const name = path.posix.basename(file.path);
            const quarantine = path.posix.basename(tombstone(file));
            const source = path.join(parent, name);
            const held = path.join(parent, quarantine);
            try {
              // Atomic isolation of the named leaf before checking/deleting it.
              // A swapped leaf is retained and refused, never silently removed.
              let heldExists = false;
              try {
                fs.lstatSync(held);
                heldExists = true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
              if (heldExists) {
                try {
                  fs.lstatSync(source);
                  refuse();
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
              } else {
                fs.renameSync(source, held);
                syncDirectory(parent);
                fault?.('quarantined');
              }
              const current = fs.lstatSync(held);
              if (
                !current.isFile() ||
                current.nlink !== 1 ||
                current.dev !== file.dev ||
                current.ino !== file.ino ||
                current.size !== file.size ||
                current.mtimeMs !== file.mtimeMs ||
                digest(fs.readFileSync(held)) !== file.sha256
              )
                refuse();
              fs.unlinkSync(held);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            syncDirectory(parent);
          });
          fault?.('deleted');
        }
      });
    } finally {
      store.close();
    }
  }
}
export function assertResumable(store: RunStore): void {
  store.assertResumable();
}
