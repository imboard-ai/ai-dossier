import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendSchedRunLog,
  buildSchedRunLogEntry,
  readDispatchLog,
  schedRunsLogPath,
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
