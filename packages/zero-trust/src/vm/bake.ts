/** Trusted profile bake: pinned cloud image + controller cloud-init → a flattened,
 * hash-pinned profile image. No repository or model input is involved. */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { replacePrivate } from '../durable-fs';
import type { AcceleratorRequest } from './adapter';
import { BAKE_FAILED_MARKER, BAKE_RESULT_MARKER, bakeMetaData, bakeUserData } from './cloud-init';
import { type HostTools, preflightHost } from './host';
import { AGENT_SOURCE_PATH, type HostOps, systemOps } from './local-qemu';
import {
  PROFILE_PINS,
  type ProfileManifest,
  parseManifest,
  profileDigest,
  sha256File,
} from './profile';
import { buildBakeArgs } from './qemu-args';

export interface BakeOptions {
  readonly profileDir: string;
  /** Download cache for the pinned base image. */
  readonly cacheDir: string;
  readonly accelerator?: AcceleratorRequest;
  readonly vcpus?: number;
  readonly memoryMiB?: number;
  readonly timeoutMs?: number;
  readonly tools?: HostTools;
  readonly ops?: HostOps;
  readonly log?: (message: string) => void;
  readonly fetchImpl?: typeof fetch;
}

const QEMU_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C' };

/** Download (if needed) and verify the pinned base image; never trust a cached copy blindly. */
export async function ensureBaseImage(
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
  log: (m: string) => void = () => undefined
): Promise<string> {
  const { name, release, url, sha256 } = PROFILE_PINS.baseImage;
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const file = path.join(cacheDir, `${name}-${release}.img`);
  if (fs.existsSync(file)) {
    if (sha256File(file) === sha256) return file;
    fs.rmSync(file);
  }
  log(`downloading ${url}`);
  const response = await fetchImpl(url);
  if (!response.ok || !response.body)
    throw new Error(`Base image download failed: ${response.status}`);
  const part = `${file}.${randomBytes(4).toString('hex')}.part`;
  const hash = createHash('sha256');
  const out = fs.createWriteStream(part, { mode: 0o600 });
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk))
        await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    }
    await new Promise<void>((resolve, reject) =>
      out.end((e?: Error | null) => (e ? reject(e) : resolve()))
    );
    if (hash.digest('hex') !== sha256) throw new Error('Base image SHA-256 does not match the pin');
    fs.renameSync(part, file);
  } finally {
    fs.rmSync(part, { force: true });
  }
  return file;
}

export function parseBakeConsole(consoleText: string): { node: string; python: string } {
  if (consoleText.includes(BAKE_FAILED_MARKER)) throw new Error('Bake script failed inside the VM');
  const line = consoleText.split('\n').find((l) => l.startsWith(`${BAKE_RESULT_MARKER} `));
  if (!line) throw new Error('Bake finished without a result marker');
  const value = JSON.parse(line.slice(BAKE_RESULT_MARKER.length + 1).trim()) as Record<
    string,
    unknown
  >;
  const id = /^sha256:[a-f0-9]{64}$/;
  if (
    typeof value.node !== 'string' ||
    typeof value.python !== 'string' ||
    !id.test(value.node) ||
    !id.test(value.python)
  )
    throw new Error('Bake result marker is malformed');
  return { node: value.node, python: value.python };
}

export async function bakeProfile(options: BakeOptions): Promise<ProfileManifest> {
  const log = options.log ?? (() => undefined);
  const ops = options.ops ?? systemOps;
  const tools = options.tools ?? preflightHost(options.accelerator ?? 'auto');
  const agentSource = fs.readFileSync(AGENT_SOURCE_PATH, 'utf8');
  const digest = profileDigest(agentSource);
  const base = await ensureBaseImage(options.cacheDir, options.fetchImpl, log);
  fs.mkdirSync(options.profileDir, { recursive: true, mode: 0o700 });
  const work = fs.mkdtempSync(path.join(options.profileDir, '.bake-'));
  try {
    fs.writeFileSync(path.join(work, 'user-data'), bakeUserData(agentSource), { mode: 0o600 });
    fs.writeFileSync(path.join(work, 'meta-data'), bakeMetaData(`zt-bake-${digest.slice(0, 12)}`), {
      mode: 0o600,
    });
    const seed = path.join(work, 'seed.iso');
    await ops.run(
      tools.isoTool,
      [
        '-quiet',
        '-output',
        seed,
        '-volid',
        'cidata',
        '-joliet',
        '-rock',
        path.join(work, 'user-data'),
        path.join(work, 'meta-data'),
      ],
      QEMU_ENV
    );
    const disk = path.join(work, 'disk.qcow2');
    await ops.run(
      tools.qemuImg,
      ['create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', base, disk, '16G'],
      QEMU_ENV
    );
    const consoleLog = path.join(work, 'console.log');
    const pidFile = path.join(work, 'qemu.pid');
    const started = Date.now();
    log(`baking with ${tools.accelerator}`);
    const launched = await ops.launch(
      tools.qemu,
      buildBakeArgs({
        name: 'zt-bake',
        accelerator: tools.accelerator,
        limits: { vcpus: options.vcpus ?? 4, memoryMiB: options.memoryMiB ?? 4096 },
        disk,
        pidFile,
        seedIso: seed,
        consoleLog,
      }),
      QEMU_ENV,
      path.join(work, 'qemu.err')
    );
    const timeoutMs = options.timeoutMs ?? (tools.accelerator === 'kvm' ? 45 : 240) * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      launched.exited.then((tail) => ({ tail })),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!outcome) {
      ops.kill(launched.pid, 'SIGKILL');
      throw new Error('Bake timed out');
    }
    if (!fs.existsSync(consoleLog))
      throw new Error(`Bake VM did not start: ${outcome.tail.trim()}`);
    const images = parseBakeConsole(fs.readFileSync(consoleLog, 'utf8'));
    log(`bake VM finished in ${Math.round((Date.now() - started) / 1000)} s`);
    const imageFile = `zt-profile-${digest.slice(0, 16)}.qcow2`;
    const image = path.join(options.profileDir, imageFile);
    fs.rmSync(image, { force: true });
    await ops.run(tools.qemuImg, ['convert', '-q', '-O', 'qcow2', disk, image], QEMU_ENV);
    fs.chmodSync(image, 0o400);
    const manifest = parseManifest(
      {
        schema: PROFILE_PINS.schema,
        profileDigest: digest,
        baseImageSha256: PROFILE_PINS.baseImage.sha256,
        containerBaseDigest: PROFILE_PINS.containerBase.digest,
        imageSha256: sha256File(image),
        imageFile,
        containerImages: images,
        bakedAt: new Date().toISOString(),
      },
      digest
    );
    replacePrivate(
      path.join(options.profileDir, 'manifest.json'),
      Buffer.from(JSON.stringify(manifest, null, 2))
    );
    return manifest;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
