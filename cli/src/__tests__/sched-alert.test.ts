import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_EPISODE_GAP_MS,
  type AlertCommentApi,
  createAlertNotifier,
  parseAlertIssue,
} from '../sched-alert';

describe('createAlertNotifier comment dedupe (#945)', () => {
  let dir: string;
  let clock: number;
  let created: string[];
  let updated: Array<{ id: number; body: string }>;
  let api: AlertCommentApi;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-alert-notify-'));
    clock = Date.parse('2026-09-29T12:00:00Z');
    created = [];
    updated = [];
    api = {
      create: (_r, _i, body) => {
        created.push(body);
        return 1000 + created.length;
      },
      update: (_r, id, body) => {
        updated.push({ id, body });
        return true;
      },
    };
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const notifier = () =>
    createAlertNotifier('proj', 'o/r', 945, { stateDir: dir, api, now: () => new Date(clock) });
  const crash = { kind: 'engine-restarted-after-crash', message: 'died' } as const;

  it('a crash loop is ONE comment: the first creates it, every restart after edits it', () => {
    const n = notifier();
    for (let i = 0; i < 6; i++) {
      n(crash);
      clock += 10_000;
    }
    expect(created).toHaveLength(1);
    expect(updated).toHaveLength(5);
    expect(updated.at(-1)?.id).toBe(1001);
    expect(updated.at(-1)?.body).toContain('Repeated 6 times');
  });

  it('a new episode (gap past the window) opens a new comment; kinds are independent', () => {
    const n = notifier();
    n(crash);
    n({ kind: 'stale-engine-lease', message: 'down' });
    expect(created).toHaveLength(2);
    clock += ALERT_EPISODE_GAP_MS + 1;
    n(crash);
    expect(created).toHaveLength(3);
    expect(updated).toHaveLength(0);
  });

  it('falls back to a new comment when the old one can no longer be edited', () => {
    const n = notifier();
    n(crash);
    api.update = () => false;
    n(crash);
    expect(created).toHaveLength(2);
  });

  it('never touches GitHub without an alert issue, and resolves a lazy repo only when it must comment', () => {
    const repo = vi.fn(() => 'o/r');
    createAlertNotifier('proj', repo, undefined, { api })(crash);
    expect(repo).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    createAlertNotifier('proj', repo, 945, { api, stateDir: dir })(crash);
    expect(repo).toHaveBeenCalledOnce();
    expect(created).toHaveLength(1);
  });

  it('an api that throws never throws out of the notifier', () => {
    const bad: AlertCommentApi = {
      create: () => {
        throw new Error('gh down');
      },
      update: () => false,
    };
    expect(() => createAlertNotifier('p', 'o/r', 1, { api: bad })(crash)).not.toThrow();
  });

  it('parseAlertIssue validates', () => {
    expect(parseAlertIssue('12', {})).toBe(12);
    expect(parseAlertIssue(undefined, {})).toBeUndefined();
    expect(() => parseAlertIssue('x', {})).toThrow(/positive integer/);
  });
});
