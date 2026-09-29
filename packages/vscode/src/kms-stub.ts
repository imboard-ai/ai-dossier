// Build-time replacement for @aws-sdk/client-kms (see scripts/build.mjs).
const unavailable = (): never => {
  throw new Error(
    'AWS KMS signature verification is not available in the editor; use `ai-dossier verify`.'
  );
};

export class KMSClient {
  constructor() {
    unavailable();
  }
}
export class VerifyCommand {
  constructor() {
    unavailable();
  }
}
export class SignCommand {
  constructor() {
    unavailable();
  }
}
export class GetPublicKeyCommand {
  constructor() {
    unavailable();
  }
}
export const SigningAlgorithmSpec = { ECDSA_SHA_256: 'ECDSA_SHA_256' };
