import { describe, expect, it } from 'vitest';
import { detectDispatchProfile, type ProfileCandidate } from '../dispatch-detect';

const CANDIDATES: ProfileCandidate[] = [
  {
    name: 'claude',
    binaries: ['claude'],
  },
  {
    name: 'glm',
    binaries: ['opencode'],
  },
];

describe('detectDispatchProfile (#707 — explicit is the mechanism, detection the convenience)', () => {
  it('CLAUDECODE=1 resolves the claude profile by name', () => {
    expect(
      detectDispatchProfile({ env: { CLAUDECODE: '1' }, candidates: CANDIDATES, ancestors: [] })
    ).toEqual({ profile: 'claude', method: 'claudecode-env' });
  });

  it('CLAUDECODE=1 falls back to a candidate that spawns the claude binary when no profile is NAMED claude', () => {
    expect(
      detectDispatchProfile({
        env: { CLAUDECODE: '1' },
        candidates: [{ name: 'anthropic', binaries: ['claude'] }],
        ancestors: [],
      })
    ).toEqual({ profile: 'anthropic', method: 'claudecode-env' });
  });

  it('a Claude environment with NO claude candidate is inconclusive — never a guess', () => {
    expect(
      detectDispatchProfile({
        env: { CLAUDECODE: '1' },
        candidates: [{ name: 'glm', binaries: ['opencode'] }],
        ancestors: [],
      })
    ).toBeNull();
  });

  it('no CLAUDECODE marks: the innermost matching ancestor binary wins', () => {
    // ai-dossier → sh → opencode → the tool: innermost match is opencode.
    expect(
      detectDispatchProfile({
        env: {},
        candidates: CANDIDATES,
        ancestors: ['node', 'bash', 'opencode', 'systemd'],
      })
    ).toEqual({ profile: 'glm', method: 'parent-chain' });
    // claude in the chain beats an unrelated outer ancestor.
    expect(
      detectDispatchProfile({
        env: {},
        candidates: CANDIDATES,
        ancestors: ['node', 'claude', 'tmux'],
      })
    ).toEqual({ profile: 'claude', method: 'parent-chain' });
  });

  it('a re-parented process (nohup/systemd ancestry) is inconclusive — null, the caller must fail loudly', () => {
    expect(
      detectDispatchProfile({ env: {}, candidates: CANDIDATES, ancestors: ['node', 'init'] })
    ).toBeNull();
    expect(detectDispatchProfile({ env: {}, candidates: CANDIDATES, ancestors: [] })).toBeNull();
  });

  it('an ancestor binary shared by multiple profiles is inconclusive, never profile-order dependent', () => {
    expect(
      detectDispatchProfile({
        env: {},
        candidates: [
          { name: 'glm-fast', binaries: ['opencode'] },
          { name: 'glm-strong', binaries: ['opencode'] },
        ],
        ancestors: ['node', 'opencode'],
      })
    ).toBeNull();
  });

  it('no candidates configured → null regardless of environment', () => {
    expect(
      detectDispatchProfile({ env: { CLAUDECODE: '1' }, candidates: [], ancestors: ['claude'] })
    ).toBeNull();
  });
});
