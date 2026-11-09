import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitBlobOid, SOURCE_STORAGE, SourcePackStore } from '../canonical/source-store';
import { TrustedGit } from '../canonical/trusted-git';
import { type Candidate, StepArtifacts } from '../controller/steps';
import {
  CanonicalError,
  createCandidate,
  createManifest,
  reconstructCandidate,
  type SourceEntry,
  type SourceManifest,
  sha256,
  validateManifest,
} from '../index';
import { Journal } from '../journal';

const temps: string[] = [];
const journals: Journal[] = [];
afterEach(() => {
  for (const j of journals.splice(0)) j.close();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'zt-source-blobs-'));
  temps.push(dir);
  return dir;
}
const MiB = 1024 * 1024;
function file(name: string, bytes: Buffer | string, mode: SourceEntry['mode'] = '100644') {
  const content = Buffer.from(bytes);
  return { path: name, mode, bytes: content.toString('base64'), sha256: sha256(content) };
}
function dir(name: string): SourceEntry {
  return { path: name, mode: '040000', bytes: '', sha256: sha256('') };
}
const author = Object.freeze({
  login: 'contributor',
  name: 'Approved Contributor',
  email: 'contributor@example.org',
  timestamp: '2026-10-05T10:00:00Z',
});
const inputs = (baseSha: string) => ({
  baseSha,
  author,
  committerTimestamp: '2026-10-05T10:01:00Z',
  message: 'fix: approved contribution\n',
});
function baseline(): { baseSha: string; pack: Buffer } {
  const git = new TrustedGit();
  try {
    const blob = git.run(['hash-object', '-w', '--stdin'], 'base\n').toString().trim();
    const tree = git
      .run(['mktree', '-z'], Buffer.from(`100644 blob ${blob}\tbase.txt\u0000`))
      .toString()
      .trim();
    const env = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: '1791194400 +0000',
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: '1791194400 +0000',
    };
    const baseSha = git.run(['commit-tree', tree], 'baseline\n', env).toString().trim();
    return { baseSha, pack: git.run(['pack-objects', '--stdout', '--revs'], `${baseSha}\n`) };
  } finally {
    git.close();
  }
}
function rig() {
  const root = temp();
  const j = new Journal(path.join(root, 'steps'));
  journals.push(j);
  const packs = new SourcePackStore(path.join(root, 'artifacts', 'source-packs'));
  return { root, j, packs, artifacts: new StepArtifacts(j, 'run-fixture', packs) };
}
type Rig = ReturnType<typeof rig>;
function recordFile(h: Rig, key: string): string {
  const row = (h.j.read() as { key: string; digest: string }[]).filter((r) => r.key === key).at(-1);
  if (!row) throw new Error('missing row');
  return path.join(h.root, 'steps', `${row.digest}.json`);
}
function sample(): SourceManifest {
  return createManifest([
    file('README.md', '# fixture\n'),
    dir('src'),
    file('src/index.js', 'module.exports = 1;\n'),
    file('src/run.sh', '#!/bin/sh\necho ok\n', '100755'),
    file('empty.txt', ''),
  ]);
}
function expectCanonical(work: () => unknown): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalError);
    expect((error as CanonicalError).reason).toBe('invalid_manifest');
    return;
  }
  throw new Error('expected refusal');
}

function packFiles(h: Rig): string[] {
  return fs.existsSync(h.packs.directory) ? fs.readdirSync(h.packs.directory).sort() : [];
}
function republish(h: Rig, key: string, stored: unknown): void {
  const bytes = Buffer.from(JSON.stringify(stored));
  const digest = sha256(bytes);
  fs.writeFileSync(path.join(h.root, 'steps', `${digest}.json`), bytes, { mode: 0o600 });
  h.j.append({ type: 'artifact', runId: 'run-fixture', key, version: 1, digest });
}

