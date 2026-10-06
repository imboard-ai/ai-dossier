import { createHash } from 'node:crypto';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireBakeLock,
  bakeProfile,
  ensureBaseImage,
  parseBakeConsole,
  sweepStaleBakes,
} from '../vm/bake';
import { BAKE_FAILED_MARKER, BAKE_RESULT_MARKER } from '../vm/cloud-init';
import type { HostTools } from '../vm/host';
import type { HostOps, Launched } from '../vm/local-qemu';
import { PROFILE_PINS } from '../vm/profile';

// The real pin is the SHA-256 of a ~600 MB cloud image. Re-pin the base image to
// bytes the test controls; parseManifest still validates against the real pin,
// so the manifest the bake writes carries it (bake.ts copies the pin verbatim).
vi.mock('../vm/profile', async (importOriginal) => {
  const real = await importOriginal<typeof import('../vm/profile')>();
  const { createHash: hash } = await import('node:crypto');
  const sha256 = hash('sha256').update(Buffer.alloc(100_000, 7)).digest('hex');
  return {
    ...real,
    PROFILE_PINS: Object.freeze({
      ...real.PROFILE_PINS,
      baseImage: Object.freeze({ ...real.PROFILE_PINS.baseImage, sha256 }),
    }),
    parseManifest: (value: Record<string, unknown>, digest: string) =>
      real.parseManifest({ ...value, baseImageSha256: real.PROFILE_PINS.baseImage.sha256 }, digest),
  };
});

const BASE_BYTES = Buffer.alloc(100_000, 7);
const NODE_ID = `sha256:${'1'.repeat(64)}`;
const PYTHON_ID = `sha256:${'2'.repeat(64)}`;
const RESULT_LINE = `${BAKE_RESULT_MARKER} ${JSON.stringify({ node: NODE_ID, python: PYTHON_ID })}`;
const { name, release } = PROFILE_PINS.baseImage;
const cachedName = `${name}-${release}.img`;

let root: string;
let cacheDir: string;
let profileDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-bake-'));
  cacheDir = path.join(root, 'cache');
  profileDir = path.join(root, 'profile');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const okFetch = (body: Buffer | null = BASE_BYTES, status = 200) =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch & {
    mock: { calls: unknown[][] };
  };

