import type { Command } from 'commander';
import * as config from '../config';

export function registerConfigCommand(program: Command): void {
  program
    .command('config')
    .description('Manage dossier configuration')
    .argument('[key]', 'Configuration key (e.g., defaultLlm)')
    .argument('[value]', 'Value to set (omit to get current value)')
    .option('--list', 'List all configuration')
    .option('--reset', 'Reset to defaults')
    .option('--add-registry <name>', 'Add a named registry')
    .option('--remove-registry <name>', 'Remove a named registry')
    .option('--set-default-registry <name>', 'Set the default registry')
    .option('--list-registries', 'List configured registries')
    .option('--url <url>', 'Registry URL (used with --add-registry)')
    .option('--default', 'Mark registry as default (used with --add-registry)')
    .option('--readonly', 'Mark registry as read-only (used with --add-registry)')
    .option('--json', 'Output as JSON')
    .action(
      (
        key: string | undefined,
        value: string | undefined,
        options: {
          list?: boolean;
          reset?: boolean;
          addRegistry?: string;
          removeRegistry?: string;
          setDefaultRegistry?: string;
          listRegistries?: boolean;
          url?: string;
          default?: boolean;
          readonly?: boolean;
          json?: boolean;
        }
      ) => {
        // --- Registry management ---

        if (options.listRegistries) {
          const registries = config.resolveRegistries();
          const currentConfig = config.loadConfig();
          const projectConfig = config.loadProjectConfig();

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  registries: registries.map((r) => ({
                    name: r.name,
                    url: r.url,
                    readonly: r.readonly || false,
                    default:
                      r.name === (projectConfig?.defaultRegistry || currentConfig.defaultRegistry),
                  })),
                  defaultRegistry:
                    projectConfig?.defaultRegistry || currentConfig.defaultRegistry || null,
                },
                null,
                2
              )
            );
          } else {
            console.log('\n📋 Configured Registries:\n');
            const defaultName = projectConfig?.defaultRegistry || currentConfig.defaultRegistry;
            for (const r of registries) {
              const flags: string[] = [];
              if (r.name === defaultName) flags.push('default');
              if (r.readonly) flags.push('read-only');
              const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';
              console.log(`   ${r.name}: ${r.url}${flagStr}`);
            }
            console.log('');
          }
          process.exit(0);
        }

        if (options.addRegistry) {
          if (!options.url) {
            console.error('\n❌ --url is required when adding a registry\n');
            console.error(
              'Example: dossier config --add-registry internal --url https://dossier.company.com\n'
            );
            process.exit(1);
          }

          const currentConfig = config.loadConfig();
          if (!currentConfig.registries) {
            currentConfig.registries = {};
          }

          const entry: config.RegistryEntry = { url: options.url };
          if (options.default) entry.default = true;
          if (options.readonly) entry.readonly = true;

          currentConfig.registries[options.addRegistry] = entry;

          if (options.default) {
            currentConfig.defaultRegistry = options.addRegistry;
          }

          if (config.saveConfig(currentConfig)) {
            console.log(`\n✅ Added registry '${options.addRegistry}': ${options.url}`);
            if (options.default) console.log('   Set as default registry');
            if (options.readonly) console.log('   Marked as read-only');
            console.log('');
          } else {
            console.error('❌ Failed to save configuration');
            process.exit(1);
          }
          process.exit(0);
        }

        if (options.removeRegistry) {
          const currentConfig = config.loadConfig();
          if (!currentConfig.registries || !(options.removeRegistry in currentConfig.registries)) {
            console.error(`\n❌ Registry '${options.removeRegistry}' not found\n`);
            process.exit(1);
          }

          delete currentConfig.registries[options.removeRegistry];
          if (currentConfig.defaultRegistry === options.removeRegistry) {
            delete currentConfig.defaultRegistry;
          }

          if (config.saveConfig(currentConfig)) {
            console.log(`\n✅ Removed registry '${options.removeRegistry}'\n`);
          } else {
            console.error('❌ Failed to save configuration');
            process.exit(1);
          }
          process.exit(0);
        }

        if (options.setDefaultRegistry) {
          const registries = config.resolveRegistries();
          const found = registries.find((r) => r.name === options.setDefaultRegistry);
          if (!found) {
            const names = registries.map((r) => r.name).join(', ');
            console.error(`\n❌ Registry '${options.setDefaultRegistry}' not found`);
            console.error(`   Available: ${names}\n`);
            process.exit(1);
          }

          const currentConfig = config.loadConfig();
          currentConfig.defaultRegistry = options.setDefaultRegistry;

          if (config.saveConfig(currentConfig)) {
            console.log(`\n✅ Default registry set to '${options.setDefaultRegistry}'\n`);
          } else {
            console.error('❌ Failed to save configuration');
            process.exit(1);
          }
          process.exit(0);
        }

        // --- Original config management ---

        if (options.list || (!key && !options.reset)) {
          const currentConfig = config.loadConfig();
          console.log('📋 Current Configuration:\n');
          console.log(`   Config file: ${config.CONFIG_FILE}\n`);
          Object.entries(currentConfig).forEach(([k, v]) => {
            if (typeof v === 'object' && v !== null) {
              console.log(`   ${k}: ${JSON.stringify(v)}`);
            } else {
              console.log(`   ${k}: ${v}`);
            }
          });
          console.log('\nTo change a setting: dossier config <key> <value>');
          console.log('Example: dossier config defaultLlm claude-code\n');
          process.exit(0);
        }

        if (options.reset) {
          if (config.saveConfig(config.DEFAULT_CONFIG)) {
            console.log('✅ Configuration reset to defaults\n');
            Object.entries(config.DEFAULT_CONFIG).forEach(([k, v]) => {
              console.log(`   ${k}: ${v}`);
            });
          } else {
            console.log('❌ Failed to reset configuration');
            process.exit(1);
          }
          process.exit(0);
        }

        if (key && !value) {
          const val = config.getConfig(key);
          if (val !== undefined) {
            if (typeof val === 'object' && val !== null) {
              console.log(`${key}: ${JSON.stringify(val, null, 2)}`);
            } else {
              console.log(`${key}: ${val}`);
            }
          } else {
            console.log(`❌ Unknown configuration key: ${key}\n`);
            console.log('Available keys:');
            for (const k of Object.keys(config.DEFAULT_CONFIG)) {
              console.log(`   - ${k}`);
            }
            process.exit(1);
          }
          process.exit(0);
        }

        if (key && value) {
          if (!(key in config.DEFAULT_CONFIG)) {
            console.log(`⚠️  Warning: '${key}' is not a standard config key\n`);
            console.log('Standard keys:');
            for (const k of Object.keys(config.DEFAULT_CONFIG)) {
              console.log(`   - ${k}`);
            }
            console.log('\nContinuing anyway...\n');
          }

          if (key === 'defaultLlm') {
            const validLlms = ['auto', 'claude-code'];
            if (!validLlms.includes(value)) {
              console.log(`⚠️  Warning: '${value}' may not be a supported LLM\n`);
              console.log('Supported values:');
              for (const llm of validLlms) {
                console.log(`   - ${llm}`);
              }
              console.log('\nContinuing anyway...\n');
            }
          }

          if (config.setConfig(key, value)) {
            console.log(`✅ Configuration updated: ${key} = ${value}`);
          } else {
            console.log('❌ Failed to update configuration');
            process.exit(1);
          }
          process.exit(0);
        }
      }
    );
}
