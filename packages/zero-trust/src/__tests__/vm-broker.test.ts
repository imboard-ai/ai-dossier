import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretRedactionError } from '../redaction';
import { BrokerError } from '../vm/adapter';
import {
  assertWorkspacePath,
  BROKER_PROTOCOL,
  BrokerClient,
  type BrokerRequest,
  MAX_FILE_BYTES,
  MAX_FRAME_BYTES,
  MAX_STREAM_BYTES,
  validateRequest,
} from '../vm/broker';

type Frame = Record<string, unknown>;

/** An in-memory guest end of the broker channel. */
function guestPair() {
  const fromClient = new PassThrough();
  // A plain Duplex: destroy() without an error emits only 'close' (Duplex.from
  // would surface a premature-close error instead).
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      fromClient.write(chunk);
      callback();
    },
  });
  const toClient = {
    get destroyed() {
      return stream.destroyed;
    },
    write(value: string | Buffer) {
      stream.push(value);
    },
  };
  const frames: Frame[] = [];
  const waiters: ((frame: Frame) => void)[] = [];
  let buffer = '';
  let cursor = 0;
  fromClient.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const frame = JSON.parse(buffer.slice(0, end)) as Frame;
      buffer = buffer.slice(end + 1);
      frames.push(frame);
      waiters.shift()?.(frame);
    }
  });
  return {
    stream,
    frames,
    /** Resolves with the next frame the client wrote that was not yet consumed. */
    next(): Promise<Frame> {
      if (cursor < frames.length) return Promise.resolve(frames[cursor++] as Frame);
      return new Promise((resolve) =>
        waiters.push((frame) => {
          cursor++;
          resolve(frame);
        })
      );
    },
    send(value: Frame | string | Buffer): void {
      if (toClient.destroyed) return;
      toClient.write(
        typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`
      );
    },
    fail(error: Error): void {
      stream.destroy(error);
    },
  };
}

type Guest = ReturnType<typeof guestPair>;
const clients: BrokerClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

function hello(scope = 'container'): Frame {
  return { v: 1, id: 0, hello: BROKER_PROTOCOL, scope };
}

async function readyClient(scope = 'container'): Promise<{ client: BrokerClient; guest: Guest }> {
  const guest = guestPair();
  const client = new BrokerClient(guest.stream);
  clients.push(client);
  const ready = client.waitReady(1000);
  expect(await guest.next()).toEqual({ v: 1, id: 0, op: 'hello' });
  guest.send(hello(scope));
  expect(await ready).toBe(scope);
  return { client, guest };
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<BrokerError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected ${code}`);
    },
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(BrokerError);
  expect((error as BrokerError).code).toBe(code);
  return error as BrokerError;
}

function throwsCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

const b64 = (text: string) => Buffer.from(text).toString('base64');
const execOk = (id: unknown, extra: Frame = {}): Frame => ({
  v: 1,
  id,
  ok: true,
  exitCode: 0,
  timedOut: false,
  truncated: false,
  stdout: b64('out'),
  stderr: b64('err'),
  ...extra,
});
const execReq = { profile: 'node' as const, argv: ['node', '-v'], timeoutMs: 1000 };

describe('assertWorkspacePath', () => {
  it('accepts plain relative paths', () => {
    expect(assertWorkspacePath('a/b.txt')).toBe('a/b.txt');
    expect(assertWorkspacePath('src')).toBe('src');
    expect(assertWorkspacePath('', true)).toBe('');
  });

  it.each([
    ['traversal', '../etc/passwd'],
    ['inner traversal', 'a/../../b'],
    ['absolute', '/etc/passwd'],
    ['empty', ''],
    ['dot segment', 'a/./b'],
    ['trailing slash', 'a/'],
    ['double slash', 'a//b'],
    ['backslash', 'a\\b'],
    ['NUL', 'a\0b'],
    ['over 512 bytes', 'a'.repeat(513)],
    ['over 32 segments', Array.from({ length: 33 }, () => 'a').join('/')],
  ])('rejects %s', (_label, value) => {
    throwsCode(() => assertWorkspacePath(value), 'invalid_path');
  });

  it('rejects non-strings even when empty is allowed', () => {
    throwsCode(() => assertWorkspacePath(undefined, true), 'invalid_path');
    throwsCode(() => assertWorkspacePath(7), 'invalid_path');
  });

  it('accepts exactly 512 bytes and 32 segments', () => {
    expect(assertWorkspacePath('a'.repeat(512))).toHaveLength(512);
    const segs = Array.from({ length: 32 }, () => 'a').join('/');
    expect(assertWorkspacePath(segs)).toBe(segs);
  });
});

