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
/**
 * No respawn storm. The minimum gap between watchdog starts is
 * `ENSURE_BASE_INTERVAL_MS * 2^streak` (capped), where `streak` counts starts
 * that were NOT followed by a live engine at the next check. At a 60 s cron
 * cadence: the first restart is immediate, the second waits 60 s, then 120 s,
 * 240 s … up to {@link ENSURE_MAX_INTERVAL_MS}. Seeing a live engine resets it.
 */
export const ENSURE_BASE_INTERVAL_MS = 30_000;
export const ENSURE_MAX_INTERVAL_MS = 30 * 60_000;
const ENSURE_LAST_MARKER = '.ensure-running-last';

interface EnsureRecord {
  at: number;
  streak: number;
}

function readRecord(file: string): EnsureRecord | null {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    // Older format: a bare timestamp.
    if (/^\d+$/.test(raw)) return { at: Number(raw), streak: 1 };
    const rec = JSON.parse(raw) as Partial<EnsureRecord>;
    return typeof rec.at === 'number' && typeof rec.streak === 'number'
      ? { at: rec.at, streak: rec.streak }
      : null;
  } catch {
    return null;
  }
}

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
  if (lease?.alive) {
    // A healthy engine ends the crash-loop episode.
    fs.rmSync(path.join(store.dir, ENSURE_LAST_MARKER), { force: true });
    return 'alive';
  }
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
  const last = readRecord(lastFile);
  const streak = last === null ? 0 : last.streak;
  if (last !== null) {
    const gap = Math.min(ENSURE_BASE_INTERVAL_MS * 2 ** (streak - 1), ENSURE_MAX_INTERVAL_MS);
    if (deps.now().getTime() - last.at < gap) return 'throttled';
  }
  fs.mkdirSync(store.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    lastFile,
    `${JSON.stringify({ at: deps.now().getTime(), streak: streak + 1 })}\n`,
    { mode: 0o600 }
  );
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
