import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  calculateChecksum,
  Ed25519Signer,
  KmsSigner,
  parseDossierContent,
} from '@ai-dossier/core';
import type { Command } from 'commander';
import { OFFICIAL_KMS_KEYS } from '../helpers';

export function registerSignCommand(program: Command): void {
  program
    .command('sign')
    .description('Sign dossier with cryptographic key (supports any AWS KMS key)')
    .argument('<file>', 'Dossier file to sign')
    .option('--method <type>', 'Signing method: kms (AWS KMS) or ed25519 (local key)', 'kms')
    .option(
      '--key <name-or-path>',
      'Key name from ~/.dossier/ or path to Ed25519 private key (required for ed25519 method)'
    )
    .option(
      '--key-id <id>',
      'KMS key alias/ARN (e.g., alias/my-key or arn:aws:kms:...) or ed25519 key ID'
    )
    .option('--region <region>', 'AWS region for KMS (default: us-east-1 or AWS_REGION env)')
    .option('--signed-by <name>', 'Signer identity (e.g., "Name <email@example.com>")')
    .option('--dry-run', 'Calculate checksum only, do not sign')
    .option('--force', 'Bypass official key restriction (not recommended)')
    .action(
      async (
        file: string,
        options: {
          method: string;
          key?: string;
          keyId?: string;
          region?: string;
          signedBy?: string;
          dryRun?: boolean;
          force?: boolean;
        }
      ) => {
        const dossierFile = path.resolve(file);

        if (!fs.existsSync(dossierFile)) {
          console.log(`❌ File not found: ${dossierFile}`);
          process.exit(1);
        }

        console.log('\n🔐 Dossier Signing Tool\n');
        console.log(`   File: ${dossierFile}`);
        console.log(`   Method: ${options.method}`);

        // Read and parse the dossier
        const content = fs.readFileSync(dossierFile, 'utf8');
        let parsed;
        try {
          parsed = parseDossierContent(content);
        } catch (err: unknown) {
          console.log(`\n❌ Failed to parse dossier: ${(err as Error).message}`);
          process.exit(1);
        }
        const { frontmatter, body } = parsed;

        // Calculate checksum
        const checksum = calculateChecksum(body);
        console.log(`\n📊 Calculating checksum...`);
        console.log(`   SHA256: ${checksum}`);
        frontmatter.checksum = {
          algorithm: 'sha256',
          hash: checksum,
        } as typeof frontmatter.checksum;

        if (options.method === 'kms') {
          const effectiveKeyId = options.keyId || 'alias/dossier-official-prod';

          const isOfficialKey = OFFICIAL_KMS_KEYS.some(
            (key) => effectiveKeyId === key || effectiveKeyId.includes(key)
          );

          if (isOfficialKey && !options.force && !options.dryRun) {
            console.log(`\n⚠️  Official Dossier Key Detected: ${effectiveKeyId}\n`);
            console.log('   Official dossier signatures should be created through CI/CD,');
            console.log('   not directly via the CLI. This ensures:');
            console.log('   - Only merged PRs from authorized contributors are signed');
            console.log('   - Audit trail via GitHub Actions');
            console.log('   - Consistent signing identity\n');
            console.log('   To sign official dossiers:');
            console.log('   1. Create a PR in the imboard-ai/ai-dossier repository');
            console.log('   2. Get approval from a maintainer');
            console.log('   3. Merge to main - CI will sign automatically\n');
            console.log('   For your own organization, use your own KMS key:');
            console.log(`   dossier sign ${file} --key-id alias/your-org-key\n`);
            console.log('   Or use Ed25519 local signing:');
            console.log(`   dossier sign ${file} --method ed25519 --key your-key.pem\n`);
            console.log('   To bypass this check (not recommended):');
            console.log(`   dossier sign ${file} --force\n`);
            process.exit(1);
          }

          if (isOfficialKey && options.force && !options.dryRun) {
            console.log(`\n⚠️  WARNING: Using official key with --force`);
            console.log('   This should only be done by authorized maintainers.\n');
          }

          console.log(`   KMS Key: ${effectiveKeyId}`);
          console.log(`   Region: ${options.region || process.env.AWS_REGION || 'us-east-1'}`);

          if (options.dryRun) {
            console.log('\n   [DRY RUN - will not sign]');
            console.log('\n✅ Dry run complete (checksum calculated, no signature)');
            console.log('\nUpdated frontmatter:');
            console.log(JSON.stringify(frontmatter, null, 2));
            return;
          }

          try {
            const region = options.region || process.env.AWS_REGION || 'us-east-1';
            const signer = new KmsSigner(effectiveKeyId, region);
            const sigResult = await signer.sign(body);
            frontmatter.signature = {
              ...sigResult,
              signed_by: options.signedBy || '(not specified)',
            } as typeof frontmatter.signature;
          } catch (err: unknown) {
            console.log(`\n❌ KMS signing failed: ${(err as Error).message}`);
            process.exit(1);
          }
        } else if (options.method === 'ed25519') {
          if (!options.key && !options.dryRun) {
            console.log('\n❌ Error: --key is required for ed25519 signing');
            console.log('\nGenerate a key pair with:');
            console.log('  dossier keys generate --name my-key');
            console.log('\nThen sign with:');
            console.log(`  dossier sign ${file} --method ed25519 --key my-key`);
            console.log(`  dossier sign ${file} --method ed25519 --key /path/to/key.pem`);
            process.exit(1);
          }

          let keyPath: string | undefined;
          if (options.key) {
            keyPath = path.resolve(options.key);
            if (!fs.existsSync(keyPath)) {
              const namedPath = path.join(os.homedir(), '.dossier', `${options.key}.pem`);
              if (fs.existsSync(namedPath)) {
                keyPath = namedPath;
              } else {
                console.log(`\n❌ Key not found: ${options.key}`);
                console.log(`   Checked: ${keyPath}`);
                console.log(`   Checked: ${namedPath}`);
                process.exit(1);
              }
            }
            console.log(`   Key: ${keyPath}`);
          }

          if (options.dryRun) {
            console.log('\n   [DRY RUN - will not sign]');
            console.log('\n✅ Dry run complete (checksum calculated, no signature)');
            console.log('\nUpdated frontmatter:');
            console.log(JSON.stringify(frontmatter, null, 2));
            return;
          }

          try {
            const signer = new Ed25519Signer(keyPath!);
            const sigResult = await signer.sign(body);
            frontmatter.signature = {
              ...sigResult,
              key_id: options.keyId || sigResult.key_id,
              signed_by: options.signedBy || '(not specified)',
            } as typeof frontmatter.signature;
          } catch (err: unknown) {
            console.log(`\n❌ Signing failed: ${(err as Error).message}`);
            process.exit(1);
          }
        } else {
          console.log(`\n❌ Unknown signing method: ${options.method}`);
          console.log('\nSupported methods:');
          console.log('  kms      - AWS KMS signing (requires AWS credentials)');
          console.log('  ed25519  - Local Ed25519 key signing');
          process.exit(1);
        }

        if (options.signedBy) console.log(`   Signed by: ${options.signedBy}`);

        // Write updated dossier
        const updatedContent = `---dossier\n${JSON.stringify(frontmatter, null, 2)}\n---\n${body}`;
        fs.writeFileSync(dossierFile, updatedContent, 'utf8');

        console.log('\n✅ Dossier signed successfully!');
        console.log(`\nSignature details:`);
        console.log(`  Algorithm: ${frontmatter.signature!.algorithm}`);
        console.log(`  Key ID: ${frontmatter.signature!.key_id || '(not specified)'}`);
        console.log(`  Signed by: ${frontmatter.signature!.signed_by || '(not specified)'}`);
        console.log(`  Signed at: ${frontmatter.signature!.signed_at}`);
      }
    );
}
