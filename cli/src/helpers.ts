/**
 * Shared helper functions and types for Dossier CLI commands.
 * Extracted from the monolithic bin/dossier entry point.
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {
  type DossierFrontmatter,
  parseDossierContent,
  RECOMMENDED_FIELDS,
  REQUIRED_FIELDS,
  VALID_RISK_LEVELS,
  VALID_STATUSES,
} from '@ai-dossier/core';

import { convertGitHubBlobToRaw } from './github-url';
import { verifyDossier as verifyDossierModule } from './verify-dossier';

// ============================================================================
// Path constants
// ============================================================================

/** Root of the CLI package (cli/) */
export const CLI_ROOT = path.resolve(__dirname, '..');

/** The bin/ directory */
export const BIN_DIR = path.join(CLI_ROOT, 'bin');

// ============================================================================
// Shared constants
// ============================================================================

/** Official KMS keys that require CI/CD signing (not direct CLI use) */
export const OFFICIAL_KMS_KEYS = [
  'alias/dossier-official-prod',
  'alias/dossier-official',
  'arn:aws:kms:us-east-1:942039714848:key/d9ccd3fc-b190-49fd-83f7-e94df6620c1d',
];

// Re-export validation constants from core (single source of truth)
export { RECOMMENDED_FIELDS, REQUIRED_FIELDS, VALID_RISK_LEVELS, VALID_STATUSES };

/** Maximum results per page for CLI pagination commands. */
export const MAX_PER_PAGE = 1000;

// ============================================================================
// TypeScript interfaces
// ============================================================================

export interface VerificationOptions {
  skipChecksum?: boolean;
  skipAllChecks?: boolean;
  force?: boolean;
  noPrompt?: boolean;
}

export interface VerificationStage {
  stage: number;
  name: string;
  passed?: boolean;
  skipped?: boolean;
}

export interface VerificationResult {
  passed: boolean;
  stages: VerificationStage[];
}

export interface ListSource {
  type: 'local' | 'github';
  path?: string;
  owner?: string;
  repo?: string;
  branch?: string;
}

export interface DossierMetadata {
  path: string;
  filename: string;
  title: string;
  version?: string;
  risk_level?: string;
  category?: string;
  status?: string;
  signed?: boolean;
  checksum?: boolean;
  objective?: string;
  error: string | null;
}

export interface GitHubFile {
  path: string;
  rawUrl: string;
  githubUrl: string;
}

// ============================================================================
// Security helpers
// ============================================================================

/**
 * Validate that a path is relative and contains no ".." traversal.
 * @throws Error if the path is absolute or contains path traversal.
 */
export function validateRelativePath(filePath: string): void {
  if (path.isAbsolute(filePath)) {
    throw new Error(`Path '${filePath}' must be relative (absolute paths are not allowed)`);
  }
  if (filePath.split(path.sep).includes('..') || filePath.split('/').includes('..')) {
    throw new Error(`Path '${filePath}' must not contain ".." (path traversal is not allowed)`);
  }
}

/**
 * Parse and clamp pagination options from CLI string arguments.
 * Logs a warning when values are clamped.
 */
export function parsePaginationParams(
  pageStr: string | undefined,
  perPageStr: string | undefined,
  defaults: { page: number; perPage: number } = { page: 1, perPage: 20 }
): { page: number; perPage: number } {
  const parsedPage = parseInt(pageStr || String(defaults.page), 10);
  const rawPage = Number.isNaN(parsedPage) ? defaults.page : parsedPage;
  const parsedPerPage = parseInt(perPageStr || String(defaults.perPage), 10);
  const rawPerPage = Number.isNaN(parsedPerPage) ? defaults.perPage : parsedPerPage;

  const page = Math.max(1, rawPage);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, rawPerPage));

  if (rawPage !== page) {
    console.warn(`⚠️  Page ${rawPage} clamped to ${page} (minimum 1)`);
  }
  if (rawPerPage !== perPage) {
    console.warn(`⚠️  Per-page ${rawPerPage} clamped to ${perPage} (range 1–${MAX_PER_PAGE})`);
  }

  return { page, perPage };
}

