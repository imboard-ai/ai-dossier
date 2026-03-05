/**
 * Verification risk assessment for dossiers.
 *
 * Evaluates checksum, signature, and declared risk level
 * to produce a recommendation (ALLOW or BLOCK).
 */

export interface ChecksumStatus {
  passed: boolean;
}

export interface SignatureStatus {
  present: boolean;
  verified: boolean;
  trusted: boolean;
}

export type VerificationRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface VerificationRiskResult {
  level: VerificationRiskLevel;
  issues: string[];
  recommendation: 'ALLOW' | 'BLOCK';
}

export function assessVerificationRisk(
  declaredRiskLevel: string | undefined,
  checksumResult: ChecksumStatus,
  signatureResult: SignatureStatus
): VerificationRiskResult {
  const issues: string[] = [];
  let riskLevel: VerificationRiskLevel = 'low';
  let shouldBlock = false;

  // Checksum failure is critical
  if (!checksumResult.passed) {
    issues.push('Checksum verification FAILED - content has been tampered with');
    riskLevel = 'critical';
    shouldBlock = true;
  }

  // Signature issues
  if (signatureResult.present && !signatureResult.verified) {
    issues.push('Signature verification FAILED or could not be verified');
    if (riskLevel !== 'critical') riskLevel = 'high';
    shouldBlock = true;
  }

  // Valid signature but not trusted - BLOCK execution
  if (signatureResult.present && signatureResult.verified && !signatureResult.trusted) {
    issues.push('Signature is valid but signer is not in your trusted keys list');
    issues.push('Add the public key to ~/.dossier/trusted-keys.txt to trust this signer');
    if (riskLevel === 'low') riskLevel = 'medium';
    shouldBlock = true;
  }

  // No signature on high-risk dossier
  if (!signatureResult.present && declaredRiskLevel === 'high') {
    issues.push('High-risk dossier without signature');
    if (riskLevel === 'low') riskLevel = 'medium';
  }

  if (!signatureResult.present && declaredRiskLevel === 'critical') {
    issues.push('Critical-risk dossier without signature');
    if (riskLevel !== 'critical') riskLevel = 'high';
  }

  return {
    level: riskLevel,
    issues,
    recommendation: shouldBlock ? 'BLOCK' : 'ALLOW',
  };
}
