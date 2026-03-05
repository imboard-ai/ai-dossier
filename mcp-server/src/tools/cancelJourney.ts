/**
 * cancel_journey tool - Cancel an active journey session.
 * Returns a summary of what completed before cancellation.
 */

import type { JourneySummary } from '../orchestration/session';
import { buildSummary, getSession, updateSession } from '../orchestration/session';
import { logger } from '../utils/logger';

export interface CancelJourneyInput {
  journey_id: string;
  reason?: string;
}

export interface CancelJourneyOutput {
  summary: JourneySummary;
}

export interface CancelJourneyError {
  error: {
    type: 'not_found' | 'invalid_state' | 'unknown';
    message: string;
  };
}

export function cancelJourney(input: CancelJourneyInput): CancelJourneyOutput | CancelJourneyError {
  const { journey_id, reason } = input;

  if (!journey_id) {
    return { error: { type: 'unknown', message: 'journey_id is required' } };
  }

  const session = getSession(journey_id);
  if (!session) {
    return { error: { type: 'not_found', message: `No journey found with id: ${journey_id}` } };
  }

  if (session.status === 'completed' || session.status === 'cancelled') {
    return {
      error: {
        type: 'invalid_state',
        message: `Journey is already ${session.status}`,
      },
    };
  }

  // Mark the current running step as skipped if it was in progress
  const currentStep = session.steps[session.currentStepIndex];
  if (currentStep?.status === 'running') {
    currentStep.status = 'skipped';
  }

  // Mark all remaining pending steps as skipped
  for (let i = session.currentStepIndex + 1; i < session.steps.length; i++) {
    if (session.steps[i].status === 'pending') {
      session.steps[i].status = 'skipped';
    }
  }

  session.status = 'cancelled';
  session.completedAt = new Date();
  session.cancelReason = reason;
  updateSession(session);

  logger.info('Journey cancelled', {
    journeyId: journey_id,
    reason,
    completedSteps: session.steps.filter((s) => s.status === 'completed').length,
    totalSteps: session.steps.length,
  });

  return { summary: buildSummary(session) };
}
