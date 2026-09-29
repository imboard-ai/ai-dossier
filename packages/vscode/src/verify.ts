/**
 * "Dossier: Verify" — same checks as `ai-dossier verify` (checksum, then signature + trust list),
 * driven by @ai-dossier/core. AWS KMS signatures need the AWS SDK, which is deliberately not
 * bundled; they are reported as unverifiable here rather than as failures.
 */
import {
  buildSignedPayload,
  findTrustedIdentifier,
  parseDossierContent,
  type SignatureResult,
  signatureCoverage,
  verifyIntegrity,
  verifySignature,
} from '@ai-dossier/core';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface VerifyReport {
  title: string;
  version: string;
  checks: { name: string; status: CheckStatus; message: string }[];
  /** False when any check failed; warnings (unsigned, untrusted key) do not fail. */
  ok: boolean;
}

export async function verifyContent(
  content: string,
  trustedKeys: Map<string, string>
): Promise<VerifyReport> {
  const { frontmatter, body } = parseDossierContent(content);
  const checks: VerifyReport['checks'] = [];

  const integrity = verifyIntegrity(body, frontmatter.checksum?.hash);
  checks.push({
    name: 'Checksum',
    status: integrity.status === 'valid' ? 'pass' : 'fail',
    message: integrity.message,
  });

  const sig = frontmatter.signature;
  if (!sig) {
    checks.push({ name: 'Signature', status: 'warn', message: 'No signature present (unsigned).' });
  } else if (sig.algorithm === 'ECDSA-SHA-256') {
    checks.push({
      name: 'Signature',
      status: 'skip',
      message: 'AWS KMS signature: not verifiable in the editor. Run `ai-dossier verify <file>`.',
    });
  } else {
    const payload = buildSignedPayload(
      frontmatter as unknown as Record<string, unknown>,
      body,
      signatureCoverage(sig as { covers?: string })
    );
    try {
      const result = await verifySignature(payload, sig as SignatureResult);
      if (!result.valid) {
        checks.push({
          name: 'Signature',
          status: 'fail',
          message: result.error
            ? `Verification error: ${result.error}`
            : 'Signature does not match.',
        });
      } else {
        const trusted = findTrustedIdentifier(trustedKeys, sig);
        checks.push(
          trusted
            ? { name: 'Signature', status: 'pass', message: `Valid, trusted signer: ${trusted}` }
            : {
                name: 'Signature',
                status: 'warn',
                message:
                  'Valid signature, but the key is not in ~/.dossier/trusted-keys.txt (`ai-dossier keys add`).',
              }
        );
      }
    } catch (err) {
      checks.push({
        name: 'Signature',
        status: 'fail',
        message: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    title: frontmatter.title,
    version: frontmatter.version,
    checks,
    ok: checks.every((c) => c.status !== 'fail'),
  };
}

const MARK: Record<CheckStatus, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  warn: 'WARN',
  skip: 'SKIP',
};

export function formatVerifyReport(r: VerifyReport): string {
  const lines = [`Verify: ${r.title} v${r.version}`, ''];
  for (const c of r.checks) lines.push(`  [${MARK[c.status]}] ${c.name}: ${c.message}`);
  lines.push('', r.ok ? 'Result: no verification failures.' : 'Result: VERIFICATION FAILED.');
  return lines.join('\n');
}
