/** Trusted profile bake: pinned cloud image + controller cloud-init → a flattened,
 * hash-pinned profile image. No repository or model input is involved. */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { privateDir, replacePrivate } from '../durable-fs';
import type { AcceleratorRequest } from './adapter';
import { BAKE_FAILED_MARKER, BAKE_RESULT_MARKER, bakeMetaData, bakeUserData } from './cloud-init';
import { type HostTools, preflightHost } from './host';
import { AGENT_SOURCE_PATH, type HostOps, systemOps } from './local-qemu';
import {
  BAKED_DISK_GIB,
  DOCKER_ID,
  PROFILE_PINS,
  parseManifest,
  profileDigest,
  sha256File,
  type VmProfileManifest,
} from './profile';
import { buildBakeArgs, buildOverlayArgs, QEMU_ENV } from './qemu-args';

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

/** Bake VM size and wall clock. A TCG bake is software emulation: hours, not minutes. */
const BAKE_VCPUS = 4;
const BAKE_MEMORY_MIB = 4096;
const BAKE_TIMEOUT_MS: Readonly<Record<'kvm' | 'tcg', number>> = Object.freeze({
  kvm: 45 * 60_000,
  tcg: 240 * 60_000,
});
/** A download that delivers nothing for this long is abandoned. */
const DOWNLOAD_IDLE_MS = 120_000;

/** Download (if needed) and verify the pinned base image; never trust a cached copy blindly. */
export async function ensureBaseImage(
  cacheDir: string,
  fetchImpl: typeof fetch = fetch,
  log: (m: string) => void = () => undefined
): Promise<string> {
  const { name, release, url, sha256 } = PROFILE_PINS.baseImage;
  privateDir(cacheDir);
  const file = path.join(cacheDir, `${name}-${release}.img`);
  if (fs.existsSync(file)) {
    if (sha256File(file) === sha256) return file;
    fs.rmSync(file);
  }
  log(`downloading ${url}`);
  const abort = new AbortController();
  let idle = setTimeout(() => abort.abort(), DOWNLOAD_IDLE_MS);
  const part = `${file}.${randomBytes(4).toString('hex')}.part`;
  const hash = createHash('sha256');
  let out: fs.WriteStream | null = null;
  let bytes = 0;
  try {
    const response = await fetchImpl(url, { signal: abort.signal });
    if (!response.ok || !response.body)
      throw new Error(`Base image download from ${url} failed: HTTP ${response.status}`);
    out = fs.createWriteStream(part, { mode: 0o600 });
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      clearTimeout(idle);
      idle = setTimeout(() => abort.abort(), DOWNLOAD_IDLE_MS);
      hash.update(chunk);
      bytes += chunk.length;
      if (!out.write(chunk))
        await new Promise<void>((resolve) => out?.once('drain', () => resolve()));
    }
    const stream = out;
    await new Promise<void>((resolve, reject) =>
      stream.end((e?: Error | null) => (e ? reject(e) : resolve()))
    );
    const actual = hash.digest('hex');
    if (actual !== sha256)
      throw new Error(
        `Base image SHA-256 does not match the pin: expected ${sha256}, got ${actual} (${bytes} bytes from ${url})`
      );
    fs.renameSync(part, file);
  } catch (error) {
    if (abort.signal.aborted)
      throw new Error(`Base image download from ${url} stalled for ${DOWNLOAD_IDLE_MS / 1000} s`);
    throw error;
  } finally {
    clearTimeout(idle);
    out?.destroy();
    fs.rmSync(part, { force: true });
  }
  return file;
}

export function parseBakeConsole(consoleText: string): { node: string; python: string } {
  const failed = consoleText.split('\n').find((l) => l.includes(BAKE_FAILED_MARKER));
  if (failed) throw new Error(`Bake script failed inside the VM: ${failed.trim().slice(0, 200)}`);
  const line = consoleText.split('\n').find((l) => l.startsWith(`${BAKE_RESULT_MARKER} `));
  if (!line) throw new Error('Bake finished without a result marker');
  const value = JSON.parse(line.slice(BAKE_RESULT_MARKER.length + 1).trim()) as Record<
    string,
    unknown
  >;
  if (
    typeof value.node !== 'string' ||
    typeof value.python !== 'string' ||
    !DOCKER_ID.test(value.node) ||
    !DOCKER_ID.test(value.python)
  )
    throw new Error('Bake result marker is malformed');
  return { node: value.node, python: value.python };
}

