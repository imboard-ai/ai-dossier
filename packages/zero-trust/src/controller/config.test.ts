import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConfigErrorCode, RunConfigError, validateRunConfig } from './config';

const dirs: string[] = [];
function configFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-config-'));
  dirs.push(root);
  const signerKeyFile = path.join(root, 'signer.pem');
  fs.writeFileSync(
    signerKeyFile,
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 }
  );
  const phase = {
    adapter: 'test-adapter',
    model: 'test-model',
    endpoint: 'https://model.example/v1',
    apiKeyEnv: 'MODEL_API_KEY',
  };
  const raw = {
    issueUrl: 'https://github.com/owner/repo/issues/1',
    contributor: 'contributor',
    executionProfile: {
      provider: 'local-qemu',
      profileDir: 'profiles',
      stateDir: 'vm-state',
      accelerator: 'auto',
      proxyEndpointsFile: 'endpoints.json',
    },
    modelProfile: {
      phases: { planning: phase, implementing: { ...phase }, repair: { ...phase } },
      rates: [
        {
          resource: 'test-model',
          currency: 'USD',
          unit: 'token',
          price: 1,
          units: 1000,
          source: 'fixture',
          fx: {
            currency: 'USD',
            numerator: 1,
            denominator: 1,
            timestamp: '2026-10-05T00:00:00.000Z',
          },
        },
      ],
    },
    budget: {
      currency: 'USD',
      ceilingMinor: 1000,
      cleanupAllowanceMinor: 100,
      tokenLimit: 10000,
      activeMinutes: 120,
    },
    signerKeyFile,
    githubApp: {
      appId: 1,
      clientId: 'fixture-client',
      slug: 'test-app',
      privateKeyEnv: 'APP_PRIVATE_KEY',
      clientSecretEnv: 'APP_CLIENT_SECRET',
    },
  };
  return { root, raw, config: () => validateRunConfig(raw) };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('validateRunConfig', () => {
  it('accepts complete configuration and derives safe defaults without retaining references', () => {
    const { raw, config } = configFixture();
    const value = config();
    expect(value.upstream).toEqual({ owner: 'owner', repo: 'repo', issue: 1 });
    expect(value.checkpoints).toEqual([]);
    expect(value.retentionDays).toBe(30);
    expect(value.limits).toEqual({
      vcpus: 4,
      memoryMiB: 8192,
      diskGiB: 20,
      commandTimeoutMs: 1200000,
      activeMinutes: 120,
    });
    raw.contributor = 'changed';
    expect(value.contributor).toBe('contributor');
  });
  const cases: [string, unknown, ConfigErrorCode][] = [
    ['issueUrl', 'https://github.com/owner/repo/pull/1', 'invalid_issue_url'],
    ['issueUrl', 'https://example.com/owner/repo/issues/1', 'invalid_issue_url'],
    ['issueUrl', 'https://github.com/owner/repo/issues/1?a=b', 'invalid_issue_url'],
    ['issueUrl', 'https://github.com/owner/repo/issues/1#fragment', 'invalid_issue_url'],
    ['issueUrl', 'https://github.com/owner/repo/issues/1/extra', 'invalid_issue_url'],
    ['issueUrl', 'https://github.com/owner/repo/issues/0', 'invalid_issue_url'],
    ['issueUrl', 'https://github.com/owner/repo/issues/99999999999999999', 'invalid_issue_url'],
    ['issueUrl', 1, 'invalid_issue_url'],
    ['contributor', 'a--b', 'invalid_contributor'],
    ['contributor', '-login', 'invalid_contributor'],
    ['contributor', 'a'.repeat(40), 'invalid_contributor'],
    ['contributor', 'a_b', 'invalid_contributor'],
    ['unknown', true, 'unknown_key'],
    ['executionProfile.provider', 'cloud-vm', 'unsupported_environment'],
    ['executionProfile.accelerator', 'other', 'unsupported_environment'],
    ['executionProfile.profileDir', '', 'unsupported_environment'],
    ['modelProfile.phases.planning.apiKeyEnv', 'ghp_plantedsecret', 'secret_detected'],
    ['modelProfile.phases.planning.apiKeyEnv', 'actual-key-value', 'invalid_env_name'],
    [
      'modelProfile.phases.planning.endpoint',
      'https://user:pass@model.example',
      'invalid_model_profile',
    ],
    ['modelProfile.phases.planning.endpoint', 'not-a-url', 'invalid_model_profile'],
    ['modelProfile.phases.planning', null, 'invalid_model_profile'],
    ['modelProfile.phases.planning.model', '', 'invalid_model_profile'],
    ['modelProfile.phases.planning.extra', true, 'unknown_key'],
    ['modelProfile.rates', [], 'missing_rate'],
    ['modelProfile.rates', null, 'missing_rate'],
    ['modelProfile.rates.0.price', -1, 'invalid_budget'],
    ['modelProfile.rates.0.fx.currency', 'EUR', 'invalid_budget'],
    ['modelProfile.rates.0.fx.extra', 1, 'unknown_key'],
    ['budget.ceilingMinor', Infinity, 'invalid_budget'],
    ['budget.ceilingMinor', 0, 'invalid_budget'],
    ['budget.cleanupAllowanceMinor', 1001, 'invalid_budget'],
    ['budget.tokenLimit', 1.5, 'invalid_budget'],
    ['budget.currency', 'usd', 'invalid_budget'],
    ['budget.activeMinutes', 121, 'invalid_limits'],
    ['checkpoints', ['plan', 'plan'], 'invalid_checkpoints'],
    ['checkpoints', ['unknown'], 'invalid_checkpoints'],
    ['checkpoints', false, 'invalid_checkpoints'],
    ['limits.vcpus', 5, 'invalid_limits'],
    ['limits.memoryMiB', 8193, 'invalid_limits'],
    ['limits.diskGiB', 21, 'invalid_limits'],
    ['limits.commandTimeoutMs', 1200001, 'invalid_limits'],
    ['limits.activeMinutes', 121, 'invalid_limits'],
    ['limits.vcpus', 0, 'invalid_limits'],
    ['retentionDays', 3651, 'invalid_retention'],
    ['retentionDays', 0, 'invalid_retention'],
    ['resumeRunId', '../escape', 'invalid_resume_run_id'],
    ['githubApp.appId', 0, 'invalid_github_app'],
    ['githubApp.slug', 'invalid slug', 'invalid_github_app'],
    ['githubApp.privateKeyEnv', 'sk-proj-secret', 'secret_detected'],
    ['githubApp.clientSecretEnv', 'bad-name', 'invalid_env_name'],
    ['signerKeyFile', '', 'invalid_signer_key'],
    ['executionProfile.stateDir', 'ghp_secret', 'secret_detected'],
  ];
  it.each(cases)('rejects %s = %s without echoing input', (field, value, code) => {
    const { raw } = configFixture();
    const input = raw as unknown as Record<string, unknown>;
    const keys = field.split('.');
    let target = input;
    for (const key of keys.slice(0, -1)) {
      if (target[key] === undefined) target[key] = {};
      target = target[key] as Record<string, unknown>;
    }
    target[keys.at(-1) as string] = value;
    expect(() => validateRunConfig(input)).toThrow(new RunConfigError(code));
    try {
      validateRunConfig(input);
    } catch (error) {
      expect(String(error)).not.toContain('ghp_');
    }
  });
  it('accepts lowered limits, checkpoints, optional repair omission and resume ID', () => {
    const { raw } = configFixture();
    const value = validateRunConfig({
      ...raw,
      modelProfile: {
        ...raw.modelProfile,
        phases: {
          planning: raw.modelProfile.phases.planning,
          implementing: raw.modelProfile.phases.implementing,
        },
      },
      budget: { ...raw.budget, activeMinutes: 60 },
      limits: {
        vcpus: 2,
        memoryMiB: 4096,
        diskGiB: 16,
        commandTimeoutMs: 600000,
        activeMinutes: 60,
      },
      checkpoints: ['plan', 'patch', 'verification'],
      retentionDays: 3650,
      resumeRunId: 'ztc-0123456789abcdef-run-1',
    });
    expect(value.modelProfile.phases.repair).toBeUndefined();
    expect(value.limits.vcpus).toBe(2);
    expect(value.resumeRunId).toBe('ztc-0123456789abcdef-run-1');
  });
  it('rejects nonobjects, uncloneable config, unknown and nested secret fields', () => {
    expect(() => validateRunConfig(null)).toThrow(RunConfigError);
    expect(() => validateRunConfig({ fn: () => 1 })).toThrow(RunConfigError);
    const { raw } = configFixture();
    expect(() => validateRunConfig({ ...raw, extra: 'ghp_secret' })).toThrow(
      new RunConfigError('secret_detected')
    );
    expect(() => validateRunConfig({ ...raw, ghp_secret: 'value' })).toThrow(
      new RunConfigError('secret_detected')
    );
    expect(() => validateRunConfig({ ...raw, contributor: 'line\nspoof' })).toThrow(
      new RunConfigError('invalid_contributor')
    );
  });
  it('rejects missing, public, symlink and non-Ed25519 signer keys', () => {
    const { raw, root } = configFixture();
    fs.chmodSync(raw.signerKeyFile, 0o644);
    expect(() => validateRunConfig(raw)).toThrow(new RunConfigError('invalid_signer_key'));
    fs.chmodSync(raw.signerKeyFile, 0o600);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(raw.signerKeyFile, alias);
    expect(() => validateRunConfig({ ...raw, signerKeyFile: alias })).toThrow(RunConfigError);
    fs.writeFileSync(
      raw.signerKeyFile,
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      })
    );
    expect(() => validateRunConfig(raw)).toThrow(RunConfigError);
    fs.unlinkSync(raw.signerKeyFile);
    expect(() => validateRunConfig(raw)).toThrow(RunConfigError);
  });
});
