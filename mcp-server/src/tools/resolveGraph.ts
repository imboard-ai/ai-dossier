/**
 * resolve_graph tool - Resolve dossier dependency graph into an execution plan.
 * Reads relationships (preceded_by, followed_by, conflicts_with, can_run_parallel_with)
 * and produces a DAG-based execution plan.
 */

import { resolve } from 'node:path';
import { buildExecutionPlan, buildGraph, CycleError } from '../orchestration/graph';
import { validateGraphMappings } from '../orchestration/outputMapper';
import { DossierResolver } from '../orchestration/resolver';
import type { ExecutionPlan } from '../orchestration/types';
import { generateGraphId, storeGraph } from '../utils/graphStore';
import { logger } from '../utils/logger';

export interface ResolveGraphInput {
  dossier: string;
}

export interface ResolveGraphOutput {
  graph_id: string;
  plan: ExecutionPlan;
}

export interface ResolveGraphError {
  error: {
    type: 'cycle' | 'resolve' | 'unknown';
    message: string;
    cycle?: string[];
  };
}

/**
 * Resolve a dossier's dependency graph and produce an execution plan.
 */
export async function resolveGraph(
  input: ResolveGraphInput
): Promise<ResolveGraphOutput | ResolveGraphError> {
  const { dossier: dossierRef } = input;

  if (!dossierRef) {
    return {
      error: { type: 'unknown', message: 'dossier parameter is required' },
    };
  }

  logger.info('Resolving dependency graph', { dossier: dossierRef });

  const resolver = new DossierResolver();

  try {
    // Determine if input is a file path or a name
    const isPath = dossierRef.includes('/') || dossierRef.endsWith('.ds.md');

    // Resolve entry dossier
    const entryDossier = isPath
      ? await resolver.resolveFromPath(resolve(dossierRef))
      : await resolver.resolve(dossierRef);

    // Recursively resolve the full dependency graph
    const nodes = await resolver.resolveGraph(entryDossier);

    // Build the graph structure
    const graph = buildGraph(nodes);

    // Generate the execution plan
    const plan = buildExecutionPlan(graph, entryDossier.name);

    // Validate cross-dossier output mappings and surface warnings
    const mappingWarnings = validateGraphMappings(plan, nodes);
    plan.warnings.push(...mappingWarnings);

    const graphId = generateGraphId();
    storeGraph(graphId, plan);

    logger.info('Dependency graph resolved', {
      entryDossier: entryDossier.name,
      totalDossiers: plan.totalDossiers,
      phases: plan.phases.length,
      conflicts: plan.conflicts.length,
      graphId,
    });

    return { graph_id: graphId, plan };
  } catch (error) {
    if (error instanceof CycleError) {
      return {
        error: {
          type: 'cycle',
          message: error.message,
          cycle: error.cycle,
        },
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error('Graph resolution failed', { dossier: dossierRef, error: message });

    return {
      error: { type: 'resolve', message },
    };
  }
}
