import { describe, expect, it } from 'vitest';
import type { CoherenceContext, DeclaredOutputSchema, StepOutput } from '../coherence';
import { validateCoherence, validateStepCoherence } from '../coherence';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(name: string, index: number, outputs: Record<string, unknown>): StepOutput {
  return { stepName: name, stepIndex: index, outputs };
}

function makeContext(
  steps: StepOutput[],
  schemas?: Map<string, DeclaredOutputSchema>
): CoherenceContext {
  return { steps, declaredSchemas: schemas };
}

// ---------------------------------------------------------------------------
// validateCoherence — full journey validation
// ---------------------------------------------------------------------------

describe('validateCoherence', () => {
  it('should return coherent for a clean journey with no issues', () => {
    const result = validateCoherence(
      makeContext([
        makeStep('setup', 0, { project_path: '/tmp/app' }),
        makeStep('build', 1, { artifact_path: '/tmp/app/dist' }),
      ])
    );

    expect(result.coherent).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it('should return coherent:true for info-only diagnostics', () => {
    const result = validateCoherence(makeContext([makeStep('setup', 0, { flag: 'true' })]));

    // boolean-string info diagnostic
    expect(result.infoCount).toBeGreaterThan(0);
    expect(result.coherent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema compliance checks
// ---------------------------------------------------------------------------

describe('schema compliance', () => {
  const schemas = new Map<string, DeclaredOutputSchema>([
    [
      'setup',
      {
        configuration: [
          { key: 'project_path', description: 'Root project path' },
          { key: 'db_url', description: 'Database connection URL' },
        ],
      },
    ],
  ]);

  it('should warn when a declared output key is missing from step outputs', () => {
    const result = validateCoherence(
      makeContext([makeStep('setup', 0, { project_path: '/tmp/app' })], schemas)
    );

    const missing = result.diagnostics.filter(
      (d) => d.checkId === 'schema-compliance' && d.field === 'db_url'
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe('warning');
    expect(missing[0].message).toContain('not reported');
  });

  it('should info when an undeclared output key is present', () => {
    const result = validateCoherence(
      makeContext(
        [makeStep('setup', 0, { project_path: '/tmp/app', db_url: 'pg://...', extra_key: 'val' })],
        schemas
      )
    );

    const undeclared = result.diagnostics.filter(
      (d) => d.checkId === 'schema-compliance' && d.field === 'extra_key'
    );
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0].severity).toBe('info');
  });

  it('should pass cleanly when all declared keys are present and no extras', () => {
    const result = validateCoherence(
      makeContext(
        [makeStep('setup', 0, { project_path: '/tmp/app', db_url: 'pg://localhost/db' })],
        schemas
      )
    );

    const schemaIssues = result.diagnostics.filter((d) => d.checkId === 'schema-compliance');
    expect(schemaIssues).toHaveLength(0);
  });

  it('should skip schema checks when no declaredSchemas provided', () => {
    const result = validateCoherence(makeContext([makeStep('setup', 0, { anything: 'goes' })]));

    const schemaIssues = result.diagnostics.filter((d) => d.checkId === 'schema-compliance');
    expect(schemaIssues).toHaveLength(0);
  });

  it('should skip schema checks for steps not in the schema map', () => {
    const result = validateCoherence(
      makeContext([makeStep('unknown-step', 0, { key: 'val' })], schemas)
    );

    const schemaIssues = result.diagnostics.filter((d) => d.checkId === 'schema-compliance');
    expect(schemaIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

describe('anomaly detection', () => {
  it('should warn on empty outputs', () => {
    const result = validateCoherence(makeContext([makeStep('setup', 0, {})]));

    const empty = result.diagnostics.filter((d) => d.checkId === 'anomaly-empty-output');
    expect(empty).toHaveLength(1);
    expect(empty[0].severity).toBe('warning');
    expect(empty[0].message).toContain('no outputs');
  });

  it('should warn on null values', () => {
    const result = validateCoherence(makeContext([makeStep('setup', 0, { path: null })]));

    const nullDiags = result.diagnostics.filter((d) => d.checkId === 'anomaly-null-value');
    expect(nullDiags).toHaveLength(1);
    expect(nullDiags[0].field).toBe('path');
  });

  it('should warn on undefined values', () => {
    const result = validateCoherence(makeContext([makeStep('setup', 0, { path: undefined })]));

    const undefDiags = result.diagnostics.filter((d) => d.checkId === 'anomaly-null-value');
    expect(undefDiags).toHaveLength(1);
  });

  it('should info on empty string values', () => {
    const result = validateCoherence(makeContext([makeStep('setup', 0, { path: '' })]));

    const emptyStr = result.diagnostics.filter((d) => d.checkId === 'anomaly-empty-value');
    expect(emptyStr).toHaveLength(1);
    expect(emptyStr[0].severity).toBe('info');
  });

  it('should detect size outliers when one step has drastically more outputs', () => {
    const result = validateCoherence(
      makeContext([
        makeStep('step-a', 0, { a: '1' }),
        makeStep('step-b', 1, { b: '2' }),
        makeStep('step-c', 2, {
          c1: '1',
          c2: '2',
          c3: '3',
          c4: '4',
          c5: '5',
          c6: '6',
          c7: '7',
          c8: '8',
          c9: '9',
          c10: '10',
          c11: '11',
          c12: '12',
          c13: '13',
          c14: '14',
          c15: '15',
        }),
      ])
    );

    const outliers = result.diagnostics.filter((d) => d.checkId === 'anomaly-size-outlier');
    expect(outliers).toHaveLength(1);
    expect(outliers[0].stepName).toBe('step-c');
  });

  it('should not flag size outliers when all steps have similar sizes', () => {
    const result = validateCoherence(
      makeContext([
        makeStep('a', 0, { x: '1', y: '2' }),
        makeStep('b', 1, { x: '1', y: '2', z: '3' }),
        makeStep('c', 2, { x: '1', y: '2' }),
      ])
    );

    const outliers = result.diagnostics.filter((d) => d.checkId === 'anomaly-size-outlier');
    expect(outliers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-step coherence
// ---------------------------------------------------------------------------

describe('cross-step coherence', () => {
  it('should warn when the same key has different values across steps', () => {
    const result = validateCoherence(
      makeContext([
        makeStep('setup', 0, { db_host: 'localhost' }),
        makeStep('deploy', 1, { db_host: 'production.rds.amazonaws.com' }),
      ])
    );

    const drift = result.diagnostics.filter((d) => d.checkId === 'cross-step-value-drift');
    expect(drift).toHaveLength(1);
    expect(drift[0].severity).toBe('warning');
    expect(drift[0].message).toContain('localhost');
    expect(drift[0].message).toContain('production.rds.amazonaws.com');
  });

  it('should not warn when the same key has the same value across steps', () => {
    const result = validateCoherence(
      makeContext([
        makeStep('setup', 0, { db_host: 'localhost' }),
        makeStep('deploy', 1, { db_host: 'localhost' }),
      ])
    );

    const drift = result.diagnostics.filter((d) => d.checkId === 'cross-step-value-drift');
    expect(drift).toHaveLength(0);
  });

  it('should not produce cross-step diagnostics for a single step', () => {
    const result = validateCoherence(makeContext([makeStep('setup', 0, { path: '/tmp/app' })]));

    const crossStep = result.diagnostics.filter((d) => d.checkId === 'cross-step-value-drift');
    expect(crossStep).toHaveLength(0);
  });

  it('should track value drift across multiple steps', () => {
    const result = validateCoherence(
      makeContext([
        makeStep('step-a', 0, { port: '5432' }),
        makeStep('step-b', 1, { port: '5432' }), // same — no warning
        makeStep('step-c', 2, { port: '3306' }), // changed — warning
      ])
    );

    const drift = result.diagnostics.filter((d) => d.checkId === 'cross-step-value-drift');
    expect(drift).toHaveLength(1);
    expect(drift[0].stepName).toBe('step-c');
  });

  it('should ignore non-string values for cross-step checks', () => {
    const result = validateCoherence(
      makeContext([makeStep('a', 0, { count: 5 }), makeStep('b', 1, { count: 10 })])
    );

    const drift = result.diagnostics.filter((d) => d.checkId === 'cross-step-value-drift');
    expect(drift).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Internal consistency
// ---------------------------------------------------------------------------

describe('internal consistency', () => {
  it('should info when multiple keys have the same non-trivial value', () => {
    const result = validateCoherence(
      makeContext([
        makeStep('setup', 0, {
          source_path: '/tmp/project/src',
          output_path: '/tmp/project/src',
        }),
      ])
    );

    const dupes = result.diagnostics.filter((d) => d.checkId === 'internal-duplicate-values');
    expect(dupes).toHaveLength(1);
    expect(dupes[0].message).toContain('source_path');
    expect(dupes[0].message).toContain('output_path');
  });

  it('should not flag trivial duplicate values like "true" or "false"', () => {
    const result = validateCoherence(
      makeContext([
        makeStep('setup', 0, {
          feature_a: 'true',
          feature_b: 'true',
        }),
      ])
    );

    const dupes = result.diagnostics.filter((d) => d.checkId === 'internal-duplicate-values');
    expect(dupes).toHaveLength(0);
  });

  it('should info on boolean-like strings', () => {
    const result = validateCoherence(makeContext([makeStep('setup', 0, { is_ready: 'true' })]));

    const boolStr = result.diagnostics.filter((d) => d.checkId === 'internal-boolean-string');
    expect(boolStr).toHaveLength(1);
    expect(boolStr[0].severity).toBe('info');
    expect(boolStr[0].message).toContain('boolean');
  });

  it('should not flag actual booleans', () => {
    const result = validateCoherence(makeContext([makeStep('setup', 0, { is_ready: true })]));

    const boolStr = result.diagnostics.filter((d) => d.checkId === 'internal-boolean-string');
    expect(boolStr).toHaveLength(0);
  });

  it('should skip internal consistency checks for single-key outputs', () => {
    const result = validateCoherence(
      makeContext([makeStep('setup', 0, { only_key: '/same/path' })])
    );

    const dupes = result.diagnostics.filter((d) => d.checkId === 'internal-duplicate-values');
    expect(dupes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateStepCoherence — incremental single-step validation
// ---------------------------------------------------------------------------

describe('validateStepCoherence', () => {
  it('should validate only the current step against prior context', () => {
    const priorSteps = [makeStep('setup', 0, { db_host: 'localhost' })];
    const currentStep = makeStep('deploy', 1, { db_host: 'production.rds.amazonaws.com' });

    const result = validateStepCoherence(currentStep, priorSteps);

    expect(result.coherent).toBe(false);
    const drift = result.diagnostics.filter((d) => d.checkId === 'cross-step-value-drift');
    expect(drift).toHaveLength(1);
  });

  it('should check schema compliance for the current step only', () => {
    const schemas = new Map<string, DeclaredOutputSchema>([
      ['deploy', { configuration: [{ key: 'endpoint', description: 'API endpoint' }] }],
    ]);

    const result = validateStepCoherence(makeStep('deploy', 1, {}), [], schemas);

    // Empty output warning + missing schema key
    const schemaIssues = result.diagnostics.filter((d) => d.checkId === 'schema-compliance');
    expect(schemaIssues.some((d) => d.field === 'endpoint')).toBe(true);
  });

  it('should return coherent when no issues found', () => {
    const priorSteps = [makeStep('setup', 0, { project_path: '/tmp/app' })];
    const currentStep = makeStep('build', 1, { artifact_path: '/tmp/app/dist' });

    const result = validateStepCoherence(currentStep, priorSteps);

    expect(result.coherent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('should handle empty steps array', () => {
    const result = validateCoherence(makeContext([]));

    expect(result.coherent).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('should handle steps with complex non-string values gracefully', () => {
    const result = validateCoherence(
      makeContext([
        makeStep('setup', 0, {
          config: { nested: 'object' },
          items: [1, 2, 3],
          count: 42,
        }),
      ])
    );

    // Should not throw, and non-string values should be ignored by entity checks
    expect(result).toBeDefined();
    expect(result.diagnostics).toBeDefined();
  });

  it('should truncate long values in diagnostic messages', () => {
    const longValue = 'a'.repeat(200);
    const result = validateCoherence(
      makeContext([
        makeStep('a', 0, { key: longValue }),
        makeStep('b', 1, { key: `${longValue}b` }),
      ])
    );

    const drift = result.diagnostics.filter((d) => d.checkId === 'cross-step-value-drift');
    expect(drift).toHaveLength(1);
    expect(drift[0].message).toContain('...');
    // Message should not contain the full 200-char value
    expect(drift[0].message.length).toBeLessThan(400);
  });
});