export async function bakeProfile(options: BakeOptions): Promise<VmProfileManifest> {
  const log = options.log ?? (() => undefined);
  const ops = options.ops ?? systemOps;
  const tools = options.tools ?? preflightHost(options.accelerator ?? 'auto');
  const agentSource = fs.readFileSync(AGENT_SOURCE_PATH, 'utf8');
  const digest = profileDigest(agentSource);
  const base = await ensureBaseImage(options.cacheDir, options.fetchImpl, log);
  privateDir(options.profileDir);
  const work = fs.mkdtempSync(path.join(options.profileDir, '.bake-'));
  let launchedPid: number | null = null;
  // The bake VM is detached; an interrupted controller must not leave it running.
  const interrupt = (signal: NodeJS.Signals) => {
    if (launchedPid !== null)
      try {
        ops.kill(launchedPid, 'SIGKILL');
      } catch {
        // already gone
      }
    fs.rmSync(work, { recursive: true, force: true });
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
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
      { ...QEMU_ENV }
    );
    const disk = path.join(work, 'disk.qcow2');
    await ops.run(tools.qemuImg, buildOverlayArgs(base, disk, BAKED_DISK_GIB), { ...QEMU_ENV });
    const consoleLog = path.join(work, 'console.log');
    const pidFile = path.join(work, 'qemu.pid');
    const started = Date.now();
    log(`baking with ${tools.accelerator}`);
    const launched = await ops.launch(
      tools.qemu,
      buildBakeArgs({
        name: 'zt-bake',
        accelerator: tools.accelerator,
        limits: {
          vcpus: options.vcpus ?? BAKE_VCPUS,
          memoryMiB: options.memoryMiB ?? BAKE_MEMORY_MIB,
        },
        disk,
        pidFile,
        seedIso: seed,
        consoleLog,
      }),
      { ...QEMU_ENV },
      path.join(work, 'qemu.err')
    );
    launchedPid = launched.pid;
    const timeoutMs = options.timeoutMs ?? BAKE_TIMEOUT_MS[tools.accelerator];
    const consoleCopy = path.join(options.profileDir, 'last-bake-console.log');
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
      throw new Error(
        `Bake timed out after ${Math.round(timeoutMs / 60_000)} min under ${tools.accelerator}; console kept at ${consoleCopy}`
      );
    }
    if (!fs.existsSync(consoleLog))
      throw new Error(`Bake VM did not start: ${outcome.tail.trim()}`);
    let images: { node: string; python: string };
    try {
      images = parseBakeConsole(fs.readFileSync(consoleLog, 'utf8'));
    } catch (error) {
      throw new Error(
        `${(error as Error).message}; console kept at ${consoleCopy}; QEMU stderr: ${outcome.tail.trim().slice(-500)}`
      );
    }
    log(`bake VM finished in ${Math.round((Date.now() - started) / 1000)} s`);
    const imageFile = `zt-profile-${digest.slice(0, 16)}.qcow2`;
    const image = path.join(options.profileDir, imageFile);
    // Flatten inside the work dir and rename into place, so a failed re-bake never
    // truncates the image the current manifest points at.
    const flattened = path.join(work, imageFile);
    await ops.run(tools.qemuImg, ['convert', '-q', '-O', 'qcow2', disk, flattened], {
      ...QEMU_ENV,
    });
    fs.chmodSync(flattened, 0o400);
    const imageSha256 = sha256File(flattened);
    fs.renameSync(flattened, image);
    const manifest = parseManifest(
      {
        schema: PROFILE_PINS.schema,
        profileDigest: digest,
        baseImageSha256: PROFILE_PINS.baseImage.sha256,
        containerBaseDigest: PROFILE_PINS.containerBase.digest,
        imageSha256,
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
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    // Keep the trusted bake console and QEMU's stderr for diagnosis; neither
    // contains run data.
    for (const [from, to] of [
      ['console.log', 'last-bake-console.log'],
      ['qemu.err', 'last-bake-qemu.err'],
    ])
      if (fs.existsSync(path.join(work, from)))
        fs.copyFileSync(path.join(work, from), path.join(options.profileDir, to));
    fs.rmSync(work, { recursive: true, force: true });
  }
}
