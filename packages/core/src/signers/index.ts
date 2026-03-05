/**
 * Signer and Verifier interfaces for dossier signatures
 */

export interface SignatureResult {
  algorithm: string;
  signature: string;
  public_key: string;
  key_id?: string;
  signed_by?: string;
  signed_at: string;
}

export interface Signer {
  /**
   * Sign content and return signature metadata
   */
  sign(content: string): Promise<SignatureResult>;

  /**
   * Get the public key in PEM format
   */
  getPublicKey(): Promise<string>;

  /**
   * Algorithm identifier
   */
  readonly algorithm: string;
}

export interface VerifyResult {
  valid: boolean;
  error?: string;
}

export interface Verifier {
  /**
   * Verify a signature.
   * Returns { valid: true } for valid signatures,
   * { valid: false } for cryptographically invalid signatures,
   * { valid: false, error: '...' } when verification could not complete (e.g., network error).
   */
  verify(content: string, signature: SignatureResult): Promise<VerifyResult>;

  /**
   * Check if this verifier supports the given algorithm
   */
  supports(algorithm: string): boolean;
}

// Export implementations
export { Ed25519Signer, Ed25519Verifier } from './ed25519';
export { KmsSigner, KmsVerifier } from './kms';

// Export registry
export {
  getVerifierRegistry,
  VerifierRegistry,
} from './registry';
