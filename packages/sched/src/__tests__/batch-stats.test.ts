/**
 * `batch-stats.ts` (#564): reconstructing a batch's dispatch costs directly
 * from raw per-unit logs on disk, for batches whose `runs.jsonl` coverage
 * never existed (batch-dispatch.ts predates #564's write-side fix, or the
 * batch's `SchedState` record was torn down long ago). Fixture logs below
 * mirror the real shape found under `~/.dossier/sched/<project>/runs/` —
 * a single Claude-CLI `type: "result"` JSON object per line, carrying
 * `modelUsage`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildBatchRunLogEntries, listBatchDispatchLogs } from '../batch-stats';

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-batch-stats-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A minimal but realistic single-object Claude CLI result, same shape as the real pilot logs. */
function fakeResultJson(costUsd: number, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: costUsd,
    duration_ms: 60_000,
    modelUsage: {
      'claude-sonnet-5': {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 200,
        costUSD: costUsd,
      },
    },
  });
}

describe('listBatchDispatchLogs', () => {
  it('parses all four filename shapes for the given batch id, ignoring unrelated files', () => {
    const runsDir = tmpDir();
    for (const name of [
      'batch-b1-m1-540.log',
      'batch-b1-m2-542.log',
      'batch-b1-tail.log',
      'batch-b1-report.log',
      'batch-b1-fix-542.log',
      'batch-b2-m1-999.log', // different batch — must not match
      'issue-540.log', // ordinary issue log — must not match
    ]) {
      fs.writeFileSync(path.join(runsDir, name), '');
    }

    const entries = listBatchDispatchLogs(runsDir, 'b1');
    expect(entries).toHaveLength(5);
    expect(entries).toContainEqual({
      role: 'member',
      member: 1,
      issue: 540,
      file: path.join(runsDir, 'batch-b1-m1-540.log'),
    });
    expect(entries).toContainEqual({
      role: 'member',
      member: 2,
      issue: 542,
      file: path.join(runsDir, 'batch-b1-m2-542.log'),
    });
    expect(entries).toContainEqual({ role: 'tail', file: path.join(runsDir, 'batch-b1-tail.log') });
    expect(entries).toContainEqual({
      role: 'report',
      file: path.join(runsDir, 'batch-b1-report.log'),
    });
    expect(entries).toContainEqual({
      role: 'fix',
      offender: 542,
      file: path.join(runsDir, 'batch-b1-fix-542.log'),
    });
  });

  it('returns an empty list for a missing (ENOENT) runs directory, silently', () => {
    expect(listBatchDispatchLogs('/nonexistent/path/xyz', 'b1')).toEqual([]);
  });

  it('warns to stderr (but still returns []) for a non-ENOENT read error (#564 review)', () => {
    // A real, unmocked ENOTDIR: `runsDir` names a FILE, not a directory —
    // `fs.readdirSync` throws with `code: 'ENOTDIR'`, a real non-ENOENT
    // error, without needing to spy on `node:fs` (unsupported under ESM —
    // "Module namespace is not configurable").
    const notADir = tmpDir();
    const filePath = path.join(notADir, 'not-a-directory');
    fs.writeFileSync(filePath, '');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(listBatchDispatchLogs(filePath, 'b1')).toEqual([]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('ENOTDIR'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(filePath));

    stderr.mockRestore();
  });
});

describe('buildBatchRunLogEntries', () => {
  it('reconstructs tokens/cost from real modelUsage JSON, attributing members and fix logs to their issue', () => {
    const runsDir = tmpDir();
    fs.writeFileSync(
      path.join(runsDir, 'batch-b1-m1-540.log'),
      fakeResultJson(2.518, 6_214_824, 47_071)
    );
    fs.writeFileSync(
      path.join(runsDir, 'batch-b1-m2-542.log'),
      fakeResultJson(2.606, 6_573_453, 49_888)
    );
    fs.writeFileSync(path.join(runsDir, 'batch-b1-tail.log'), fakeResultJson(0.5, 100_000, 5_000));

    const entries = buildBatchRunLogEntries(runsDir, 'b1');
    expect(entries).toHaveLength(3);

    const m1 = entries.find((e) => e.unit === 'issue:540');
    expect(m1).toBeTruthy();
    expect(m1?.input_tokens).toBe(6_214_824);
    expect(m1?.output_tokens).toBe(47_071);
    expect(m1?.total_cost_usd).toBe(2.518);

    const m2 = entries.find((e) => e.unit === 'issue:542');
    expect(m2?.total_cost_usd).toBe(2.606);

    // Tail has no owning issue — attributed to the batch unit, not an issue.
    const tail = entries.find((e) => e.unit === 'batch:b1');
    expect(tail).toBeTruthy();
    expect(tail?.total_cost_usd).toBe(0.5);
  });

  it('a log with no parseable usage yields a null-usage entry, not a thrown error (#564 AC2)', () => {
    const runsDir = tmpDir();
    fs.writeFileSync(
      path.join(runsDir, 'batch-b1-m1-540.log'),
      'not json at all\njust plain text output'
    );

    const entries = buildBatchRunLogEntries(runsDir, 'b1');
    expect(entries).toHaveLength(1);
    expect(entries[0].unit).toBe('issue:540');
    expect(entries[0].input_tokens).toBeNull();
    expect(entries[0].output_tokens).toBeNull();
  });

  it('empty batch (no matching logs) reconstructs to an empty list', () => {
    const runsDir = tmpDir();
    fs.writeFileSync(path.join(runsDir, 'issue-540.log'), fakeResultJson(1, 100, 100));
    expect(buildBatchRunLogEntries(runsDir, 'b1')).toEqual([]);
  });
});
