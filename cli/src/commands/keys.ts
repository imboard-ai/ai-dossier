import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isKmsKeyIdentifier,
  isSupportedPublicKey,
  normalizePublicKey,
  parseTrustedKeys,
  reportTrustedKeyProblems,
  type TrustedKeyEntry,
  type TrustedKeyProblem,
  trustedKeysFromContent,
} from '@ai-dossier/core';
import type { Command } from 'commander';

/**
 * A one-line rendering of a rejected key argument, for the error message.
 *
 * Multi-line and overlong values are collapsed so the error stays readable, but
 * the head of the value is kept — that is what lets someone see they pasted a
 * path, a private key, or a truncated string.
 */
function summarizeKeyArgument(value: string): string {
  const flat = value.trim().replace(/\s+/g, ' ');
  const shown = flat.length > 70 ? `${flat.slice(0, 70)}...` : flat;
  return `"${shown}" (${value.trim().length} chars)`;
}

/** Whether an argument looks like someone passed a file path instead of a key. */
function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^[~.]?\//.test(trimmed) || /\.(pub|pem|key|txt)$/i.test(trimmed) || fs.existsSync(trimmed)
  );
}

export function registerKeysCommand(program: Command): void {
  const keysCmd = program.command('keys').description('Manage trusted signing keys');

  keysCmd
    .command('generate')
    .description('Generate a new Ed25519 signing key pair')
    .option('--name <name>', 'Key pair name', 'default')
    .option('--force', 'Overwrite existing key files')
    .action((options: { name: string; force?: boolean }) => {
      const dossierDir = path.join(os.homedir(), '.dossier');
      const privatePath = path.join(dossierDir, `${options.name}.pem`);
      const publicPath = path.join(dossierDir, `${options.name}.pub`);

      console.log('\n🔑 Generating Ed25519 Key Pair\n');

      if (!options.force) {
        if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) {
          console.error(
            `❌ Key files already exist for "${options.name}". Use --force to overwrite.`
          );
          process.exit(1);
        }
      }

      if (!fs.existsSync(dossierDir)) {
        fs.mkdirSync(dossierDir, { recursive: true });
      }

      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');

      const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
      const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

      fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
      fs.writeFileSync(publicPath, publicPem, { mode: 0o644 });

      // The canonical shareable form is the raw 32-byte key in base64 — the same
      // form the signer emits and the trust list stores.
      const publicKeyBase64 = normalizePublicKey(publicPem);

      console.log(`✅ Key pair generated successfully`);
      console.log(`   Name:        ${options.name}`);
      console.log(`   Private key: ${privatePath}`);
      console.log(`   Public key:  ${publicPath}`);
      console.log(`   Public key (base64): ${publicKeyBase64}`);
      console.log('\nTo sign a dossier:');
      console.log(`   ai-dossier sign <file> --method ed25519 --key ${privatePath}`);
      console.log('\nTo add this public key as trusted:');
      console.log(`   ai-dossier keys add ${publicKeyBase64} "${options.name}"\n`);

      process.exit(0);
    });

  keysCmd
    .command('list')
    .description('List trusted and generated signing keys')
    .option('--json', 'JSON output')
    .action((options: { json?: boolean }) => {
      const dossierDir = path.join(os.homedir(), '.dossier');
      const trustedKeysPath = path.join(dossierDir, 'trusted-keys.txt');

      // Discover generated key pairs in ~/.dossier/
      const generatedKeys: { name: string; privatePath: string; publicPath: string }[] = [];
      if (fs.existsSync(dossierDir)) {
        const files = fs.readdirSync(dossierDir);
        const pemFiles = files.filter((f) => f.endsWith('.pem'));
        for (const pem of pemFiles) {
          const name = pem.replace('.pem', '');
          const pubFile = `${name}.pub`;
          generatedKeys.push({
            name,
            privatePath: path.join(dossierDir, pem),
            publicPath: files.includes(pubFile) ? path.join(dossierDir, pubFile) : '',
          });
        }
      }

      // Parse through core so this listing reflects exactly what verification
      // trusts — including legacy multi-line PEM entries, which a line-oriented
      // read here would report as several bogus keys.
      let trustedEntries: TrustedKeyEntry[] = [];
      // Lines the parser had to skip. `keys list` is where someone lands when a
      // key "isn't trusted", so this is the one place that must show them.
      let trustedProblems: TrustedKeyProblem[] = [];
      if (fs.existsSync(trustedKeysPath)) {
        const parsed = parseTrustedKeys(fs.readFileSync(trustedKeysPath, 'utf8'));
        trustedEntries = parsed.entries;
        trustedProblems = parsed.problems;
      }

      if (options.json) {
        const trusted = trustedEntries.map((entry) => ({
          type: 'trusted',
          // As written in the file, plus the canonical form actually compared
          // against a signature — a legacy entry differs between the two.
          public_key: entry.publicKey,
          normalized_public_key: normalizePublicKey(entry.publicKey),
          identifier: entry.keyId,
        }));
        const generated = generatedKeys.map((k) => ({
          type: 'generated',
          name: k.name,
          private_key: k.privatePath,
          public_key: k.publicPath,
        }));
        console.log(JSON.stringify({ trusted, generated, problems: trustedProblems }, null, 2));
        process.exit(0);
      }

      // Display generated keys
      if (generatedKeys.length > 0) {
        console.log('\n🔑 Generated Key Pairs\n');
        console.log(`Total: ${generatedKeys.length} key pair(s)\n`);
        generatedKeys.forEach((k, index) => {
          console.log(`${index + 1}. ${k.name}`);
          console.log(`   Private: ${k.privatePath}`);
          if (k.publicPath) {
            console.log(`   Public:  ${k.publicPath}`);
          }
          console.log();
        });
      }

      // Display trusted keys
      console.log('🔑 Trusted Signing Keys\n');

      // Before the listing: an unterminated PEM block can swallow the rest of the
      // file, so "no trusted keys" may itself be the symptom being explained.
      reportTrustedKeyProblems(trustedProblems, trustedKeysPath);

      if (trustedEntries.length === 0) {
        if (!fs.existsSync(trustedKeysPath)) {
          console.log('⚠️  No trusted keys file found');
          console.log(`   Location: ${trustedKeysPath}`);
        } else {
          console.log('⚠️  No trusted keys configured');
          console.log(`   File exists at: ${trustedKeysPath}`);
        }
        console.log('\nTo add a trusted key:');
        console.log('   ai-dossier keys add <public-key> <identifier>\n');

        if (generatedKeys.length === 0) {
          console.log('To generate a new key pair:');
          console.log('   ai-dossier keys generate\n');
        }

        process.exit(0);
      }

      console.log(`Total: ${trustedEntries.length} trusted key(s)\n`);
      trustedEntries.forEach((entry, index) => {
        // Show the canonical form: a legacy PEM entry is multi-line and would
        // otherwise wreck the listing.
        const key = normalizePublicKey(entry.publicKey);
        const shortKey = key.length > 60 ? `${key.substring(0, 60)}...` : key;
        console.log(`${index + 1}. ${entry.keyId}`);
        console.log(`   ${shortKey}`);
        console.log();
      });
      console.log(`Location: ${trustedKeysPath}\n`);

      process.exit(0);
    });

  keysCmd
    .command('add')
    .description('Add a trusted signing key')
    .argument('<public-key>', 'Public key: raw base64, SPKI PEM (see below), or minisign')
    .argument('<identifier>', 'Human-readable identifier (e.g., "dossier-team-2025")')
    // A PEM begins with "-", so commander reads it as an unknown option and the
    // action never runs. The remediation `ai-dossier verify` prints uses raw base64
    // and avoids this, but anyone pasting a PEM or a .pub file hits it — so the
    // escape hatch has to be visible from `--help` and from any parse error.
    .addHelpText(
      'after',
      '\nAccepted key formats:\n' +
        '  raw Ed25519 public key   44-char base64, e.g. "5kr+/8mNiy...o1M="  (canonical)\n' +
        '  SPKI PEM block           "-----BEGIN PUBLIC KEY-----..."\n' +
        '  minisign public key      "RWT..."  (legacy)\n' +
        '\nWhatever you pass is normalized to the raw base64 form before it is stored,\n' +
        'so all three end up as the same entry in ~/.dossier/trusted-keys.txt.\n' +
        '\nExamples:\n' +
        '  ai-dossier keys add 5kr+/8mNiy...o1M= "dossier-team-2025"\n' +
        '  ai-dossier keys add -- "$(cat ~/.dossier/default.pub)" "my-key"\n' +
        '\nA PEM starts with "-", which is read as an option — put "--" before it,\n' +
        'as in the second example. `ai-dossier verify <dossier>` prints a ready-to-run\n' +
        'command with the key already in base64 form.\n'
    )
    .showHelpAfterError(
      'Note: a PEM starts with "-" and is read as an option — use: ai-dossier keys add -- "<pem>" "<id>"'
    )
    .action((publicKey: string, identifier: string) => {
      const dossierDir = path.join(os.homedir(), '.dossier');
      const trustedKeysPath = path.join(dossierDir, 'trusted-keys.txt');

      console.log('\n🔑 Adding Trusted Key\n');

      // Store the canonical raw-key base64. A PEM argument — what `verify` used to
      // suggest, and what a `.pub` file contains — would otherwise be appended
      // verbatim and shredded by the line-oriented trusted-keys parser.
      const canonicalKey = normalizePublicKey(publicKey);

      // Validate positively rather than just rejecting whitespace. normalizePublicKey
      // hands back anything it cannot interpret, so a typo, a truncated key, or a
      // path to a .pub file would otherwise be written as a "trusted key" under a
      // ✅ and only surface much later as `ai-dossier verify` saying "not trusted".
      // KMS-signed dossiers are verified against the key ARN, not the public key,
      // so the ARN is the only thing that can make one trusted.
      if (!isSupportedPublicKey(canonicalKey) && !isKmsKeyIdentifier(canonicalKey)) {
        console.error('❌ Unrecognized public key format — nothing was added');
        console.error(`   Got: ${summarizeKeyArgument(publicKey)}`);
        console.error('\n   Expected one of:');
        console.error('     • raw Ed25519 public key — 44-char base64, e.g. "5kr+/8mNiy...o1M="');
        console.error('     • SPKI PEM block — "-----BEGIN PUBLIC KEY-----..."');
        console.error('     • minisign public key — "RWT..."');
        console.error('     • AWS KMS key ARN — "arn:aws:kms:<region>:<account>:key/..."');

        if (looksLikeFilePath(publicKey)) {
          console.error('\n   That looks like a file path. Pass the key itself, not its path:');
          console.error(`     ai-dossier keys add -- "$(cat ${publicKey})" "${identifier}"`);
          console.error('   (the leading "--" is required: a PEM starts with "-", which the');
          console.error('    option parser would otherwise read as a flag)');
        }

        console.error('\n   To print a key you can paste:  ai-dossier keys generate');
        console.error("   To get a signer's key:         ai-dossier verify <dossier>");
        console.error('   (verify prints a ready-to-run `ai-dossier keys add` command)\n');
        process.exit(1);
      }

      // The identifier is written verbatim into a line-oriented trust file, so a
      // newline in it appends a whole extra entry — a second, unrelated key the
      // user never approved, trusted from then on. Reject rather than escape:
      // there is no legitimate multi-line identifier.
      if (/[\n\r]/.test(identifier)) {
        console.error('❌ Identifier cannot span multiple lines — nothing was added');
        console.error('   One trusted key per line, as "<public-key> <identifier>".\n');
        process.exit(1);
      }

      if (!fs.existsSync(dossierDir)) {
        fs.mkdirSync(dossierDir, { recursive: true });
        console.log(`✅ Created directory: ${dossierDir}`);
      }

      if (fs.existsSync(trustedKeysPath)) {
        const content = fs.readFileSync(trustedKeysPath, 'utf8');
        if (trustedKeysFromContent(content).has(canonicalKey)) {
          console.log('⚠️  This key already exists in trusted keys');
          console.log(`   Location: ${trustedKeysPath}\n`);
          process.exit(0);
        }
      }

      const entry = `${canonicalKey} ${identifier}\n`;
      fs.appendFileSync(trustedKeysPath, entry, 'utf8');

      console.log('✅ Key added successfully');
      console.log(`   Identifier: ${identifier}`);
      console.log(
        `   Public Key: ${canonicalKey.substring(0, 60)}${canonicalKey.length > 60 ? '...' : ''}`
      );
      console.log(`   Location: ${trustedKeysPath}`);
      console.log('\nYou can now verify dossiers signed with this key.\n');

      process.exit(0);
    });
}
