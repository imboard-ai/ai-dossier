/**
 * Types for the dependency graph resolver and execution planner.
 */

// --- Relationship types (matching dossier-schema.json) ---

export interface PrecededByRelation {
  dossier: string;
  condition?: 'required' | 'optional' | 'suggested';
  reason?: string;
}

export interface FollowedByRelation {
  dossier: string;
  condition?: 'required' | 'suggested';
  purpose?: string;
}

export interface ConflictsWithRelation {
  dossier: string;
  reason: string;
}

export interface DossierRelationships {
  preceded_by?: PrecededByRelation[];
  followed_by?: FollowedByRelation[];
  conflicts_with?: ConflictsWithRelation[];
  can_run_parallel_with?: string[];
  alternatives?: Array<{ dossier: string; when_to_use?: string }>;
}

// --- Graph types ---

export interface DossierNode {
  name: string;
  source: 'local' | 'registry';
  path?: string;
  riskLevel?: string;
  status?: string;
  relationships?: DossierRelationships;
  fromDossiers?: FromDossierDeclaration[];
  outputConfig?: OutputConfigItem[];
}

export interface GraphEdge {
  from: string;
  to: string;
  condition: 'required' | 'optional' | 'suggested';
  reason?: string;
}

export interface DependencyGraph {
  nodes: Map<string, DossierNode>;
  edges: GraphEdge[];
}

// --- Execution plan types ---

export interface PhaseEntry {
  name: string;
  source: 'local' | 'registry';
  path?: string;
  condition: 'required' | 'optional' | 'suggested';
  riskLevel?: string;
}

export interface ExecutionPhase {
  phase: number;
  dossiers: PhaseEntry[];
}

export interface ConflictWarning {
  dossierA: string;
  dossierB: string;
  reason: string;
}

export interface ExecutionPlan {
  entryDossier: string;
  totalDossiers: number;
  phases: ExecutionPhase[];
  conflicts: ConflictWarning[];
  warnings: string[];
}

// --- Output mapping types ---

export interface FromDossierDeclaration {
  source_dossier: string;
  output_name: string;
  usage?: string;
}

export interface OutputConfigItem {
  key: string;
  description: string;
  consumed_by?: string[];
  export_as?: string;
}

// --- Resolver types ---

export interface ResolvedDossier {
  name: string;
  source: 'local' | 'registry';
  path?: string;
  metadata: Record<string, unknown>;
  relationships?: DossierRelationships;
}
