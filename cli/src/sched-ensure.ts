/**
 * `sched ensure-running` — the non-systemd watchdog (#945 AC1). Run every
 * minute (cron): if no live engine holds the lease, raise the once-per-episode
 * stale-lease alert and start one, detached, with its output appended to
 * `<sched-dir>/engine.log`. Starting is race-safe by construction — the engine
 * itself takes the lease atomically, so two watchdogs (or a watchdog and a
 * systemd unit) can never run two engines.
 *
 * `--disable` / `--enable` toggle a marker file so an operator can stop the
 * engine on purpose without the watchdog resurrecting it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AlertNotifier } from '@ai-dossier/sched';
import { checkStaleLeaseAlert, type Journal, type SchedStore } from '@ai-dossier/sched';

export const ENSURE_DISABLED_MARKER = '.ensure-running-disabled';
/** No respawn storm: a crash-looping engine is started at most this often. */
export const ENSURE_MIN_INTERVAL_MS = 30_000;
const ENSURE_LAST_MARKER = '.ensure-running-last';

export type EnsureOutcome = 'alive' | 'disabled' | 'throttled' | 'started' | 'start-failed';

export interface EnsureDeps {
  store: SchedStore;
  journal: Journal;
  notify: AlertNotifier;
  /** Spawn the engine detached; returns its pid or null when the spawn failed. */
  spawnEngine: (logFile: string) => number | null;
  now: () => Date;
}

export function setEnsureDisabled(store: SchedStore, disabled: boolean): void {
  const marker = path.join(store.dir, ENSURE_DISABLED_MARKER);
  if (disabled) {
    fs.mkdirSync(store.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } else {
    fs.rmSync(marker, { force: true });
  }
}

export function ensureRunning(deps: EnsureDeps): EnsureOutcome {
  const { store, journal } = deps;
  if (fs.existsSync(path.join(store.dir, ENSURE_DISABLED_MARKER))) return 'disabled';
  const lease = store.engineLeaseStatus();
  if (lease?.alive) return 'alive';
  // Dead or absent: alert (deduped per episode), then bring the engine back.
  try {
    checkStaleLeaseAlert(store, journal, deps.notify, deps.now());
  } catch (err) {
    // An unreadable state must not stop the restart attempt — the alert is advisory.
    process.stderr.write(
      `⚠ sched ensure-running: stale-lease alert skipped: ${(err as Error).message}\n`
    );
  }

  const lastFile = path.join(store.dir, ENSURE_LAST_MARKER);
  try {
    const last = Number(fs.readFileSync(lastFile, 'utf8').trim());
    if (Number.isFinite(last) && deps.now().getTime() - last < ENSURE_MIN_INTERVAL_MS) {
      return 'throttled';
    }
  } catch {
    // never started by a watchdog
  }
  fs.mkdirSync(store.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(lastFile, `${deps.now().getTime()}\n`, { mode: 0o600 });
  const pid = deps.spawnEngine(path.join(store.dir, 'engine.log'));
  journal.append(
    {
      event: 'engine-started',
      ...(pid !== null ? { pid } : {}),
      reason: pid !== null ? 'ensure-running' : 'ensure-running-spawn-failed',
      detail:
        pid !== null
          ? `watchdog started the engine (${lease ? `stale lease pid ${lease.pid}` : 'no lease'})`
          : 'watchdog could not spawn the engine',
    },
    deps.now()
  );
  return pid !== null ? 'started' : 'start-failed';
}
