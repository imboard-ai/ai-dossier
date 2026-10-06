import { describe, expect, it } from 'vitest';
import { SecretRedactionError } from '../../redaction';
import { replayTokens, TokenJournal, TokenJournalError } from '../token-journal';

const at = '2026-10-06T12:00:00.000Z';
const ids = [1, 2, 3, 4].map((n) => `0000000${n}-0000-4000-8000-000000000000`);
const [user, child, install, other] = ids as [string, string, string, string];
const requested = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'token_requested',
  id,
  kind,
  parentId: null,
  intentKey: kind === 'user' ? null : `key-${id}`,
  attempt: kind === 'user' ? null : 1,
  repositoryId: kind === 'user' ? null : 42,
  at,
  useBy: kind === 'user' ? null : at,
  ...extra,
});
const minted = (id: string) => ({ v: 1, type: 'token_minted', id, expiresAt: at });
const base = [
  requested(user, 'user'),
  minted(user),
  requested(child, 'user_scoped', { parentId: user }),
  minted(child),
  requested(install, 'installation'),
  minted(install),
];

describe('token journal replay', () => {
  it('replays a lifecycle', () => {
    const ledger = replayTokens([
      ...base,
      { v: 1, type: 'token_used', id: install, at },
      { v: 1, type: 'token_revoke_failed', id: install, at },
      { v: 1, type: 'token_revoked', id: install, verified: true, at },
      { v: 1, type: 'token_revoked', id: user, verified: false, at },
      { v: 1, type: 'admissions_disabled', reason: 'kill_switch', at },
      { v: 1, type: 'admissions_disabled', reason: 'cleanup_blocked', at },
      { v: 1, type: 'grant_delete_refused', via: child, status: 404, at },
      { v: 1, type: 'grant_deleted', via: child, at },
      { v: 1, type: 'reauthorization_required', at },
    ]);
    expect(ledger.tokens.get(install)).toMatchObject({ status: 'revoked', revokeFailures: 1 });
    expect(ledger.tokens.get(user)).toMatchObject({ status: 'revoked', revokedVia: 'token' });
    expect(ledger.tokens.get(child)).toMatchObject({ status: 'revoked', revokedVia: 'grant' });
    expect(ledger.admissionsClosed).toBe('kill_switch');
    expect(ledger.reauthorizationRequired).toBe(true);
  });

  it.each([
    ['unknown event', [{ v: 1, type: 'token_leaked', id: user }]],
    ['wrong version', [{ ...requested(user, 'user'), v: 2 }]],
    ['non-uuid id', [requested('t-1', 'user')]],
    ['unknown kind', [requested(user, 'pat')]],
    ['duplicate id', [requested(user, 'user'), requested(user, 'user')]],
    ['scoped without parent', [requested(child, 'user_scoped')]],
    [
      'scoped from a scoped token',
      [...base.slice(0, 4), requested(other, 'user_scoped', { parentId: child })],
    ],
    [
      'installation with parent',
      [...base.slice(0, 2), requested(install, 'installation', { parentId: user })],
    ],
    ['operation token without window', [requested(install, 'installation', { useBy: null })]],
    ['user token bound to an intent', [requested(user, 'user', { intentKey: 'k' })]],
    ['bad attempt', [requested(install, 'installation', { attempt: 0 })]],
    ['bad repository', [requested(install, 'installation', { repositoryId: -1 })]],
    ['bad timestamp', [requested(user, 'user', { at: 'yesterday' })]],
    [
      'second token for one intent attempt',
      [
        requested(install, 'installation'),
        requested(other, 'installation', { intentKey: `key-${install}` }),
      ],
    ],
    ['mint of unknown token', [minted(user)]],
    ['double mint', [...base.slice(0, 2), minted(user)]],
    [
      'mint failure with bad status',
      [requested(user, 'user'), { v: 1, type: 'token_mint_failed', id: user, status: 'x' }],
    ],
    ['user token handed out', [...base.slice(0, 2), { v: 1, type: 'token_used', id: user, at }]],
    ['revocation without verdict', [...base, { v: 1, type: 'token_revoked', id: install, at }]],
    ['rotating a child', [...base, { v: 1, type: 'token_rotated', id: child, at }]],
    ['grant via installation token', [...base, { v: 1, type: 'grant_deleted', via: install, at }]],
    [
      'grant refusal for unknown token',
      [{ v: 1, type: 'grant_delete_refused', via: user, status: 404, at }],
    ],
    ['unknown admission closer', [{ v: 1, type: 'admissions_disabled', reason: 'bored', at }]],
    [
      'revoking twice',
      [
        ...base,
        { v: 1, type: 'token_revoked', id: install, verified: true, at },
        { v: 1, type: 'token_revoked', id: install, verified: true, at },
      ],
    ],
  ])('rejects %s', (_label, events) => {
    expect(() => replayTokens(events)).toThrow(TokenJournalError);
  });

  it('marks the token mint failed, rotated or unrevocable', () => {
    const ledger = replayTokens([
      ...base,
      requested(other, 'installation', { intentKey: 'k2' }),
      { v: 1, type: 'token_mint_failed', id: other, status: 422 },
      { v: 1, type: 'token_rotated', id: user, at },
      { v: 1, type: 'token_unrevocable', id: install, at },
    ]);
    expect(ledger.tokens.get(other)?.status).toBe('mint_failed');
    expect(ledger.tokens.get(user)?.status).toBe('rotated');
    expect(ledger.tokens.get(child)?.status).toBe('live');
    expect(ledger.tokens.get(install)?.status).toBe('unrevocable');
  });
});

describe('TokenJournal', () => {
  it('refuses credential-shaped content before it reaches the store', () => {
    const appended: unknown[] = [];
    const journal = new TokenJournal({ read: () => [], append: (e) => appended.push(e) });
    expect(() =>
      journal.record({
        ...requested(install, 'installation', { intentKey: 'ghs_notatoken' }),
      } as never)
    ).toThrow(SecretRedactionError);
    expect(() => journal.record(minted(user) as never)).toThrow(TokenJournalError);
    expect(appended).toEqual([]);
  });
});
