import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Command } from 'commander';

export function registerCacheCommand(program: Command): void {
  const cacheCmd = program.command('cache').description('Manage local dossier cache');

  // cache list
  cacheCmd
    .command('list')
    .description('Show all cached dossiers')
    .option('--json', 'Output as JSON')
    .option('--size', 'Show file sizes')
    .action((options: { json?: boolean; size?: boolean }) => {
      const cacheDir = path.join(os.homedir(), '.dossier', 'cache');

      if (!fs.existsSync(cacheDir)) {
        if (options.json) {
          console.log(JSON.stringify([]));
        } else {
          console.log('\nNo cached dossiers.\n');
        }
        process.exit(0);
      }

      const entries: any[] = [];
      function walk(dir: string): void {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name.endsWith('.meta.json')) {
            try {
              const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
              const version = entry.name.replace('.meta.json', '');
              const contentFile = path.join(dir, `${version}.ds.md`);
              if (!fs.existsSync(contentFile)) return;

              const rel = path.relative(cacheDir, dir);
              const stats = fs.statSync(contentFile);
              entries.push({
                name: rel,
                version,
                size: stats.size,
                cached_at: meta.cached_at,
                path: contentFile,
              });
            } catch {
              // skip invalid entries
            }
          }
        }
      }
      walk(cacheDir);

      if (entries.length === 0) {
        if (options.json) {
          console.log(JSON.stringify([]));
        } else {
          console.log('\nNo cached dossiers.\n');
        }
        process.exit(0);
      }

      entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        process.exit(0);
      }

      function formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
      }

      console.log(`\n📦 Cached dossiers (${entries.length}):\n`);
      if (options.size) {
        console.log(`  ${'NAME'.padEnd(40)} ${'VERSION'.padEnd(10)} ${'SIZE'.padEnd(8)} CACHED AT`);
        console.log(`  ${'─'.repeat(40)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(19)}`);
      } else {
        console.log(`  ${'NAME'.padEnd(40)} ${'VERSION'.padEnd(10)} CACHED AT`);
        console.log(`  ${'─'.repeat(40)} ${'─'.repeat(10)} ${'─'.repeat(19)}`);
      }

      for (const e of entries) {
        const date = e.cached_at ? e.cached_at.slice(0, 19).replace('T', ' ') : '';
        if (options.size) {
          console.log(
            `  ${e.name.padEnd(40)} ${e.version.padEnd(10)} ${formatSize(e.size).padEnd(8)} ${date}`
          );
        } else {
          console.log(`  ${e.name.padEnd(40)} ${e.version.padEnd(10)} ${date}`);
        }
      }
      console.log('');
      process.exit(0);
    });

  // cache clean
  cacheCmd
    .command('clean')
    .description('Remove cached dossiers')
    .argument('[name]', 'Specific dossier to remove')
    .option('-V, --ver <version>', 'Remove specific version only')
    .option('--older-than <days>', 'Remove entries older than N days')
    .option('--all', 'Remove all cached dossiers')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (name: string | undefined, options: any) => {
      const cacheDir = path.join(os.homedir(), '.dossier', 'cache');

      if (!fs.existsSync(cacheDir)) {
        console.log('\nNo cached dossiers.\n');
        process.exit(0);
      }

      async function confirm(msg: string): Promise<boolean> {
        if (options.yes) return true;
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`${msg} (y/N) `, resolve);
        });
        rl.close();
        return answer.toString().toLowerCase() === 'y';
      }

      function rmDir(dir: string): void {
        fs.rmSync(dir, { recursive: true, force: true });
        let parent = path.dirname(dir);
        while (parent !== cacheDir && parent.startsWith(cacheDir)) {
          try {
            const contents = fs.readdirSync(parent);
            if (contents.length === 0) {
              fs.rmdirSync(parent);
              parent = path.dirname(parent);
            } else {
              break;
            }
          } catch {
            break;
          }
        }
      }

      if (options.all) {
        if (!(await confirm('Remove ALL cached dossiers?'))) {
          console.log('\nAborted.\n');
          process.exit(0);
        }
        fs.rmSync(cacheDir, { recursive: true, force: true });
        console.log('\n✅ Cache cleared.\n');
        process.exit(0);
      }

      if (options.olderThan) {
        const days = parseInt(options.olderThan, 10);
        if (isNaN(days) || days <= 0) {
          console.error('\n❌ --older-than must be a positive number\n');
          process.exit(1);
        }

        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        let count = 0;

        function walkClean(dir: string): void {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walkClean(full);
            } else if (entry.name.endsWith('.meta.json')) {
              try {
                const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
                if (meta.cached_at && new Date(meta.cached_at).getTime() < cutoff) {
                  const version = entry.name.replace('.meta.json', '');
                  const contentFile = path.join(dir, `${version}.ds.md`);
                  fs.unlinkSync(full);
                  if (fs.existsSync(contentFile)) fs.unlinkSync(contentFile);
                  count++;
                }
              } catch {
                // skip
              }
            }
          }
        }

        if (!(await confirm(`Remove dossiers cached more than ${days} days ago?`))) {
          console.log('\nAborted.\n');
          process.exit(0);
        }

        walkClean(cacheDir);
        console.log(`\n✅ Removed ${count} cached dossier(s).\n`);
        process.exit(0);
      }

      if (name) {
        const dossierDir = path.join(cacheDir, ...name.split('/'));
        if (!fs.existsSync(dossierDir)) {
          console.error(`\n❌ Not cached: ${name}\n`);
          process.exit(1);
        }

        if (options.ver) {
          const contentFile = path.join(dossierDir, `${options.ver}.ds.md`);
          const metaFile = path.join(dossierDir, `${options.ver}.meta.json`);
          if (!fs.existsSync(contentFile) && !fs.existsSync(metaFile)) {
            console.error(`\n❌ Version ${options.ver} not cached for ${name}\n`);
            process.exit(1);
          }
          if (fs.existsSync(contentFile)) fs.unlinkSync(contentFile);
          if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile);
          console.log(`\n✅ Removed: ${name}@${options.ver}\n`);
        } else {
          if (!(await confirm(`Remove all cached versions of '${name}'?`))) {
            console.log('\nAborted.\n');
            process.exit(0);
          }
          rmDir(dossierDir);
          console.log(`\n✅ Removed: ${name} (all versions)\n`);
        }
        process.exit(0);
      }

      console.log('\nUsage:');
      console.log('  dossier cache clean <name>              Remove all versions of a dossier');
      console.log('  dossier cache clean <name> --ver X      Remove specific version');
      console.log('  dossier cache clean --older-than <days>  Remove stale entries');
      console.log('  dossier cache clean --all                Remove everything');
      console.log('');
      process.exit(0);
    });
}