/**
 * Validate a dossier name to prevent path traversal attacks.
 * Rejects names containing '..' segments or absolute paths.
 * @throws Error if the name is invalid.
 */
export function validateDossierName(name: string): void {
  const segments = name.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.' || segment === '') {
      throw new Error(`Invalid dossier name: "${name}" contains unsafe path segments`);
    }
  }
  if (path.isAbsolute(name)) {
    throw new Error(`Invalid dossier name: "${name}" must not be an absolute path`);
  }
}

/**
 * Safely join a base directory with a dossier name and verify the result
 * stays within the base directory.
 * @throws Error if the resolved path escapes the base directory.
 */
export function safeDossierPath(baseDir: string, dossierName: string): string {
  validateDossierName(dossierName);
  const resolved = path.resolve(baseDir, ...dossierName.split('/'));
  const resolvedBase = path.resolve(baseDir);
  if (!resolved.startsWith(`${resolvedBase}${path.sep}`) && resolved !== resolvedBase) {
    throw new Error(`Path traversal detected: "${dossierName}" resolves outside base directory`);
  }
  return resolved;
}

// ============================================================================
// Helper functions
// ============================================================================

/**
 * Read all data from stdin (piped input) with a timeout.
 * Returns null if stdin is a TTY (interactive terminal).
 */
export function readStdin(timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    let data = '';
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(data || null);
    }, timeoutMs);

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data || null);
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      process.stderr.write(`Warning: stdin read error: ${err.message}\n`);
      resolve(null);
    });
    process.stdin.resume();
  });
}

/**
 * Detect and resolve which LLM to use.
 * @returns The resolved LLM name, or null if none detected.
 */
export function detectLlm(llmOption: string, silent = false): string | null {
  if (llmOption !== 'auto') {
    return llmOption;
  }

  // Auto-detect LLM
  try {
    execSync('command -v claude', { stdio: 'pipe' });
    if (!silent) console.log('   Detected: Claude Code');
    return 'claude-code';
  } catch {
    if (!silent) {
      console.log('❌ No supported LLM detected\n');
      console.log('Supported LLM:');
      console.log('  - Claude Code (install from https://claude.com/claude-code)\n');
      console.log('Or specify manually: --llm claude-code\n');
    }
    return null;
  }
}

export interface LlmExecDescriptor {
  cmd: string;
  args: string[];
  /** If set, pipe this content to the process's stdin */
  stdin?: string;
  /** Human-readable description for logging */
  description: string;
}

/**
 * Download a URL to a local temp file (synchronous).
 * Returns the temp file path.
 */
