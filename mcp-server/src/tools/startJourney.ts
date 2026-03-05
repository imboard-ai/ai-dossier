/**
 * start_journey tool - Create a journey session from a resolved graph.
 * Returns the first step's dossier content with any injected context.
 */

import { readFileSync } from 'node:fs';
import { parseDossierContent } from '@ai-dossier/core';
import { createSession, stepsFromPhases, updateSession } from '../orchestration/session';
import type { PhaseEntry } from '../orchestration/types';
import { getGraph } from '../utils/graphStore';
import { logger } from '../utils/logger';

export interface StartJourneyInput {
  graph_id: string;
}

export interface StepPayload {
  index: number;
  dossier: string;
  body: string;
  context: string;
}

export interface StartJourneyOutput {
  journey_id: string;
  step: StepPayload;
  total_steps: number;
}

export interface StartJourneyError {
  error: {
    type: 'not_found' | 'empty_graph' | 'unknown';
    message: string;
  };
}

/**
 * Fetch the markdown body of a dossier step.
 * Local dossiers are read from disk; registry dossiers return empty string as fallback.
 */
function fetchDossierBody(entry: Pick<PhaseEntry, 'source' | 'path' | 'name'>): string {
  if (entry.source === 'local' && entry.path) {
    try {
      const raw = readFileSync(entry.path, 'utf8');
      try {
        return parseDossierContent(raw).body;
      } catch {
        return raw;
      }
    } catch {
      logger.warn('Could not read dossier file', { path: entry.path });
      return '';
    }
  }
  // Registry dossiers: body is not available without a download step
  return '';
}

/**
 * Flatten execution plan phases into an ordered step list.
 */
function flattenPhases(plan: { phases: Array<{ dossiers: PhaseEntry[] }> }): PhaseEntry[] {
  const seen = new Set<string>();
  const result: PhaseEntry[] = [];
  for (const phase of plan.phases) {
    for (const entry of phase.dossiers) {
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        result.push(entry);
      }
    }
  }
  return result;
}

export async function startJourney(
  input: StartJourneyInput
): Promise<StartJourneyOutput | StartJourneyError> {
  const { graph_id } = input;

  if (!graph_id) {
    return { error: { type: 'unknown', message: 'graph_id is required' } };
  }

  const plan = getGraph(graph_id);
  if (!plan) {
    return { error: { type: 'not_found', message: `No graph found with id: ${graph_id}` } };
  }

  const entries = flattenPhases(plan);
  if (entries.length === 0) {
    return { error: { type: 'empty_graph', message: 'Graph has no steps to execute' } };
  }

  const steps = stepsFromPhases(entries);
  const session = createSession(graph_id, steps);

  // Start the first step
  session.steps[0].status = 'running';
  session.status = 'running';
  updateSession(session);

  const first = entries[0];
  const body = fetchDossierBody(first);

  logger.info('Journey started', {
    journeyId: session.id,
    graphId: graph_id,
    totalSteps: steps.length,
    firstStep: first.name,
  });

  return {
    journey_id: session.id,
    step: {
      index: 0,
      dossier: first.name,
      body,
      context: '',
    },
    total_steps: steps.length,
  };
}
