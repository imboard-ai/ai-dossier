// Bundles the extension (and @ai-dossier/core with it) into dist/extension.js so the
// .vsix is self-contained: validation never needs the CLI or node_modules at runtime.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: [`${root}src/extension.ts`],
  outfile: `${root}dist/extension.js`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  // @ai-dossier/core imports the AWS KMS SDK at module top level for KMS signature
  // verification. That is ~MBs of code the editor never needs, so it is replaced with a
  // stub whose calls throw; the Verify command reports KMS signatures as "use the CLI".
  alias: { '@aws-sdk/client-kms': `${root}src/kms-stub.ts` },
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
