/**
 * start_journey tool - Create a journey session from a resolved graph.
 * Returns the first step's dossier content with any injected context.
 */

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { type DossierFrontmatter, parseDossierContent } from '@ai-dossier/core';
import { extractDossierTraceInfo } from '../orchestration/dossier-trace-info';
import { getRecorder } from '../orchestration/recorder';
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
 * Fetch the body + parsed frontmatter of a dossier step. The frontmatter
 * is returned (when parseable) so callers can record audit metadata
 * (version, checksum, signature) in the execution trace.
 *
 * Local dossiers are read from disk; registry dossiers return an empty
 * body + null frontmatter as fallback.
 */
export function fetchDossierContent(entry: Pick<PhaseEntry, 'source' | 'path' | 'name'>): {
  body: string;
  frontmatter: DossierFrontmatter | null;
} {
  if (entry.source === 'local' && entry.path) {
    try {
      const raw = readFileSync(entry.path, 'utf8');
      try {
        const parsed = parseDossierContent(raw);
        return { body: parsed.body, frontmatter: parsed.frontmatter };
      } catch {
        return { body: raw, frontmatter: null };
      }
    } catch {
      logger.warn('Could not read dossier file', { path: entry.path });
      return { body: '', frontmatter: null };
    }
  }
  // Registry dossiers: body is not available without a download step
  return { body: '', frontmatter: null };
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
  const { body, frontmatter } = fetchDossierContent(first);

  // Cache audit metadata on the session step so stepComplete can include
  // the same checksum/version on the appendStep payload — without
  // re-reading the file or trusting Claude's report.
  const dossierMeta = extractDossierTraceInfo(first.name, frontmatter);
  session.steps[0].dossierMeta = dossierMeta;
  updateSession(session);

  logger.info('Journey started', {
    journeyId: session.id,
    graphId: graph_id,
    totalSteps: steps.length,
    firstStep: first.name,
  });

  // Fire-and-forget: opens a trace if DOSSIER_TRACE_URL/TOKEN are set.
  getRecorder().create({
    trace_id: session.id,
    dossier: dossierMeta,
    agent: { name: 'mcp-server', host: hostname() },
    started_at: session.startedAt.toISOString(),
    status: 'running',
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
