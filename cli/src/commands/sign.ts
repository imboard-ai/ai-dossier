import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { OFFICIAL_KMS_KEYS, REPO_ROOT } from '../helpers';

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

        const toolsDir = path.join(REPO_ROOT, 'tools');
        let signTool: string;
        const signArgs: string[] = [dossierFile];

        if (options.method === 'kms') {
          signTool = path.join(toolsDir, 'sign-dossier-kms.js');

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
            console.log('   1. Create a PR in the imboard-ai/dossier repository');
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

          if (options.keyId) signArgs.push('--key-id', options.keyId);
          if (options.region) signArgs.push('--region', options.region);
          if (options.signedBy) signArgs.push('--signed-by', options.signedBy);
          if (options.dryRun) signArgs.push('--dry-run');

          console.log(`   KMS Key: ${effectiveKeyId}`);
          console.log(`   Region: ${options.region || process.env.AWS_REGION || 'us-east-1'}`);
        } else if (options.method === 'ed25519') {
          signTool = path.join(toolsDir, 'sign-dossier.js');

          if (!options.key && !options.dryRun) {
            console.log('\n❌ Error: --key is required for ed25519 signing');
            console.log('\nGenerate a key pair with:');
            console.log('  dossier keys generate --name my-key');
            console.log('\nThen sign with:');
            console.log(`  dossier sign ${file} --method ed25519 --key my-key`);
            console.log(`  dossier sign ${file} --method ed25519 --key /path/to/key.pem`);
            process.exit(1);
          }

          if (options.key) {
            let keyPath = path.resolve(options.key);
            // Support name-based lookup from ~/.dossier/
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
            signArgs.push('--key', keyPath);
            console.log(`   Key: ${keyPath}`);
          }

          if (options.keyId) signArgs.push('--key-id', options.keyId);
          if (options.signedBy) signArgs.push('--signed-by', options.signedBy);
          if (options.dryRun) signArgs.push('--dry-run');
        } else {
          console.log(`\n❌ Unknown signing method: ${options.method}`);
          console.log('\nSupported methods:');
          console.log('  kms      - AWS KMS signing (requires AWS credentials)');
          console.log('  ed25519  - Local Ed25519 key signing');
          process.exit(1);
        }

        if (!fs.existsSync(signTool)) {
          console.log(`\n❌ Signing tool not found: ${signTool}`);
          console.log('\nThis may be a package installation issue.');
          console.log('Please report at: https://github.com/imboard-ai/dossier/issues');
          process.exit(1);
        }

        if (options.signedBy) console.log(`   Signed by: ${options.signedBy}`);
        if (options.dryRun) console.log('\n   [DRY RUN - will not sign]');

        console.log('');

        try {
          const result = spawnSync('node', [signTool, ...signArgs], {
            stdio: 'inherit',
            cwd: REPO_ROOT,
          });

          if (result.status !== 0) {
            process.exit(result.status || 1);
          }
        } catch (err: unknown) {
          console.log(`\n❌ Signing failed: ${(err as Error).message}`);
          process.exit(1);
        }
      }
    );
}
