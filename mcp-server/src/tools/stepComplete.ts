/**
 * step_complete tool - Advance a journey session to the next step.
 * Maps outputs to next step's inputs and returns the next step's dossier content.
 */

import { readFileSync } from 'node:fs';
import { parseDossierContent } from '@ai-dossier/core';
import type { JourneyStep, JourneySummary } from '../orchestration/session';
import {
  buildOutputContext,
  buildSummary,
  getSession,
  updateSession,
} from '../orchestration/session';
import { logger } from '../utils/logger';
import type { StepPayload } from './startJourney';

export interface StepCompleteInput {
  journey_id: string;
  outputs?: Record<string, unknown>;
  status: 'completed' | 'failed';
}

export interface StepCompleteRunning {
  status: 'running';
  step: StepPayload;
}

export interface StepCompleteDone {
  status: 'completed' | 'failed';
  summary: JourneySummary;
}

export interface StepCompleteError {
  error: {
    type: 'not_found' | 'invalid_state' | 'unknown';
    message: string;
  };
}

export type StepCompleteOutput = StepCompleteRunning | StepCompleteDone;

function fetchDossierBody(step: JourneyStep): string {
  if (step.source === 'local' && step.path) {
    try {
      const raw = readFileSync(step.path, 'utf8');
      try {
        return parseDossierContent(raw).body;
      } catch {
        return raw;
      }
    } catch {
      return '';
    }
  }
  return '';
}

export async function stepComplete(
  input: StepCompleteInput
): Promise<StepCompleteOutput | StepCompleteError> {
  const { journey_id, outputs, status } = input;

  if (!journey_id) {
    return { error: { type: 'unknown', message: 'journey_id is required' } };
  }

  const session = getSession(journey_id);
  if (!session) {
    return { error: { type: 'not_found', message: `No journey found with id: ${journey_id}` } };
  }

  if (
    session.status === 'completed' ||
    session.status === 'cancelled' ||
    session.status === 'failed'
  ) {
    return {
      error: {
        type: 'invalid_state',
        message: `Journey is already ${session.status}`,
      },
    };
  }

  const currentStep = session.steps[session.currentStepIndex];

  // Record outputs and mark current step
  if (outputs) {
    currentStep.collectedOutputs = outputs;
    session.outputs[currentStep.dossier] = outputs;
  }
  currentStep.status = status;

  if (status === 'failed') {
    session.status = 'failed';
    session.completedAt = new Date();
    updateSession(session);

    logger.info('Journey failed at step', {
      journeyId: journey_id,
      stepIndex: session.currentStepIndex,
      dossier: currentStep.dossier,
    });

    return { status: 'failed', summary: buildSummary(session) };
  }

  // Find next step (skip optional steps that are already marked skipped)
  const nextIndex = session.currentStepIndex + 1;

  if (nextIndex >= session.steps.length) {
    session.status = 'completed';
    session.completedAt = new Date();
    updateSession(session);

    logger.info('Journey completed', {
      journeyId: journey_id,
      totalSteps: session.steps.length,
    });

    return { status: 'completed', summary: buildSummary(session) };
  }

  // Advance to next step
  session.currentStepIndex = nextIndex;
  const nextStep = session.steps[nextIndex];
  nextStep.status = 'running';

  const context = buildOutputContext(session.outputs);
  nextStep.injectedContext = context;

  updateSession(session);

  const body = fetchDossierBody(nextStep);

  logger.info('Journey advanced to next step', {
    journeyId: journey_id,
    stepIndex: nextIndex,
    dossier: nextStep.dossier,
  });

  return {
    status: 'running',
    step: {
      index: nextIndex,
      dossier: nextStep.dossier,
      body,
      context,
    },
  };
}
