import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { assertProxyTarget, ProvisionChannel } from '../vm/provision-channel';

const servers: net.Server[] = [];
const serverSockets: net.Socket[] = [];
const channels: ProvisionChannel[] = [];
afterEach(async () => {
  for (const channel of channels.splice(0)) channel.close();
  for (const socket of serverSockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function server(onSocket: (socket: net.Socket) => void): Promise<number> {
  const s = net.createServer({ allowHalfOpen: true }, (socket) => {
    serverSockets.push(socket);
    onSocket(socket);
  });
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()));
  return (s.address() as net.AddressInfo).port;
}

/** Stands in for the guest relay behind the forward: hands out accepted connections. */
async function fakeRelay() {
  const accepted: net.Socket[] = [];
  const waiters: ((s: net.Socket) => void)[] = [];
  const port = await server((socket) => {
    const waiter = waiters.shift();
    if (waiter) waiter(socket);
    else accepted.push(socket);
  });
  return {
    port,
    accepted,
    next: () =>
      new Promise<net.Socket>((resolve) => {
        const ready = accepted.shift();
        if (ready) resolve(ready);
        else waiters.push(resolve);
      }),
  };
}

function start(forwardPort: number, targetPort: number, extra = {}): ProvisionChannel {
  const channel = new ProvisionChannel({
    forwardPort,
    target: { host: '127.0.0.1', port: targetPort },
    ...extra,
  });
  channels.push(channel);
  channel.start();
  return channel;
}

/** The channel hung up on this relay-side socket (FIN or reset). */
const hungUp = (socket: net.Socket) =>
  new Promise<void>((resolve) => {
    socket.resume();
    for (const event of ['end', 'close', 'error']) socket.once(event, () => resolve());
  });

const read = (socket: net.Socket) =>
  new Promise<string>((resolve) => {
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.once('end', () => resolve(data));
  });

describe('ProvisionChannel', () => {
  it('keeps a pool of connections dialed into the guest', async () => {
    const relay = await fakeRelay();
    const channel = start(relay.port, 1, { poolSize: 3 });
    await expect.poll(() => relay.accepted.length).toBe(3);
    expect(channel.stats.dialed).toBe(3);
    expect(channel.stats.spliced).toBe(0);
  });

  it('splices a guest connection to the target only once the guest speaks', async () => {
    const upstreamSeen: string[] = [];
    let upstreamConnections = 0;
    const target = await server((socket) => {
      upstreamConnections++;
      socket.on('data', (chunk) => {
        upstreamSeen.push(chunk.toString());
        socket.end('HTTP/1.1 200 OK\r\n\r\npong');
      });
    });
    const relay = await fakeRelay();
    const channel = start(relay.port, target, { poolSize: 1 });
    const guest = await relay.next();
    await new Promise((r) => setTimeout(r, 50));
    expect(upstreamConnections).toBe(0); // nothing is dialed for an idle connection
    const reply = read(guest);
    guest.write('GET /ms HTTP/1.1\r\n\r\n');
    expect(await reply).toBe('HTTP/1.1 200 OK\r\n\r\npong');
    expect(upstreamSeen.join('')).toBe('GET /ms HTTP/1.1\r\n\r\n');
    expect(channel.stats).toMatchObject({ spliced: 1, upstreamFailures: 0 });
    // The used connection is replaced, so the pool stays full.
    await expect.poll(() => channel.stats.dialed).toBeGreaterThanOrEqual(2);
  });

  it('closes the guest connection when the target refuses', async () => {
    // A port that was free a moment ago: nothing listens there.
    const port = await server(() => undefined);
    await new Promise((r) => servers.pop()?.close(r));
    const relay = await fakeRelay();
    const channel = start(relay.port, port, { poolSize: 1 });
    const guest = await relay.next();
    const ended = hungUp(guest);
    guest.write('GET / HTTP/1.1\r\n\r\n');
    await ended;
    expect(channel.stats.upstreamFailures).toBe(1);
  });

  it('drops a guest that sends too much before the target is connected', async () => {
    const target = await server(() => undefined);
    const relay = await fakeRelay();
    start(relay.port, target, { poolSize: 1, maxPendingBytes: 4 });
    const guest = await relay.next();
    const ended = hungUp(guest);
    guest.write('0123456789');
    await ended;
  });

  it('stops dialing and closes everything on close()', async () => {
    const relay = await fakeRelay();
    const channel = start(relay.port, 1, { poolSize: 2 });
    await expect.poll(() => relay.accepted.length).toBe(2);
    const sockets = [...relay.accepted];
    const closed = Promise.all(sockets.map(hungUp));
    channel.close();
    await closed;
    const dialed = channel.stats.dialed;
    await new Promise((r) => setTimeout(r, 400));
    expect(channel.stats.dialed).toBe(dialed);
  });

  it('accepts only an IPv4 literal and a valid port as the target', () => {
    expect(assertProxyTarget({ host: '172.31.250.3', port: 4873 })).toEqual({
      host: '172.31.250.3',
      port: 4873,
    });
    for (const bad of [
      { host: 'mirror', port: 4873 },
      { host: '256.1.1.1', port: 1 },
      { host: '::1', port: 1 },
      { host: '1.2.3.4', port: 0 },
      { host: '1.2.3.4', port: 65536 },
    ])
      expect(() => assertProxyTarget(bad)).toThrow('Invalid provisioning proxy target');
    expect(
      () => new ProvisionChannel({ forwardPort: 0, target: { host: '1.2.3.4', port: 1 } })
    ).toThrow('Invalid forward port');
  });
});
