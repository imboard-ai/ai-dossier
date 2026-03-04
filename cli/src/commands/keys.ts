import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';

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

      // Extract raw public key bytes for base64 sharing
      const publicDer = publicKey.export({ type: 'spki', format: 'der' });
      // Ed25519 SPKI DER has 12-byte header, raw key is last 32 bytes
      const rawPublicKey = publicDer.subarray(publicDer.length - 32);
      const publicKeyBase64 = rawPublicKey.toString('base64');

      console.log(`✅ Key pair generated successfully`);
      console.log(`   Name:        ${options.name}`);
      console.log(`   Private key: ${privatePath}`);
      console.log(`   Public key:  ${publicPath}`);
      console.log(`   Public key (base64): ${publicKeyBase64}`);
      console.log('\nTo sign a dossier:');
      console.log(`   dossier sign <file> --method ed25519 --key ${privatePath}`);
      console.log('\nTo add this public key as trusted:');
      console.log(`   dossier keys add ${publicKeyBase64} "${options.name}"\n`);

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

      // Load trusted keys
      let trustedLines: string[] = [];
      if (fs.existsSync(trustedKeysPath)) {
        const content = fs.readFileSync(trustedKeysPath, 'utf8');
        trustedLines = content.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
      }

      if (options.json) {
        const trusted = trustedLines.map((line) => {
          const [key, ...idParts] = line.trim().split(/\s+/);
          return { type: 'trusted', public_key: key, identifier: idParts.join(' ') };
        });
        const generated = generatedKeys.map((k) => ({
          type: 'generated',
          name: k.name,
          private_key: k.privatePath,
          public_key: k.publicPath,
        }));
        console.log(JSON.stringify({ trusted, generated }, null, 2));
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

      if (trustedLines.length === 0) {
        if (!fs.existsSync(trustedKeysPath)) {
          console.log('⚠️  No trusted keys file found');
          console.log(`   Location: ${trustedKeysPath}`);
        } else {
          console.log('⚠️  No trusted keys configured');
          console.log(`   File exists at: ${trustedKeysPath}`);
        }
        console.log('\nTo add a trusted key:');
        console.log('   dossier keys add <public-key> <identifier>\n');

        if (generatedKeys.length === 0) {
          console.log('To generate a new key pair:');
          console.log('   dossier keys generate\n');
        }

        process.exit(0);
      }

      console.log(`Total: ${trustedLines.length} trusted key(s)\n`);
      trustedLines.forEach((line, index) => {
        const [key, ...idParts] = line.trim().split(/\s+/);
        const identifier = idParts.join(' ');
        const shortKey = key.length > 60 ? key.substring(0, 60) + '...' : key;
        console.log(`${index + 1}. ${identifier}`);
        console.log(`   ${shortKey}`);
        console.log();
      });
      console.log(`Location: ${trustedKeysPath}\n`);

      process.exit(0);
    });

  keysCmd
    .command('add')
    .description('Add a trusted signing key')
    .argument('<public-key>', 'Public key (base64 or minisign format)')
    .argument('<identifier>', 'Human-readable identifier (e.g., "dossier-team-2025")')
    .action((publicKey: string, identifier: string) => {
      const dossierDir = path.join(os.homedir(), '.dossier');
      const trustedKeysPath = path.join(dossierDir, 'trusted-keys.txt');

      console.log('\n🔑 Adding Trusted Key\n');

      if (!fs.existsSync(dossierDir)) {
        fs.mkdirSync(dossierDir, { recursive: true });
        console.log(`✅ Created directory: ${dossierDir}`);
      }

      if (fs.existsSync(trustedKeysPath)) {
        const content = fs.readFileSync(trustedKeysPath, 'utf8');
        if (content.includes(publicKey)) {
          console.log('⚠️  This key already exists in trusted keys');
          console.log(`   Location: ${trustedKeysPath}\n`);
          process.exit(0);
        }
      }

      const entry = `${publicKey} ${identifier}\n`;
      fs.appendFileSync(trustedKeysPath, entry, 'utf8');

      console.log('✅ Key added successfully');
      console.log(`   Identifier: ${identifier}`);
      console.log(
        `   Public Key: ${publicKey.substring(0, 60)}${publicKey.length > 60 ? '...' : ''}`
      );
      console.log(`   Location: ${trustedKeysPath}`);
      console.log('\nYou can now verify dossiers signed with this key.\n');

      process.exit(0);
    });
}