export function downloadUrlToTempFile(url: string): string {
  const resolvedUrl = convertGitHubBlobToRaw(url);
  const tmpFile = path.join(
    os.tmpdir(),
    `dossier-${Date.now()}-${Math.random().toString(36).slice(2)}.ds.md`
  );
  const result = spawnSync('curl', ['-sL', '-o', tmpFile, '--', resolvedUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to download ${resolvedUrl}: curl exit code ${result.status}`);
  }
  if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
    try {
      fs.unlinkSync(tmpFile);
    } catch (err) {
      process.stderr.write(
        `Warning: failed to clean up temp file ${tmpFile}: ${(err as Error).message}\n`
      );
    }
    throw new Error(`Downloaded file is empty: ${resolvedUrl}`);
  }
  return tmpFile;
}

/**
 * Build the execution descriptor for a given LLM.
 * File must be a local file path (download URLs first with downloadUrlToTempFile).
 * @returns The execution descriptor, or null for unknown LLM.
 */
export function buildLlmCommand(
  llm: string,
  file: string,
  headless = false
): LlmExecDescriptor | null {
  if (llm === 'claude-code') {
    if (headless) {
      const content = fs.readFileSync(file, 'utf8');
      return {
        cmd: 'claude',
        args: ['-p'],
        stdin: content,
        description: `cat "${file}" | claude -p`,
      };
    } else {
      return {
        cmd: 'claude',
        args: [file],
        description: `claude "${file}"`,
      };
    }
  } else {
    return null;
  }
}

/**
 * Multi-stage verification pipeline.
 */
export async function runVerification(
  file: string,
  options: VerificationOptions
): Promise<VerificationResult> {
  const results: VerificationResult = { passed: true, stages: [] };

  console.log('🔐 Running Multi-Stage Verification Pipeline...\n');

  // Stage 1: Integrity Check (checksum + signature)
  if (!options.skipChecksum && !options.skipAllChecks) {
    console.log('📊 Stage 1: Integrity Check (checksum + signature)');
    const passed = await verifyDossierModule(file, { verbose: false });
    if (passed) {
      console.log('   ✅ PASSED: Checksum and signature valid\n');
      results.stages.push({ stage: 1, name: 'Integrity', passed: true });
    } else {
      console.log('   ❌ FAILED: Verification failed');
      console.log(`   Run "dossier verify ${file}" for details\n`);
      results.passed = false;
      results.stages.push({ stage: 1, name: 'Integrity', passed: false });
      return results;
    }
  } else {
    console.log('⚠️  Stage 1: SKIPPED - Integrity check\n');
    results.stages.push({ stage: 1, name: 'Integrity', skipped: true });
  }

  return results;
}

/**
 * Recursively find all .ds.md files in a local directory.
 */
export function findDossierFilesLocal(dir: string, recursive = false): string[] {
  const results: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
          continue;
        }
        if (recursive) {
          results.push(...findDossierFilesLocal(fullPath, recursive));
        }
      } else if (entry.isFile() && entry.name.endsWith('.ds.md')) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    process.stderr.write(`Warning: cannot read directory ${dir}: ${(err as Error).message}\n`);
  }

  return results;
}

/**
 * Parse source string to determine type and details.
 */
export function parseListSource(source: string): ListSource {
  // GitHub shorthand: github:owner/repo or github:owner/repo/path@branch
  if (source.startsWith('github:')) {
    const rest = source.slice(7);
    const [pathPart, branch] = rest.split('@');
    const parts = pathPart.split('/');
    const owner = parts[0];
    const repo = parts[1];
    const subpath = parts.slice(2).join('/') || '';
    return {
      type: 'github',
      owner,
      repo,
      path: subpath,
      branch: branch || 'main',
    };
  }

  // GitHub URL
  if (source.startsWith('https://github.com/') || source.startsWith('http://github.com/')) {
    const url = new URL(source);
    const parts = url.pathname.split('/').filter((p) => p);
    const owner = parts[0];
    const repo = parts[1];

    if (parts[2] === 'tree' && parts.length >= 4) {
      const branch = parts[3];
      const subpath = parts.slice(4).join('/');
      return {
        type: 'github',
        owner,
        repo,
        path: subpath,
        branch,
      };
    }

    return {
      type: 'github',
      owner,
      repo,
      path: '',
      branch: 'main',
    };
  }

  // Default: local path
  return {
    type: 'local',
    path: source,
  };
}

/**
 * Fetch GitHub repository tree and find .ds.md files.
 */
export async function findDossierFilesGitHub(
  owner: string,
  repo: string,
  subpath: string,
  branch: string
): Promise<GitHubFile[]> {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;

  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'dossier-cli',
        Accept: 'application/vnd.github.v3+json',
      },
    };

    https
      .get(apiUrl, options, (res) => {
        if (res.statusCode === 404) {
          return reject(new Error(`Repository not found: ${owner}/${repo} (branch: ${branch})`));
        }
        if (res.statusCode === 403) {
          return reject(
            new Error('GitHub API rate limit exceeded. Try again later or use a local clone.')
          );
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`GitHub API error: ${res.statusCode} ${res.statusMessage}`));
        }

        let data = '';
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const tree = JSON.parse(data);
            if (!tree.tree) {
              return reject(new Error('Invalid response from GitHub API'));
            }

            const dossierFiles: GitHubFile[] = tree.tree
              .filter((item: { type: string; path: string }) => {
                if (item.type !== 'blob') return false;
                if (!item.path.endsWith('.ds.md')) return false;
                if (subpath && !item.path.startsWith(`${subpath}/`) && item.path !== subpath)
                  return false;
                if (item.path.includes('node_modules/')) return false;
                return true;
              })
              .map((item: { path: string }) => ({
                path: item.path,
                rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${item.path}`,
                githubUrl: `https://github.com/${owner}/${repo}/blob/${branch}/${item.path}`,
              }));

            resolve(dossierFiles);
          } catch (err) {
            reject(new Error(`Failed to parse GitHub response: ${(err as Error).message}`));
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * Fetch and parse dossier metadata from a URL.
 */
export async function fetchDossierMetadata(
  url: string,
  displayPath: string
): Promise<DossierMetadata> {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https://') ? https : http;

    protocol
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          resolve({
            path: displayPath,
            filename: path.basename(displayPath),
            title: path.basename(displayPath, '.ds.md'),
            error: `HTTP ${res.statusCode}`,
          });
          return;
        }

        let content = '';
        res.on('data', (chunk: string) => {
          content += chunk;
        });
        res.on('end', () => {
          resolve(parseDossierMetadataFromContent(content, displayPath));
        });
      })
      .on('error', (err) => {
        resolve({
          path: displayPath,
          filename: path.basename(displayPath),
          title: path.basename(displayPath, '.ds.md'),
          error: err.message,
        });
      });
  });
}

