import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_GITIGNORE = join(__dirname, '..', '.gitignore');

describe('gitignore node_modules symlink regression', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'gitignore-test-'));
    execSync('git init', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: tempDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('ignores node_modules as a directory', () => {
    const gitignorePath = join(tempDir, '.gitignore');
    const gitignoreContent = readFileSync(REPO_GITIGNORE, 'utf-8');
    writeFileSync(gitignorePath, gitignoreContent);

    execSync('git add .gitignore', { cwd: tempDir });
    execSync('git commit -m "add gitignore"', { cwd: tempDir, stdio: 'pipe' });

    // Create node_modules directory with a file
    const nodeModulesDir = join(tempDir, 'node_modules');
    execSync(`mkdir -p ${nodeModulesDir} && echo "test" > ${nodeModulesDir}/test.txt`, {
      shell: true,
    });

    const status = execSync('git status --porcelain', { cwd: tempDir, encoding: 'utf-8' });
    expect(status.trim()).toBe('');
  });

  it('ignores node_modules as a symlink', () => {
    const gitignorePath = join(tempDir, '.gitignore');
    const gitignoreContent = readFileSync(REPO_GITIGNORE, 'utf-8');
    writeFileSync(gitignorePath, gitignoreContent);

    execSync('git add .gitignore', { cwd: tempDir });
    execSync('git commit -m "add gitignore"', { cwd: tempDir, stdio: 'pipe' });

    // Create node_modules symlink (as worktree warmers do)
    const nodeModulesTarget = join(tmpdir(), 'node_modules-target');
    execSync(`mkdir -p ${nodeModulesTarget}`, { shell: true });
    symlinkSync(nodeModulesTarget, join(tempDir, 'node_modules'));

    const status = execSync('git status --porcelain', { cwd: tempDir, encoding: 'utf-8' });
    expect(status.trim()).toBe('');

    // Cleanup target
    rmSync(nodeModulesTarget, { recursive: true, force: true });
  });
});
