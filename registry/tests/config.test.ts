import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('config', () => {
  const REQUIRED_VARS = {
    GITHUB_BOT_TOKEN: 'test-bot-token',
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
    JWT_SECRET: 'test-jwt-secret',
    REGISTRY_BASE_URL: 'https://registry.example.com',
  };

  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of Object.keys(REQUIRED_VARS)) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.resetModules();
  });

  it('should throw when GITHUB_BOT_TOKEN is missing', async () => {
    delete process.env.GITHUB_BOT_TOKEN;
    const { default: config } = await import('../lib/config');
    expect(() => config.content.botToken).toThrow(
      'Missing required environment variable: GITHUB_BOT_TOKEN'
    );
  });

  it('should throw when GITHUB_CLIENT_ID is missing', async () => {
    delete process.env.GITHUB_CLIENT_ID;
    const { default: config } = await import('../lib/config');
    expect(() => config.auth.github.clientId).toThrow(
      'Missing required environment variable: GITHUB_CLIENT_ID'
    );
  });

  it('should throw when GITHUB_CLIENT_SECRET is missing', async () => {
    delete process.env.GITHUB_CLIENT_SECRET;
    const { default: config } = await import('../lib/config');
    expect(() => config.auth.github.clientSecret).toThrow(
      'Missing required environment variable: GITHUB_CLIENT_SECRET'
    );
  });

  it('should throw when JWT_SECRET is missing', async () => {
    delete process.env.JWT_SECRET;
    const { default: config } = await import('../lib/config');
    expect(() => config.auth.jwt.secret).toThrow(
      'Missing required environment variable: JWT_SECRET'
    );
  });

  it('should throw when REGISTRY_BASE_URL is missing', async () => {
    delete process.env.REGISTRY_BASE_URL;
    const { default: config } = await import('../lib/config');
    expect(() => config.baseUrl).toThrow(
      'Missing required environment variable: REGISTRY_BASE_URL'
    );
  });

  it('should return values when env vars are set', async () => {
    for (const [key, value] of Object.entries(REQUIRED_VARS)) {
      process.env[key] = value;
    }
    const { default: config } = await import('../lib/config');
    expect(config.content.botToken).toBe('test-bot-token');
    expect(config.auth.github.clientId).toBe('test-client-id');
    expect(config.auth.github.clientSecret).toBe('test-client-secret');
    expect(config.auth.jwt.secret).toBe('test-jwt-secret');
    expect(config.baseUrl).toBe('https://registry.example.com');
  });
});
