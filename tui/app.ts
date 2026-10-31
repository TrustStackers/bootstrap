#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Bootstrap Server TUI — Entry Point.
 *
 * Parses CLI arguments, creates the blessed screen, boots the bootstrap server
 * (libp2p node + relay), then hands off to the dashboard.
 *
 * Usage:
 *   npm run init:bootstrap -- --host <dns-or-ip>   # once: write the .env
 *   npm start                                      # run the server
 *   npm start -- --env ./other.env --no-relay
 *
 * ## Configuration resolution
 *
 * The server's IDENTITY (the seed the peer ID is derived from) and ADDRESS
 * (host, ports, relay) come from a gitignored `.env` file, loaded through
 * `@p2p-trust-stack/core/config/bootstrap-env`. That file is created by `npm run init:bootstrap`
 * from a developer-supplied 24-word BIP-39 word sequence.
 *
 * There are deliberately NO hardcoded addresses and NO OS environment-variable
 * overrides: a missing or malformed `.env` prints an actionable message and
 * exits(1). Only operational knobs (bind host, DB path, relay grant) remain as
 * CLI flags.
 */

import blessed from 'blessed';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BootstrapAPI } from '../api/bootstrap-api.js';
import { PeerDb } from '../db/peer-db.js';
import { BootstrapServer } from '../server/bootstrap-server.js';
import { showDashboard } from './dashboard.js';
import {
  loadBootstrapEnv,
  verifyBootstrapEnv,
  BOOTSTRAP_ENV_FILENAME,
} from '@p2p-trust-stack/core/config/bootstrap-env.js';
import { applyLoggingEnv } from '@p2p-trust-stack/core/config/logging-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolved server configuration.
 *
 * The IDENTITY (seedHex → peer ID) and ADDRESS (host, ports, relay) come from
 * the component's `.env` file via `@p2p-trust-stack/core/config/bootstrap-env` — there is no
 * hardcoded address and no OS environment-variable override. Only operational
 * knobs (bind host, DB path, relay grant) remain as CLI flags.
 */
interface ServerConfig {
  /** Bind address (default 0.0.0.0). */
  host: string;
  tcpPort: number;
  wsPort: number;
  /** Advertised DNS hostname or fixed public IP (from `.env`). */
  dnsHostname: string;
  dbPath: string;
  enableDht: boolean;
  enableRelay: boolean;
  seedHex: string;
  /**
   * Circuit-relay grant policy: how long a single RELAYED connection may stay
   * open (ms), and how many bytes it may transfer. `0` means UNLIMITED.
   */
  relayMaxDurationMs: number;
  relayMaxDataBytes: number;
}

/** Operational CLI overrides (identity/address come from `.env`, not flags). */
interface CliArgs {
  envPath?: string;
  host?: string;
  dbPath?: string;
  enableDht?: boolean;
  noRelay?: boolean;
  relayMaxDurationMs?: number;
  relayMaxDataBytes?: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: CliArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[i + 1];
    if (arg === '--env' && next()) { opts.envPath = next(); i++; }
    else if (arg === '--host' && next()) { opts.host = next(); i++; }
    else if (arg === '--db' && next()) { opts.dbPath = next(); i++; }
    else if (arg === '--enable-dht') { opts.enableDht = true; }
    else if (arg === '--no-relay') { opts.noRelay = true; }
    else if (arg === '--relay-duration' && next()) { opts.relayMaxDurationMs = parseInt(next(), 10); i++; }
    else if (arg === '--relay-max-bytes' && next()) { opts.relayMaxDataBytes = parseInt(next(), 10); i++; }
  }
  return opts;
}

/**
 * Resolve the full server config: identity + address from the `.env`, with
 * operational CLI overrides on top. Throws (with an actionable message) when
 * the `.env` is missing or malformed — main() turns that into exit(1).
 */
