/**
 * Signal Authentication Script
 *
 * Links signal-cli as a secondary device to your Signal account.
 * Displays QR code, waits for scan, saves account number to .env.
 *
 * Usage: npx tsx src/signal-auth.ts
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import qrcode from 'qrcode-terminal';

const ENV_FILE = path.join(process.cwd(), '.env');

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function saveAccountToEnv(accountNumber: string): void {
  let content = '';
  try {
    content = fs.readFileSync(ENV_FILE, 'utf-8');
  } catch {
    // .env doesn't exist yet
  }

  // Replace or append SIGNAL_ACCOUNT
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.startsWith('SIGNAL_ACCOUNT='));
  const entry = `SIGNAL_ACCOUNT=${accountNumber}`;

  if (idx >= 0) {
    lines[idx] = entry;
  } else {
    // Add with a blank line separator if file has content
    if (content.trim()) lines.push('');
    lines.push(entry);
  }

  fs.writeFileSync(ENV_FILE, lines.join('\n'));
  console.log(`\n✓ Saved SIGNAL_ACCOUNT=${accountNumber} to .env`);
}

async function link(): Promise<void> {
  // Check signal-cli is installed
  try {
    execSync('which signal-cli', { stdio: 'ignore' });
  } catch {
    console.error(
      '✗ signal-cli not found. Install it with: brew install signal-cli',
    );
    process.exit(1);
  }

  console.log('Starting Signal linking...\n');
  console.log('  1. Open Signal on your phone');
  console.log('  2. Tap Settings → Linked Devices → Link New Device');
  console.log('  3. Scan the QR code below\n');

  const proc = spawn('signal-cli', ['link', '-n', 'NanoClaw'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let linkedAccount = '';

  proc.stdout.on('data', (data) => {
    const text = data.toString().trim();

    // signal-cli link outputs a tsdevice:// URI first (for QR), then the account number
    if (text.startsWith('tsdevice:')) {
      qrcode.generate(text, { small: true });
    } else if (text.startsWith('+')) {
      // Account number returned after successful linking
      linkedAccount = text;
    }
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) {
      // signal-cli logs to stderr; only show errors
      if (
        text.toLowerCase().includes('error') ||
        text.toLowerCase().includes('failed')
      ) {
        console.error(`signal-cli: ${text}`);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0 && linkedAccount) {
        console.log(`\n✓ Successfully linked to Signal as ${linkedAccount}`);
        saveAccountToEnv(linkedAccount);
        console.log('\nNext steps:');
        console.log(
          `  1. Start the daemon: signal-cli -a ${linkedAccount} daemon --socket /tmp/signal-cli.sock --receive-mode on-start`,
        );
        console.log('  2. Start NanoClaw: npm run dev');
        resolve();
      } else if (code === 0) {
        // No account number captured but exited clean — ask user
        askQuestion(
          'Enter your Signal phone number (with +country code, e.g. +14155551234): ',
        ).then((num) => {
          linkedAccount = num;
          saveAccountToEnv(linkedAccount);
          console.log('\nNext steps:');
          console.log(
            `  1. Receive initial messages: signal-cli -a ${linkedAccount} receive`,
          );
          console.log(
            `  2. Start the daemon: signal-cli -a ${linkedAccount} daemon --socket /tmp/signal-cli.sock --receive-mode on-start`,
          );
          console.log('  3. Start NanoClaw: npm run dev');
          resolve();
        });
      } else {
        reject(new Error(`signal-cli link exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

link().catch((err) => {
  console.error('Signal linking failed:', err.message);
  process.exit(1);
});
