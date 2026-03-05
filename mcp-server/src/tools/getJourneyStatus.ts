/**
 * get_journey_status tool - Return current state of a journey session.
 */

import type { JourneySummary } from '../orchestration/session';
import { buildSummary, getSession } from '../orchestration/session';
import { logger } from '../utils/logger';

export interface GetJourneyStatusInput {
  journey_id: string;
}

export interface GetJourneyStatusOutput {
  summary: JourneySummary;
  current_step?: {
    index: number;
    dossier: string;
    status: string;
    context?: string;
  };
  steps: Array<{
    index: number;
    dossier: string;
    status: string;
  }>;
}

export interface GetJourneyStatusError {
  error: {
    type: 'not_found' | 'unknown';
    message: string;
  };
}

export function getJourneyStatus(
  input: GetJourneyStatusInput
): GetJourneyStatusOutput | GetJourneyStatusError {
  const { journey_id } = input;

  if (!journey_id) {
    return { error: { type: 'unknown', message: 'journey_id is required' } };
  }

  const session = getSession(journey_id);
  if (!session) {
    return { error: { type: 'not_found', message: `No journey found with id: ${journey_id}` } };
  }

  logger.info('Journey status requested', { journeyId: journey_id, status: session.status });

  const steps = session.steps.map((step, index) => ({
    index,
    dossier: step.dossier,
    status: step.status,
  }));

  const currentIndex = session.currentStepIndex;
  const currentStep =
    session.status === 'running' && currentIndex < session.steps.length
      ? {
          index: currentIndex,
          dossier: session.steps[currentIndex].dossier,
          status: session.steps[currentIndex].status,
          context: session.steps[currentIndex].injectedContext,
        }
      : undefined;

  return {
    summary: buildSummary(session),
    current_step: currentStep,
    steps,
  };
}