describe('validateRequest', () => {
  const exec = (over: Partial<Extract<BrokerRequest, { op: 'exec' }>> = {}) =>
    ({
      op: 'exec',
      profile: 'node',
      argv: ['ls'],
      cwd: '',
      timeoutMs: 1000,
      ...over,
    }) as BrokerRequest;

  it('rejects unknown or missing ops', () => {
    throwsCode(() => validateRequest({ op: 'rm' } as unknown as BrokerRequest), 'invalid_op');
    throwsCode(() => validateRequest({} as unknown as BrokerRequest), 'invalid_op');
    throwsCode(() => validateRequest(null as unknown as BrokerRequest), 'invalid_op');
  });

  it('copies a valid exec request and drops extra fields', () => {
    const argv = ['npm', 'test'];
    const out = validateRequest({
      ...exec({ argv, cwd: 'pkg', profile: 'python' }),
      extra: 1,
    } as unknown as BrokerRequest);
    expect(out).toEqual({
      op: 'exec',
      profile: 'python',
      argv: ['npm', 'test'],
      cwd: 'pkg',
      timeoutMs: 1000,
    });
    expect((out as { argv: string[] }).argv).not.toBe(argv);
  });

  it('rejects an unknown profile', () => {
    throwsCode(() => validateRequest(exec({ profile: 'ruby' as 'node' })), 'invalid_profile');
  });

  it.each([
    ['empty', []],
    ['non-array', 'ls'],
    ['non-string', ['ls', 3]],
    ['NUL', ['ls\0']],
    ['arg over 8192 bytes', ['x'.repeat(8193)]],
    ['total over 64 KiB', Array.from({ length: 9 }, () => 'x'.repeat(8000))],
    ['over 256 args', Array.from({ length: 257 }, () => 'a')],
  ])('rejects argv: %s', (_label, argv) => {
    throwsCode(() => validateRequest(exec({ argv: argv as string[] })), 'invalid_argv');
  });

  it('accepts an argv exactly at the limits', () => {
    expect(() =>
      validateRequest(exec({ argv: Array.from({ length: 256 }, () => 'a') }))
    ).not.toThrow();
    expect(() => validateRequest(exec({ argv: ['x'.repeat(8192)] }))).not.toThrow();
  });

  it('rejects argv carrying a secret-shaped token', () => {
    expect(() => validateRequest(exec({ argv: ['curl', 'ghp_abcdef'] }))).toThrow(
      SecretRedactionError
    );
  });

  it.each([
    999,
    6 * 3600 * 1000 + 1,
    1500.5,
    Number.NaN,
    '2000',
  ])('rejects timeout %s', (timeoutMs) => {
    throwsCode(() => validateRequest(exec({ timeoutMs: timeoutMs as number })), 'invalid_timeout');
  });

  it('accepts timeout bounds and validates cwd', () => {
    expect(() => validateRequest(exec({ timeoutMs: 6 * 3600 * 1000 }))).not.toThrow();
    throwsCode(() => validateRequest(exec({ cwd: '../up' })), 'invalid_path');
  });

  it('validates put payloads', () => {
    expect(
      validateRequest({ op: 'put', path: 'a.txt', data: b64('hi'), executable: 'yes' as never })
    ).toEqual({ op: 'put', path: 'a.txt', data: b64('hi'), executable: false });
    expect(
      validateRequest({ op: 'put', path: 'bin/run', data: '', executable: true })
    ).toMatchObject({ executable: true });
    throwsCode(
      () => validateRequest({ op: 'put', path: 'a', data: 'abc', executable: false }),
      'invalid_data'
    );
    throwsCode(
      () => validateRequest({ op: 'put', path: 'a', data: 'a b=', executable: false }),
      'invalid_data'
    );
    throwsCode(
      () =>
        validateRequest({
          op: 'put',
          path: 'a',
          data: Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64'),
          executable: false,
        }),
      'invalid_data'
    );
    throwsCode(
      () => validateRequest({ op: 'put', path: '/abs', data: '', executable: false }),
      'invalid_path'
    );
  });

  it('validates get paths', () => {
    expect(validateRequest({ op: 'get', path: 'out/x' })).toEqual({ op: 'get', path: 'out/x' });
    throwsCode(() => validateRequest({ op: 'get', path: '../x' }), 'invalid_path');
    throwsCode(() => validateRequest({ op: 'get', path: '' }), 'invalid_path');
  });
});