/**
 * Parse dossier metadata from file content.
 */
export function parseDossierMetadataFromContent(
  content: string,
  filePath: string
): DossierMetadata {
  try {
    const parsed = parseDossierContent(content);
    const frontmatter: DossierFrontmatter = parsed.frontmatter;
    const category = frontmatter.category as string | string[] | undefined;
    return {
      path: filePath,
      filename: path.basename(filePath),
      title: frontmatter.title || path.basename(filePath, '.ds.md'),
      version: frontmatter.version || '-',
      risk_level: frontmatter.risk_level || 'unknown',
      category: Array.isArray(category) ? category.join(', ') : (category as string) || '-',
      status: frontmatter.status || '-',
      signed: !!frontmatter.signature,
      checksum: !!frontmatter.checksum,
      objective: frontmatter.objective || '',
      error: null,
    };
  } catch {
    return {
      path: filePath,
      filename: path.basename(filePath),
      title: path.basename(filePath, '.ds.md'),
      error: 'Invalid frontmatter',
    };
  }
}

/**
 * Parse dossier metadata from a local file.
 */
export function parseDossierMetadataLocal(filePath: string): DossierMetadata {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseDossierMetadataFromContent(content, filePath);
  } catch (err) {
    return {
      path: filePath,
      filename: path.basename(filePath),
      title: path.basename(filePath, '.ds.md'),
      error: (err as Error).message,
    };
  }
}

/**
 * Verify a dossier file (quick check using the TS module directly).
 */
export async function verifyDossierQuick(filePath: string): Promise<boolean> {
  return verifyDossierModule(filePath, { verbose: false });
}

/**
 * Format output as table.
 */
