/**
 * Dossier verification module.
 *
 * Provides integrity (checksum), authenticity (signature), and risk
 * assessment for local files and remote URLs.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type {
  ChecksumStatus,
  DossierFrontmatter,
  SignatureResult,
  SignatureStatus,
  VerificationRiskResult,
} from '@ai-dossier/core';
import {
  assessVerificationRisk,
  loadTrustedKeys,
  parseDossierContent,
  verifyIntegrity,
  verifySignature,
} from '@ai-dossier/core';

import { convertGitHubBlobToRaw } from './github-url';

// ============================================================================
// Terminal colors
// ============================================================================

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const;

function log(message: string, color: keyof typeof colors = 'reset'): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function error(message: string): void {
  log(`\u274C ${message}`, 'red');
}

function success(message: string): void {
  log(`\u2705 ${message}`, 'green');
}

function warning(message: string): void {
  log(`\u26A0\uFE0F  ${message}`, 'yellow');
}

function info(message: string): void {
  log(`\u2139\uFE0F  ${message}`, 'cyan');
}

// ============================================================================
// Options
// ============================================================================

export interface VerifyOptions {
  verbose: boolean;
}

// ============================================================================
// Download with redirect depth limit
// ============================================================================

const MAX_REDIRECTS = 10;

export async function downloadFile(url: string, redirectCount = 0): Promise<string> {
  if (redirectCount >= MAX_REDIRECTS) {
    throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
  }

  const resolvedUrl = redirectCount === 0 ? convertGitHubBlobToRaw(url) : url;

  return new Promise((resolve, reject) => {
    const protocol = resolvedUrl.startsWith('https://') ? https : http;

    protocol
      .get(resolvedUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (!location) {
            return reject(new Error(`Redirect without Location header from ${resolvedUrl}`));
          }
          return downloadFile(location, redirectCount + 1)
            .then(resolve)
            .catch(reject);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }

        let data = '';
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

// ============================================================================
// Signature check (wraps core)
// ============================================================================

export interface SignatureCheckResult {
  present: boolean;
  verified: boolean;
  trusted: boolean;
  message: string;
}

export async function checkSignature(
  body: string,
  frontmatter: DossierFrontmatter
): Promise<SignatureCheckResult> {
  if (!frontmatter.signature) {
    return {
      present: false,
      verified: false,
      trusted: false,
      message: 'No signature present',
    };
  }

  const signature = frontmatter.signature;
  const trustedKeys = loadTrustedKeys();
  const isTrusted =
    (signature.key_id != null && trustedKeys.has(signature.key_id)) ||
    (signature.public_key != null && trustedKeys.has(signature.public_key));

  const result = await verifySignature(body, signature as SignatureResult);

  if (result.valid) {
    let trustedName = '';
    if (isTrusted) {
      trustedName =
        (signature.key_id ? trustedKeys.get(signature.key_id) : undefined) ||
        (signature.public_key ? trustedKeys.get(signature.public_key) : undefined) ||
        '';
    }
    return {
      present: true,
      verified: true,
      trusted: isTrusted,
      message: isTrusted
        ? `Verified signature from trusted source: ${trustedName}`
        : 'Valid signature but key is not in trusted list',
    };
  }

  if (result.error) {
    return {
      present: true,
      verified: false,
      trusted: false,
      message: `Verification error: ${result.error}`,
    };
  }

  return {
    present: true,
    verified: false,
    trusted: isTrusted,
    message: 'Signature verification FAILED',
  };
}

// ============================================================================
// Main verification
// ============================================================================

export async function verifyDossier(input: string, options: VerifyOptions): Promise<boolean> {
  try {
    log(`\n${colors.bright}\uD83D\uDD10 Dossier Verification Tool${colors.reset}\n`);

    const isUrl = input.startsWith('http://') || input.startsWith('https://');
    let content: string;

    if (isUrl) {
      info(`Downloading: ${input}`);
      content = await downloadFile(input);
      success('Downloaded successfully');
    } else {
      info(`Reading: ${input}`);
      content = fs.readFileSync(input, 'utf8');
      success('File read successfully');
    }

    // Parse dossier (using core directly)
    info('Parsing dossier...');
    const parsed = parseDossierContent(content);
    const { frontmatter, body } = parsed;
    success(`Parsed: ${frontmatter.title} v${frontmatter.version}`);

    if (options.verbose) {
      console.log(`\n${colors.bright}Dossier Metadata:${colors.reset}`);
      console.log(`  Title: ${frontmatter.title}`);
      console.log(`  Version: ${frontmatter.version}`);
      console.log(`  Risk Level: ${frontmatter.risk_level ?? 'not specified'}`);
    }

    // Verify checksum (using core directly)
    console.log(`\n${colors.bright}\uD83D\uDCCA Integrity Check:${colors.reset}`);
    const integrityResult = verifyIntegrity(body, frontmatter.checksum?.hash);
    const checksumPassed = integrityResult.status === 'valid';

    if (checksumPassed) {
      success('Checksum VALID - content has not been tampered with');
      if (options.verbose) {
        console.log(`   Hash: ${integrityResult.actualHash}`);
      }
    } else {
      error('Checksum INVALID - content has been modified!');
      if (options.verbose) {
        console.log(`   Declared: ${integrityResult.expectedHash}`);
        console.log(`   Actual:   ${integrityResult.actualHash}`);
      }
    }

    // Verify signature
    console.log(`\n${colors.bright}\uD83D\uDD0F Authenticity Check:${colors.reset}`);
    const signatureResult = await checkSignature(body, frontmatter);

    if (signatureResult.present) {
      if (signatureResult.verified && signatureResult.trusted) {
        success('Signature VERIFIED - from trusted author');
      } else if (signatureResult.verified && !signatureResult.trusted) {
        warning(signatureResult.message);
        if (frontmatter.signature?.signed_by) {
          console.log(`   Signed by: ${frontmatter.signature.signed_by}`);
        }
        console.log(`\n   ${colors.cyan}To trust this signer, run:${colors.reset}`);
        const sig = frontmatter.signature;
        const publicKey = sig?.public_key || sig?.key_id;
        const identifier = sig?.signed_by
          ? sig.signed_by.split('<')[0].trim().toLowerCase().replace(/\s+/g, '-')
          : 'unknown-signer';
        console.log(
          `   ${colors.bright}dossier keys add "${publicKey}" "${identifier}"${colors.reset}\n`
        );
      } else {
        warning(signatureResult.message);
        if (frontmatter.signature?.signed_by) {
          console.log(`   Signed by: ${frontmatter.signature.signed_by}`);
        }
      }
    } else {
      warning('No signature present (dossier is unsigned)');
    }

    // Assess risk (using core function)
    console.log(`\n${colors.bright}\uD83D\uDD34 Risk Assessment:${colors.reset}`);
    const checksumStatus: ChecksumStatus = { passed: checksumPassed };
    const signatureStatus: SignatureStatus = {
      present: signatureResult.present,
      verified: signatureResult.verified,
      trusted: signatureResult.trusted,
    };
    const risk: VerificationRiskResult = assessVerificationRisk(
      frontmatter.risk_level,
      checksumStatus,
      signatureStatus
    );

    const riskColors: Record<string, keyof typeof colors> = {
      low: 'green',
      medium: 'yellow',
      high: 'yellow',
      critical: 'red',
    };

    log(`   Risk Level: ${risk.level.toUpperCase()}`, riskColors[risk.level] || 'reset');

    if (risk.issues.length > 0) {
      console.log(`\n   Issues Found:`);
      risk.issues.forEach((issue) => {
        console.log(`   - ${issue}`);
      });
    }

    // Recommendation
    console.log(`\n${colors.bright}Recommendation:${colors.reset}`, risk.recommendation);

    if (risk.recommendation === 'BLOCK') {
      error('\nDO NOT EXECUTE this dossier');
      console.log('   Security verification failed.');
      console.log('   This dossier may have been tampered with or is from an untrusted source.\n');
      return false;
    } else if (risk.level === 'medium' || risk.level === 'high') {
      warning('\nProceed with CAUTION');
      console.log('   Review the dossier code before executing.');
      console.log('   Consider the risk level and your trust in the source.\n');
      return true;
    } else {
      success('\nSafe to execute');
      console.log('   Dossier passed security verification.\n');
      return true;
    }
  } catch (err) {
    error(`\nVerification failed: ${(err as Error).message}`);
    if (options.verbose) {
      console.error(err);
    }
    return false;
  }
}

// ============================================================================
// CLI argument parsing
// ============================================================================

export interface ParsedArgs {
  verbose: boolean;
  help: boolean;
  input: string | null;
}

export function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const options: ParsedArgs = {
    verbose: false,
    help: false,
    input: null,
  };

  for (const arg of args) {
    if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!options.input) {
      options.input = arg;
    }
  }

  return options;
}

export function showHelp(): void {
  console.log(`
${colors.bright}Dossier Verification CLI${colors.reset}

${colors.bright}Usage:${colors.reset}
  dossier-verify <file-or-url>              Verify dossier security
  dossier-verify --verbose <file-or-url>    Show detailed verification

${colors.bright}Exit Codes:${colors.reset}
  0 - Verification passed (safe to execute)
  1 - Verification failed (do not execute)
  2 - Error occurred (cannot verify)

${colors.bright}Examples:${colors.reset}
  # Verify local file
  dossier-verify path/to/dossier.ds.md

  # Verify remote dossier
  dossier-verify https://example.com/dossier.ds.md

  # Use in shell script
  if dossier-verify "$URL"; then
    claude-code "run $URL"
  else
    echo "Security verification failed"
  fi

${colors.bright}Security Checks:${colors.reset}
  \u2713 SHA256 checksum verification (required)
  \u2713 Signature verification (if present)
  \u2713 Trusted keys check
  \u2713 Risk level assessment

${colors.bright}More Information:${colors.reset}
  Documentation: https://github.com/imboard/ai-dossier
  Security: SECURITY_STATUS.md
  Protocol: PROTOCOL.md
`);
}

// ============================================================================
// CLI entry point
// ============================================================================

export async function main(): Promise<void> {
  const options = parseArgs();

  if (options.help || !options.input) {
    showHelp();
    process.exit(options.help ? 0 : 2);
  }

  const passed = await verifyDossier(options.input, options);

  if (!passed) {
    process.exit(1);
  }

  process.exit(0);
}
