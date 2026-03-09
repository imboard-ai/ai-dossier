/**
 * @ai-dossier/core - Core verification and parsing logic for dossier automation standard
 *
 * This package provides:
 * - Dossier parsing (frontmatter + body extraction)
 * - Checksum verification (SHA256 integrity checks)
 * - Signature verification (Minisign and AWS KMS)
 * - Output coherence validation
 * - TypeScript type definitions
 */

// Checksum exports
export { calculateChecksum, verifyIntegrity } from './checksum';
// Coherence validation exports
export type {
  CoherenceContext,
  CoherenceDiagnostic,
  CoherenceResult,
  CoherenceSeverity,
  DeclaredOutputSchema,
  StepOutput,
} from './coherence';
export { validateCoherence, validateStepCoherence } from './coherence';
export type { FormatOptions, FormatResult } from './formatter';
// Formatter exports
export { formatDossierContent, formatDossierFile } from './formatter';
export type {
  LintConfig,
  LintDiagnostic,
  LintResult,
  LintRule,
  LintRuleContext,
  LintSeverity,
  RuleSeverityOverride,
} from './linter';
// Linter exports
export {
  defaultRules,
  LintRuleRegistry,
  lintDossier,
  lintDossierFile,
  loadLintConfig,
} from './linter';
// Parser exports
export {
  parseDossierContent,
  parseDossierFile,
  RECOMMENDED_FIELDS,
  REQUIRED_FIELDS,
  VALID_RISK_LEVELS,
  VALID_STATUSES,
  validateFrontmatter,
} from './parser';
export type {
  ChecksumStatus,
  ContentRiskResult,
  SignatureStatus,
  VerificationRiskLevel,
  VerificationRiskResult,
} from './risk-assessment';
// Risk assessment exports
export { assessContentRisk, assessVerificationRisk } from './risk-assessment';
// Security scanner exports
export type {
  SecurityCategory,
  SecurityFinding,
  SecurityReport,
  SecurityRule,
  SecurityRuleContext,
  SecurityRuleSeverityOverride,
  SecurityScanConfig,
  SecuritySeverity,
} from './security-scanner';
export {
  buildReport,
  defaultSecurityRules,
  SecurityRuleRegistry,
  scanDossier,
  scanDossierFile,
  scanMarkdown,
} from './security-scanner';
// Signature exports
export { loadTrustedKeys, verifySignature, verifyWithEd25519, verifyWithKms } from './signature';
// Signer/Verifier interfaces and implementations
export {
  Ed25519Signer,
  Ed25519Verifier,
  getVerifierRegistry,
  KmsSigner,
  KmsVerifier,
  SignatureResult,
  Signer,
  Verifier,
  VerifierRegistry,
  VerifyResult,
} from './signers';
// Type exports
export * from './types';
// Crypto utilities
export { sha256Hash, sha256Hex } from './utils/crypto';
// Error utilities
export { getErrorMessage, getErrorStack } from './utils/errors';
// File system utilities
export { readFileIfExists } from './utils/fs';
// URL scanning utilities
export {
  collectDeclaredUrls,
  findStaleReferences,
  findUndeclaredUrls,
  isPlaceholderUrl,
  isUrlCoveredByDeclared,
  scanBodyForUrls,
} from './utils/url-scanner';
// Verification utilities
export { createDefaultVerificationResult } from './utils/verification';
