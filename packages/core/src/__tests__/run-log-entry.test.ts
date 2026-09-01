import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runsLogPath } from '../run-log-entry';

describe('runsLogPath', () => {
  it('resolves to <home>/.dossier/runs.jsonl — the one location both cli and sched write to', () => {
    expect(runsLogPath('/home/test')).toBe(path.join('/home/test', '.dossier', 'runs.jsonl'));
  });
});
