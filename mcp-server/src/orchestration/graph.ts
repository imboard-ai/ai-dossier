/**
 * DAG builder for dossier dependency graphs.
 * Parses relationships (preceded_by, followed_by, conflicts_with, can_run_parallel_with)
 * and produces an execution plan via topological sort.
 */

import type {
  ConflictWarning,
  DependencyGraph,
  DossierNode,
  ExecutionPhase,
  ExecutionPlan,
  GraphEdge,
  PhaseEntry,
} from './types';

export class CycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
  }
}

/**
 * Build a dependency graph from a set of resolved dossier nodes.
 */
export function buildGraph(nodes: Map<string, DossierNode>): DependencyGraph {
  const edges: GraphEdge[] = [];

  for (const [name, node] of nodes) {
    const rels = node.relationships;
    if (!rels) continue;

    // preceded_by: dependency must run BEFORE this node
    // Edge direction: preceded -> this
    if (rels.preceded_by) {
      for (const dep of rels.preceded_by) {
        if (nodes.has(dep.dossier)) {
          edges.push({
            from: dep.dossier,
            to: name,
            condition: dep.condition ?? 'required',
            reason: dep.reason,
          });
        }
      }
    }

    // followed_by: this node must run BEFORE the follower
    // Edge direction: this -> follower
    if (rels.followed_by) {
      for (const dep of rels.followed_by) {
        if (nodes.has(dep.dossier)) {
          edges.push({
            from: name,
            to: dep.dossier,
            condition: dep.condition ?? 'required',
            reason: dep.purpose,
          });
        }
      }
    }
  }

  return { nodes, edges };
}

/**
 * Detect cycles in the dependency graph using DFS coloring.
 * Returns the cycle path if one exists, or null if the graph is acyclic.
 */
export function detectCycle(graph: DependencyGraph): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const name of graph.nodes.keys()) {
    adj.set(name, []);
    color.set(name, WHITE);
  }
  for (const edge of graph.edges) {
    adj.get(edge.from)?.push(edge.to);
  }

  function dfs(node: string): string[] | null {
    color.set(node, GRAY);

    for (const neighbor of adj.get(node) ?? []) {
      if (color.get(neighbor) === GRAY) {
        // Found a cycle - reconstruct it
        const cycle = [neighbor, node];
        let current = node;
        while (current !== neighbor) {
          current = parent.get(current) ?? '';
          if (current && current !== neighbor) {
            cycle.push(current);
          }
        }
        cycle.push(neighbor);
        cycle.reverse();
        return cycle;
      }
      if (color.get(neighbor) === WHITE) {
        parent.set(neighbor, node);
        const result = dfs(neighbor);
        if (result) return result;
      }
    }

    color.set(node, BLACK);
    return null;
  }

  for (const node of graph.nodes.keys()) {
    if (color.get(node) === WHITE) {
      const cycle = dfs(node);
      if (cycle) return cycle;
    }
  }

  return null;
}

/**
 * Topological sort using Kahn's algorithm.
 * Returns phases where each phase contains dossiers that can run in parallel.
 */
export function topologicalSort(graph: DependencyGraph): string[][] {
  // Build adjacency list and in-degree map
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const name of graph.nodes.keys()) {
    adj.set(name, []);
    inDegree.set(name, 0);
  }

  for (const edge of graph.edges) {
    adj.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // Start with nodes that have no incoming edges
  const phases: string[][] = [];
  let queue = [...graph.nodes.keys()].filter((n) => inDegree.get(n) === 0);

  while (queue.length > 0) {
    phases.push([...queue]);
    const nextQueue: string[] = [];

    for (const node of queue) {
      for (const neighbor of adj.get(node) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          nextQueue.push(neighbor);
        }
      }
    }

    queue = nextQueue;
  }

  return phases;
}

/**
 * Detect conflicts between dossiers in the graph.
 */
export function detectConflicts(graph: DependencyGraph): ConflictWarning[] {
  const conflicts: ConflictWarning[] = [];
  const seen = new Set<string>();

  for (const [name, node] of graph.nodes) {
    if (!node.relationships?.conflicts_with) continue;

    for (const conflict of node.relationships.conflicts_with) {
      if (!graph.nodes.has(conflict.dossier)) continue;

      // Avoid duplicate reports (A conflicts B = B conflicts A)
      const key = [name, conflict.dossier].sort().join('::');
      if (seen.has(key)) continue;
      seen.add(key);

      conflicts.push({
        dossierA: name,
        dossierB: conflict.dossier,
        reason: conflict.reason,
      });
    }
  }

  return conflicts;
}

/**
 * Build a complete execution plan from the dependency graph.
 */
export function buildExecutionPlan(graph: DependencyGraph, entryDossier: string): ExecutionPlan {
  // Check for cycles
  const cycle = detectCycle(graph);
  if (cycle) {
    throw new CycleError(cycle);
  }

  // Detect conflicts
  const conflicts = detectConflicts(graph);

  // Build the edge condition map for quick lookup
  const edgeConditions = new Map<string, 'required' | 'optional' | 'suggested'>();
  for (const edge of graph.edges) {
    edgeConditions.set(`${edge.from}->${edge.to}`, edge.condition);
  }

  // Topological sort into phases
  const sortedPhases = topologicalSort(graph);

  // Build execution phases
  const phases: ExecutionPhase[] = sortedPhases.map((phaseNodes, index) => {
    const dossiers: PhaseEntry[] = phaseNodes.map((name) => {
      const node = graph.nodes.get(name);
      if (!node) {
        // Only reachable through an edge whose target is not a node; buildGraph never creates one.
        throw new Error(
          `Dossier "${name}" is referenced by a graph edge but missing from the graph`
        );
      }

      // Determine condition: entry dossier is always 'required',
      // others inherit from edges pointing to them
      let condition: 'required' | 'optional' | 'suggested' = 'required';
      if (name !== entryDossier) {
        for (const edge of graph.edges) {
          if (edge.to === name) {
            condition = edge.condition;
            break;
          }
        }
      }

      return {
        name,
        source: node.source,
        path: node.path,
        condition,
        riskLevel: node.riskLevel,
      };
    });

    return { phase: index + 1, dossiers };
  });

  // Generate warnings
  const warnings: string[] = [];

  if (conflicts.length > 0) {
    warnings.push(
      `${conflicts.length} conflict(s) detected between dossiers in the execution graph`
    );
  }

  // Warn about optional dependencies
  const optionalCount = graph.edges.filter((e) => e.condition === 'optional').length;
  if (optionalCount > 0) {
    warnings.push(`${optionalCount} optional dependency(ies) included — these may be skipped`);
  }

  return {
    entryDossier,
    totalDossiers: graph.nodes.size,
    phases,
    conflicts,
    warnings,
  };
}
