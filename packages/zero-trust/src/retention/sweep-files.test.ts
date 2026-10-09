import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFixtures, NOW } from '../../fixtures/retention';
import { applySweep, planSweep } from './retention';
import {
  deleteArtifact,
  heldName,
  INVENTORY_LIMITS,
  inventory,
  QUARANTINE,
  withQuarantine,
} from './sweep-files';

const { rig, cleanup } = createFixtures();
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});
it('preserves protected bytes swapped into the held name after hashing (same-UID controller probe)', () => {
  const r = rig();
  r.artifact();
  r.write('tokens/protected.json', { preserve: true });
  r.close();
  const plan = planSweep(r.root, NOW),
    originalRead = fs.readSync;
  const protectedFile = path.join(r.directory, 'tokens/protected.json'),
    protectedBytes = fs.readFileSync(protectedFile);
  let injected = false;
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const result = originalRead(...args);
    const named = fs.readlinkSync(`/proc/self/fd/${args[0]}`);
    if (!injected && result === 0 && named.includes(`/${QUARANTINE}/.zt-retention-`)) {
      injected = true;
      fs.renameSync(named, path.join(r.temp, 'original-saved'));
      fs.renameSync(protectedFile, named);
    }
    return result;
  });
  expect(() => applySweep(plan)).toThrow('stale-plan');
  expect(injected).toBe(true);
  expect(
    fs.readFileSync(path.join(r.directory, QUARANTINE, heldName(plan.contributions[0].files[0])))
  ).toEqual(protectedBytes);
  expect(fs.readFileSync(path.join(r.temp, 'original-saved'), 'utf8')).toBe('snapshot bytes');
});
it('worker-surface writes cannot replace a quarantined leaf; unplanned leaves remain', () => {
  const r = rig(),
    artifact = r.artifact();
  r.close();
  const plan = planSweep(r.root, NOW);
  applySweep(plan, (point) => {
    if (point === 'quarantined') fs.writeFileSync(artifact, 'unplanned replacement');
  });
  expect(fs.readFileSync(artifact, 'utf8')).toBe('unplanned replacement');
  expect(fs.readdirSync(path.join(r.directory, QUARANTINE))).toEqual([]);
  expect(fs.statSync(path.join(r.directory, QUARANTINE)).mode & 0o777).toBe(0o700);
  const next = planSweep(r.root, NOW);
  applySweep(next);
  expect(fs.readFileSync(artifact, 'utf8')).toBe('unplanned replacement');
});
it('single artifact deletion accepts missing only on replay, and never consumes unknown quarantine leaves', () => {
  const r = rig(),
    artifact = r.artifact();
  const file = inventory(r.directory).artifacts[0];
  fs.unlinkSync(artifact);
  withQuarantine(r.directory, (quarantine) => {
    expect(() => deleteArtifact(r.directory, quarantine, file, false, () => {})).toThrow(
      'stale-plan'
    );
    expect(() => deleteArtifact(r.directory, quarantine, file, true, () => {})).not.toThrow();
    fs.writeFileSync(path.join(quarantine, 'unplanned'), 'preserve', { mode: 0o600 });
  });
  expect(() => inventory(r.directory, [file])).toThrow('stale-plan');
  expect(fs.readFileSync(path.join(r.directory, QUARANTINE, 'unplanned'), 'utf8')).toBe('preserve');
});
it('refuses unsafe quarantine authority and bounded inventory depth/bytes', () => {
  const r = rig();
  fs.mkdirSync(path.join(r.directory, QUARANTINE), { mode: 0o700 });
  fs.chmodSync(path.join(r.directory, QUARANTINE), 0o755);
  expect(() => withQuarantine(r.directory, () => true)).toThrow();
  fs.rmdirSync(path.join(r.directory, QUARANTINE));
  const file = r.artifact();
  fs.truncateSync(file, INVENTORY_LIMITS.fileBytes + 1);
  expect(() => inventory(r.directory)).toThrow('size-limit');
  fs.unlinkSync(file);
  r.artifact(`${'d/'.repeat(INVENTORY_LIMITS.depth)}file`);
  expect(() => inventory(r.directory)).toThrow('size-limit');
});
