/** Controller-owned proxy certificate, never a worker-selected trust root. */
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';

export type ProxyCaReason = 'proxy_ca_expired' | 'proxy_ca_not_yet_valid' | 'proxy_ca_unavailable';
export class ProxyCaError extends Error {
  constructor(readonly code: ProxyCaReason) {
    super(code);
    this.name = 'ProxyCaError';
  }
}

/** Re-read before each allocation so an expiry or a corrected proxy is observed on resume.
 * Legacy/non-inspecting proxies omit this metadata. Our Squid setup must supply it. */
export function preflightProxyCa(file: string | undefined, now: Date): void {
  if (file === undefined) return;
  let fd: number | undefined;
  let certificate: X509Certificate;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > 16 * 1024) throw new Error('invalid_ca');
    const bytes = Buffer.alloc(16 * 1024 + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 16 * 1024) throw new Error('invalid_ca');
    certificate = new X509Certificate(bytes.subarray(0, size));
    if (!certificate.ca) throw new Error('invalid_ca');
  } catch {
    throw new ProxyCaError('proxy_ca_unavailable');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const from = Date.parse(certificate.validFrom);
  const until = Date.parse(certificate.validTo);
  const time = now.getTime();
  if (![from, until, time].every(Number.isFinite)) throw new ProxyCaError('proxy_ca_unavailable');
  if (time >= until) throw new ProxyCaError('proxy_ca_expired');
  if (time < from) throw new ProxyCaError('proxy_ca_not_yet_valid');
}
