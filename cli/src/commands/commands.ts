import type { Command, Option } from 'commander';

interface OptionInfo {
  flags: string;
  description: string;
  required: boolean;
  optional: boolean;
  variadic: boolean;
  default?: unknown;
  choices?: string[];
}

interface ArgumentInfo {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
  default?: unknown;
  choices?: string[];
}

interface CommandInfo {
  name: string;
  description: string;
  aliases: string[];
  arguments: ArgumentInfo[];
  options: OptionInfo[];
}

function extractOption(opt: Option): OptionInfo {
  const info: OptionInfo = {
    flags: opt.flags,
    description: opt.description,
    required: opt.required,
    optional: opt.optional,
    variadic: opt.variadic,
  };
  if (opt.defaultValue !== undefined) {
    info.default = opt.defaultValue;
  }
  if (opt.argChoices) {
    info.choices = opt.argChoices;
  }
  return info;
}

function extractCommand(cmd: Command): CommandInfo {
  const args: ArgumentInfo[] =
    (cmd as any).registeredArguments?.map((arg: any) => {
      const info: ArgumentInfo = {
        name: arg._name,
        description: arg.description || '',
        required: arg.required,
        variadic: arg.variadic,
      };
      if (arg.defaultValue !== undefined) {
        info.default = arg.defaultValue;
      }
      if (arg.argChoices) {
        info.choices = arg.argChoices;
      }
      return info;
    }) || [];

  const options: OptionInfo[] = cmd.options
    .filter((o) => o.long !== '--version' && o.long !== '--help')
    .map(extractOption);

  return {
    name: cmd.name(),
    description: cmd.description(),
    aliases: cmd.aliases(),
    arguments: args,
    options,
  };
}

export function registerCommandsCommand(program: Command): void {
  program
    .command('commands')
    .description('List all available commands and their flags as JSON')
    .option('--command <name>', 'Show detail for a single command')
    .action((options: { command?: string }) => {
      const pkg = require('../../package.json');

      if (options.command) {
        const cmd = program.commands.find(
          (c) => c.name() === options.command || c.aliases().includes(options.command!)
        );
        if (!cmd) {
          console.error(`\nUnknown command: ${options.command}\n`);
          process.exit(1);
        }
        console.log(JSON.stringify(extractCommand(cmd), null, 2));
        return;
      }

      const commands = program.commands.filter((c) => c.name() !== 'commands').map(extractCommand);

      console.log(
        JSON.stringify(
          {
            cli: program.name(),
            version: pkg.version,
            commands,
          },
          null,
          2
        )
      );
    });
}
