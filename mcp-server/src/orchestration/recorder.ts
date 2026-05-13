// Singleton TraceRecorder for the MCP server. Lazily constructed from
// env vars (DOSSIER_TRACE_URL, DOSSIER_TRACE_TOKEN). Tests can inject a
// mock via setRecorder() to assert calls without hitting the network.

import { createTraceRecorder, type TraceRecorder, type TraceStatus } from '@ai-dossier/core';
import type { JourneySession } from './session';

let recorder: TraceRecorder | null = null;

export function getRecorder(): TraceRecorder {
  if (!recorder) {
    recorder = createTraceRecorder();
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
