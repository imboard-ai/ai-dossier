/**
 * Individual coherence checks for dossier execution outputs.
 *
 * Each check is a pure function: (context) => diagnostics[].
 * Checks are lightweight and fast -- they catch messy failures,
 * not enforce strict contracts.
 */

import type { CoherenceContext, CoherenceDiagnostic } from './types';

// ---------------------------------------------------------------------------
// 1. Schema compliance — do outputs match declared output schemas?
// ---------------------------------------------------------------------------

export function checkSchemaCompliance(context: CoherenceContext): CoherenceDiagnostic[] {
  const diagnostics: CoherenceDiagnostic[] = [];
  if (!context.declaredSchemas) return diagnostics;

  for (const step of context.steps) {
    const schema = context.declaredSchemas.get(step.stepName);
    if (!schema) continue;

    // Check that declared configuration keys are present in outputs
    if (schema.configuration) {
      for (const declared of schema.configuration) {
        if (!(declared.key in step.outputs)) {
          diagnostics.push({
            checkId: 'schema-compliance',
            severity: 'warning',
            message: `Step "${step.stepName}" declares output "${declared.key}" but it was not reported`,
            stepName: step.stepName,
            field: declared.key,
          });
        }
      }
    }

    // Check for undeclared outputs (outputs not in any declared category)
    const declaredKeys = new Set<string>();
    if (schema.configuration) {
      for (const c of schema.configuration) {
        declaredKeys.add(c.key);
      }
    }

    if (declaredKeys.size > 0) {
      for (const key of Object.keys(step.outputs)) {
        if (!declaredKeys.has(key)) {
          diagnostics.push({
            checkId: 'schema-compliance',
            severity: 'info',
            message: `Step "${step.stepName}" reported undeclared output "${key}" — not in outputs.configuration`,
            stepName: step.stepName,
            field: key,
          });
        }
      }
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// 2. Anomaly detection — unexpected empty outputs, size outliers
// ---------------------------------------------------------------------------

/** Ratio threshold: a step's output count differs from the mean by more than this factor */
const SIZE_OUTLIER_FACTOR = 3;

export function checkAnomalies(context: CoherenceContext): CoherenceDiagnostic[] {
  const diagnostics: CoherenceDiagnostic[] = [];

  for (const step of context.steps) {
    // Empty output check
    if (Object.keys(step.outputs).length === 0) {
      diagnostics.push({
        checkId: 'anomaly-empty-output',
        severity: 'warning',
        message: `Step "${step.stepName}" completed with no outputs — expected at least one key`,
        stepName: step.stepName,
      });
      continue;
    }

    // Null / undefined value check
    for (const [key, value] of Object.entries(step.outputs)) {
      if (value === null || value === undefined) {
        diagnostics.push({
          checkId: 'anomaly-null-value',
          severity: 'warning',
          message: `Step "${step.stepName}" output "${key}" is ${value === null ? 'null' : 'undefined'}`,
          stepName: step.stepName,
          field: key,
        });
      }
      if (value === '') {
        diagnostics.push({
          checkId: 'anomaly-empty-value',
          severity: 'info',
          message: `Step "${step.stepName}" output "${key}" is an empty string`,
          stepName: step.stepName,
          field: key,
        });
      }
    }
  }

  // Size outlier detection: flag steps whose key count is drastically larger than
  // the median of all other steps. Using median (not mean) prevents a single outlier
  // from skewing the baseline.
  const completedSteps = context.steps.filter((s) => Object.keys(s.outputs).length > 0);
  if (completedSteps.length >= 3) {
    for (const step of completedSteps) {
      const size = Object.keys(step.outputs).length;
      const otherSizes = completedSteps
        .filter((s) => s !== step)
        .map((s) => Object.keys(s.outputs).length)
        .sort((a, b) => a - b);

      const median =
        otherSizes.length % 2 === 0
          ? (otherSizes[otherSizes.length / 2 - 1] + otherSizes[otherSizes.length / 2]) / 2
          : otherSizes[Math.floor(otherSizes.length / 2)];

      if (median > 0 && size / median > SIZE_OUTLIER_FACTOR) {
        diagnostics.push({
          checkId: 'anomaly-size-outlier',
          severity: 'info',
          message: `Step "${step.stepName}" has ${size} output keys — ${(size / median).toFixed(1)}x the median of ${median}`,
          stepName: step.stepName,
        });
      }
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// 3. Cross-step coherence — does step N's output make sense given step N-1?
// ---------------------------------------------------------------------------

/**
 * Extracts "entity-like" string values from an output record.
 * Looks for values that resemble paths, URLs, identifiers, etc.
 */
function extractEntityValues(outputs: Record<string, unknown>): Map<string, string> {
  const entities = new Map<string, string>();
  for (const [key, value] of Object.entries(outputs)) {
    if (typeof value === 'string' && value.length > 0) {
      entities.set(key, value);
    }
  }
  return entities;
}

export function checkCrossStepCoherence(context: CoherenceContext): CoherenceDiagnostic[] {
  const diagnostics: CoherenceDiagnostic[] = [];
  if (context.steps.length < 2) return diagnostics;

  // Build a map of all outputs from prior steps
  const priorOutputs = new Map<string, { value: string; fromStep: string }>();

  for (let i = 0; i < context.steps.length; i++) {
    const step = context.steps[i];

    if (i > 0) {
      // Check if this step references keys from prior steps with different values
      const currentEntities = extractEntityValues(step.outputs);

      for (const [key, currentValue] of currentEntities) {
        const prior = priorOutputs.get(key);
        if (prior && prior.value !== currentValue) {
          diagnostics.push({
            checkId: 'cross-step-value-drift',
            severity: 'warning',
            message:
              `Output key "${key}" changed from "${truncate(prior.value)}" (step "${prior.fromStep}") ` +
              `to "${truncate(currentValue)}" (step "${step.stepName}") — verify this is intentional`,
            stepName: step.stepName,
            field: key,
          });
        }
      }
    }

    // Add this step's outputs to the prior map
    const entities = extractEntityValues(step.outputs);
    for (const [key, value] of entities) {
      priorOutputs.set(key, { value, fromStep: step.stepName });
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// 4. Internal consistency — within a single step's outputs
// ---------------------------------------------------------------------------

export function checkInternalConsistency(context: CoherenceContext): CoherenceDiagnostic[] {
  const diagnostics: CoherenceDiagnostic[] = [];

  for (const step of context.steps) {
    const entries = Object.entries(step.outputs);
    if (entries.length === 0) continue;

    // Check for duplicate values under different keys (potential copy-paste / hallucination)
    // Only meaningful when there are at least 2 entries
    if (entries.length >= 2) {
      const valueMap = new Map<string, string[]>();
      for (const [key, value] of entries) {
        if (typeof value === 'string' && value.length > 0) {
          const existing = valueMap.get(value) || [];
          existing.push(key);
          valueMap.set(value, existing);
        }
      }

      const trivialValues = new Set(['true', 'false', 'yes', 'no', 'ok', 'none', 'null']);
      for (const [value, keys] of valueMap) {
        if (keys.length > 1 && value.length > 3) {
          if (!trivialValues.has(value.toLowerCase())) {
            diagnostics.push({
              checkId: 'internal-duplicate-values',
              severity: 'info',
              message:
                `Step "${step.stepName}" has identical value "${truncate(value)}" ` +
                `for keys: ${keys.join(', ')} — possible copy-paste error`,
              stepName: step.stepName,
            });
          }
        }
      }
    }

    // Check for boolean-like string inconsistencies (e.g., "true" vs true)
    for (const [key, value] of entries) {
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (lower === 'true' || lower === 'false') {
          diagnostics.push({
            checkId: 'internal-boolean-string',
            severity: 'info',
            message:
              `Step "${step.stepName}" output "${key}" is "${value}" (string) ` +
              `instead of ${lower === 'true'} (boolean) — may cause type mismatches downstream`,
            stepName: step.stepName,
            field: key,
          });
        }
      }
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(value: string, maxLen = 60): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 3)}...`;
}
