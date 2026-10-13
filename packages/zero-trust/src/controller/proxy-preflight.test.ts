import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxyCaFixture } from './__tests__/proxy-ca-fixture';
import { preflightProxyCa } from './proxy-preflight';

describe('controller proxy CA preflight', () => {
  let root: string;
  let file: string;
  let ca: X509Certificate;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-ca-preflight-'));
    file = createProxyCaFixture(root);
    ca = new X509Certificate(fs.readFileSync(file));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts a valid CA and legacy non-intercepting proxies', () => {
    expect(() => preflightProxyCa(file, new Date(ca.validFrom))).not.toThrow();
    expect(() => preflightProxyCa(undefined, new Date())).not.toThrow();
  });
  it('refuses the exact expiry boundary and not-yet-valid certificates', () => {
    expect(() => preflightProxyCa(file, new Date(ca.validTo))).toThrow('proxy_ca_expired');
    expect(() => preflightProxyCa(file, new Date(Date.parse(ca.validFrom) - 1))).toThrow(
      'proxy_ca_not_yet_valid'
    );
  });
  it('fails closed with fixed text for missing, malformed, oversized and symlink files', () => {
    const malformed = path.join(root, 'malformed');
    const oversized = path.join(root, 'oversized');
    const link = path.join(root, 'symlink');
    fs.writeFileSync(malformed, 'untrusted certificate data');
    fs.writeFileSync(oversized, Buffer.alloc(16 * 1024 + 1));
    fs.symlinkSync(file, link);
    for (const input of [path.join(root, 'missing'), malformed, oversized, link, root]) {
      expect(() => preflightProxyCa(input, new Date(ca.validFrom))).toThrow('proxy_ca_unavailable');
    }
    expect(() => preflightProxyCa(file, new Date(Number.NaN))).toThrow('proxy_ca_unavailable');
  });
});
