#!/usr/bin/env npx tsx

/**
 * Dossier AWS KMS Signing Tool
 *
 * Signs a dossier with AWS KMS and embeds the checksum and signature in the frontmatter.
 *
 * Usage:
 *   npx tsx tools/sign-dossier-kms.ts <dossier-file> [options]
 *
 * Prerequisites:
 *   - AWS SDK must be installed (npm install @aws-sdk/client-kms)
 *   - AWS credentials configured (via environment or ~/.aws/credentials)
 *   - Permission to use the KMS key
 *
 * Example:
 *   npx tsx tools/sign-dossier-kms.ts examples/devops/deploy-to-aws.ds.md \
 *     --key-id alias/dossier-official-prod \
 *     --signed-by "Dossier Team <team@dossier.ai>"
 */

import { KmsSigner, type SignatureResult } from '@imboard-ai/dossier-core';
import { createCliParser } from './lib/cli-parser';
import { addChecksum, handleDryRun, readAndParseDossier, writeDossier } from './lib/signing-common';

// Configure CLI parser
const parseArgs = createCliParser({
  name: 'Dossier AWS KMS Signing Tool',
  description:
    'Signs a dossier with AWS KMS and embeds the checksum and signature in the frontmatter.',
  usage: 'npx tsx tools/sign-dossier-kms.ts <dossier-file> [options]',
  options: [
    {
      name: 'keyId',
      flag: 'key-id',
      description: 'AWS KMS key ID or alias',
      defaultValue: 'alias/dossier-official-prod',
    },
    {
      name: 'region',
      flag: 'region',
      description: 'AWS region',
      defaultFn: () => process.env.AWS_REGION || 'us-east-1',
    },
    {
      name: 'signedBy',
      flag: 'signed-by',
      description: "Signer identity (e.g., 'Dossier Team <team@dossier.ai>')",
    },
    {
      name: 'dryRun',
      flag: 'dry-run',
      description: "Calculate checksum but don't sign",
      isBoolean: true,
    },
  ],
  extraHelp: `
Environment Variables:
  AWS_REGION           AWS region (default: us-east-1)
  AWS_ACCESS_KEY_ID    AWS access key
  AWS_SECRET_ACCESS_KEY AWS secret key

Example:
  npx tsx tools/sign-dossier-kms.ts examples/devops/deploy-to-aws.ds.md \\
    --key-id alias/dossier-official-prod \\
    --signed-by "Dossier Team <team@dossier.ai>"`,
});

// Main function
async function main(): Promise<void> {
  const options = parseArgs();

  console.log('🔐 Dossier AWS KMS Signing Tool\n');
  console.log(`Dossier: ${options.dossierFile}`);
  console.log(`KMS Key: ${options.keyId}`);
  console.log(`Region: ${options.region}`);

  // Read and parse dossier
  const { frontmatter, body } = readAndParseDossier(options.dossierFile as string);

  // Calculate and add checksum
  addChecksum(frontmatter, body);

  if (options.dryRun) {
    handleDryRun(frontmatter);
    return;
  }

  // Sign with AWS KMS
  console.log('\n✍️  Signing with AWS KMS...');

  let signatureResult: SignatureResult;
  try {
    const signer = new KmsSigner(options.keyId as string, options.region as string);
    signatureResult = await signer.sign(body);
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log('   ✓ Signature created');
  console.log(`   Key ARN: ${signatureResult.key_id}`);

  // Add signature to frontmatter
  frontmatter.signature = signatureResult;

  // Add optional metadata
  if (options.signedBy) {
    frontmatter.signature.signed_by = options.signedBy as string;
  }

  // Write updated dossier
  writeDossier(options.dossierFile as string, frontmatter, body);
  console.log('\n✅ Dossier signed successfully!');
  console.log(`\nSignature details:`);
  console.log(`  Algorithm: ECDSA-SHA-256`);
  console.log(`  Key ARN: ${frontmatter.signature.key_id}`);
  console.log(`  Signed by: ${options.signedBy || '(not specified)'}`);
  console.log(`  Signed at: ${frontmatter.signature.signed_at}`);
  console.log(`\nVerify with: cli/bin/dossier-verify ${options.dossierFile}`);
}

// Run
main().catch((err: unknown) => {
  console.error(`\nFatal error: ${(err as Error).message}`);
  process.exit(1);
});
