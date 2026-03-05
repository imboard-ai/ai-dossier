/**
 * Journey session state and in-memory store.
 * Tracks multi-dossier execution from start to finish.
 */

import { randomUUID } from 'node:crypto';
import type { PhaseEntry } from './types';

export interface JourneyStep {
  dossier: string;
  source: 'local' | 'registry';
  path?: string;
  condition: 'required' | 'optional' | 'suggested';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  injectedContext?: string;
  collectedOutputs?: Record<string, unknown>;
}

export interface JourneySession {
  id: string;
  graphId: string;
  steps: JourneyStep[];
  currentStepIndex: number;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  outputs: Record<string, Record<string, unknown>>; // dossier name → collected outputs
  startedAt: Date;
  completedAt?: Date;
  cancelReason?: string;
}

const sessions = new Map<string, JourneySession>();

export function stepsFromPhases(entries: PhaseEntry[]): JourneyStep[] {
  return entries.map((entry) => ({
    dossier: entry.name,
    source: entry.source,
    path: entry.path,
    condition: entry.condition,
    status: 'pending' as const,
  }));
}

export function createSession(graphId: string, steps: JourneyStep[]): JourneySession {
  const session: JourneySession = {
    id: randomUUID(),
    graphId,
    steps,
    currentStepIndex: 0,
    status: 'pending',
    outputs: {},
    startedAt: new Date(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): JourneySession | undefined {
  return sessions.get(id);
}

export function updateSession(session: JourneySession): void {
  sessions.set(session.id, session);
}

export function buildOutputContext(outputs: Record<string, Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [dossierName, dossierOutputs] of Object.entries(outputs)) {
    for (const [key, value] of Object.entries(dossierOutputs)) {
      parts.push(`${key}=${String(value)} (from ${dossierName})`);
    }
  }
  return parts.length > 0 ? `Available from previous steps: ${parts.join(', ')}` : '';
}

export interface JourneySummary {
  journey_id: string;
  status: JourneySession['status'];
  total_steps: number;
  completed_steps: number;
  failed_steps: number;
  outputs: Record<string, Record<string, unknown>>;
  started_at: string;
  completed_at?: string;
  cancel_reason?: string;
}

export function buildSummary(session: JourneySession): JourneySummary {
  const completed = session.steps.filter((s) => s.status === 'completed').length;
  const failed = session.steps.filter((s) => s.status === 'failed').length;
  return {
    journey_id: session.id,
    status: session.status,
    total_steps: session.steps.length,
    completed_steps: completed,
    failed_steps: failed,
    outputs: session.outputs,
    started_at: session.startedAt.toISOString(),
    completed_at: session.completedAt?.toISOString(),
    cancel_reason: session.cancelReason,
  };
}
