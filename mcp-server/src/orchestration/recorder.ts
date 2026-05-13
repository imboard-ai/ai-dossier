// Singleton TraceRecorder for the MCP server. Lazily constructed from
// env vars (DOSSIER_TRACE_URL, DOSSIER_TRACE_TOKEN). Tests can inject a
// mock via setRecorder() to assert calls without hitting the network.

import { createTraceRecorder, type TraceRecorder } from '@ai-dossier/core';

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
