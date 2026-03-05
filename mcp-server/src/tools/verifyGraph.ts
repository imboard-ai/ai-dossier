/**
 * verify_graph tool - Batch verification for dossier dependency graphs.
 * Verifies all dossiers in a resolved graph and returns an aggregate security report.
 */

import { resolve } from 'node:path';
import { buildExecutionPlan, buildGraph } from '../orchestration/graph';
import { DossierResolver } from '../orchestration/resolver';
import type { ExecutionPlan, PhaseEntry } from '../orchestration/types';
import { CliNotFoundError, execCli } from '../utils/cli-wrapper';
import { getGraph } from '../utils/graphStore';
import { logger } from '../utils/logger';
import type { VerifyDossierOutput } from './verifyDossier';

export interface VerifyGraphInput {
  graph_id?: string;
  dossier?: string;
}

export type Recommendation = 'ALLOW' | 'WARN' | 'BLOCK';

export interface DossierVerificationResult {
  name: string;
  recommendation: Recommendation;
  risk: string;
  passed: boolean;
  error?: string;
}

export interface VerifyGraphOutput {
  overall_recommendation: Recommendation;
  summary: string;
  blockers: string[];
  dossiers: DossierVerificationResult[];
}

export interface VerifyGraphError {
  error: {
    type: 'validation' | 'resolve' | 'not_found';
    message: string;
  };
}

/**
 * Extract all unique dossiers from an execution plan.
 */
function extractDossiers(plan: ExecutionPlan): PhaseEntry[] {
  const seen = new Set<string>();
  const dossiers: PhaseEntry[] = [];
  for (const phase of plan.phases) {
    for (const entry of phase.dossiers) {
      if (!seen.has(entry.name)) {
        seen.add(entry.name);
        dossiers.push(entry);
      }
    }
  }
  return dossiers;
}

/**
 * Determine recommendation based on verification result and risk level.
 */
function getRecommendation(result: VerifyDossierOutput, riskLevel: string): Recommendation {
  if (!result.passed) {
    // Check if integrity stage specifically failed (stage 1 is typically integrity/checksum)
    const integrityFailed = result.stages.some(
      (s) =>
        s.passed === false &&
        (s.name.toLowerCase().includes('integrity') || s.name.toLowerCase().includes('checksum'))
    );
    if (integrityFailed) return 'BLOCK';
    return 'WARN';
  }
  // Even if verification passed, high risk dossiers get a WARN
  if (riskLevel === 'critical' || riskLevel === 'high') return 'WARN';
  return 'ALLOW';
}

/**
 * Compute the worst-case recommendation across all results.
 */
function worstCase(recommendations: Recommendation[]): Recommendation {
  if (recommendations.includes('BLOCK')) return 'BLOCK';
  if (recommendations.includes('WARN')) return 'WARN';
  return 'ALLOW';
}

/**
 * Verify a single dossier entry, returning its verification result.
 */
async function verifySingleDossier(entry: PhaseEntry): Promise<DossierVerificationResult> {
  const identifier = entry.path ?? entry.name;
  try {
    const result = await execCli<VerifyDossierOutput>('verify', [identifier, '--json']);
    const risk = entry.riskLevel ?? 'unknown';
    const recommendation = getRecommendation(result, risk);
    return {
      name: entry.name,
      recommendation,
      risk,
      passed: result.passed,
    };
  } catch (error) {
    if (error instanceof CliNotFoundError) {
      return {
        name: entry.name,
        recommendation: 'BLOCK',
        risk: entry.riskLevel ?? 'unknown',
        passed: false,
        error: error.message,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: entry.name,
      recommendation: 'BLOCK',
      risk: entry.riskLevel ?? 'unknown',
      passed: false,
      error: message,
    };
  }
}

/**
 * Resolve a dossier reference into an execution plan (same logic as resolveGraph tool).
 */
async function resolvePlan(dossierRef: string): Promise<ExecutionPlan> {
  const resolver = new DossierResolver();
  const isPath = dossierRef.includes('/') || dossierRef.endsWith('.ds.md');
  const entryDossier = isPath
    ? await resolver.resolveFromPath(resolve(dossierRef))
    : await resolver.resolve(dossierRef);
  const nodes = await resolver.resolveGraph(entryDossier);
  const graph = buildGraph(nodes);
  return buildExecutionPlan(graph, entryDossier.name);
}

/**
 * Verify all dossiers in a dependency graph and return an aggregate security report.
 */
export async function verifyGraph(
  input: VerifyGraphInput
): Promise<VerifyGraphOutput | VerifyGraphError> {
  const { graph_id, dossier } = input;

  if (!graph_id && !dossier) {
    return {
      error: {
        type: 'validation',
        message: 'Either graph_id or dossier parameter is required',
      },
    };
  }

  let plan: ExecutionPlan;

  if (graph_id) {
    const stored = getGraph(graph_id);
    if (!stored) {
      return {
        error: {
          type: 'not_found',
          message: `No graph found with id: ${graph_id}`,
        },
      };
    }
    plan = stored;
    logger.info('Verifying graph from store', { graphId: graph_id });
  } else {
    logger.info('Resolving and verifying graph', { dossier });
    try {
      plan = await resolvePlan(dossier!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Graph resolution failed during verify', { dossier, error: message });
      return {
        error: { type: 'resolve', message },
      };
    }
  }

  const entries = extractDossiers(plan);

  logger.info('Starting batch verification', { totalDossiers: entries.length });

  // Verify all dossiers in parallel
  const results = await Promise.all(entries.map(verifySingleDossier));

  const blockers = results.filter((r) => r.recommendation === 'BLOCK').map((r) => r.name);
  const overall = worstCase(results.map((r) => r.recommendation));

  const counts = { ALLOW: 0, WARN: 0, BLOCK: 0 };
  for (const r of results) counts[r.recommendation]++;

  const parts: string[] = [`${results.length} dossiers verified`];
  if (counts.ALLOW > 0) parts.push(`${counts.ALLOW} passed`);
  if (counts.WARN > 0) parts.push(`${counts.WARN} warnings`);
  if (counts.BLOCK > 0) parts.push(`${counts.BLOCK} blocked`);

  const output: VerifyGraphOutput = {
    overall_recommendation: overall,
    summary: parts.join(', '),
    blockers,
    dossiers: results,
  };

  logger.info('Batch verification complete', {
    overall,
    total: results.length,
    blockers: blockers.length,
  });

  return output;
}
