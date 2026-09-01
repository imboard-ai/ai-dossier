import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendSchedRunLog,
  buildSchedRunLogEntry,
  readDispatchLog,
  schedRunsLogPath,
  schedTelemetryEnabled,
  usageParserFor,
} from '../index';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-run-log-test-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('schedRunsLogPath', () => {
  it('resolves to ~/.dossier/runs.jsonl under the given home — the same file cli writes to', () => {
    expect(schedRunsLogPath(home)).toBe(path.join(home, '.dossier', 'runs.jsonl'));
  });
});

describe('usageParserFor', () => {
  it('selects the opencode parser for the opencode binary', () => {
    const stdout = JSON.stringify({
      type: 'step_finish',
      part: { type: 'step-finish', tokens: { input: 10, output: 5 }, cost: 0.01 },
    });
    expect(usageParserFor('opencode')(stdout)).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
    });
  });

  it('selects the claude parser for anything else', () => {
    const stdout = JSON.stringify({
      type: 'result',
      modelUsage: { 'claude-opus-4': { inputTokens: 10, outputTokens: 5 } },
    });
    expect(usageParserFor('claude')(stdout)).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });
});

describe('buildSchedRunLogEntry', () => {
  const completedAt = new Date('2026-09-01T12:05:00Z');

  it('builds a claude entry sourced from modelUsage, with duration from spawnedAt', () => {
    const logContent = JSON.stringify({
      type: 'result',
      modelUsage: {
        'claude-sonnet-4': {
          inputTokens: 1000,
          outputTokens: 200,
          cacheCreationInputTokens: 50,
          cacheReadInputTokens: 400,
          totalCostUsd: 0.015,
        },
      },
    });

    const entry = buildSchedRunLogEntry({
      unit: 'issue:524',
      role: 'cycle',
      cmd0: 'claude',
      cmd: ['claude', '-p', '--output-format', 'json', '--model', 'sonnet'],
      logContent,
      spawnedAt: '2026-09-01T12:00:00Z',
      completedAt,
      configuredModel: 'sonnet',
    });

    expect(entry).toMatchObject({
      dossier: 'sched:cycle',
      unit: 'issue:524',
      llm: 'claude',
      spawned_command: 'claude -p --output-format json --model sonnet',
      model: 'claude-sonnet-4',
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_tokens: 50,
      cache_read_tokens: 400,
      total_cost_usd: 0.015,
      duration_ms: 5 * 60 * 1000,
    });
  });

  it('builds an opencode entry from the JSONL event stream', () => {
    const logContent = JSON.stringify({
      type: 'step_finish',
      part: { type: 'step-finish', tokens: { input: 300, output: 40 }, cost: 0.004 },
    });

    const entry = buildSchedRunLogEntry({
      unit: 'issue:524',
      role: 'report',
      cmd0: 'opencode',
      cmd: ['opencode', 'run', '--auto', '--format', 'json', '--model', 'grok'],
      logContent,
      spawnedAt: '2026-09-01T12:00:00Z',
      completedAt,
      configuredModel: 'grok',
    });

    expect(entry).toMatchObject({
      dossier: 'sched:report',
      llm: 'opencode',
      // opencode events carry no model id — falls back to the configured model.
      model: 'grok',
      input_tokens: 300,
      output_tokens: 40,
      total_cost_usd: 0.004,
    });
  });

  it('falls back to the configured model, and leaves duration null, when the agent reported no usage and spawnedAt is unknown', () => {
    const entry = buildSchedRunLogEntry({
      unit: 'issue:524',
      role: 'cycle',
      cmd0: 'claude',
      cmd: ['claude', '-p'],
      logContent: null,
      spawnedAt: null, // pre-#524 slot, or the field was never backfilled
      completedAt,
      configuredModel: 'sonnet',
    });

    expect(entry).toMatchObject({
      model: 'sonnet',
      input_tokens: null,
      output_tokens: null,
      cache_creation_tokens: null,
      cache_read_tokens: null,
      total_cost_usd: null,
      duration_ms: null,
    });
  });

  it('never fabricates exit_code — null unless the caller supplies one, since detached children report none', () => {
    const entry = buildSchedRunLogEntry({
      unit: 'issue:524',
      role: 'cycle',
      cmd0: 'claude',
      cmd: ['claude', '-p'],
      logContent: null,
      spawnedAt: null,
      completedAt,
      configuredModel: null,
    });

    expect(entry.exit_code).toBeNull();
    expect(entry.spawn_error).toBeNull();
  });
});

