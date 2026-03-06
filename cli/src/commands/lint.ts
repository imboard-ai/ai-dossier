import fs from 'node:fs';
import {
  defaultRules,
  type LintConfig,
  type LintResult,
  type LintRule,
  LintRuleRegistry,
  lintDossierFile,
} from '@ai-dossier/core';
import type { Command } from 'commander';

export function registerLintCommand(program: Command): void {
  program
    .command('lint')
    .description('Lint dossier files for errors and warnings')
    .argument('[file]', 'Dossier file to lint')
    .option('--strict', 'Treat warnings as errors')
    .option('--json', 'Output diagnostics as JSON')
    .option('--quiet', 'Only show errors (suppress warnings and info)')
    .option('--config <path>', 'Path to .dossierrc.json config file')
    .option('--list-rules', 'List all available lint rules and exit')
    .action(
      (
        file: string | undefined,
        options: {
          listRules?: boolean;
          json?: boolean;
          quiet?: boolean;
          strict?: boolean;
          config?: string;
        }
      ) => {
        if (options.listRules) {
          const registry = new LintRuleRegistry();
          registry.registerAll(defaultRules);
          const rules = registry.getRules();

          if (options.json) {
            console.log(
              JSON.stringify(
                rules.map((r: LintRule) => ({
                  id: r.id,
                  description: r.description,
                  defaultSeverity: r.defaultSeverity,
                })),
                null,
                2
              )
            );
          } else {
            console.log('Available lint rules:\n');
            for (const rule of rules) {
              const severity = rule.defaultSeverity.toUpperCase().padEnd(7);
              console.log(`  ${severity}  ${rule.id}`);
              console.log(`           ${rule.description}\n`);
            }
          }
          process.exit(0);
        }

        if (!file) {
          console.error('Error: missing required argument "file"');
          process.exit(2);
        }

        let lintConfig: LintConfig | undefined;
        if (options.config) {
          try {
            const raw = fs.readFileSync(options.config, 'utf8');
            const parsed = JSON.parse(raw);
            lintConfig = { rules: parsed.rules || {} };
          } catch (err: unknown) {
            console.error(`Error loading config: ${(err as Error).message}`);
            process.exit(2);
          }
        }

        let result: LintResult;
        try {
          result = lintDossierFile(file, lintConfig);
        } catch (err: unknown) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(2);
        }

        let diagnostics = result.diagnostics;
        if (options.quiet) {
          diagnostics = diagnostics.filter((d) => d.severity === 'error');
        }

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                file,
                diagnostics,
                errorCount: result.errorCount,
                warningCount: result.warningCount,
                infoCount: result.infoCount,
              },
              null,
              2
            )
          );
        } else {
          if (diagnostics.length === 0) {
            console.log(`${file}: no issues found`);
          } else {
            for (const d of diagnostics) {
              const icon = d.severity === 'error' ? 'x' : d.severity === 'warning' ? '!' : 'i';
              const field = d.field ? ` (${d.field})` : '';
              console.log(`  ${icon} ${d.severity.padEnd(7)}  ${d.message}${field}  [${d.ruleId}]`);
            }
            console.log(
              `\n  ${result.errorCount} error(s), ${result.warningCount} warning(s), ${result.infoCount} info`
            );
          }
        }

        const effectiveErrors = options.strict
          ? result.errorCount + result.warningCount
          : result.errorCount;

        if (effectiveErrors > 0) {
          process.exit(2);
        } else if (result.warningCount > 0) {
          process.exit(1);
        } else {
          process.exit(0);
        }
      }
    );
}
