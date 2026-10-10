#!/usr/bin/env node
// Repository CLI; requires `npm run build` in this package first.
// Exit 0: durable stop (including hand-offs); 2: blocked/failed/unsupported,
// cancelled or blocked_cleanup; 3: invalid input; 4: another controller holds the store.
import { createInterface } from 'node:readline/promises';
import { createController } from '../dist/controller/wiring.js';
import { createCommands } from './zt-run-bindings.mjs';
import { main } from './zt-run-lib.mjs';

process.exitCode = await main(process.argv.slice(2), {
  createController: (options) => createCommands({ ...options, createController }),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  ...(process.stdin.isTTY && process.stdout.isTTY
    ? {
        confirmAuthor: async () => {
          const prompt = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return (
              (await prompt.question('Confirm displayed commit author? Type yes: ')).trim() ===
              'yes'
            );
          } finally {
            prompt.close();
          }
        },
      }
    : {}),
});
