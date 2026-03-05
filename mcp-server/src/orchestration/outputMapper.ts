/**
 * Cross-dossier output mapper.
 * Connects dossier outputs to downstream dossier inputs, enabling automatic
 * data flow between steps in a journey.
 *
 * Schema fields consumed:
 *   inputs.from_dossiers  — declares what this dossier expects from prior steps
 *   outputs.configuration — declares what this dossier produces for later steps
 */

// --- Types matching dossier schema ---

export interface FromDossierInput {
  source_dossier: string;
  output_name: string;
  usage?: string;
}

export interface OutputConfiguration {
  key: string;
  description: string;
  consumed_by?: string[];
  export_as?: string;
}

// --- Internal / result types ---

export interface CollectedOutput {
  key: string;
  value: string;
  export_as?: string;
}

export interface ResolvedInput {
  source_dossier: string;
  output_name: string;
  value: string;
  export_as?: string;
  usage?: string;
}

export interface MappingValidationWarning {
  dossier: string;
  source_dossier: string;
  output_name: string;
  message: string;
}

// --- OutputMapper class ---

/**
 * Stores outputs collected from completed dossier steps and resolves them
 * into the inputs of subsequent steps.
 *
 * Lifecycle per journey session:
 *   1. Call collectOutput() each time a step reports an output value.
 *   2. Call resolveInputs() / generateContextString() to inject values into
 *      the next step's dossier prompt.
 *   3. Call validateInputs() at graph-resolution time to surface missing outputs
 *      before execution begins.
 *   4. Call clear() to reset between journey sessions.
 */
export class OutputMapper {
  /** dossier name → (output key → collected output) */
  private readonly store = new Map<string, Map<string, CollectedOutput>>();

  /**
   * Store an output value reported by a completed dossier step.
   * Called when the LLM invokes the step_complete tool.
   */
  collectOutput(dossier: string, key: string, value: string, export_as?: string): void {
    if (!this.store.has(dossier)) {
      this.store.set(dossier, new Map());
    }
    this.store.get(dossier)?.set(key, { key, value, export_as });
  }

  /**
   * Return all collected outputs for a specific dossier.
   */
  getOutputs(dossier: string): CollectedOutput[] {
    const map = this.store.get(dossier);
    return map ? [...map.values()] : [];
  }

  /**
   * Resolve a dossier's from_dossiers inputs against previously collected
   * outputs. Inputs whose source value has not yet been collected are silently
   * skipped (the caller decides whether that is an error).
   */
  resolveInputs(fromDossiers: FromDossierInput[]): ResolvedInput[] {
    const resolved: ResolvedInput[] = [];

    for (const input of fromDossiers) {
      const output = this.store.get(input.source_dossier)?.get(input.output_name);
      if (output === undefined) continue;

      resolved.push({
        source_dossier: input.source_dossier,
        output_name: input.output_name,
        value: output.value,
        export_as: output.export_as,
        usage: input.usage,
      });
    }

    return resolved;
  }

  /**
   * Generate an LLM-readable context string listing all resolved input values.
   * Returns null when no inputs could be resolved (e.g. first step in a journey).
   *
   * Example output:
   *   The following values are available from previous steps:
   *   - `cluster_arn = arn:aws:ecs:us-east-1:123:cluster/prod` [env_var] (from setup-infra) — Target ECS cluster
   */
  generateContextString(fromDossiers: FromDossierInput[]): string | null {
    const resolved = this.resolveInputs(fromDossiers);
    if (resolved.length === 0) return null;

    const lines = ['The following values are available from previous steps:'];
    for (const r of resolved) {
      const exportTag = r.export_as ? ` [${r.export_as}]` : '';
      const usageNote = r.usage ? ` — ${r.usage}` : '';
      lines.push(
        `- \`${r.output_name} = ${r.value}\`${exportTag} (from ${r.source_dossier})${usageNote}`
      );
    }

    return lines.join('\n');
  }

  /**
   * Validate that a dossier's from_dossiers inputs have matching output
   * declarations in their source dossiers. Run this at graph-resolution time,
   * before any step executes.
   *
   * @param dossier        - name of the dossier being validated
   * @param fromDossiers   - its inputs.from_dossiers declarations
   * @param sourceOutputs  - map of dossier name → declared outputs.configuration
   * @returns warnings for missing or mismatched declarations (empty = all good)
   */
  validateInputs(
    dossier: string,
    fromDossiers: FromDossierInput[],
    sourceOutputs: Map<string, OutputConfiguration[]>
  ): MappingValidationWarning[] {
    const warnings: MappingValidationWarning[] = [];

    for (const input of fromDossiers) {
      const outputs = sourceOutputs.get(input.source_dossier);

      if (!outputs) {
        warnings.push({
          dossier,
          source_dossier: input.source_dossier,
          output_name: input.output_name,
          message: `Source dossier "${input.source_dossier}" is not in the execution graph or declares no outputs`,
        });
        continue;
      }

      if (!outputs.some((o) => o.key === input.output_name)) {
        warnings.push({
          dossier,
          source_dossier: input.source_dossier,
          output_name: input.output_name,
          message: `Source dossier "${input.source_dossier}" does not declare an output named "${input.output_name}"`,
        });
      }
    }

    return warnings;
  }

  /**
   * Clear all stored outputs. Call between journey sessions.
   */
  clear(): void {
    this.store.clear();
  }
}
