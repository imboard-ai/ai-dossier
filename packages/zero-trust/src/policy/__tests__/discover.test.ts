import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitHubRead, GitHubResponse } from '../../github/reconcile';
import { classifyPolicy } from '../classify';
import {
  discoverPolicy,
  POLICY_FILE_LIMIT,
  POLICY_PATHS,
  POLICY_TEMPLATE_DIRECTORY,
} from '../discover';

const upstream = { owner: 'synthetic-owner', repo: 'synthetic-repo', ref: 'a'.repeat(40) };
const template = `${POLICY_TEMPLATE_DIRECTORY}/bug.md`;
function body(
  path = 'CONTRIBUTING.md',
  bytes: Buffer = Buffer.from('AI contributions are banned.')
) {
  return {
    type: 'file',
    path,
    name: path.split('/').at(-1),
    sha: 'b'.repeat(40),
    size: bytes.length,
    encoding: 'base64',
    content: bytes.toString('base64'),
  };
}
function fake(responses: Record<string, GitHubResponse> = {}) {
  const calls: string[] = [];
  const read: GitHubRead = async (url) => {
    calls.push(url);
    const path = decodeURIComponent(url.split('/contents/')[1].split('?')[0]).replace(/\/$/u, '');
    return responses[path] ?? { status: 404, body: null };
  };
  return { calls, read };
}
function discovery(patch: Record<string, unknown>) {
  return discoverPolicy(
    fake({ 'CONTRIBUTING.md': { status: 200, body: { ...body(), ...patch } } }).read,
    upstream
  );
}

