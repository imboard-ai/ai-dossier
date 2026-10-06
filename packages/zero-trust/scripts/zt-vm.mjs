#!/usr/bin/env node
// Local execution-profile helper (requires `npm run build` first).
//   zt-vm.mjs bake  --profile-dir D --cache-dir C [--accel auto|kvm|tcg]
//   zt-vm.mjs smoke --profile-dir D --state-dir S [--accel auto|kvm|tcg] [--timings-out F]
//   zt-vm.mjs kill-all --profile-dir D --state-dir S --reason R
import fs from 'node:fs';
import { createRequire } from 'node:module';

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
    const node = await adapter.exec(vm, {
      profile: 'node',
      argv: ['node', '-e', 'console.log(6*7)'],
    });
    const t2 = Date.now();
    const py = await adapter.exec(vm, { profile: 'python', argv: ['python3', '-c', 'print(6*7)'] });
    const t3 = Date.now();
    await adapter.destroy(vm);
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
    const adapter = new zt.LocalQemuAdapter({
      profileDir: arg('profile-dir'),
      stateDir: arg('state-dir'),
      verifyImage: false,
    });
    const result = await adapter.killAll(arg('reason'));
    console.log(JSON.stringify(result, null, 2));
    if (result.failed.length) process.exitCode = 2;
  } else {
    console.error('usage: zt-vm.mjs bake|smoke|kill-all ...');
    process.exitCode = 64;
  }
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
