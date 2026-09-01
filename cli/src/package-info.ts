/**
 * Read an npm package's own version from its installed package.json —
 * shared by `commands/doctor.ts` (its own dependency checks) and
 * `engine-version.ts` (#537's engine-staleness check). Lives outside
 * `commands/` deliberately: every other file in `commands/` is imported
 * only by `cli.ts` for command registration, and a lib module reaching into
 * a command file for a helper is a layering exception worth avoiding.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Try to read a package's version from its package.json, or null if unresolvable. */
export function getPackageVersion(packageName: string): string | null {
  try {
    const entryPath = require.resolve(packageName);
    // Walk up to find the package.json
    let dir = path.dirname(entryPath);
    for (let i = 0; i < 10; i++) {
      const pkgFile = path.join(dir, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (pkg.name === packageName) {
          return pkg.version ?? null;
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // not installed
  }
  return null;
}
