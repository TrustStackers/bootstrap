#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * init-bootstrap-env — initialize this bootstrap server's own relay identity
 * + address.
 *
 * Run from the bootstrap repo root: `npm run init-bootstrap` (alias:
 * `npm run init:bootstrap`).
 *
 * ## What it does
 *
 * A developer supplies a **24-word BIP-39 word sequence** (or asks the tool to
 * generate one). The tool:
 *
 *   1. derives the 32-byte Ed25519 seed from the words (checksum-validated),
 *   2. derives the libp2p **peer ID** from that seed,
 *   3. writes this repo's gitignored **`.env`** with the seed, peer ID, host
 *      (DNS name or fixed public IP) and ports.
 *
 * The `.env` is the single source of truth this server reads through
 * `@p2p-trust-stack/core/config/bootstrap-env.js` — there are no hardcoded
 * addresses and no OS environment-variable overrides.
 *
 * ## Examples
 *
 *   # Generate a fresh word sequence, print it once, write ./.env
 *   npm run init-bootstrap -- --generate --host mediator.example.com
 *
 *   # Use an existing phrase kept in a file (never lands in shell history)
 *   npm run init-bootstrap -- --words-file ./bootstrap-phrase.txt --host 203.0.113.5
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { keys } from '@libp2p/crypto';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

import { mnemonicToSeed, exportSeedPhrase } from '@p2p-trust-stack/core/crypto/seed-phrase.js';
import { buildBootstrapUrls, type BootstrapEnv } from '@p2p-trust-stack/core/config/bootstrap-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** This repo's root — the script lives in `<root>/scripts/`. */
const REPO_ROOT = resolve(__dirname, '..');
/** The single `.env` this repo reads (bootstrap/relay block). */
const ENV_PATH = resolve(REPO_ROOT, '.env');
/** The only component this repo configures (kept for `--component` back-compat). */
const COMPONENT = 'bootstrap';