async function resolveConfig(): Promise<ServerConfig> {
  const args = parseArgs();
  const envPath = args.envPath ?? join(__dirname, '..', BOOTSTRAP_ENV_FILENAME);
  const env = loadBootstrapEnv({ path: envPath });

  // Verbosity comes from the same `.env` as the identity and address — no
  // `P2PTS_LOG_LEVEL=info` prefix in the npm script, which Windows cannot parse.
  // Applied here (not in main()) so it takes effect before the first stack line.
  applyLoggingEnv({ path: envPath });

  // Fail loudly on a hand-edited/corrupt env: the peer ID clients dial must
  // match the seed this server derives its key from.
  await verifyBootstrapEnv(env);

  return {
    host: args.host ?? '0.0.0.0',
    tcpPort: env.tcpPort,
    wsPort: env.wsPort,
    dnsHostname: env.host,
    dbPath: args.dbPath ?? './data/bootstrapdb.db',
    enableDht: args.enableDht ?? false,
    enableRelay: args.noRelay ? false : env.enableRelay,
    seedHex: env.seedHex,
    relayMaxDurationMs: Number.isFinite(args.relayMaxDurationMs)
      ? (args.relayMaxDurationMs as number)
      : 60 * 60 * 1000,
    relayMaxDataBytes: Number.isFinite(args.relayMaxDataBytes)
      ? (args.relayMaxDataBytes as number)
      : 10 * 1024 * 1024,
  };
}





// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
Bootstrap Server — Peer discovery and relay node.

Usage:
  npm start [options]

The server's IDENTITY (peer ID) and ADDRESS (host, ports, relay) come from a
gitignored .env file, created with:
  npm run init:bootstrap -- --host <dns-or-ip> [--generate | --words-file <path>]

Options (operational overrides only — no address/identity flags):
  --env <path>          Path to the .env file (default: bootstrap/.env)
  --host <addr>         Bind address (default: 0.0.0.0)
  --db <path>           SQLite database path (default: ./data/bootstrapdb.db)
  --enable-dht          Enable Kademlia DHT for peer discovery
  --no-relay            Disable circuit relay (overrides the .env)
  --relay-duration <ms> Max duration of ONE relayed connection. 0 = unlimited.
                        (default: 3600000 = 1 hour)
  --relay-max-bytes <n> Max bytes ONE relayed connection may transfer.
                        0 = unlimited. (default: 10485760 = 10 MB)
  --help                Show this help

The address and ports are NOT flags — set them in the .env
(BOOTSTRAP_HOST / BOOTSTRAP_TCP_PORT / BOOTSTRAP_WS_PORT).
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Help is always honored.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Identity + address come from the .env; operational overrides from CLI flags.
  let config: ServerConfig;
  try {
    config = await resolveConfig();
  } catch (err) {
    console.error(`Bootstrap Server: ${err instanceof Error ? err.message : err}`);
    console.error('');
    console.error('Create the config first:');
    console.error('  npm run init:bootstrap -- --host <dns-or-ip> --generate');
    process.exit(1);
  }

  // Create the blessed screen
  const screen = blessed.screen({
    smartCSR: false,
    title: 'Bootstrap Server',
    fullUnicode: true,
    dockBorders: true,
  });

  // Global Ctrl-C fallback
  screen.key(['C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  try {
    // Show starting message
    const startingBox = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 55,
      height: 5,
      border: { type: 'line' },
      content: `\n  Starting Bootstrap Server...\n  ${config.dnsHostname}\n  TCP:${config.tcpPort} WS:${config.wsPort}\n`,
      style: { border: { fg: 'cyan' }, fg: 'white' },
    });
    screen.render();

    // Create database and API layer
    const peerDb = new PeerDb(config.dbPath);
    const api = new BootstrapAPI(peerDb);

    // Start the bootstrap server
    const server = new BootstrapServer(api, peerDb, {
      host: config.host,
      tcpPort: config.tcpPort,
      wsPort: config.wsPort,
      dnsHostname: config.dnsHostname || undefined,
      enableDht: config.enableDht,
      enableRelay: config.enableRelay,
      seedHex: config.seedHex || undefined,
      // Relay-session grant policy. Explicit here so the effective limit is
      // visible at the call site and settable via CLI.
      relayMaxDuration: config.relayMaxDurationMs,
      relayMaxData: BigInt(config.relayMaxDataBytes),
    });

    await server.start();

    // Remove starting message and show dashboard
    startingBox.destroy();

    // Force full terminal repaint (same pattern as TUI app)
    (screen as unknown as { realloc(): void }).realloc();
    screen.render();

    // Show the dashboard (runs until [q] or Ctrl-C)
    await showDashboard(screen, api);

  } catch (err) {
    screen.destroy();
    console.error('Bootstrap Server error:', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});