describe('git-backed held source (#1275)', () => {
  it('keeps the manifest digest and candidate SHA identical to the inline format', () => {
    const base = baseline();
    const inline = sample();
    const h = rig();
    h.artifacts.put('source', { manifest: inline, pack: base.pack.toString('base64') });
    const produced = createCandidate(inline, inputs(base.baseSha), base.pack);
    h.artifacts.put('candidate', {
      touched: ['src/index.js'],
      manifest: inline,
      record: produced.record,
      authority: produced.authority,
      meta: { title: 't', cause: 'c', scope: 's', limitations: [] },
    });
    const reopened = new StepArtifacts(h.j, 'run-fixture', h.packs);
    const source = reopened.require<{ manifest: SourceManifest; pack: string }>('source');
    expect(validateManifest(source.manifest)).toEqual(inline);
    expect(validateManifest(source.manifest).digest).toBe(inline.digest);
    expect(Buffer.from(source.pack, 'base64').equals(base.pack)).toBe(true);
    const held = reopened.require<Candidate>('candidate');
    expect(validateManifest(held.manifest).digest).toBe(inline.digest);
    const again = createCandidate(held.manifest, inputs(base.baseSha), base.pack);
    expect(again.record.candidateSha).toBe(produced.record.candidateSha);
    expect(
      reconstructCandidate(held.manifest, held.record, held.authority, base.pack).record
        .candidateSha
    ).toBe(produced.record.candidateSha);
  });

  it('references the acquired pack for base blobs and records git ids, never bytes', () => {
    const base = baseline();
    const h = rig();
    const manifest = createManifest([file('base.txt', 'base\n')]);
    h.artifacts.put('source', { manifest, pack: base.pack.toString('base64') });
    // Every base blob is already in the acquired pack: exactly one pack file, no extra.
    expect(packFiles(h)).toEqual([sha256(base.pack)]);
    const stored = JSON.parse(fs.readFileSync(recordFile(h, 'source'), 'utf8'));
    expect(stored.pack).toEqual({ sha256: sha256(base.pack), size: base.pack.length });
    expect(stored.manifest).toEqual({
      version: 1,
      storage: SOURCE_STORAGE,
      packs: [{ sha256: sha256(base.pack), size: base.pack.length }],
      entries: [
        {
          path: 'base.txt',
          mode: '100644',
          gitOid: gitBlobOid(Buffer.from('base\n')),
          sha256: sha256('base\n'),
          size: 5,
        },
      ],
      totalBytes: 5,
      digest: manifest.digest,
    });
    // A candidate stores only its new blobs, in a pack of its own beside the source pack.
    const next = createManifest([file('base.txt', 'base\n'), file('new.txt', 'new\n')]);
    h.artifacts.put('candidate', { touched: ['new.txt'], manifest: next });
    expect(packFiles(h)).toHaveLength(2);
    const candidate = JSON.parse(fs.readFileSync(recordFile(h, 'candidate'), 'utf8'));
    expect(candidate.manifest.packs[0]).toEqual(stored.pack);
    expect(h.artifacts.require<{ manifest: SourceManifest }>('candidate').manifest).toEqual(
      JSON.parse(JSON.stringify(next))
    );
  });

  it('persists records whose size scales with entry count, not content size', () => {
    const tiny = createManifest([
      dir('assets'),
      ...[1, 2, 3, 4].map((n) => file(`assets/${n}.gif`, `g${n}`)),
    ]);
    const huge = createManifest([
      dir('assets'),
      ...[1, 2, 3, 4].map((n) => file(`assets/${n}.gif`, randomBytes(3 * MiB))),
    ]);
    const base = baseline();
    const h = rig();
    h.artifacts.put('candidate', { manifest: tiny });
    const small = fs.statSync(recordFile(h, 'candidate')).size;
    h.artifacts.put('source', { manifest: huge, pack: base.pack.toString('base64') });
    const large = fs.statSync(recordFile(h, 'source')).size;
    expect(large).toBeLessThan(4096);
    expect(large - small).toBeLessThan(400);
    const names = packFiles(h);
    expect(names.every((n) => /^[a-f0-9]{64}$/u.test(n))).toBe(true);
    for (const name of names)
      expect(fs.statSync(path.join(h.packs.directory, name)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(h.packs.directory).mode & 0o777).toBe(0o700);
    expect(h.artifacts.require<{ manifest: SourceManifest }>('source').manifest).toEqual(
      JSON.parse(JSON.stringify(huge))
    );
    // Re-persisting identical content adds no pack.
    const count = packFiles(h).length;
    h.artifacts.put('candidate', { manifest: huge });
    expect(packFiles(h)).toHaveLength(count);
  }, 60000);

  it('stores the shipping record manifest and base pack in git packs', () => {
    const base = baseline();
    const manifest = sample();
    const h = rig();
    const shipping = {
      manifest,
      basePack: base.pack.toString('base64'),
      bindings: { candidateSha: 'a'.repeat(40) },
    };
    h.artifacts.put('shipping', shipping);
    const stored = JSON.parse(fs.readFileSync(recordFile(h, 'shipping'), 'utf8'));
    expect(stored.manifest.storage).toBe(SOURCE_STORAGE);
    expect(stored.basePack).toEqual({ sha256: sha256(base.pack), size: base.pack.length });
    expect(new StepArtifacts(h.j, 'run-fixture', h.packs).require('shipping')).toEqual(
      JSON.parse(JSON.stringify(shipping))
    );
  });

  it('stores a nested implementation-basis candidate in git packs, reusing held packs', () => {
    const h = rig();
    const manifest = createManifest([file('a.txt', 'a\n'), file('b.txt', 'b\n')]);
    h.artifacts.put('candidate', { touched: [], manifest });
    const count = packFiles(h).length;
    const basis = { phaseKey: 2, candidate: { touched: [], manifest }, verification: 'v' };
    h.artifacts.put('implementation_basis', basis);
    // The basis candidate's blobs are already in the held candidate's pack.
    expect(packFiles(h)).toHaveLength(count);
    const stored = JSON.parse(fs.readFileSync(recordFile(h, 'implementation_basis'), 'utf8'));
    expect(stored.candidate.manifest.storage).toBe(SOURCE_STORAGE);
    expect(new StepArtifacts(h.j, 'run-fixture', h.packs).require('implementation_basis')).toEqual(
      JSON.parse(JSON.stringify(basis))
    );
    h.artifacts.put('implementation_basis', { phaseKey: 3, candidate: null, verification: null });
    expect(h.artifacts.require('implementation_basis')).toEqual({
      phaseKey: 3,
      candidate: null,
      verification: null,
    });
  });

  it('opens and reconstructs a store written in the previous inline format', () => {
    const base = baseline();
    const inline = sample();
    const produced = createCandidate(inline, inputs(base.baseSha), base.pack);
    const h = rig();
    // Exactly what the previous StepArtifacts.put published: sorted keys, inline base64.
    const legacy = (key: string, value: unknown) =>
      republish(
        h,
        key,
        JSON.parse(
          JSON.stringify(value, (_k, v) =>
            v && typeof v === 'object' && !Array.isArray(v)
              ? Object.fromEntries(
                  Object.keys(v)
                    .sort()
                    .map((k) => [k, v[k]])
                )
              : v
          )
        )
      );
    legacy('source', { manifest: inline, pack: base.pack.toString('base64') });
    legacy('candidate', {
      touched: [],
      manifest: inline,
      record: produced.record,
      authority: produced.authority,
      meta: { title: 't', cause: 'c', scope: 's', limitations: [] },
    });
    const reopened = new StepArtifacts(h.j, 'run-fixture', h.packs);
    const source = reopened.require<{ manifest: SourceManifest; pack: string }>('source');
    expect(validateManifest(source.manifest).digest).toBe(inline.digest);
    const held = reopened.require<Candidate>('candidate');
    expect(
      reconstructCandidate(
        held.manifest,
        held.record,
        held.authority,
        Buffer.from(source.pack, 'base64')
      ).record.candidateSha
    ).toBe(produced.record.candidateSha);
    expect(packFiles(h)).toEqual([]);
  });

  it('fails closed on every tampered, substituted or unsafe pack file', () => {
    const base = baseline();
    const manifest = sample();
    const h = rig();
    h.artifacts.put('source', { manifest, pack: base.pack.toString('base64') });
    h.artifacts.put('candidate', { touched: [], manifest });
    const blobPack = packFiles(h).find((n) => n !== sha256(base.pack)) as string;
    const file = path.join(h.packs.directory, blobPack);
    const original = fs.readFileSync(file);
    const restore = () => {
      fs.rmSync(file, { force: true, recursive: true });
      fs.writeFileSync(file, original, { mode: 0o600 });
    };
    const refused = () => {
      // Replay validates structure only; every consumer read refuses.
      const reopened = new StepArtifacts(h.j, 'run-fixture', h.packs);
      expect(() => reopened.get('source')).toThrow('invalid_step_artifact');
      expect(() => reopened.get('candidate')).toThrow('invalid_step_artifact');
      expect(() => h.artifacts.get('source')).toThrow('invalid_step_artifact');
    };
    const flipped = Buffer.from(original);
    flipped[flipped.length - 30] ^= 1;
    fs.writeFileSync(file, flipped);
    refused();
    fs.writeFileSync(file, original.subarray(1));
    refused();
    fs.writeFileSync(file, Buffer.concat([original, Buffer.from('x')]));
    refused();
    restore();
    fs.renameSync(file, `${file}.real`);
    fs.symlinkSync(`${file}.real`, file);
    refused();
    fs.rmSync(file);
    fs.renameSync(`${file}.real`, file);
    fs.linkSync(file, `${file}.link`);
    refused();
    fs.rmSync(`${file}.link`);
    fs.chmodSync(file, 0o640);
    refused();
    fs.rmSync(file);
    fs.mkdirSync(file);
    refused();
    fs.rmdirSync(file);
    refused(); // missing
    restore();
    expect(h.artifacts.require<{ manifest: SourceManifest }>('candidate').manifest).toBeDefined();
    // The source pack itself is verified too.
    const packFile = path.join(h.packs.directory, sha256(base.pack));
    const pack = fs.readFileSync(packFile);
    pack[pack.length - 1] ^= 1;
    fs.writeFileSync(packFile, pack);
    expect(() => h.artifacts.get('source')).toThrow('invalid_step_artifact');
    // A put never trusts or overwrites a mismatching existing pack.
    expect(() =>
      h.artifacts.put('source', { manifest, pack: base.pack.toString('base64') })
    ).toThrow('invalid_step_artifact');
  });

  it('re-checks size and SHA-256 over every object git returns', () => {
    const h = rig();
    h.artifacts.put('candidate', { touched: [], manifest: sample() });
    const stored = JSON.parse(fs.readFileSync(recordFile(h, 'candidate'), 'utf8'));
    const readme = stored.manifest.entries.findIndex(
      (e: { path: string }) => e.path === 'README.md'
    );
    const sizeLie = structuredClone(stored);
    sizeLie.manifest.entries[readme].size += 1;
    republish(h, 'candidate', sizeLie);
    expect(() => new StepArtifacts(h.j, 'run-fixture', h.packs).get('candidate')).toThrow(
      'invalid_step_artifact'
    );
    const hashLie = structuredClone(stored);
    hashLie.manifest.entries[readme].sha256 = sha256('other');
    republish(h, 'candidate', hashLie);
    expect(() => new StepArtifacts(h.j, 'run-fixture', h.packs).get('candidate')).toThrow(
      'invalid_step_artifact'
    );
    // Re-pointing a path at another genuine blob verifies per object but not as a manifest.
    const swap = structuredClone(stored);
    const other = stored.manifest.entries.find((e: { path: string }) => e.path === 'src/index.js');
    Object.assign(swap.manifest.entries[readme], {
      gitOid: other.gitOid,
      sha256: other.sha256,
      size: other.size,
    });
    republish(h, 'candidate', swap);
    const held = new StepArtifacts(h.j, 'run-fixture', h.packs).require<{
      manifest: SourceManifest;
    }>('candidate');
    expectCanonical(() => validateManifest(held.manifest));
  });

  it('refuses malformed references at replay without reading packs', () => {
    const h = rig();
    h.artifacts.put('candidate', { touched: [], manifest: sample() });
    const stored = JSON.parse(fs.readFileSync(recordFile(h, 'candidate'), 'utf8'));
    stored.manifest.packs[0].sha256 = '../../escape';
    republish(h, 'candidate', stored);
    expect(() => new StepArtifacts(h.j, 'run-fixture', h.packs)).toThrow('invalid_step_artifact');
  });

  it('recovers from an interrupted write and refuses a symlinked pack directory', () => {
    const root = temp();
    const store = new SourcePackStore(path.join(root, 'packs'));
    store.write([Buffer.from('first')]);
    const stale = path.join(store.directory, '.zt-write-00000000-0000-4000-8000-000000000000');
    fs.writeFileSync(stale, 'partial', { mode: 0o600 });
    const [ref] = store.write([Buffer.from('second')]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.statSync(path.join(store.directory, ref.sha256)).nlink).toBe(1);
    expect(store.read(ref).toString()).toBe('second');
    expectCanonical(() => store.read({ ...ref, size: 5 }));
    expectCanonical(() => store.read({ sha256: '../x', size: 6 }));
    fs.renameSync(store.directory, path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), store.directory);
    expectCanonical(() => store.read(ref));
  });
});