describe('appendSchedRunLog + readDispatchLog', () => {
  it('appends one JSONL line to ~/.dossier/runs.jsonl', () => {
    const entry = buildSchedRunLogEntry({
      unit: 'issue:524',
      role: 'cycle',
      cmd0: 'claude',
      cmd: ['claude', '-p'],
      logContent: null,
      spawnedAt: null,
      completedAt: new Date('2026-09-01T12:05:00Z'),
      configuredModel: null,
    });

    appendSchedRunLog(entry, home);
    appendSchedRunLog(entry, home);

    const lines = fs.readFileSync(schedRunsLogPath(home), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ unit: 'issue:524' });
  });

  it('never throws when the target directory cannot be created', () => {
    // A file where a directory needs to go — mkdirSync must fail.
    const blocked = path.join(home, 'blocked-file');
    fs.writeFileSync(blocked, 'x');
    const entry = buildSchedRunLogEntry({
      unit: 'issue:524',
      role: 'cycle',
      cmd0: 'claude',
      cmd: [],
      logContent: null,
      spawnedAt: null,
      completedAt: new Date(),
      configuredModel: null,
    });

    expect(() => appendSchedRunLog(entry, path.join(blocked, 'nested'))).not.toThrow();
  });

  it('readDispatchLog returns the file content, distinguishing empty from missing', () => {
    const logFile = path.join(home, 'issue-524.log');
    fs.writeFileSync(logFile, '');
    expect(readDispatchLog(logFile)).toBe('');
    expect(readDispatchLog(path.join(home, 'does-not-exist.log'))).toBeNull();
  });
});

/**
 * #524 decision 2 — sched telemetry gets its OWN opt-out rather than
 * inheriting the CLI's `auditLog` (which covers `ai-dossier run`'s entries) or
 * ignoring the user's config entirely. Default on: `sched stats` and the
 * RFC-0001 cost gates exist because this data was missing.
 */