describe('BrokerClient handshake', () => {
  it('resolves with vm-root scope and stays ready', async () => {
    const { client } = await readyClient('vm-root');
    expect(client.scope).toBe('vm-root');
    expect(await client.waitReady(10)).toBe('vm-root');
    expect(client.tainted).toBeNull();
  });

  it.each([
    ['wrong protocol', { v: 1, id: 0, hello: 'zt-broker-v2', scope: 'container' }],
    ['wrong scope', { v: 1, id: 0, hello: BROKER_PROTOCOL, scope: 'host' }],
    ['wrong id', { v: 1, id: 1, hello: BROKER_PROTOCOL, scope: 'container' }],
  ])('taints on a bad hello: %s', async (_label, frame) => {
    const guest = guestPair();
    const client = new BrokerClient(guest.stream);
    clients.push(client);
    const ready = client.waitReady(1000);
    await guest.next();
    guest.send(frame);
    await rejectsCode(ready, 'unexpected_hello');
    expect(client.tainted?.code).toBe('unexpected_hello');
    await rejectsCode(client.waitReady(10), 'unexpected_hello');
  });

  it('taints on a hello that arrives before anyone waits for it', async () => {
    const guest = guestPair();
    const client = new BrokerClient(guest.stream);
    clients.push(client);
    guest.send(hello());
    await expect.poll(() => client.tainted?.code).toBe('unexpected_hello');
  });

  it('treats a second hello after ready as unsolicited', async () => {
    const { client, guest } = await readyClient();
    guest.send(hello());
    await expect.poll(() => client.tainted?.code).toBe('unsolicited_frame');
  });

  it('refuses a concurrent waitReady', async () => {
    const guest = guestPair();
    const client = new BrokerClient(guest.stream);
    clients.push(client);
    const first = client.waitReady(1000);
    await rejectsCode(client.waitReady(1000), 'hello_pending');
    guest.send(hello());
    expect(await first).toBe('container');
  });

  it('taints with boot_timeout when the guest never answers', async () => {
    const guest = guestPair();
    const client = new BrokerClient(guest.stream);
    clients.push(client);
    await rejectsCode(client.waitReady(20), 'boot_timeout');
  });

  it('refuses requests before the handshake without tainting', async () => {
    const guest = guestPair();
    const client = new BrokerClient(guest.stream);
    clients.push(client);
    await rejectsCode(client.get('a', 1000), 'not_ready');
    expect(client.tainted).toBeNull();
  });

  it('taints when the stream errors or closes, rejecting the waiter', async () => {
    const guest = guestPair();
    const client = new BrokerClient(guest.stream);
    clients.push(client);
    const ready = client.waitReady(1000);
    guest.fail(new Error('boom'));
    await rejectsCode(ready, 'stream_error');

    const other = guestPair();
    const closed = new BrokerClient(other.stream);
    clients.push(closed);
    other.stream.destroy();
    await expect.poll(() => closed.tainted?.code).toBe('stream_closed');
  });
});

