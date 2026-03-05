import { resolve } from 'node:path';

/**
 * Validate that a path stays within the current working directory.
 * Throws if the resolved path is outside cwd.
 *
 * @returns The resolved absolute path
 */
export function validatePathWithinCwd(inputPath: string): string {
  const resolvedPath = resolve(inputPath);
  const cwd = process.cwd();
  if (!resolvedPath.startsWith(`${cwd}/`) && resolvedPath !== cwd) {
    throw new Error(`Access denied: path "${inputPath}" is outside the working directory`);
  }
  return resolvedPath;
}
