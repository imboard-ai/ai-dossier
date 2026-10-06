#!/usr/bin/env node
// Local execution-profile helper (requires `npm run build` first).
//   zt-vm.mjs bake  --profile-dir D --cache-dir C [--accel auto|kvm|tcg]
//   zt-vm.mjs smoke --profile-dir D --state-dir S [--accel auto|kvm|tcg] [--timings-out F]
//   zt-vm.mjs kill-all --state-dir S --reason R   (exit 2: a VM was left behind)
//   zt-vm.mjs diagnose --profile-dir D --out-dir O [--accel kvm|tcg] [--scope container|vm-root]
//     boots the baked image once with the run-VM arguments plus a serial log; no fixture code runs
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';

const require = createRequire(import.meta.url);
const zt = require('../dist/index.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) {
    if (fallback === undefined) throw new Error(`missing --${name}`);
    return fallback;
  }
  return process.argv[i + 1];
}

const log = (m) => console.error(`[zt-vm] ${m}`);
const command = process.argv[2];

try {
  if (command === 'bake') {
    const manifest = await zt.bakeProfile({
      profileDir: arg('profile-dir'),
      cacheDir: arg('cache-dir'),
      accelerator: arg('accel', 'auto'),
      log,
    });
    console.log(JSON.stringify(manifest, null, 2));
  } else if (command === 'smoke') {
    const adapter = new zt.LocalQemuAdapter({
      profileDir: arg('profile-dir'),
      stateDir: arg('state-dir'),
      accelerator: arg('accel', 'auto'),
    });
    const limits = { ...zt.DEFAULT_LIMITS, vcpus: 2, memoryMiB: 4096, diskGiB: zt.BAKED_DISK_GIB };
    const t0 = Date.now();
    const vm = await adapter.create({ runId: `smoke-${Date.now()}`, limits, scope: 'container' });
    const t1 = Date.now();
    let node;
    let py;
    let t2;
    let t3;
    try {
      node = await adapter.exec(vm, { profile: 'node', argv: ['node', '-e', 'console.log(6*7)'] });
      t2 = Date.now();
      py = await adapter.exec(vm, { profile: 'python', argv: ['python3', '-c', 'print(6*7)'] });
      t3 = Date.now();
    } finally {
      await adapter.destroy(vm);
    }
    const t4 = Date.now();
    if (node.stdout.trim() !== '42' || py.stdout.trim() !== '42')
      throw new Error(`smoke exec mismatch: ${JSON.stringify({ node, py })}`);
    const timings = {
      accelerator: vm.accelerator,
      bootToBrokerMs: t1 - t0,
      nodeExecMs: t2 - t1,
      pythonExecMs: t3 - t2,
      destroyMs: t4 - t3,
      totalMs: t4 - t0,
    };
    const out = arg('timings-out', '');
    if (out) fs.writeFileSync(out, `${JSON.stringify(timings, null, 2)}\n`);
    console.log(JSON.stringify(timings, null, 2));
  } else if (command === 'kill-all') {
    // Needs neither QEMU nor a current profile: only the VM records in the state dir.
    const adapter = new zt.LocalQemuAdapter({
      profileDir: arg('profile-dir', '.'),
      stateDir: arg('state-dir'),
      verifyImage: false,
    });
    const result = await adapter.killAll(arg('reason'));
    console.log(JSON.stringify(result, null, 2));
    if (result.failed.length) process.exitCode = 2;
  } else if (command === 'diagnose') {
    const profileDir = arg('profile-dir');
    const outDir = arg('out-dir');
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'manifest.json'), 'utf8'));
    const disk = path.join(outDir, 'diag.qcow2');
    execFileSync(
      'qemu-img',
      zt.buildOverlayArgs(path.join(profileDir, manifest.imageFile), disk, zt.BAKED_DISK_GIB)
    );
    const socket = path.join(outDir, 'diag.sock');
    const args = zt.buildRunArgs({
      name: 'zt-diag',
      accelerator: arg('accel', 'kvm'),
      limits: { vcpus: 2, memoryMiB: 4096 },
      disk,
      pidFile: path.join(outDir, 'diag.pid'),
      brokerSocket: socket,
      scope: arg('scope', 'vm-root'),
    });
    args[args.indexOf('-serial') + 1] = `file:${path.join(outDir, 'diag-console.log')}`;
    const qemu = spawn('qemu-system-x86_64', args, { stdio: 'inherit', env: zt.QEMU_ENV });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('no hello reply within 120 s'), 120_000);
      const s = net.connect(socket);
      s.once('error', (e) => resolve(`broker socket error: ${e.message}`));
      s.once('data', (d) => {
        clearTimeout(timer);
        resolve(`hello reply: ${d.toString().trim()}`);
      });
      s.write(`${JSON.stringify({ v: 1, id: 0, op: 'hello' })}\n`);
    });
    console.log(reply);
    qemu.kill('SIGKILL');
  } else {
    console.error('usage: zt-vm.mjs bake|smoke|kill-all|diagnose ...');
    process.exitCode = 64;
  }
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
