import fs from 'node:fs';
import path from 'node:path';
import {
  type DossierFrontmatter,
  parseDossierContent,
  RECOMMENDED_FIELDS,
  REQUIRED_FIELDS,
  VALID_RISK_LEVELS,
  VALID_STATUSES,
} from '@ai-dossier/core';
import type { Command } from 'commander';

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate dossier frontmatter structure')
    .argument('<file>', 'Dossier file to validate')
    .option('--strict', 'Treat warnings as errors')
    .option('--quiet', 'Only output errors (no warnings)')
    .option('--json', 'Output results as JSON')
    .action((file: string, options: { strict?: boolean; quiet?: boolean; json?: boolean }) => {
      const dossierFile = path.resolve(file);

      if (!fs.existsSync(dossierFile)) {
        if (options.json) {
          console.log(
            JSON.stringify({
              valid: false,
              errors: [`File not found: ${dossierFile}`],
              warnings: [],
            })
          );
        } else {
          console.log(`❌ File not found: ${dossierFile}`);
        }
        process.exit(1);
      }

      const content = fs.readFileSync(dossierFile, 'utf8');
      const errors: string[] = [];
      const warnings: string[] = [];
      let frontmatter: DossierFrontmatter | null = null;

      try {
        const parsed = parseDossierContent(content);
        frontmatter = parsed.frontmatter;
      } catch {
        errors.push('No frontmatter found. Expected ---dossier or --- at start of file.');
      }

      if (frontmatter && errors.length === 0) {
        for (const field of REQUIRED_FIELDS) {
          if (!frontmatter[field]) {
            errors.push(`Missing required field: ${field}`);
          }
        }

        if (!options.quiet) {
          for (const field of RECOMMENDED_FIELDS) {
            if (!frontmatter[field]) {
              warnings.push(`Missing recommended field: ${field}`);
            }
          }
        }

        if (
          frontmatter.risk_level &&
          !VALID_RISK_LEVELS.includes(
            frontmatter.risk_level.toLowerCase() as (typeof VALID_RISK_LEVELS)[number]
          )
        ) {
          warnings.push(
            `Unknown risk_level: "${frontmatter.risk_level}" (expected: ${VALID_RISK_LEVELS.join(', ')})`
          );
        }

        if (
          frontmatter.status &&
          !VALID_STATUSES.some(
            (s: string) => s.toLowerCase() === (frontmatter.status as string).toLowerCase()
          )
        ) {
          warnings.push(
            `Unknown status: "${frontmatter.status}" (expected: ${VALID_STATUSES.join(', ')})`
          );
        }

        if (frontmatter.version && !/^\d+\.\d+(\.\d+)?(-[\w.]+)?$/.test(frontmatter.version)) {
          warnings.push(
            `Version "${frontmatter.version}" doesn't follow semver format (e.g., 1.0.0)`
          );
        }

        if (frontmatter.dossier_schema_version && frontmatter.dossier_schema_version !== '1.0.0') {
          warnings.push(
            `Unknown schema version: ${frontmatter.dossier_schema_version} (current: 1.0.0)`
          );
        }

        if (frontmatter.signature && !frontmatter.checksum) {
          warnings.push('Dossier is signed but has no checksum');
        }

        if (!options.quiet && frontmatter.risk_level) {
          const risk = frontmatter.risk_level.toLowerCase();
          if ((risk === 'high' || risk === 'critical') && !frontmatter.signature) {
            warnings.push(`${risk}-risk dossier is not signed`);
          }
        }
      }

      const hasErrors = errors.length > 0;
      const hasWarnings = warnings.length > 0;
      const valid = options.strict ? !hasErrors && !hasWarnings : !hasErrors;

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              valid,
              file: dossierFile,
              errors,
              warnings,
              frontmatter: frontmatter
                ? {
                    title: frontmatter.title,
                    version: frontmatter.version,
                    schema_version: frontmatter.dossier_schema_version,
                  }
                : null,
            },
            null,
            2
          )
        );
      } else {
        console.log(`\n📋 Dossier Validation\n`);
        console.log(`   File: ${path.basename(dossierFile)}`);

        if (frontmatter?.title) {
          console.log(`   Title: ${frontmatter.title}`);
        }
        if (frontmatter?.version) {
          console.log(`   Version: ${frontmatter.version}`);
        }

        if (errors.length > 0) {
          console.log(`\n❌ Errors (${errors.length}):`);
          for (const err of errors) {
            console.log(`   • ${err}`);
          }
        }

        if (warnings.length > 0 && !options.quiet) {
          console.log(`\n⚠️  Warnings (${warnings.length}):`);
          for (const warn of warnings) {
            console.log(`   • ${warn}`);
          }
        }

        if (valid) {
          console.log(`\n✅ Valid${hasWarnings ? ' (with warnings)' : ''}`);
        } else {
          console.log(`\n❌ Invalid`);
        }
        console.log('');
      }

      process.exit(valid ? 0 : 1);
    });
}
