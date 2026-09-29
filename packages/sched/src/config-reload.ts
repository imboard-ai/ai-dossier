/**
 * Hot config reload for the running engine (#883).
 *
 * `sched start` used to read config.json once at startup and hand that object
 * to every tick, while `sched status` re-read the file each call — so an edit
 * to a dispatch profile tier (e.g. `opus @ low` → `sonnet @ medium`) showed up
 * in `status` immediately and in the engine never: a batch member dispatched
 * after the edit still spawned the OLD model (imboard, 2026-09-29).
 *
 * The reloader is consulted once per tick. Its steady-state cost is two
 * `stat`s (a fingerprint compare); the file is re-parsed only when the
 * fingerprint moved. A reload that fails validation KEEPS the last good config
 * and reports the failure once per distinct edit — never every tick, never a
 * silent revert to built-in defaults (which is what the non-strict
 * `SchedStore.loadConfig` does for one-shot commands).
 */

import { dispatchSummary, resolveProfiledDispatch, tierExecutors } from './dispatch';
import type { SchedConfig } from './types';

export interface ConfigReloaderOptions {
  /** The config the engine started with (already passed through `derive`). */
  initial: SchedConfig;
  /** Strict load — must THROW on an invalid config (`SchedStore.loadConfigStrict`). */
  load: () => SchedConfig;
  /** Cheap change detector (`SchedStore.configFingerprint`). */
  fingerprint: () => string;
  /** Fingerprint taken BEFORE `initial` was loaded, so an edit in between is not marked seen. */
  initialFingerprint?: string;
  /** Startup-time overrides re-applied to every reloaded config (CLI flags, command auto-detect). */
  derive?: (config: SchedConfig) => SchedConfig;
  /** A changed config was adopted; `changes` is a human-readable dispatch diff (may be empty). */
  onReload?: (config: SchedConfig, changes: string[]) => void;
  /** A changed config was rejected; the previous one stays in force. */
  onInvalid?: (err: Error) => void;
}

export interface ConfigReloader {
  /** The effective config for THIS tick — reloads first when the files changed. */
  current(): SchedConfig;
}

/** One line per default/profile whose resolved tier ladder differs between two configs. */
export function dispatchDiff(before: SchedConfig, after: SchedConfig): string[] {
  const describe = (config: SchedConfig, profile: string | null): string => {
    try {
      return dispatchSummary(tierExecutors(resolveProfiledDispatch(config, profile)));
    } catch {
      return '(removed)';
    }
  };
  const names = new Set([
    ...Object.keys(before.dispatch?.dispatch_profiles ?? {}),
    ...Object.keys(after.dispatch?.dispatch_profiles ?? {}),
  ]);
  const out: string[] = [];
  for (const profile of [null, ...[...names].sort()]) {
    const was = describe(before, profile);
    const now = describe(after, profile);
    if (was !== now) out.push(`${profile ?? 'default'}: ${was} -> ${now}`);
  }
  return out;
}

export function createConfigReloader(opts: ConfigReloaderOptions): ConfigReloader {
  const derive = opts.derive ?? ((config: SchedConfig) => config);
  let active = opts.initial;
  let seen = opts.initialFingerprint ?? safeFingerprint(opts.fingerprint);
  return {
    current(): SchedConfig {
      const fingerprint = safeFingerprint(opts.fingerprint);
      if (fingerprint === seen) return active;
      // Mark seen BEFORE loading: an invalid edit reports once, then stays
      // quiet until the file changes again.
      seen = fingerprint;
      let next: SchedConfig;
      let changes: string[];
      try {
        next = derive(opts.load());
        changes = dispatchDiff(active, next);
      } catch (err) {
        opts.onInvalid?.(err as Error);
        return active;
      }
      active = next;
      // Outside the try: a throwing observer must not read as "invalid config".
      try {
        opts.onReload?.(next, changes);
      } catch {
        // observers are best-effort
      }
      return active;
    },
  };
}

function safeFingerprint(fingerprint: () => string): string {
  try {
    return fingerprint();
  } catch {
    return 'unreadable';
  }
}
