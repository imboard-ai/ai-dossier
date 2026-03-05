import { beforeEach, describe, expect, it } from 'vitest';
import type { FromDossierInput, OutputConfiguration } from '../outputMapper';
import { OutputMapper } from '../outputMapper';

describe('OutputMapper', () => {
  let mapper: OutputMapper;

  beforeEach(() => {
    mapper = new OutputMapper();
  });

  describe('collectOutput / getOutputs', () => {
    it('should store and retrieve a collected output', () => {
      mapper.collectOutput('setup-infra', 'cluster_arn', 'arn:aws:ecs:us-east-1:123:cluster/prod');

      const outputs = mapper.getOutputs('setup-infra');
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toEqual({
        key: 'cluster_arn',
        value: 'arn:aws:ecs:us-east-1:123:cluster/prod',
        export_as: undefined,
      });
    });

    it('should store export_as metadata alongside the value', () => {
      mapper.collectOutput('setup-infra', 'cluster_arn', 'arn:aws:ecs:...', 'env_var');

      const outputs = mapper.getOutputs('setup-infra');
      expect(outputs[0].export_as).toBe('env_var');
    });

    it('should store multiple outputs for the same dossier', () => {
      mapper.collectOutput('setup-infra', 'cluster_arn', 'arn:...');
      mapper.collectOutput('setup-infra', 'region', 'us-east-1');

      expect(mapper.getOutputs('setup-infra')).toHaveLength(2);
    });

    it('should overwrite an output with the same key', () => {
      mapper.collectOutput('setup-infra', 'cluster_arn', 'old-value');
      mapper.collectOutput('setup-infra', 'cluster_arn', 'new-value');

      const outputs = mapper.getOutputs('setup-infra');
      expect(outputs).toHaveLength(1);
      expect(outputs[0].value).toBe('new-value');
    });

    it('should return an empty array for unknown dossiers', () => {
      expect(mapper.getOutputs('nonexistent')).toEqual([]);
    });
  });

  describe('resolveInputs', () => {
    beforeEach(() => {
      mapper.collectOutput(
        'setup-infra',
        'cluster_arn',
        'arn:aws:ecs:us-east-1:123:cluster/prod',
        'env_var'
      );
      mapper.collectOutput('setup-infra', 'region', 'us-east-1');
      mapper.collectOutput('build-image', 'image_uri', 'ecr.amazonaws.com/app:latest');
    });

    it('should resolve inputs that have matching collected outputs', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'setup-infra', output_name: 'cluster_arn', usage: 'Target ECS cluster' },
      ];

      const resolved = mapper.resolveInputs(fromDossiers);

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toEqual({
        source_dossier: 'setup-infra',
        output_name: 'cluster_arn',
        value: 'arn:aws:ecs:us-east-1:123:cluster/prod',
        export_as: 'env_var',
        usage: 'Target ECS cluster',
      });
    });

    it('should resolve inputs from multiple source dossiers', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'setup-infra', output_name: 'cluster_arn' },
        { source_dossier: 'build-image', output_name: 'image_uri' },
      ];

      const resolved = mapper.resolveInputs(fromDossiers);

      expect(resolved).toHaveLength(2);
      expect(resolved.map((r) => r.output_name)).toEqual(['cluster_arn', 'image_uri']);
    });

    it('should skip inputs whose source dossier has not reported outputs', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'not-yet-run', output_name: 'some_value' },
      ];

      const resolved = mapper.resolveInputs(fromDossiers);
      expect(resolved).toHaveLength(0);
    });

    it('should skip inputs whose output key does not exist in the source', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'setup-infra', output_name: 'nonexistent_key' },
      ];

      const resolved = mapper.resolveInputs(fromDossiers);
      expect(resolved).toHaveLength(0);
    });

    it('should return an empty array for an empty from_dossiers list', () => {
      expect(mapper.resolveInputs([])).toEqual([]);
    });
  });

  describe('generateContextString', () => {
    beforeEach(() => {
      mapper.collectOutput(
        'setup-infra',
        'cluster_arn',
        'arn:aws:ecs:us-east-1:123:cluster/prod',
        'env_var'
      );
      mapper.collectOutput('build-image', 'image_uri', 'ecr.amazonaws.com/app:latest');
    });

    it('should generate a context string for resolved inputs', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'setup-infra', output_name: 'cluster_arn', usage: 'Target ECS cluster' },
      ];

      const context = mapper.generateContextString(fromDossiers);

      expect(context).not.toBeNull();
      expect(context).toContain('The following values are available from previous steps:');
      expect(context).toContain('cluster_arn = arn:aws:ecs:us-east-1:123:cluster/prod');
      expect(context).toContain('[env_var]');
      expect(context).toContain('from setup-infra');
      expect(context).toContain('Target ECS cluster');
    });

    it('should include multiple resolved inputs in the context string', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'setup-infra', output_name: 'cluster_arn' },
        { source_dossier: 'build-image', output_name: 'image_uri' },
      ];

      const context = mapper.generateContextString(fromDossiers);

      expect(context).toContain('cluster_arn');
      expect(context).toContain('image_uri');
    });

    it('should omit export_as tag when not set', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'build-image', output_name: 'image_uri' },
      ];

      const context = mapper.generateContextString(fromDossiers);

      expect(context).not.toContain('[');
    });

    it('should return null when no inputs can be resolved', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'not-yet-run', output_name: 'some_value' },
      ];

      expect(mapper.generateContextString(fromDossiers)).toBeNull();
    });

    it('should return null for an empty from_dossiers list', () => {
      expect(mapper.generateContextString([])).toBeNull();
    });
  });

  describe('validateInputs', () => {
    const sourceOutputs: Map<string, OutputConfiguration[]> = new Map([
      [
        'setup-infra',
        [
          { key: 'cluster_arn', description: 'ECS cluster ARN', export_as: 'env_var' },
          { key: 'region', description: 'AWS region' },
        ],
      ],
    ]);

    it('should return no warnings when all inputs are satisfied', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'setup-infra', output_name: 'cluster_arn' },
        { source_dossier: 'setup-infra', output_name: 'region' },
      ];

      const warnings = mapper.validateInputs('deploy-app', fromDossiers, sourceOutputs);
      expect(warnings).toHaveLength(0);
    });

    it('should warn when the source dossier is not in the execution graph', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'not-in-graph', output_name: 'some_value' },
      ];

      const warnings = mapper.validateInputs('deploy-app', fromDossiers, sourceOutputs);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].source_dossier).toBe('not-in-graph');
      expect(warnings[0].dossier).toBe('deploy-app');
      expect(warnings[0].message).toContain('not in the execution graph');
    });

    it('should warn when the source dossier does not declare the required output', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'setup-infra', output_name: 'undeclared_output' },
      ];

      const warnings = mapper.validateInputs('deploy-app', fromDossiers, sourceOutputs);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].output_name).toBe('undeclared_output');
      expect(warnings[0].message).toContain('does not declare an output named "undeclared_output"');
    });

    it('should return multiple warnings for multiple missing inputs', () => {
      const fromDossiers: FromDossierInput[] = [
        { source_dossier: 'not-in-graph', output_name: 'foo' },
        { source_dossier: 'setup-infra', output_name: 'missing_key' },
      ];

      const warnings = mapper.validateInputs('deploy-app', fromDossiers, sourceOutputs);
      expect(warnings).toHaveLength(2);
    });

    it('should return no warnings for an empty from_dossiers list', () => {
      expect(mapper.validateInputs('deploy-app', [], sourceOutputs)).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('should remove all stored outputs', () => {
      mapper.collectOutput('setup-infra', 'cluster_arn', 'some-arn');
      mapper.collectOutput('build-image', 'image_uri', 'some-uri');

      mapper.clear();

      expect(mapper.getOutputs('setup-infra')).toHaveLength(0);
      expect(mapper.getOutputs('build-image')).toHaveLength(0);
    });
  });
});
