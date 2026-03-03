/**
 * @dossier/core - Core verification and parsing logic for dossier automation standard
 *
 * This package provides:
 * - Dossier parsing (frontmatter + body extraction)
 * - Checksum verification (SHA256 integrity checks)
 * - Signature verification (Minisign and AWS KMS)
 * - TypeScript type definitions
 */

// Checksum exports
export { calculateChecksum, verifyIntegrity } from './checksum';
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
export { parseDossierContent, parseDossierFile, validateFrontmatter } from './parser';
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
} from './signers';
// Type exports
export * from './types';
// Crypto utilities
export { sha256Hash, sha256Hex } from './utils/crypto';
// Error utilities
export { getErrorMessage, getErrorStack } from './utils/errors';
// File system utilities
export { readFileIfExists } from './utils/fs';
// Verification utilities
export { createDefaultVerificationResult } from './utils/verification';
