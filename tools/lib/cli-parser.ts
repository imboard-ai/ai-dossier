/**
 * Generic CLI argument parser for dossier tools
 * Provides a declarative way to define CLI options
 */

export interface OptionConfig {
  name: string;
  flag: string;
  description: string;
  required?: boolean;
  defaultValue?: string;
  isBoolean?: boolean;
  defaultFn?: () => string;
}

export interface ParserConfig {
  name: string;
  description: string;
  usage: string;
  options: OptionConfig[];
  extraHelp?: string;
}

/**
 * Print help message and exit
 */
function printHelp(config: ParserConfig, exitCode: number): never {
  console.log(`
${config.name}

Usage:
  ${config.usage}

Options:`);

  for (const opt of config.options) {
    const flag = opt.isBoolean ? `--${opt.flag}` : `--${opt.flag} <value>`;
    const padded = flag.padEnd(24);
    const defaultStr = opt.defaultValue !== undefined ? ` (default: ${opt.defaultValue})` : '';
    const requiredStr = opt.required ? ' (REQUIRED)' : '';
    console.log(`  ${padded} ${opt.description}${defaultStr}${requiredStr}`);
  }

  console.log(`  ${'--help, -h'.padEnd(24)} Show this help message`);

  if (config.extraHelp) {
    console.log(config.extraHelp);
  }

  process.exit(exitCode);
}

/**
 * Create a CLI argument parser
 */
function createCliParser(config: ParserConfig): () => Record<string, string | boolean | null> {
  return function parseArgs(): Record<string, string | boolean | null> {
    const args = process.argv.slice(2);

    // Help check
    if (args.length < 1 || args.includes('--help') || args.includes('-h')) {
      printHelp(config, args.includes('--help') || args.includes('-h') ? 0 : 1);
    }

    // First positional argument is the dossier file
    const result: Record<string, string | boolean | null> = {
      dossierFile: args[0],
    };

    // First pass: parse boolean flags (so --dry-run is available for required checks)
    for (const opt of config.options) {
      if (opt.isBoolean) {
        const flagIndex = args.indexOf(`--${opt.flag}`);
        result[opt.name] = flagIndex !== -1;
      }
    }

    // Second pass: parse value options and check required
    for (const opt of config.options) {
      if (opt.isBoolean) continue; // Already parsed

      const flagIndex = args.indexOf(`--${opt.flag}`);

      if (flagIndex !== -1 && args[flagIndex + 1]) {
        // Value options
        result[opt.name] = args[flagIndex + 1];
      } else if (opt.defaultFn) {
        // Computed default
        result[opt.name] = opt.defaultFn();
      } else if (opt.defaultValue !== undefined) {
        // Static default
        result[opt.name] = opt.defaultValue;
      } else {
        result[opt.name] = null;
      }

      // Check required (skip if dry-run is set)
      if (opt.required && !result[opt.name] && !result.dryRun) {
        console.error(`Error: --${opt.flag} is required (unless using --dry-run)`);
        process.exit(1);
      }
    }

    return result;
  };
}

export { createCliParser, printHelp };
