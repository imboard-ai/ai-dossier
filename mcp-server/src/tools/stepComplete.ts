/**
 * step_complete tool - Advance a journey session to the next step.
 * Maps outputs to next step's inputs and returns the next step's dossier content.
 */

import { readFileSync } from 'node:fs';
import { type DossierFrontmatter, parseDossierContent } from '@ai-dossier/core';
import { extractDossierTraceInfo } from '../orchestration/dossier-trace-info';
import { finalizeTrace, getRecorder } from '../orchestration/recorder';
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

function fetchDossierContent(step: JourneyStep): {
  body: string;
  frontmatter: DossierFrontmatter | null;
} {
  if (step.source === 'local' && step.path) {
    try {
      const raw = readFileSync(step.path, 'utf8');
      try {
        const parsed = parseDossierContent(raw);
        return { body: parsed.body, frontmatter: parsed.frontmatter };
      } catch {
        return { body: raw, frontmatter: null };
      }
    } catch {
      return { body: '', frontmatter: null };
    }
  }
  return { body: '', frontmatter: null };
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

  // Fire-and-forget: append this step to the trace. `dossier_meta` carries
  // the version + checksum + signature metadata captured when the step's
  // dossier was first read, so the trace pins exactly which content ran.
  const recorder = getRecorder();
  recorder.appendStep(session.id, {
    step_id: `${currentStep.dossier}-${session.currentStepIndex}`,
    type: status,
    timestamp: new Date().toISOString(),
    dossier: currentStep.dossier,
    dossier_meta: currentStep.dossierMeta ?? null,
    index: session.currentStepIndex,
    outputs: outputs ?? null,
  });

  if (status === 'failed') {
    session.status = 'failed';
    session.completedAt = new Date();
    updateSession(session);

    finalizeTrace(recorder, session, 'failed');

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

    finalizeTrace(recorder, session, 'success');

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

  const { body, frontmatter } = fetchDossierContent(nextStep);
  // Cache audit metadata on the step so the next stepComplete includes
  // the same checksum/version when this step finishes.
  nextStep.dossierMeta = extractDossierTraceInfo(nextStep.dossier, frontmatter);

  updateSession(session);

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
