import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizePublish, signJwt } from '../lib/auth';
import { canPublishTo } from '../lib/permissions';
import type { JwtPayload } from '../lib/types';
import { createViMockRes } from './helpers/mocks';

describe('canPublishTo', () => {
  const basePayload: JwtPayload = {
    sub: 'alice',
    email: 'alice@example.com',
    orgs: ['acme-corp', 'cool-team'],
  };

  it('allows publishing to personal namespace', () => {
    const result = canPublishTo(basePayload, 'alice/my-dossier');
    expect(result.allowed).toBe(true);
  });

  it('allows publishing to org namespace', () => {
    const result = canPublishTo(basePayload, 'acme-corp/some-dossier');
    expect(result.allowed).toBe(true);
  });

  it('denies publishing to unrelated namespace', () => {
    const result = canPublishTo(basePayload, 'evil-corp/bad-stuff');
    expect(result.allowed).toBe(false);
  });
});

describe('authorizePublish - 403 response', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-for-permissions';
  });

  it('does not expose username or orgs in 403 error message', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const token = signJwt({
      sub: 'alice',
      email: 'alice@example.com',
      orgs: ['acme-corp', 'cool-team'],
    });
    const req = { headers: { authorization: `Bearer ${token}` } } as never;
    const res = createViMockRes();

    const result = await authorizePublish(req, res, 'evil-corp/bad-stuff');
    expect(result).toBeNull();
    expect(res.status).toHaveBeenCalledWith(403);

    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonArg.error.message).not.toContain('alice');
    expect(jsonArg.error.message).not.toContain('acme-corp');
    expect(jsonArg.error.message).not.toContain('cool-team');
    expect(jsonArg.error.message).toBe("Cannot publish to namespace 'evil-corp/bad-stuff'");

    vi.restoreAllMocks();
  });

  it('uses delete wording when action is delete', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const token = signJwt({
      sub: 'alice',
      email: 'alice@example.com',
      orgs: ['acme-corp'],
    });
    const req = { headers: { authorization: `Bearer ${token}` } } as never;
    const res = createViMockRes();

    const result = await authorizePublish(req, res, 'evil-corp/bad-stuff', 'delete');
    expect(result).toBeNull();

    const jsonArg = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(jsonArg.error.message).toBe("Cannot delete from namespace 'evil-corp/bad-stuff'");

    vi.restoreAllMocks();
  });
});