describe('schedTelemetryEnabled (#524 decision 2)', () => {
  const writeConfig = (config: unknown): void => {
    fs.mkdirSync(path.join(home, '.dossier'), { recursive: true });
    fs.writeFileSync(path.join(home, '.dossier', 'config.json'), JSON.stringify(config));
  };

  it('defaults to on when no config file exists', () => {
    expect(schedTelemetryEnabled(home)).toBe(true);
  });

  it('defaults to on when the key is absent, and is NOT gated by auditLog', () => {
    writeConfig({ auditLog: false, theme: 'dark' });
    expect(schedTelemetryEnabled(home)).toBe(true);
  });

  it('is off only for an explicit false', () => {
    writeConfig({ schedTelemetry: false });
    expect(schedTelemetryEnabled(home)).toBe(false);
  });

  it('treats a malformed config as not-opted-out rather than silently disabling telemetry', () => {
    fs.mkdirSync(path.join(home, '.dossier'), { recursive: true });
    fs.writeFileSync(path.join(home, '.dossier', 'config.json'), '{ broken');
    expect(schedTelemetryEnabled(home)).toBe(true);
  });

  it('appendSchedRunLog writes nothing, and reports success, when opted out', () => {
    writeConfig({ schedTelemetry: false });
    const entry = buildSchedRunLogEntry({
      unit: 'issue:524',
      role: 'cycle',
      cmd0: 'claude',
      cmd: ['claude', '-p'],
      logContent: JSON.stringify({ type: 'result', modelUsage: {} }),
      spawnedAt: '2026-09-01T10:00:00.000Z',
      completedAt: new Date('2026-09-01T10:05:00.000Z'),
      configuredModel: 'sonnet',
      cwd: '/repo',
    });

    // `true` = the opt-out was honoured, not a failed write for the caller to
    // journal as a lost entry.
    expect(appendSchedRunLog(entry, home)).toBe(true);
    expect(fs.existsSync(schedRunsLogPath(home))).toBe(false);
  });

  it('appendSchedRunLog writes when telemetry is enabled', () => {
    writeConfig({ schedTelemetry: true });
    const entry = buildSchedRunLogEntry({
      unit: 'issue:524',
      role: 'cycle',
      cmd0: 'claude',
      cmd: ['claude', '-p'],
      logContent: null,
      spawnedAt: null,
      completedAt: new Date('2026-09-01T10:05:00.000Z'),
      configuredModel: 'sonnet',
      cwd: '/repo',
    });

    expect(appendSchedRunLog(entry, home)).toBe(true);
    expect(fs.readFileSync(schedRunsLogPath(home), 'utf-8')).toContain('issue:524');
  });
});

/**
 * The 6-of-11 batch-pilot case end-to-end (#524 AC1/AC3): a dispatch the
 * scheduler killed on external-advance never emits a `result` event, so before
 * stream-json its entry carried null tokens. Through the real
 * `buildSchedRunLogEntry` path it must now carry the tokens actually spent.
 */
describe('killed-dispatch telemetry (#524 AC1/AC3)', () => {
  const preamble = JSON.stringify({
    type: 'sched-dispatch',
    ts: '2026-09-01T10:00:00.000Z',
    cmd: ['claude', '-p', '--output-format', 'stream-json', '--verbose'],
  });
  const assistant = JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-5',
      usage: {
        input_tokens: 40,
        output_tokens: 400,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 6,
      },
    },
  });

  it('records real tokens for a dispatch that was killed before its result event', () => {
    const entry = buildSchedRunLogEntry({
      unit: 'issue:495',
      role: 'cycle',
      cmd0: 'claude',
      cmd: ['claude', '-p', '--output-format', 'stream-json', '--verbose'],
      // Killed mid-write: no result event, and the last line is truncated.
      logContent: [preamble, assistant, '{"type":"assis'].join('\n'),
      spawnedAt: '2026-09-01T10:00:00.000Z',
      completedAt: new Date('2026-09-01T10:30:00.000Z'),
      configuredModel: 'sonnet',
      cwd: '/repo',
    });

    expect(entry).toMatchObject({
      unit: 'issue:495',
      input_tokens: 40,
      output_tokens: 400,
      cache_creation_tokens: 5,
      cache_read_tokens: 6,
      model: 'claude-sonnet-4-5',
      duration_ms: 30 * 60 * 1000,
      total_cost_usd: null,
    });
  });

  it('falls back to the configured model, with null tokens, when the agent wrote only the preamble', () => {
    const entry = buildSchedRunLogEntry({
      unit: 'issue:496',
      role: 'cycle',
      cmd0: 'claude',
      cmd: ['claude', '-p'],
      logContent: preamble,
      spawnedAt: '2026-09-01T10:00:00.000Z',
      completedAt: new Date('2026-09-01T10:01:00.000Z'),
      configuredModel: 'sonnet',
      cwd: '/repo',
    });

    // Genuinely unavailable, never fabricated as zero — but the entry still
    // exists, so the dispatch is visible in `sched stats` rather than absent.
    expect(entry).toMatchObject({
      unit: 'issue:496',
      input_tokens: null,
      output_tokens: null,
      model: 'sonnet',
    });
  });
});