export function formatTable(dossiers: DossierMetadata[], showPath = false): string {
  if (dossiers.length === 0) {
    return 'No dossiers found.';
  }

  const titleWidth = Math.min(30, Math.max(5, ...dossiers.map((d) => (d.title || '').length)));
  const riskWidth = 8;
  const signedWidth = 6;

  let output = '\n';
  output += 'TITLE'.padEnd(titleWidth + 2);
  output += 'RISK'.padEnd(riskWidth + 2);
  output += 'SIGNED'.padEnd(signedWidth + 2);
  output += showPath ? 'PATH' : 'FILE';
  output += '\n';
  output += `${'─'.repeat(titleWidth + riskWidth + signedWidth + 50)}\n`;

  for (const d of dossiers) {
    const title = (d.title || d.filename).substring(0, titleWidth);
    const risk = (d.risk_level || 'unknown').toUpperCase().substring(0, riskWidth);
    const signed = d.signed ? '✅' : '⚠️';
    const pathOrFile = showPath ? d.path : d.filename;

    output += title.padEnd(titleWidth + 2);
    output += risk.padEnd(riskWidth + 2);
    output += signed.padEnd(signedWidth + 2);
    output += pathOrFile;
    output += '\n';
  }

  return output;
}

/**
 * Print registry errors to stderr in a consistent format.
 * Used across commands when multi-registry lookups partially or fully fail.
 */
export function printRegistryErrors(
  errors: ReadonlyArray<{ registry: string; error: string }>,
  style: 'indent' | 'warning' = 'indent'
): void {
  for (const e of errors) {
    if (style === 'warning') {
      console.error(`⚠️  Registry '${e.registry}': ${e.error}`);
    } else {
      console.error(`   ${e.registry}: ${e.error}`);
    }
  }
}

const NOT_FOUND_PATTERNS = ['404', 'not found'] as const;
const TIMEOUT_PATTERNS = ['timeout', 'etimedout', 'econnaborted'] as const;

/**
 * Classify and print a user-facing error when all registries fail to resolve a dossier.
 * Distinguishes between 404s, timeouts, mixed failures, and other errors.
 */
export function printRegistryNotFoundError(
  label: string,
  errors: ReadonlyArray<{ registry: string; error: string }>
): void {
  const has404 = errors.some((e) => {
    const lower = e.error.toLowerCase();
    return NOT_FOUND_PATTERNS.some((p) => lower.includes(p));
  });
  const hasTimeout = errors.some((e) => {
    const lower = e.error.toLowerCase();
    return TIMEOUT_PATTERNS.some((p) => lower.includes(p));
  });

  if (hasTimeout && !has404) {
    console.error(`\n❌ Could not reach any registry for: ${label}`);
    console.error('   All registries timed out — check network connectivity');
  } else if (has404 && hasTimeout) {
    console.error(`\n❌ Not found: ${label}`);
    console.error('   Some registries returned 404, others timed out — results may be incomplete');
  } else if (!has404 && !hasTimeout) {
    console.error(`\n❌ All registries failed for: ${label}`);
    console.error('   See individual errors below');
  } else {
    console.error(`\n❌ Not found: ${label}`);
    console.error('   Not a local file and not found in any registry');
  }
  printRegistryErrors(errors);
  console.error('');
}

/**
 * Extract and format common dossier display fields from a registry list item.
 * Used by search and list commands to normalize metadata for display.
 */
export function formatDossierFields(d: {
  name?: string;
  version?: string;
  title?: string;
  category?: string | string[];
  description?: string;
  objective?: string;
}): { name: string; version: string; title: string; category: string; description: string } {
  return {
    name: d.name || '',
    version: d.version || '',
    title: d.title || '',
    category: Array.isArray(d.category) ? d.category.join(', ') : d.category || '',
    description: d.description || d.objective || '',
  };
}

/**
 * Log pagination info to the console.
 * Used by search and list commands when results span multiple pages.
 */
export function logPaginationInfo(total: number, page: number, perPage: number): void {
  const totalPages = Math.ceil(total / perPage);
  if (totalPages > 1) {
    console.log(`\nPage ${page}/${totalPages} (${perPage} per page)`);
    if (page < totalPages) {
      console.log(`Use --page ${page + 1} to see more results`);
    }
    console.log('');
  }
}