describe('BrokerClient exec', () => {
  it('sends a validated request and decodes the streams', async () => {
    const { client, guest } = await readyClient();
    const result = client.exec({ ...execReq, cwd: 'pkg' }, 50);
    const frame = await guest.next();
    expect(frame).toEqual({
      v: 1,
      id: 1,
      op: 'exec',
      profile: 'node',
      argv: ['node', '-v'],
      cwd: 'pkg',
      timeoutMs: 1000,
    });
    guest.send(execOk(1, { exitCode: null, timedOut: true, truncated: true }));
    expect(await result).toMatchObject({
      exitCode: null,
      timedOut: true,
      truncated: true,
      stdout: 'out',
      stderr: 'err',
    });
    const second = client.exec(execReq, 50);
    expect(await guest.next()).toMatchObject({ id: 2, cwd: '' });
    guest.send(execOk(2, { exitCode: 255 }));
    expect((await second).exitCode).toBe(255);
    expect(client.tainted).toBeNull();
  });

  it.each([
    ['exit code 256', { exitCode: 256 }],
    ['negative exit code', { exitCode: -1 }],
    ['fractional exit code', { exitCode: 1.5 }],
    ['string exit code', { exitCode: '0' }],
    ['non-boolean timedOut', { timedOut: 'no' }],
    ['non-boolean truncated', { truncated: 1 }],
    ['non-canonical stdout', { stdout: 'abc' }],
    ['non-string stderr', { stderr: 5 }],
    ['oversize stdout', { stdout: Buffer.alloc(MAX_STREAM_BYTES + 1).toString('base64') }],
  ])('taints on a malformed response: %s', async (_label, extra) => {
    const { client, guest } = await readyClient();
    const result = client.exec(execReq, 50);
    await guest.next();
    guest.send(execOk(1, extra));
    await rejectsCode(result, 'malformed_response');
    expect(client.tainted?.code).toBe('malformed_response');
    await rejectsCode(client.exec(execReq, 50), 'malformed_response');
    await rejectsCode(client.get('a', 100), 'malformed_response');
  });

  it('maps a guest error slug without tainting', async () => {
    const { client, guest } = await readyClient();
    const result = client.exec(execReq, 50);
    await guest.next();
    guest.send({ v: 1, id: 1, ok: false, error: 'some_code' });
    await rejectsCode(result, 'guest_some_code');
    expect(client.tainted).toBeNull();
  });

  it.each([
    ['invalid slug', { ok: false, error: 'Bad-Code' }],
    ['non-string error', { ok: false, error: 42 }],
    ['ok neither true nor false', { ok: 'yes', error: 'x' }],
  ])('taints on an untrusted error frame: %s', async (_label, extra) => {
    const { client, guest } = await readyClient();
    const result = client.exec(execReq, 50);
    await guest.next();
    guest.send({ v: 1, id: 1, ...extra });
    await rejectsCode(result, 'malformed_response');
    expect(client.tainted?.code).toBe('malformed_response');
  });

  it('rejects a secret-bearing argv before sending', async () => {
    const { client, guest } = await readyClient();
    await expect(client.exec({ ...execReq, argv: ['sk-ant-x'] }, 50)).rejects.toThrow(
      SecretRedactionError
    );
    expect(guest.frames).toHaveLength(1);
    expect(client.tainted).toBeNull();
  });
});

describe('BrokerClient protocol violations', () => {
  async function pendingGet() {
    const ctx = await readyClient();
    const result = ctx.client.get('a', 1000);
    await ctx.guest.next();
    return { ...ctx, result };
  }

  it('taints on an id mismatch', async () => {
    const { client, guest, result } = await pendingGet();
    guest.send({ v: 1, id: 7, ok: true, data: '' });
    await rejectsCode(result, 'id_mismatch');
    expect(client.tainted?.code).toBe('id_mismatch');
  });

  it('taints on an unsolicited frame', async () => {
    const { client, guest } = await readyClient();
    guest.send({ v: 1, id: 1, ok: true });
    await expect.poll(() => client.tainted?.code).toBe('unsolicited_frame');
  });

  it.each([
    ['malformed JSON', '{not json\n'],
    ['array frame', '[1]\n'],
    ['null frame', 'null\n'],
    ['wrong version', `${JSON.stringify({ v: 2, id: 1, ok: true })}\n`],
  ])('taints on %s', async (_label, line) => {
    const { client, guest, result } = await pendingGet();
    guest.send(line);
    await rejectsCode(result, 'malformed_frame');
    expect(client.tainted?.code).toBe('malformed_frame');
  });

  it('taints when a whole line exceeds MAX_FRAME_BYTES', async () => {
    const { client, guest, result } = await pendingGet();
    guest.send(Buffer.alloc(MAX_FRAME_BYTES, 0x61));
    guest.send('a\n');
    await rejectsCode(result, 'frame_too_large');
    expect(client.tainted?.code).toBe('frame_too_large');
  });

  it('taints when an unterminated buffer exceeds MAX_FRAME_BYTES', async () => {
    const { client, guest, result } = await pendingGet();
    guest.send(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61));
    await rejectsCode(result, 'frame_too_large');
    expect(client.tainted?.code).toBe('frame_too_large');
  });

  it('ignores data after taint and accepts frames split across chunks', async () => {
    const { client, guest } = await readyClient();
    const result = client.get('a', 1000);
    await guest.next();
    const line = `${JSON.stringify({ v: 1, id: 1, ok: true, data: b64('xy') })}\n`;
    guest.send(line.slice(0, 5));
    guest.send(line.slice(5));
    expect((await result).toString()).toBe('xy');
    client.taint('manual');
    client.taint('second');
    guest.send(hello());
    expect(client.tainted?.code).toBe('manual');
  });

  it('taints with request_timeout when the guest stalls', async () => {
    const { client, guest } = await readyClient();
    const result = client.get('a', 20);
    await guest.next();
    await rejectsCode(result, 'request_timeout');
    expect(client.tainted?.code).toBe('request_timeout');
  });

  it('rejects a pending request when the stream errors', async () => {
    const { client, guest, result } = await pendingGet();
    guest.fail(new Error('reset'));
    await rejectsCode(result, 'stream_error');
    expect(client.tainted?.code).toBe('stream_error');
  });

  it('rejects a pending request when the stream closes', async () => {
    const { client, guest, result } = await pendingGet();
    guest.stream.destroy();
    await rejectsCode(result, 'stream_closed');
    expect(client.tainted?.code).toBe('stream_closed');
  });
});

