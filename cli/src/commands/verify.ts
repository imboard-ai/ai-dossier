import type { Command } from 'commander';
import type { VerificationOptions } from '../helpers';
import { runVerification } from '../helpers';

export function registerVerifyCommand(program: Command): void {
  program
    .command('verify')
    .description('Verify dossier integrity and authenticity')
    .argument('<file>', 'Dossier file or URL to verify')
    .option('--verbose', 'Show detailed verification output')
    .option('--json', 'Output result as JSON')
    .option('--skip-checksum', 'Skip checksum verification (DANGEROUS)')
    .option('--skip-signature', 'Skip signature verification')
    .option('--skip-author-check', 'Skip author whitelist/blacklist')
    .option('--skip-dossier-check', 'Skip dossier whitelist/blacklist')
    .option('--skip-risk-assessment', 'Skip risk level checks')
    .option('--skip-review', 'Skip review dossier execution')
    .option('--skip-all-checks', 'Skip ALL verifications (VERY DANGEROUS)')
    .option('--review-dossier <file>', 'Custom review dossier')
    .action(
      async (
        file: string,
        options: VerificationOptions & { verbose?: boolean; json?: boolean }
      ) => {
        const result = await runVerification(file, options);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          process.exit(result.passed ? 0 : 1);
        }

        if (!result.passed) {
          console.log('❌ Verification failed\n');
          process.exit(1);
        }

        if (options.verbose) {
          console.log('✅ All verification stages passed\n');
          console.log('Stages completed:');
          result.stages.forEach((s) => {
            const status = s.passed ? '✅' : s.skipped ? '⚠️' : '❌';
            const demo = s.demo ? ' (demo)' : '';
            console.log(`  ${status} Stage ${s.stage}: ${s.name}${demo}`);
          });
        } else {
          console.log('✅ Verification passed\n');
          console.log('Run with --verbose for detailed stage information');
        }

        process.exit(0);
      }
    );
}