interface Args {
  words?: string;
  wordsFile?: string;
  generate: boolean;
  host?: string;
  tcpPort: number;
  wsPort: number;
  enableRelay: boolean;
  out?: string;
  component: string;
  all: boolean;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    generate: false,
    tcpPort: 4001,
    wsPort: 4002,
    enableRelay: true,
    component: COMPONENT,
    all: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--words' && argv[i + 1] !== undefined) args.words = next();
    else if (a === '--words-file' && argv[i + 1] !== undefined) args.wordsFile = next();
    else if (a === '--generate') args.generate = true;
    else if (a === '--host' && argv[i + 1] !== undefined) args.host = next();
    else if (a === '--tcp-port' && argv[i + 1] !== undefined) args.tcpPort = parseInt(next(), 10);
    else if (a === '--ws-port' && argv[i + 1] !== undefined) args.wsPort = parseInt(next(), 10);
    else if (a === '--no-relay') args.enableRelay = false;
    else if (a === '--out' && argv[i + 1] !== undefined) args.out = next();
    else if (a === '--component' && argv[i + 1] !== undefined) args.component = next();
    else if (a === '--all') args.all = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp(): void {
  console.log(`
init-bootstrap-env — set this bootstrap server's relay identity + address.

Usage:
  npm run init-bootstrap -- [options]        (alias: npm run init:bootstrap)

Identity (pick ONE):
  --generate                Generate a fresh 24-word sequence (printed once).
  --words "<24 words>"      Use this BIP-39 word sequence.
  --words-file <path>       Read the word sequence from a file (avoids shell history).

Address:
  --host <dns-or-ip>        DNS name OR fixed public IP (required).
  --tcp-port <n>            TCP port (default 4001).
  --ws-port <n>             WebSocket port (default 4002).
  --no-relay                Disable the circuit-relay service on the server.

Output:
  --out <path>              Write to this file (default ./.env).
  --dry-run                 Print what would be written; touch nothing.
  --help                    Show this help.

Writes this repo's gitignored ./.env, read back through
@p2p-trust-stack/core/config/bootstrap-env.js — no hardcoded address, no OS env override.

(--component bootstrap and --all are still accepted for backwards
compatibility; this repo has a single component.)
`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Update `KEY=value` lines in existing `.env` text, preserving everything else. */
function upsertEnvKeys(existing: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const outLines: string[] = [];
  for (const line of existing.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
    if (m && remaining.has(m[1])) {
      outLines.push(`${m[1]}=${remaining.get(m[1])}`);
      remaining.delete(m[1]);
    } else {
      outLines.push(line);
    }
  }
  if (remaining.size > 0) {
    // Drop trailing blank lines, then append the new keys under a heading.
    while (outLines.length > 0 && outLines[outLines.length - 1].trim() === '') outLines.pop();
    if (outLines.length > 0) outLines.push('');
    outLines.push('# ── Bootstrap / relay server (written by `npm run init-bootstrap`) ──');
    for (const [k, v] of remaining) outLines.push(`${k}=${v}`);
  }
  return outLines.join('\n').replace(/\n*$/, '\n');
}

/**
 * True when `git` reports the path as ignored (so it can never be committed).
 *
 * This standalone repo may not be `git init`-ed yet, in which case
 * `git check-ignore` exits 128 ("not a git repository"). Fall back to reading
 * the committed `.gitignore` so the seed still cannot be written to a path that
 * would end up tracked.
 */
function isGitIgnored(filePath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', filePath], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 128) return isIgnoredByDotGitignore(filePath);
    return false; // status 1 => git is present and the path is NOT ignored
  }
}

/** Minimal `.gitignore` matcher, used only when the repo has no `.git` yet. */
function isIgnoredByDotGitignore(filePath: string): boolean {
  const ignoreFile = resolve(REPO_ROOT, '.gitignore');
  if (!existsSync(ignoreFile)) return false;
  const rel = relative(REPO_ROOT, filePath);
  const name = basename(rel);
  return readFileSync(ignoreFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('!'))
    .map((p) => p.replace(/^\//, '').replace(/\/$/, ''))
    .some((p) => p === rel || p === name || p === `**/${name}` || p === `*/${name}`);
}

/** Resolve the word sequence from the chosen input, or generate a fresh one. */
async function resolveSeed(args: Args): Promise<{ seed: Uint8Array; generatedMnemonic?: string }> {
  if (args.generate) {
    const seed = randomBytes(32);
    const priv = await keys.generateKeyPairFromSeed('Ed25519', seed);
    const { mnemonic } = exportSeedPhrase({ secretKey: seed, publicKey: priv.publicKey.raw });
    return { seed: new Uint8Array(seed), generatedMnemonic: mnemonic };
  }
  let words: string | undefined;
  if (args.words) words = args.words;
  else if (args.wordsFile) words = readFileSync(args.wordsFile, 'utf8').trim();
  if (!words) {
    throw new Error(
      'No word sequence supplied. Pass --words, --words-file, or --generate (see --help).',
    );
  }
  return { seed: mnemonicToSeed(words) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.component !== COMPONENT) {
    console.error(
      `init-bootstrap-env: --component '${args.component}' is not valid in this repo.\n` +
      `  This tool only configures the '${COMPONENT}' component (its own ./.env) — drop --component.`,
    );
    process.exit(1);
  }
  if (!args.host) {
    console.error('init-bootstrap-env: --host <dns-or-ip> is required.\n');
    printHelp();
    process.exit(1);
  }

  const { seed, generatedMnemonic } = await resolveSeed(args);
  const seedHex = Buffer.from(seed).toString('hex');
  const priv = await keys.generateKeyPairFromSeed('Ed25519', seed);
  const peerId = (await peerIdFromPrivateKey(priv)).toString();

  const env: BootstrapEnv = {
    version: 1,
    seedHex,
    peerId,
    host: args.host,
    tcpPort: args.tcpPort,
    wsPort: args.wsPort,
    enableRelay: args.enableRelay,
  };
  const urls = buildBootstrapUrls(env);

  const updates: Record<string, string> = {
    BOOTSTRAP_SEED_HEX: seedHex,
    BOOTSTRAP_PEER_ID: peerId,
    BOOTSTRAP_HOST: args.host,
    BOOTSTRAP_TCP_PORT: String(args.tcpPort),
    BOOTSTRAP_WS_PORT: String(args.wsPort),
    BOOTSTRAP_ENABLE_RELAY: args.enableRelay ? 'true' : 'false',
  };

  const target = args.out ? resolve(args.out) : ENV_PATH;

  console.log('');
  console.log('Bootstrap / relay identity');
  console.log('──────────────────────────');
  console.log(`  Peer ID   : ${peerId}`);
  console.log(`  Host      : ${args.host}   (${args.tcpPort} tcp / ${args.wsPort} ws)`);
  console.log(`  TCP addr  : ${urls.tcpUrl}`);
  console.log(`  WS addr   : ${urls.wsUrl}`);
  console.log(`  Relay     : ${urls.relayAddr}`);
  if (generatedMnemonic) {
    console.log('');
    console.log('  ⚠  NEW word sequence — write this down and store it securely.');
    console.log('     It is the ONLY way to reproduce this peer ID:');
    console.log('');
    console.log(`     ${generatedMnemonic}`);
  }
  console.log('');

  const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const next = upsertEnvKeys(existing, updates);
  if (args.dryRun) {
    console.log(`[dry-run] would write ${target}:`);
    console.log(next.split('\n').map((l) => `    ${l}`).join('\n'));
    return;
  }
  if (!isGitIgnored(target)) {
    console.error(
      `init-bootstrap-env: refusing to write ${target} — it is NOT gitignored. ` +
      'Add `.env` to .gitignore first so the seed can never be committed.',
    );
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, next, { mode: 0o600 });
  console.log(`  ✓ wrote ${target}  (chmod 600)`);
  console.log('');
}

main().catch((err) => {
  console.error('init-bootstrap-env:', err instanceof Error ? err.message : err);
  process.exit(1);
});
