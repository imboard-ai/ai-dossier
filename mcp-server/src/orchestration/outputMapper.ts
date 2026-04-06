/**
 * Cross-dossier output mapper.
 * Connects outputs from completed dossier steps to the inputs of downstream steps,
 * enabling automatic data flow in multi-dossier journeys.
 *
 * Schema fields consumed:
 *   inputs.from_dossiers[].{ source_dossier, output_name, usage }
 *   outputs.configuration[].{ key, consumed_by, export_as }
 */

import { logger } from '../utils/logger';
import type { DossierNode, ExecutionPlan, FromDossierDeclaration } from './types';

// ---------------------------------------------------------------------------
// In-memory storage: journeyId → dossierName → outputKey → value
// ---------------------------------------------------------------------------

const MAX_JOURNEYS = 1000;
const journeyOutputStore = new Map<string, Map<string, Map<string, unknown>>>();

export function initJourneyOutputs(journeyId: string): void {
  if (!journeyOutputStore.has(journeyId)) {
    // Evict oldest entry if at capacity
    if (journeyOutputStore.size >= MAX_JOURNEYS) {
      const oldest = journeyOutputStore.keys().next().value!;
      journeyOutputStore.delete(oldest);
      logger.warn('Journey output store at capacity, evicted oldest entry', {
        evicted: oldest,
        maxJourneys: MAX_JOURNEYS,
      });
    }
    journeyOutputStore.set(journeyId, new Map());
  }
}

/**
 * Store outputs reported by the LLM after completing a step.
 */
export function collectOutputs(
  journeyId: string,
  dossierName: string,
  outputs: Record<string, unknown>
): void {
  if (!journeyOutputStore.has(journeyId)) {
    initJourneyOutputs(journeyId);
  }
  const journey = journeyOutputStore.get(journeyId)!;
  const existing = journey.get(dossierName) ?? new Map<string, unknown>();
  for (const [key, value] of Object.entries(outputs)) {
    existing.set(key, value);
  }
  journey.set(dossierName, existing);
}

/**
 * Get all collected outputs for a journey.
 */
export function getJourneyOutputs(journeyId: string): Map<string, Map<string, unknown>> {
  return journeyOutputStore.get(journeyId) ?? new Map();
}

/**
 * Remove journey outputs from memory (e.g. on cancel or completion).
 */
export function clearJourneyOutputs(journeyId: string): void {
  journeyOutputStore.delete(journeyId);
}

// ---------------------------------------------------------------------------
// Graph-resolution time validation
// ---------------------------------------------------------------------------

export interface MappingValidationWarning {
  dossier: string;
  source_dossier: string;
  output_name: string;
  message: string;
}

/**
 * Validate that all from_dossiers declarations in the graph reference source
 * dossiers that exist in the graph and appear in an earlier execution phase.
 * Returns an array of human-readable warning strings (empty = no issues).
 */
export function validateGraphMappings(
  plan: ExecutionPlan,
  nodes: Map<string, DossierNode>
): string[] {
  const warnings: string[] = [];

  // Build a map of dossier name → phase index for ordering checks
  const phaseOf = new Map<string, number>();
  for (const phase of plan.phases) {
    for (const entry of phase.dossiers) {
      phaseOf.set(entry.name, phase.phase);
    }
  }

  for (const [name, node] of nodes) {
    if (!node.fromDossiers?.length) continue;

    for (const decl of node.fromDossiers) {
      const sourcePhase = phaseOf.get(decl.source_dossier);

      if (sourcePhase === undefined) {
        warnings.push(
          `"${name}" declares input "${decl.output_name}" from "${decl.source_dossier}", ` +
            `but "${decl.source_dossier}" is not in the execution graph`
        );
        continue;
      }

      const consumerPhase = phaseOf.get(name)!;
      if (sourcePhase >= consumerPhase) {
        warnings.push(
          `"${name}" (phase ${consumerPhase}) declares input "${decl.output_name}" from ` +
            `"${decl.source_dossier}" (phase ${sourcePhase}), ` +
            `but the source does not precede the consumer`
        );
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Runtime: resolve inputs for a step
// ---------------------------------------------------------------------------

/**
 * Return the subset of declared from_dossiers inputs that are currently available
 * in the journey outputs store.
 */
export function resolveStepInputs(
  fromDossiers: FromDossierDeclaration[],
  availableOutputs: Map<string, Map<string, unknown>>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  // Track which source_dossier owns each output_name so we can detect collisions
  const sourceOf = new Map<string, string>();

  for (const decl of fromDossiers) {
    const value = availableOutputs.get(decl.source_dossier)?.get(decl.output_name);
    if (value !== undefined) {
      const prevSource = sourceOf.get(decl.output_name);
      if (prevSource !== undefined) {
        // Collision — move the previous entry to a namespaced key if not already moved
        if (resolved[decl.output_name] !== undefined) {
          resolved[`${prevSource}.${decl.output_name}`] = resolved[decl.output_name];
          delete resolved[decl.output_name];
        }
        resolved[`${decl.source_dossier}.${decl.output_name}`] = value;
      } else {
        resolved[decl.output_name] = value;
        sourceOf.set(decl.output_name, decl.source_dossier);
      }
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// LLM context injection
// ---------------------------------------------------------------------------

/**
 * Generate a Markdown context block to prepend to a dossier's body when
 * serving it to the LLM, injecting available output values from prior steps.
 * Returns an empty string when there are no declarations.
 */
export function generateInjectedContext(
  fromDossiers: FromDossierDeclaration[],
  availableOutputs: Map<string, Map<string, unknown>>
): string {
  if (!fromDossiers.length) return '';

  const resolved: Array<{ decl: FromDossierDeclaration; value: unknown }> = [];
  const missing: FromDossierDeclaration[] = [];

  for (const decl of fromDossiers) {
    const value = availableOutputs.get(decl.source_dossier)?.get(decl.output_name);
    if (value !== undefined) {
      resolved.push({ decl, value });
    } else {
      missing.push(decl);
    }
  }

  const lines: string[] = ['## Injected Values from Previous Steps', ''];

  if (resolved.length > 0) {
    lines.push('The following values are available from previous steps:', '');
    for (const { decl, value } of resolved) {
      const usage = decl.usage ? ` — ${decl.usage}` : '';
      lines.push(
        `- \`${decl.output_name}\` = \`${JSON.stringify(value)}\`${usage} *(from \`${decl.source_dossier}\`)*`
      );
    }
  }

  if (missing.length > 0) {
    lines.push('', 'The following inputs were declared but not yet available:', '');
    for (const decl of missing) {
      const usage = decl.usage ? ` — ${decl.usage}` : '';
      lines.push(`- \`${decl.output_name}\`${usage} *(expected from \`${decl.source_dossier}\`)*`);
    }
  }

  return lines.join('\n');
}
