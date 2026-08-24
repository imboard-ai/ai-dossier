/**
 * Human-readable elapsed times.
 *
 * The CLI reports durations in three unrelated places — cache age, trace timings, and
 * runstate phase spans — and each grew its own formatter. These are the shared ones.
 */

export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86400;
export const MILLIS_PER_SECOND = 1000;

/**
 * Seconds as the largest two units that carry information: `45s`, `5m 3s`, `2h 14m`,
 * `1d 3h`.
 *
 * Two units because one is too coarse to compare runs (`2h` hides 59 minutes) and three is
 * noise at these magnitudes. Negative input keeps its sign rather than being clamped —
 * a backwards span is a real signal (see `runstate-stats`), not a rendering accident.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return `-${formatDuration(-seconds)}`;
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s`;
  if (seconds < SECONDS_PER_HOUR) {
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m ${seconds % SECONDS_PER_MINUTE}s`;
  }
  if (seconds < SECONDS_PER_DAY) {
    const hours = Math.floor(seconds / SECONDS_PER_HOUR);
    const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    return `${hours}h ${minutes}m`;
  }
  const days = Math.floor(seconds / SECONDS_PER_DAY);
  return `${days}d ${Math.floor((seconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR)}h`;
}

/** A duration for a table cell: human form plus the raw seconds it was derived from. */
export function formatDurationCell(seconds: number | null): string {
  return seconds === null ? '-' : `${formatDuration(seconds)} (${seconds}s)`;
}

/**
 * An age as a single rounded unit: `45s`, `3m`, `2h`, `9d`.
 *
 * Coarser than {@link formatDuration} on purpose — "how stale is this cache entry" needs
 * one glanceable unit, not a precise span. `suffix` appends e.g. `' ago'`.
 */
export function formatAge(ageMs: number, suffix = ''): string {
  const seconds = Math.round(ageMs / MILLIS_PER_SECOND);
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}s${suffix}`;
  const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
  if (minutes < 60) return `${minutes}m${suffix}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h${suffix}`;
  return `${Math.round(hours / 24)}d${suffix}`;
}