describe('pinned, fail-closed discovery', () => {
  it.each(
    readdirSync(resolve('fixtures/policy')).filter((path) => path.endsWith('.json'))
  )('discovers and assesses synthetic fixture %s through fake GitHubRead', async (name) => {
    const fixture = JSON.parse(readFileSync(resolve('fixtures/policy', name), 'utf8')) as {
      files: Record<string, string>;
      expected: object;
    };
    const responses: Record<string, GitHubResponse> = {};
    const templates = [];
    for (const [path, content] of Object.entries(fixture.files)) {
      const file = body(path, Buffer.from(content));
      responses[path] = { status: 200, body: file };
      if (path.startsWith(`${POLICY_TEMPLATE_DIRECTORY}/`)) templates.push(file);
    }
    if (templates.length) responses[POLICY_TEMPLATE_DIRECTORY] = { status: 200, body: templates };
    const d = await discoverPolicy(fake(responses).read, upstream);
    if (d.kind !== 'known') throw new Error('Expected complete fixture discovery');
    const { citations: _citations, ...assessment } = classifyPolicy(d.files);
    expect(assessment).toEqual(fixture.expected);
  });
  it('reads exactly the fixed list and one directory when all paths are absent', async () => {
    const { read, calls } = fake();
    expect(await discoverPolicy(read, upstream)).toEqual({ kind: 'known', files: [] });
    expect(calls).toEqual(
      [...POLICY_PATHS, `${POLICY_TEMPLATE_DIRECTORY}/`].map(
        (path) => `/repos/synthetic-owner/synthetic-repo/contents/${path}?ref=${upstream.ref}`
      )
    );
  });
  it('decodes strict UTF-8 and wrapped base64, preserving a BOM and original lines', async () => {
    const bytes = Buffer.from('\ufeff# Contributions\nAI contributions are banned.');
    const b = body('CONTRIBUTING.md', bytes);
    const { read } = fake({
      'CONTRIBUTING.md': {
        status: 200,
        body: { ...b, content: `${b.content.slice(0, 4)}\r\n${b.content.slice(4)}\n` },
      },
    });
    const d = await discoverPolicy(read, upstream);
    expect(d.kind).toBe('known');
    if (d.kind !== 'known') throw new Error('Expected known discovery');
    expect(d.files[0].content).toBe(bytes.toString());
    expect(classifyPolicy(d.files).ai).toBe('banned');
    expect(Object.isFrozen(d.files)).toBe(true);
    expect(Object.isFrozen(d.files[0])).toBe(true);
  });
  it('reads listed template files only through the fixed upstream target', async () => {
    const b = body(template);
    const { read, calls } = fake({
      [POLICY_TEMPLATE_DIRECTORY]: { status: 200, body: [b] },
      [template]: { status: 200, body: { ...b, download_url: 'https://invalid.example/ignore' } },
    });
    const d = await discoverPolicy(read, upstream);
    expect(d).toMatchObject({ kind: 'known', files: [{ path: template }] });
    expect(calls.at(-1)).toBe(
      `/repos/synthetic-owner/synthetic-repo/contents/${template}?ref=${upstream.ref}`
    );
  });
  it.each([
    401, 403, 429, 500, 204, 302,
  ])('refuses HTTP %i without partial fallback', async (status) => {
    expect(
      await discoverPolicy(
        fake({ 'CONTRIBUTING.md': { status, body: 'untrusted error' } }).read,
        upstream
      )
    ).toEqual({ kind: 'unknown' });
  });
  it('refuses thrown reads without leaking exception text', async () => {
    expect(
      await discoverPolicy(async () => {
        throw new Error('untrusted secret exception');
      }, upstream)
    ).toEqual({ kind: 'unknown' });
  });
  it.each([
    { type: 'symlink' },
    { type: 'submodule' },
    { path: 'AI_POLICY.md' },
    { sha: 'bad' },
    { encoding: 'none' },
    { size: -1 },
    { size: 0.5 },
    { size: POLICY_FILE_LIMIT + 1 },
    { size: 1 },
    { content: '!!!!' },
    { content: 'YQ' },
    { content: 'YR==', size: 1 },
    { content: 'Y Q==', size: 1 },
    { content: 'x'.repeat(400000) },
    { truncated: true },
    { content: 1 },
  ])('refuses malformed/oversize file %#', async (patch) => {
    expect(await discovery(patch)).toEqual({ kind: 'unknown' });
  });
  it.each([
    Buffer.from([0xc0, 0xaf]),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from([0xff]),
  ])('refuses invalid UTF-8 %#', async (bytes) => {
    expect(await discovery({ content: bytes.toString('base64'), size: bytes.length })).toEqual({
      kind: 'unknown',
    });
  });
  it('accepts exact file and total caps, refuses a total over the cap', async () => {
    const entries = POLICY_PATHS.slice(0, 4).map((path) => [
      path,
      { status: 200, body: body(path, Buffer.alloc(POLICY_FILE_LIMIT, 120)) },
    ]);
    expect((await discoverPolicy(fake(Object.fromEntries(entries)).read, upstream)).kind).toBe(
      'known'
    );
    entries.push([POLICY_PATHS[4], { status: 200, body: body(POLICY_PATHS[4], Buffer.from('x')) }]);
    expect(await discoverPolicy(fake(Object.fromEntries(entries)).read, upstream)).toEqual({
      kind: 'unknown',
    });
  });
  it.each([
    null,
    { truncated: true, entries: [] },
    Array.from({ length: 21 }, () => body(template)),
    [{ ...body(template), type: 'dir' }],
    [{ ...body(template), path: '../AI_POLICY.md' }],
    [{ ...body(template), path: `${POLICY_TEMPLATE_DIRECTORY}/nested/bug.md` }],
    [{ ...body(template), name: 'other.md' }],
    [{ ...body(template), sha: 'bad' }],
    [{ ...body(template), size: POLICY_FILE_LIMIT + 1 }],
    [{ ...body(template), size: -1 }],
    [{ ...body(template), truncated: true }],
    [body(template), body(template)],
  ])('refuses malformed/truncated listing %#', async (listing) => {
    expect(
      await discoverPolicy(
        fake({ [POLICY_TEMPLATE_DIRECTORY]: { status: 200, body: listing } }).read,
        upstream
      )
    ).toEqual({ kind: 'unknown' });
  });
  it('rejects an explicitly truncated array and failed listing reads', async () => {
    const listing = Object.assign([], { truncated: true });
    expect(
      await discoverPolicy(
        fake({ [POLICY_TEMPLATE_DIRECTORY]: { status: 200, body: listing } }).read,
        upstream
      )
    ).toEqual({ kind: 'unknown' });
    expect(
      await discoverPolicy(
        fake({ [POLICY_TEMPLATE_DIRECTORY]: { status: 500, body: [] } }).read,
        upstream
      )
    ).toEqual({ kind: 'unknown' });
  });
  it('refuses a missing listed file or blob that differs from its listing', async () => {
    const listing = { status: 200, body: [body(template)] };
    expect(
      await discoverPolicy(fake({ [POLICY_TEMPLATE_DIRECTORY]: listing }).read, upstream)
    ).toEqual({ kind: 'unknown' });
    expect(
      await discoverPolicy(
        fake({
          [POLICY_TEMPLATE_DIRECTORY]: listing,
          [template]: { status: 200, body: { ...body(template), sha: 'c'.repeat(40) } },
        }).read,
        upstream
      )
    ).toEqual({ kind: 'unknown' });
  });
  it('handles an exact twenty-file listing deterministically', async () => {
    const bodies = Array.from({ length: 20 }, (_, n) =>
      body(`${POLICY_TEMPLATE_DIRECTORY}/${n} template.md`)
    );
    const { read, calls } = fake({
      [POLICY_TEMPLATE_DIRECTORY]: { status: 200, body: [...bodies].reverse() },
      ...Object.fromEntries(bodies.map((b) => [b.path, { status: 200, body: b }])),
    });
    const d = await discoverPolicy(read, upstream);
    expect(d.kind === 'known' && d.files.length).toBe(20);
    expect(calls).toHaveLength(POLICY_PATHS.length + 21);
    expect(calls.some((url) => url.includes('%20template.md'))).toBe(true);
  });
  it.each([
    { ...upstream, ref: 'main' },
    { ...upstream, owner: '../other' },
    { ...upstream, repo: '../other' },
    { ...upstream, repo: '..' },
  ])('rejects an unpinned or invalid target before reads %#', async (target) => {
    const { read, calls } = fake();
    expect(await discoverPolicy(read, target)).toEqual({ kind: 'unknown' });
    expect(calls).toHaveLength(0);
  });
});