describe('ensureBaseImage', () => {
  it('returns a cached image whose hash matches without fetching', async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, cachedName), BASE_BYTES);
    const fetchImpl = okFetch();
    expect(await ensureBaseImage(cacheDir, fetchImpl)).toBe(path.join(cacheDir, cachedName));
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });

  it('downloads, verifies and renames into the cache', async () => {
    const fetchImpl = okFetch();
    const log = vi.fn();
    const file = await ensureBaseImage(cacheDir, fetchImpl, log);
    expect(fs.readFileSync(file).equals(BASE_BYTES)).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(PROFILE_PINS.baseImage.url);
    expect(log).toHaveBeenCalledWith(`downloading ${PROFILE_PINS.baseImage.url}`);
    expect(fs.readdirSync(cacheDir)).toEqual([cachedName]);
    expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700);
  });

  it('removes a cached image with the wrong hash and re-downloads', async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, cachedName), 'corrupt');
    const fetchImpl = okFetch();
    const file = await ensureBaseImage(cacheDir, fetchImpl);
    expect(fetchImpl.mock.calls).toHaveLength(1);
    expect(fs.readFileSync(file).equals(BASE_BYTES)).toBe(true);
  });

  it('throws on a download hash mismatch and leaves no partial file', async () => {
    const fetchImpl = okFetch(Buffer.from('not the pinned image'));
    const bytes = Buffer.from('not the pinned image');
    const actual = createHash('sha256').update(bytes).digest('hex');
    await expect(ensureBaseImage(cacheDir, fetchImpl)).rejects.toThrow(
      `Base image SHA-256 does not match the pin: expected ${PROFILE_PINS.baseImage.sha256}, got ${actual} (${bytes.length} bytes from ${PROFILE_PINS.baseImage.url})`
    );
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });

  it('throws on a non-ok response or a missing body', async () => {
    await expect(ensureBaseImage(cacheDir, okFetch(null, 404))).rejects.toThrow(
      `Base image download from ${PROFILE_PINS.baseImage.url} failed: HTTP 404`
    );
    await expect(ensureBaseImage(cacheDir, okFetch(null, 200))).rejects.toThrow(
      `Base image download from ${PROFILE_PINS.baseImage.url} failed: HTTP 200`
    );
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });

  it('passes an abort signal and abandons a request that stalls before responding', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? undefined;
            signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            );
          })
      ) as unknown as typeof fetch;
      const result = ensureBaseImage(cacheDir, fetchImpl).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(119_000);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      const error = (await result) as Error;
      expect(signal?.aborted).toBe(true);
      expect(error.message).toBe(
        `Base image download from ${PROFILE_PINS.baseImage.url} stalled for 120 s`
      );
      expect(fs.readdirSync(cacheDir)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a body that stops delivering, keeping the idle timer alive per chunk', async () => {
    // Only the idle timer is faked: setImmediate and file I/O stay real, so the
    // test can let the download consume a chunk before moving the clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const gate = {
        signal: undefined as AbortSignal | undefined,
        pulls: 0,
        deliver: null as (() => void) | null,
      };
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        gate.signal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>(
          {
            // Each chunk waits for the test; an abort rejects the pending read,
            // including one that was already aborted when the read started.
            pull(controller) {
              gate.pulls++;
              return new Promise<void>((resolve, reject) => {
                const abort = () => reject(new DOMException('aborted', 'AbortError'));
                if (gate.signal?.aborted) return abort();
                gate.signal?.addEventListener('abort', abort, { once: true });
                gate.deliver = () => {
                  gate.signal?.removeEventListener('abort', abort);
                  gate.deliver = null;
                  controller.enqueue(new Uint8Array(10));
                  resolve();
                };
              });
            },
          },
          { highWaterMark: 0 }
        );
        return new Response(body);
      }) as unknown as typeof fetch;
      const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
      const until = async (condition: () => boolean) => {
        for (let i = 0; i < 1000 && !condition(); i++) await turn();
        expect(condition()).toBe(true);
      };
      const result = ensureBaseImage(cacheDir, fetchImpl).catch((e: unknown) => e as Error);

      await until(() => gate.deliver !== null);
      await vi.advanceTimersByTimeAsync(100_000);
      expect(gate.signal?.aborted).toBe(false);
      // A chunk at 100 s re-arms the idle timer...
      gate.deliver?.();
      await until(() => gate.pulls >= 2 && gate.deliver !== null);
      await turn();
      // ...so 200 s after the start the download is still alive...
      await vi.advanceTimersByTimeAsync(100_000);
      expect(gate.signal?.aborted).toBe(false);
      // ...until 120 s pass without a chunk.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(gate.signal?.aborted).toBe(true);
      const error = await result;
      expect(error.message).toBe(
        `Base image download from ${PROFILE_PINS.baseImage.url} stalled for 120 s`
      );
      expect(fs.readdirSync(cacheDir)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the global fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(BASE_BYTES));
    try {
      await ensureBaseImage(cacheDir);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('parseBakeConsole', () => {
  it('extracts the container image ids', () => {
    expect(parseBakeConsole(`boot\n${RESULT_LINE}  \npoweroff\n`)).toEqual({
      node: NODE_ID,
      python: PYTHON_ID,
    });
  });

  it('fails on the failure marker even with a result', () => {
    expect(() =>
      parseBakeConsole(`boot\n  ${BAKE_FAILED_MARKER} line=3 exit=1  \n${RESULT_LINE}`)
    ).toThrow(`Bake script failed inside the VM: ${BAKE_FAILED_MARKER} line=3 exit=1`);
    const long = `${BAKE_FAILED_MARKER} ${'x'.repeat(500)}`;
    expect(() => parseBakeConsole(long)).toThrow(
      new Error(`Bake script failed inside the VM: ${long.slice(0, 200)}`)
    );
  });

  it('fails without a result marker', () => {
    expect(() => parseBakeConsole('boot\npoweroff\n')).toThrow('without a result marker');
    expect(() => parseBakeConsole(`prefix ${RESULT_LINE}`)).toThrow('without a result marker');
  });

  it.each([
    ['non-string node', { node: 1, python: PYTHON_ID }],
    ['missing python', { node: NODE_ID }],
    ['short id', { node: 'sha256:abc', python: PYTHON_ID }],
    ['upper-case python', { node: NODE_ID, python: `sha256:${'A'.repeat(64)}` }],
  ])('rejects malformed ids: %s', (_label, value) => {
    expect(() => parseBakeConsole(`${BAKE_RESULT_MARKER} ${JSON.stringify(value)}`)).toThrow(
      'Bake result marker is malformed'
    );
  });

  it('rejects a non-JSON result', () => {
    expect(() => parseBakeConsole(`${BAKE_RESULT_MARKER} {oops`)).toThrow(SyntaxError);
  });
});

describe('bakeProfile', () => {
  const tools: HostTools = {
    qemu: '/opt/fake/qemu-system-x86_64',
    qemuImg: '/opt/fake/qemu-img',
    isoTool: '/opt/fake/genisoimage',
    accelerator: 'kvm',
  };

  interface Fake {
    ops: HostOps;
    runs: { binary: string; args: readonly string[]; env: Record<string, string> }[];
    launches: { args: readonly string[]; env: Record<string, string>; stderrFile: string }[];
    kills: [number, NodeJS.Signals][];
    listenersAtLaunch?: number;
  }

  function fakeOps(
    consoleText: string | null,
    exited: Promise<string> = Promise.resolve('')
  ): Fake {
    const fake: Fake = {
      runs: [],
      launches: [],
      kills: [],
      ops: {
        async run(binary, args, env) {
          fake.runs.push({ binary, args, env });
          if (args[0] === 'convert') fs.writeFileSync(String(args.at(-1)), 'flattened image');
        },
        async launch(_binary, args, env, stderrFile): Promise<Launched> {
          fake.launches.push({ args, env, stderrFile });
          fake.listenersAtLaunch = process.listenerCount('SIGINT');
          if (fs.existsSync(path.dirname(stderrFile)))
            fs.writeFileSync(stderrFile, 'qemu: bake stderr\n');
          const serial = String(args[args.indexOf('-serial') + 1]);
          if (consoleText !== null) fs.writeFileSync(serial.slice('file:'.length), consoleText);
          return { pid: 777, exited };
        },
        async connect() {
          throw new Error('unused');
        },
        startToken: (pid) => `tok-${pid}`,
        cmdline: () => null,
        listProcesses: () => [],
        alive: () => false,
        kill(pid, signal) {
          fake.kills.push([pid, signal]);
        },
        rm() {},
        async sleep() {},
      },
    };
    return fake;
  }

  function seedCache(): void {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, cachedName), BASE_BYTES);
  }

  const leftovers = () => fs.readdirSync(profileDir).filter((n) => n.startsWith('.bake-'));

  it('bakes a profile image and writes a pinned manifest', async () => {
    seedCache();
    const fake = fakeOps(`cloud-init...\n${RESULT_LINE}\n`);
    const log = vi.fn();
    const manifest = await bakeProfile({
      profileDir,
      cacheDir,
      tools,
      ops: fake.ops,
      log,
      vcpus: 2,
      memoryMiB: 2048,
    });
    expect(manifest.containerImages).toEqual({ node: NODE_ID, python: PYTHON_ID });
    expect(manifest.imageFile).toMatch(/^zt-profile-[a-f0-9]{16}\.qcow2$/);
    const image = path.join(profileDir, manifest.imageFile);
    expect(manifest.imageSha256).toBe(createHash('sha256').update('flattened image').digest('hex'));
    expect(fs.statSync(image).mode & 0o777).toBe(0o400);
    const written = JSON.parse(fs.readFileSync(path.join(profileDir, 'manifest.json'), 'utf8'));
    expect(written).toEqual(JSON.parse(JSON.stringify(manifest)));
    expect(fs.readFileSync(path.join(profileDir, 'last-bake-console.log'), 'utf8')).toContain(
      RESULT_LINE
    );
    expect(leftovers()).toEqual([]);

    expect(fake.runs.map((r) => [r.binary, r.args[0]])).toEqual([
      [tools.isoTool, '-quiet'],
      [tools.qemuImg, 'create'],
      [tools.qemuImg, 'convert'],
    ]);
    const create = fake.runs[1]?.args ?? [];
    expect(create[create.indexOf('-b') + 1]).toBe(path.join(cacheDir, cachedName));
    for (const env of [...fake.runs.map((r) => r.env), fake.launches[0]?.env])
      expect(Object.keys(env ?? {}).sort()).toEqual(['LANG', 'PATH']);
    const args = fake.launches[0]?.args ?? [];
    expect(args[args.indexOf('-smp') + 1]).toBe('2');
    expect(args[args.indexOf('-m') + 1]).toBe('2048');
    expect(log).toHaveBeenCalledWith('baking with kvm');
    // The flattened image is written inside the work dir, then renamed into place.
    const convert = fake.runs[2]?.args ?? [];
    expect(path.dirname(String(convert.at(-1)))).toMatch(/\.bake-/);
    expect(path.basename(String(convert.at(-1)))).toBe(manifest.imageFile);
    expect(fs.readFileSync(path.join(profileDir, 'last-bake-qemu.err'), 'utf8')).toBe(
      'qemu: bake stderr\n'
    );
  });

  it('removes its SIGINT/SIGTERM listeners after a bake, successful or not', async () => {
    seedCache();
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };
    const fake = fakeOps(RESULT_LINE);
    await bakeProfile({ profileDir, cacheDir, tools, ops: fake.ops });
    expect(fake.listenersAtLaunch).toBe(before.SIGINT + 1);
    const failing = fakeOps(`${BAKE_FAILED_MARKER} line=1\n`);
    await expect(bakeProfile({ profileDir, cacheDir, tools, ops: failing.ops })).rejects.toThrow(
      'Bake script failed'
    );
    expect(failing.listenersAtLaunch).toBe(before.SIGINT + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
  });

  it('on an interrupt kills the bake VM, removes the work dir and re-raises the signal', async () => {
    seedCache();
    const existing = new Set(process.listeners('SIGTERM'));
    const reraised = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const interrupt = () => {
        const listener = process.listeners('SIGTERM').find((l) => !existing.has(l));
        if (!listener) throw new Error('expected the bake to listen for SIGTERM');
        (listener as (signal: NodeJS.Signals) => void)('SIGTERM');
      };
      const exited = new Promise<string>((resolve) => setImmediate(resolve, '')).then((tail) => {
        interrupt();
        return tail;
      });
      const fake = fakeOps(null, exited);
      const kill = fake.ops.kill;
      fake.ops.kill = (pid, signal) => {
        kill(pid, signal);
        throw new Error('ESRCH');
      };
      const launch = fake.ops.launch;
      fake.ops.launch = async (...args) => {
        interrupt(); // before the PID is known: nothing to kill yet
        return launch(...args);
      };
      await expect(bakeProfile({ profileDir, cacheDir, tools, ops: fake.ops })).rejects.toThrow(
        'Bake VM did not start'
      );
      expect(fake.kills).toEqual([[777, 'SIGKILL']]);
      expect(reraised).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      expect(leftovers()).toEqual([]);
    } finally {
      reraised.mockRestore();
    }
  });

  it('replaces a previous image of the same profile', async () => {
    seedCache();
    await bakeProfile({ profileDir, cacheDir, tools, ops: fakeOps(RESULT_LINE).ops });
    const again = await bakeProfile({ profileDir, cacheDir, tools, ops: fakeOps(RESULT_LINE).ops });
    expect(fs.existsSync(path.join(profileDir, again.imageFile))).toBe(true);
  });

  it('defaults to host preflight and system ops, refusing before anything starts', async () => {
    // Preflight refuses on a host without QEMU; otherwise the failed download does.
    // Either way no process is launched, since the base image comes first.
    await expect(
      bakeProfile({ profileDir, cacheDir, fetchImpl: okFetch(null, 503) })
    ).rejects.toThrow(/Execution profile refused|failed: HTTP 503/);
  });

  it('kills the VM and throws when the bake times out', async () => {
    seedCache();
    const fake = fakeOps(null, new Promise<string>(() => undefined));
    await expect(
      bakeProfile({ profileDir, cacheDir, tools, ops: fake.ops, timeoutMs: 10 })
    ).rejects.toThrow(
      `Bake timed out after 0 min under kvm; console kept at ${path.join(profileDir, 'last-bake-console.log')}`
    );
    expect(fake.kills).toEqual([[777, 'SIGKILL']]);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(path.join(profileDir, 'last-bake-console.log'))).toBe(false);
  });

  it('reports a VM that never wrote its console', async () => {
    seedCache();
    const fake = fakeOps(null, Promise.resolve('qemu: could not access KVM\n'));
    await expect(bakeProfile({ profileDir, cacheDir, tools, ops: fake.ops })).rejects.toThrow(
      'Bake VM did not start: qemu: could not access KVM'
    );
    expect(leftovers()).toEqual([]);
  });

  it('throws on the failure marker, keeps the console and cleans the work dir', async () => {
    seedCache();
    const fake = fakeOps(`${BAKE_FAILED_MARKER} line=12\n`);
    await expect(
      bakeProfile({ profileDir, cacheDir, tools: { ...tools, accelerator: 'tcg' }, ops: fake.ops })
    ).rejects.toThrow(
      `Bake script failed inside the VM: ${BAKE_FAILED_MARKER} line=12; console kept at ${path.join(profileDir, 'last-bake-console.log')}; QEMU stderr: `
    );
    expect(leftovers()).toEqual([]);
    expect(fs.readFileSync(path.join(profileDir, 'last-bake-qemu.err'), 'utf8')).toBe(
      'qemu: bake stderr\n'
    );
    expect(fs.readFileSync(path.join(profileDir, 'last-bake-console.log'), 'utf8')).toContain(
      BAKE_FAILED_MARKER
    );
    expect(fs.existsSync(path.join(profileDir, 'manifest.json'))).toBe(false);
    expect(fake.runs.map((r) => r.args[0])).not.toContain('convert');
  });

  it('holds the bake lock while baking and removes it afterwards, on success or failure', async () => {
    seedCache();
    const lock = path.join(profileDir, '.bake.lock');
    const fake = fakeOps(RESULT_LINE);
    let held: unknown = null;
    const launch = fake.ops.launch;
    fake.ops.launch = async (...args) => {
      held = JSON.parse(fs.readFileSync(lock, 'utf8'));
      expect(fs.statSync(lock).mode & 0o777).toBe(0o600);
      return launch(...args);
    };
    await bakeProfile({ profileDir, cacheDir, tools, ops: fake.ops });
    expect(held).toEqual({ pid: process.pid, token: `tok-${process.pid}` });
    expect(fs.existsSync(lock)).toBe(false);
    const failing = fakeOps(`${BAKE_FAILED_MARKER} line=1\n`);
    await expect(bakeProfile({ profileDir, cacheDir, tools, ops: failing.ops })).rejects.toThrow(
      'Bake script failed'
    );
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('refuses to start while another live bake holds the lock', async () => {
    seedCache();
    fs.mkdirSync(profileDir, { recursive: true });
    const lock = path.join(profileDir, '.bake.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: 4321, token: 'tok-4321' }));
    const fake = fakeOps(RESULT_LINE);
    await expect(bakeProfile({ profileDir, cacheDir, tools, ops: fake.ops })).rejects.toThrow(
      `Another bake holds ${lock} (pid 4321); wait for it to finish`
    );
    expect(fake.launches).toEqual([]);
    // The other bake's lock is not ours to remove.
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('sweeps the work dir of an interrupted bake, killing its VM, before baking', async () => {
    seedCache();
    fs.mkdirSync(profileDir, { recursive: true });
    const stale = path.join(profileDir, '.bake-old123');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'disk.qcow2'), 'old');
    const fake = fakeOps(RESULT_LINE);
    fake.ops.listProcesses = () => [555];
    fake.ops.cmdline = (pid) =>
      pid === 555
        ? ['qemu', '-drive', `file=${stale}/disk.qcow2`, '-pidfile', `${stale}/qemu.pid`]
        : null;
    await bakeProfile({ profileDir, cacheDir, tools, ops: fake.ops });
    expect(fake.kills).toEqual([[555, 'SIGKILL']]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});

describe('acquireBakeLock', () => {
  const ops = (startToken: HostOps['startToken']): HostOps =>
    ({ startToken }) as unknown as HostOps;
  const lockFile = () => path.join(profileDir, '.bake.lock');
  const holder = (value: unknown) => {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(lockFile(), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const mine = () => JSON.parse(fs.readFileSync(lockFile(), 'utf8'));

  it('creates a private lock naming this process', () => {
    fs.mkdirSync(profileDir);
    expect(
      acquireBakeLock(
        profileDir,
        ops((pid) => `tok-${pid}`)
      )
    ).toBe(lockFile());
    expect(mine()).toEqual({ pid: process.pid, token: `tok-${process.pid}` });
    expect(fs.statSync(lockFile()).mode & 0o777).toBe(0o600);
  });

  it('refuses a live holder, and a holder whose liveness cannot be read', () => {
    holder({ pid: 4321, token: 'tok-4321' });
    expect(() =>
      acquireBakeLock(
        profileDir,
        ops((pid) => `tok-${pid}`)
      )
    ).toThrow(/Another bake holds .*\(pid 4321\)/);
    const unreadable = ops((pid) => {
      if (pid === 4321) throw new Error('EACCES');
      return 'mine';
    });
    expect(() => acquireBakeLock(profileDir, unreadable)).toThrow(/Another bake holds/);
    expect(mine()).toEqual({ pid: 4321, token: 'tok-4321' });
  });

  it.each([
    ['a holder whose PID was recycled', { pid: 4321, token: 'tok-old' }],
    ['a holder that is gone', { pid: 4321, token: 'tok-4321', gone: true }],
    ['pid 1', { pid: 1, token: 'tok-1' }],
    ['a non-numeric pid', { pid: 'x', token: 'tok-x' }],
    ['an unreadable lock', '{not json'],
    ['an empty lock', ''],
  ])('takes over a stale lock: %s', (_label, value) => {
    holder(value);
    const startToken = (pid: number) =>
      pid === process.pid
        ? 'mine'
        : pid === 4321 && typeof value === 'object' && 'gone' in value
          ? null
          : `tok-${pid}`;
    expect(acquireBakeLock(profileDir, ops(startToken))).toBe(lockFile());
    expect(mine()).toEqual({ pid: process.pid, token: 'mine' });
  });

  it('rethrows errors other than an existing lock', () => {
    expect(() =>
      acquireBakeLock(
        path.join(root, 'missing'),
        ops(() => 'x')
      )
    ).toThrow(/ENOENT/);
  });

  it('gives up when the lock keeps reappearing', () => {
    holder({ pid: 4321, token: 'tok-old' });
    const rm = fs.rmSync;
    const spy = vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options) => {
      if (String(target) === lockFile()) return; // another bake re-creates it at once
      rm(target, options);
    }) as typeof fs.rmSync);
    try {
      expect(() =>
        acquireBakeLock(
          profileDir,
          ops((pid) => `tok-${pid}-now`)
        )
      ).toThrow(`Could not take the bake lock ${lockFile()}`);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('sweepStaleBakes', () => {
  interface SweepFake {
    ops: HostOps;
    kills: [number, NodeJS.Signals][];
    listed: number;
  }
  function sweepOps(processes: Record<number, string[] | null | Error>): SweepFake {
    const fake: SweepFake = {
      kills: [],
      listed: 0,
      ops: {
        listProcesses: () => {
          fake.listed++;
          return Object.keys(processes).map(Number);
        },
        cmdline: (pid: number) => {
          const argv = processes[pid];
          if (argv instanceof Error) throw argv;
          return argv ?? null;
        },
        kill: (pid: number, signal: NodeJS.Signals) => {
          fake.kills.push([pid, signal]);
          if (pid === 13) throw new Error('ESRCH');
        },
      } as unknown as HostOps,
    };
    return fake;
  }

  it('does nothing, and lists no processes, without stale work dirs', () => {
    fs.mkdirSync(profileDir);
    fs.writeFileSync(path.join(profileDir, 'manifest.json'), '{}');
    const fake = sweepOps({ 10: ['qemu'] });
    expect(sweepStaleBakes(profileDir, fake.ops)).toEqual([]);
    expect(fake.listed).toBe(0);
    expect(fs.readdirSync(profileDir)).toEqual(['manifest.json']);
  });

  it('kills only processes using a stale work dir, then removes every one', () => {
    fs.mkdirSync(profileDir);
    const a = path.join(profileDir, '.bake-a');
    const b = path.join(profileDir, '.bake-b');
    for (const dir of [a, b]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'disk.qcow2'), 'x');
    }
    fs.writeFileSync(path.join(profileDir, 'image.qcow2'), 'keep');
    const fake = sweepOps({
      10: ['qemu', '-pidfile', `${a}/qemu.pid`],
      11: ['qemu', '-pidfile', path.join(root, 'elsewhere', 'qemu.pid')],
      12: new Error('EACCES'),
      13: ['qemu', `${b}/disk.qcow2`],
      14: null,
      15: ['qemu', `${a}bc/disk.qcow2`, a],
    });
    expect(sweepStaleBakes(profileDir, fake.ops).sort()).toEqual([a, b]);
    expect(fake.kills).toEqual([
      [10, 'SIGKILL'],
      [13, 'SIGKILL'],
    ]);
    expect(fs.readdirSync(profileDir)).toEqual(['image.qcow2']);
  });
});
