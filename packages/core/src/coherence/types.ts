/**
 * Types for output coherence validation.
 *
 * Coherence validation catches the "incoherent failures" described in
 * Anthropic's ICLR 2026 research: AI doesn't fail systematically on
 * complex tasks -- it fails *messily*. These types support lightweight
 * sanity checks on dossier execution outputs.
 */

export type CoherenceSeverity = 'error' | 'warning' | 'info';

export interface CoherenceDiagnostic {
  checkId: string;
  severity: CoherenceSeverity;
  message: string;
  stepName?: string;
  field?: string;
}

/**
 * A single step's output record, as reported by the LLM via step_complete.
 * Maps output key -> value.
 */
export interface StepOutput {
  stepName: string;
  stepIndex: number;
  outputs: Record<string, unknown>;
}

/**
 * Declared output schema from a dossier's frontmatter `outputs` field.
 * Maps step name -> declared output keys and their metadata.
 */
export interface DeclaredOutputSchema {
  files?: Array<{ path: string; description: string; required?: boolean; format?: string }>;
  configuration?: Array<{ key: string; description: string; export_as?: string }>;
  state_changes?: Array<{ description: string; affects?: string; reversible?: boolean }>;
  artifacts?: Array<{ path: string; purpose: string; type?: string }>;
}

/**
 * Full context for coherence validation across a journey.
 */
export interface CoherenceContext {
  /** All step outputs collected so far, in execution order. */
  steps: StepOutput[];
  /** Declared output schemas per step name (from frontmatter). */
  declaredSchemas?: Map<string, DeclaredOutputSchema>;
}

export interface CoherenceResult {
  diagnostics: CoherenceDiagnostic[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  /** true when no errors or warnings were found */
  coherent: boolean;
}
