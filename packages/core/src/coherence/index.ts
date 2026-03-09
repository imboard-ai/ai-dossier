/**
 * Output coherence validation for dossier execution results.
 *
 * Inspired by Anthropic's ICLR 2026 finding that AI fails incoherently
 * on complex tasks (not systematically). This module provides lightweight
 * sanity checks that catch the messy failures:
 *
 * - Schema compliance: do outputs match declared output schemas?
 * - Anomaly detection: unexpected empty outputs, null values, size outliers
 * - Cross-step coherence: does step N's output make sense given step N-1?
 * - Internal consistency: duplicate values, type mismatches within a step
 *
 * Usage:
 *   import { validateCoherence } from '@ai-dossier/core';
 *
 *   const result = validateCoherence({
 *     steps: [
 *       { stepName: 'setup', stepIndex: 0, outputs: { path: '/tmp/app' } },
 *       { stepName: 'build', stepIndex: 1, outputs: { artifact: '/tmp/app/dist' } },
 *     ],
 *   });
 *
 *   if (!result.coherent) {
 *     console.warn('Coherence issues found:', result.diagnostics);
 *   }
 */

import {
  checkAnomalies,
  checkCrossStepCoherence,
  checkInternalConsistency,
  checkSchemaCompliance,
} from './checks';
import type { CoherenceContext, CoherenceDiagnostic, CoherenceResult } from './types';

export type {
  CoherenceContext,
  CoherenceDiagnostic,
  CoherenceResult,
  CoherenceSeverity,
  DeclaredOutputSchema,
  StepOutput,
} from './types';

/**
 * Run all coherence checks against a set of step outputs.
 * Returns a result with diagnostics and summary counts.
 */
export function validateCoherence(context: CoherenceContext): CoherenceResult {
  const diagnostics: CoherenceDiagnostic[] = [
    ...checkSchemaCompliance(context),
    ...checkAnomalies(context),
    ...checkCrossStepCoherence(context),
    ...checkInternalConsistency(context),
  ];

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length;
  const infoCount = diagnostics.filter((d) => d.severity === 'info').length;

  return {
    diagnostics,
    errorCount,
    warningCount,
    infoCount,
    coherent: errorCount === 0 && warningCount === 0,
  };
}

/**
 * Validate coherence for a single step's outputs (e.g., called after each step_complete).
 * This is a lighter-weight version that only checks the latest step against prior context.
 */
export function validateStepCoherence(
  currentStep: { stepName: string; stepIndex: number; outputs: Record<string, unknown> },
  priorSteps: Array<{ stepName: string; stepIndex: number; outputs: Record<string, unknown> }>,
  declaredSchema?: Map<string, import('./types').DeclaredOutputSchema>
): CoherenceResult {
  const context: CoherenceContext = {
    steps: [...priorSteps, currentStep],
    declaredSchemas: declaredSchema,
  };

  // Run all checks but filter to only diagnostics about the current step
  const allDiagnostics: CoherenceDiagnostic[] = [
    ...checkSchemaCompliance({
      steps: [currentStep],
      declaredSchemas: declaredSchema,
    }),
    ...checkAnomalies({
      steps: [currentStep],
      declaredSchemas: declaredSchema,
    }),
    ...checkCrossStepCoherence(context),
    ...checkInternalConsistency({
      steps: [currentStep],
    }),
  ];

  const errorCount = allDiagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = allDiagnostics.filter((d) => d.severity === 'warning').length;
  const infoCount = allDiagnostics.filter((d) => d.severity === 'info').length;

  return {
    diagnostics: allDiagnostics,
    errorCount,
    warningCount,
    infoCount,
    coherent: errorCount === 0 && warningCount === 0,
  };
}
