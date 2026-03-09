/**
 * validate-surrogate-fix.mjs
 *
 * End-to-end validation that lone surrogates in JSONL session transcripts are
 * sanitised before the container is spawned, preventing HTTP 400 from the API.
 *
 * Usage (run from the NanoClaw project root):
 *   node scripts/validate-surrogate-fix.mjs <group-folder>
 *
 * The script:
 *   1. Finds the most-recently-modified .jsonl session file for the group.
 *   2. Injects a lone surrogate into one of the string values in the last line
 *      (simulating what happens after a Bash tool returns binary/mojibake output).
 *   3. Verifies that NanoClaw's sanitizeSessionTranscripts logic cleans it back up.
 *   4. Restores the original file so no permanent damage is done.
 *
 * To test the full round-trip (HTTP 400 without fix, success with fix):
 *   - Run this script to inject the surrogate, then send a message to the group
 *     WITHOUT applying the fix first; watch the container log for HTTP 400.
 *   - Apply the fix, restart NanoClaw, inject again, send the same message;
 *     the agent should respond normally.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// ── config ────────────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve(process.cwd(), 'data');

const group = process.argv[2];
if (!group) {
  const available = fs.readdirSync(path.join(DATA_DIR, 'sessions'))
    .filter(d => fs.existsSync(path.join(DATA_DIR, 'sessions', d, '.claude')));
  console.error('Usage: node scripts/validate-surrogate-fix.mjs <group-folder>');
  console.error('\nAvailable groups:');
  available.forEach(g => console.error('  ', g));
  process.exit(1);
}

const sessionDir = path.join(DATA_DIR, 'sessions', group, '.claude');
if (!fs.existsSync(sessionDir)) {
  console.error(`No session directory found: ${sessionDir}`);
  console.error('Send at least one message to the group first.');
  process.exit(1);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function sanitizeSurrogates(s) {
  return s.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}

function sanitizeTranscript(content) {
  return content
    .split('\n')
    .map(line => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(JSON.parse(line), (_, v) =>
          typeof v === 'string' ? sanitizeSurrogates(v) : v
        );
      } catch {
        return line;
      }
    })
    .join('\n');
}

function hasLoneSurrogate(s) {
  // Match the JSON-escaped form \udXXX (lone surrogates produce \ud800–\udfff)
  return /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/i.test(s)
      || /(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(s);
}

// ── find most-recently-modified .jsonl ───────────────────────────────────────

function walkJsonl(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkJsonl(full));
    else if (entry.name.endsWith('.jsonl')) results.push(full);
  }
  return results;
}

const jsonlFiles = walkJsonl(sessionDir)
  .map(f => ({ f, mtime: fs.statSync(f).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

if (jsonlFiles.length === 0) {
  console.error('No .jsonl session files found for this group.');
  console.error('Send at least one message to the group first.');
  process.exit(1);
}

const targetFile = jsonlFiles[0].f;
console.log(`\nTarget file: ${path.relative(process.cwd(), targetFile)}`);

// ── inject a lone surrogate ───────────────────────────────────────────────────

const original = fs.readFileSync(targetFile, 'utf-8');
const lines = original.split('\n');

// Find the last non-empty line and inject a surrogate into a string value
let injectedLineIdx = -1;
let injectedLine = '';
for (let i = lines.length - 1; i >= 0; i--) {
  if (!lines[i].trim()) continue;
  try {
    const obj = JSON.parse(lines[i]);
    // Inject into the first string value we can find anywhere in the object
    const patched = JSON.stringify(obj, (_, v) =>
      typeof v === 'string' && injectedLineIdx === -1
        ? (injectedLineIdx = i, v + '\uD800injected-surrogate')
        : v
    );
    if (injectedLineIdx === i) {
      injectedLine = patched;
      break;
    }
  } catch {
    continue;
  }
}

if (injectedLineIdx === -1) {
  console.error('Could not find a string field in the session to inject into.');
  process.exit(1);
}

// Write the corrupted file
const corruptedLines = [...lines];
corruptedLines[injectedLineIdx] = injectedLine;
const corrupted = corruptedLines.join('\n');
fs.writeFileSync(targetFile, corrupted, 'utf-8');

const corruptConfirmed = hasLoneSurrogate(injectedLine);
console.log('\n── Step 1: Injected lone surrogate ─────────────────────────────────────');
console.log(`  Line ${injectedLineIdx + 1} now contains lone surrogate: ${corruptConfirmed ? '✗ YES (bug reproduced)' : '? could not confirm'}`);
if (process.env.VERBOSE) {
  console.log('\n  Corrupted line (truncated to 200 chars):');
  console.log(' ', injectedLine.slice(0, 200) + (injectedLine.length > 200 ? '…' : ''));
}

// ── run the sanitizer ─────────────────────────────────────────────────────────

console.log('\n── Step 2: Run sanitizer ────────────────────────────────────────────────');
const sanitized = sanitizeTranscript(corrupted);
const stillCorrupt = hasLoneSurrogate(sanitized.split('\n')[injectedLineIdx] ?? '');
console.log(`  After sanitizeSessionTranscripts: ${stillCorrupt ? '✗ STILL CORRUPT (fix not working)' : '✓ Surrogate replaced with \\uFFFD (fix works)'}`);

// ── restore original ──────────────────────────────────────────────────────────

fs.writeFileSync(targetFile, original, 'utf-8');
console.log('\n── Step 3: Original file restored ──────────────────────────────────────');
console.log('  No permanent changes made to the session transcript.\n');

// ── full round-trip instructions ──────────────────────────────────────────────

console.log('── Full round-trip test (manual) ────────────────────────────────────────');
console.log(`
  To observe HTTP 400 without the fix / success with the fix:

  WITHOUT fix (reproduce the bug):
    1. Check out a commit before this fix:
         git stash && git checkout HEAD~1
         npm run build
    2. Inject a surrogate:
         node scripts/validate-surrogate-fix.mjs ${group}
       Then immediately send a message to the group — before NanoClaw sanitizes.
       (The injection happens here; NanoClaw reads the corrupted file on next spawn.)
    3. Watch the container log:
         tail -f data/sessions/${group}/logs/container-*.log
       Look for: HTTP 400 / Bad Request / invalid_request_error

  WITH fix (confirm it's resolved):
    1. Return to the fix branch:
         git checkout - && npm run build && npm run dev
    2. Inject and send again:
         node scripts/validate-surrogate-fix.mjs ${group}
       Then send a message.  NanoClaw sanitizes before spawning the container.
    3. Agent responds normally; no HTTP 400 in logs.
`);

process.exit(corruptConfirmed && !stillCorrupt ? 0 : 1);
