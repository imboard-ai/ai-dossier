import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPackageVersion } from '../commands/doctor';
import * as config from '../config';
import { checkEngineStaleness } from '../engine-version';

vi.mock('node:fs');
vi.mock('../config');
vi.mock('../commands/doctor');

const mockedFs = vi.mocked(fs);

describe('checkEngineStaleness (#537)', () => {
  beforeEach(() => {
    vi.mocked(config.getConfig).mockReturnValue(300);
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readFileSync.mockReturnValue('');
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.mkdirSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports stale when installed is behind npm latest, and writes the resolution cache', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('0.12.1');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '0.13.0' }),
      })
    );

    const result = await checkEngineStaleness();

    expect(result).toEqual({ installed: '0.12.1', latest: '0.13.0', stale: true });
    expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockedFs.writeFileSync.mock.calls[0][1] as string);
    expect(written.latest_version).toBe('0.13.0');
  });

  it('reports not stale when installed matches or is ahead of npm latest', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('0.13.0');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: '0.13.0' }) })
    );

    expect(await checkEngineStaleness()).toEqual({
      installed: '0.13.0',
      latest: '0.13.0',
      stale: false,
    });
  });

  it('serves the cached latest version within the TTL without calling fetch', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('0.12.1');
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ latest_version: '0.13.0', checked_at: new Date().toISOString() })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkEngineStaleness();

    expect(result).toEqual({ installed: '0.12.1', latest: '0.13.0', stale: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-fetches once the cached record is older than the TTL', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('0.12.1');
    mockedFs.existsSync.mockReturnValue(true);
    const stale = new Date(Date.now() - 400_000).toISOString(); // older than 300s TTL
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ latest_version: '0.12.5', checked_at: stale })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: '0.13.0' }) })
    );

    const result = await checkEngineStaleness();

    expect(result.latest).toBe('0.13.0');
  });

  it('is best-effort: a network failure returns latest=null and never throws', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('0.12.1');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('registry unreachable')));

    const result = await checkEngineStaleness();

    expect(result).toEqual({ installed: '0.12.1', latest: null, stale: false });
  });

  it('is best-effort: a non-ok HTTP response returns latest=null and never throws', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('0.12.1');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    const result = await checkEngineStaleness();

    expect(result).toEqual({ installed: '0.12.1', latest: null, stale: false });
  });

  it('noFetch reads the warm cache but never hits the network (sched status contract)', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('0.12.1');
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ latest_version: '0.13.0', checked_at: new Date().toISOString() })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkEngineStaleness({ noFetch: true });

    expect(result).toEqual({ installed: '0.12.1', latest: '0.13.0', stale: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('noFetch with no warm cache returns latest=null without ever calling fetch', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('0.12.1');
    mockedFs.existsSync.mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkEngineStaleness({ noFetch: true });

    expect(result).toEqual({ installed: '0.12.1', latest: null, stale: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fresh bypasses a warm cache and re-fetches', async () => {
    vi.mocked(getPackageVersion).mockReturnValue('0.12.1');
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ latest_version: '0.12.5', checked_at: new Date().toISOString() })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: '0.13.0' }) })
    );

    const result = await checkEngineStaleness({ fresh: true });

    expect(result.latest).toBe('0.13.0');
  });

  it('reports stale=false when the installed version cannot be resolved', async () => {
    vi.mocked(getPackageVersion).mockReturnValue(null);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ version: '0.13.0' }) })
    );

    const result = await checkEngineStaleness();

    expect(result).toEqual({ installed: null, latest: '0.13.0', stale: false });
  });
});