describe('BrokerClient put/get', () => {
  it('round-trips put and get', async () => {
    const { client, guest } = await readyClient();
    const put = client.put('bin/run', Buffer.from('#!/bin/sh\n'), true, 1000);
    expect(await guest.next()).toEqual({
      v: 1,
      id: 1,
      op: 'put',
      path: 'bin/run',
      data: b64('#!/bin/sh\n'),
      executable: true,
    });
    guest.send({ v: 1, id: 1, ok: true });
    await put;
    const get = client.get('out.txt', 1000);
    expect(await guest.next()).toEqual({ v: 1, id: 2, op: 'get', path: 'out.txt' });
    guest.send({ v: 1, id: 2, ok: true, data: b64('result') });
    expect((await get).toString()).toBe('result');
  });

  it('maps guest errors on put and get', async () => {
    const { client, guest } = await readyClient();
    const put = client.put('a', Buffer.from('x'), false, 1000);
    await guest.next();
    guest.send({ v: 1, id: 1, ok: false, error: 'no_space' });
    await rejectsCode(put, 'guest_no_space');
    const get = client.get('a', 1000);
    await guest.next();
    guest.send({ v: 1, id: 2, ok: false, error: 'not_found' });
    await rejectsCode(get, 'guest_not_found');
    expect(client.tainted).toBeNull();
  });

  it.each([
    ['non-string data', { data: 12 }],
    ['non-canonical data', { data: 'abc' }],
    ['oversize data', { data: Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64') }],
  ])('taints on get with %s', async (_label, extra) => {
    const { client, guest } = await readyClient();
    const get = client.get('a', 1000);
    await guest.next();
    guest.send({ v: 1, id: 1, ok: true, ...extra });
    await rejectsCode(get, 'malformed_response');
    expect(client.tainted?.code).toBe('malformed_response');
  });

  it('rejects an oversize put before sending anything', async () => {
    const { client, guest } = await readyClient();
    await rejectsCode(
      client.put('a', Buffer.alloc(MAX_FILE_BYTES + 1), false, 1000),
      'invalid_data'
    );
    expect(guest.frames).toHaveLength(1);
    expect(client.tainted).toBeNull();
  });

  it('serializes requests: the second is written only after the first resolves', async () => {
    const { client, guest } = await readyClient();
    const first = client.get('one', 1000);
    const second = client.get('two', 1000);
    expect(await guest.next()).toMatchObject({ id: 1, path: 'one' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(guest.frames).toHaveLength(2);
    guest.send({ v: 1, id: 1, ok: true, data: b64('1') });
    expect((await first).toString()).toBe('1');
    expect(await guest.next()).toMatchObject({ id: 2, path: 'two' });
    guest.send({ v: 1, id: 2, ok: true, data: b64('2') });
    expect((await second).toString()).toBe('2');
  });

  it('runs the next queued request after a failed one', async () => {
    const { client, guest } = await readyClient();
    const bad = client.get('../escape', 1000);
    const good = client.get('ok', 1000);
    await rejectsCode(bad, 'invalid_path');
    expect(client.tainted).toBeNull();
    expect(await guest.next()).toMatchObject({ id: 1, path: 'ok' });
    guest.send({ v: 1, id: 1, ok: true, data: '' });
    expect((await good).length).toBe(0);
  });

  it('close() destroys the stream and taints the client', async () => {
    const { client, guest } = await readyClient();
    client.close();
    expect(guest.stream.destroyed).toBe(true);
    await expect.poll(() => client.tainted?.code).toBe('stream_closed');
    await rejectsCode(client.get('a', 1000), 'stream_closed');
  });
});
