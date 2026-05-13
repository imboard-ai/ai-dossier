// Singleton TraceRecorder for the MCP server. Lazily constructed from the
// resolved trace config (env > project > user > defaults — see
// @ai-dossier/core/trace-config). Tests can inject a mock via setRecorder().

import {
  createTraceRecorder,
  resolveTraceConfig,
  type TraceRecorder,
  type TraceStatus,
} from '@ai-dossier/core';
import type { JourneySession } from './session';

let recorder: TraceRecorder | null = null;

export function getRecorder(): TraceRecorder {
  if (!recorder) {
    const config = resolveTraceConfig();
    if (config.enabled && config.url && config.token) {
      recorder = createTraceRecorder({ url: config.url, token: config.token });
    } else {
      // Returns a disabled (no-op) recorder when no config is in effect.
      recorder = createTraceRecorder({ url: '', token: '' });
    }
  }
  return recorder;
}

export function setRecorder(r: TraceRecorder | null): void {
  recorder = r;
}

/**
 * Fire-and-forget: finalize the trace for a terminated journey.
 * Computes duration from session.startedAt and session.completedAt
 * (falling back to "now" if completedAt hasn't been set yet).
 */
export function finalizeTrace(
  rec: TraceRecorder,
  session: JourneySession,
  status: TraceStatus
): void {
  const completedAt = session.completedAt ?? new Date();
  const durationMs = completedAt.getTime() - session.startedAt.getTime();
  rec.complete(session.id, {
    status,
    completed_at: completedAt.toISOString(),
    duration_ms: durationMs,
  });
}
