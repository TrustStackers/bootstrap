#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Bootstrap Server Connectivity Tester
 *
 * A small test script that isolates connectivity issues when a client
 * cannot connect to the bootstrap server. It runs through a series of
 * diagnostic checks to pinpoint the failure.
 *
 * Usage:
 *   npm run test-bootstrap
 *   npm run test-bootstrap -- --host bootstrap.example.com --port 4001
 *   npm run test-bootstrap -- --local        # test localhost server
 */

import * as net from 'node:net';
import * as dns from 'node:dns';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { keys } from '@libp2p/crypto';
import { multiaddr } from '@multiformats/multiaddr';
import { loadBootstrapEnv } from '@p2p-trust-stack/core/config/bootstrap-env.js';

// ---------------------------------------------------------------------------
// CLI Args
// ---------------------------------------------------------------------------

interface TestOptions {
  host: string;
  tcpPort: number;
  wsPort: number;
  peerId: string;
  local: boolean;
}

function parseArgs(): TestOptions {
  const args = process.argv.slice(2);
  const opts: Partial<TestOptions> = { local: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[i + 1];
    if ((a === '--host' || a === '--dns') && next()) { opts.host = next(); i++; }
    else if ((a === '--port' || a === '--tcp-port') && next()) { opts.tcpPort = parseInt(next(), 10); i++; }
    else if ((a === '--ws-port') && next()) { opts.wsPort = parseInt(next(), 10); i++; }
    else if (a === '--peer-id' && next()) { opts.peerId = next(); i++; }
    else if (a === '--local') { opts.local = true; }
  }

  if (opts.local) {
    return {
      host: '127.0.0.1',
      tcpPort: 4001,
      wsPort: 4002,
      peerId: 'auto', // Will discover from the server
      local: true,
    };
  }

  // Defaults come from the component `.env` (create it with
  // `npm run init:bootstrap`). There is no hardcoded host or peer ID here.
  let env;
  try {
    env = loadBootstrapEnv();
  } catch {
    env = undefined;
  }

  const host = opts.host ?? env?.host;
  const peerId = opts.peerId ?? env?.peerId;
  if (!host || !peerId) {
    console.error(
      'test-bootstrap-connect: no host/peer ID. Pass --host and --peer-id, ' +
      'or create a .env with `npm run init:bootstrap -- --host <dns-or-ip>`.',
    );
    process.exit(1);
  }

  return {
    host,
    tcpPort: opts.tcpPort ?? env?.tcpPort ?? 4001,
    wsPort: opts.wsPort ?? env?.wsPort ?? 4002,
    peerId,
    local: false,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PASS = '\x1b[32m✓ PASS\x1b[0m';
const FAIL = '\x1b[31m✗ FAIL\x1b[0m';
const INFO = '\x1b[36m  info\x1b[0m';

function status(pass: boolean, label: string, detail?: unknown) {
  const tag = pass ? PASS : FAIL;
  const msg = detail ? ` — ${detail}` : '';
  console.error(`${tag} ${label}${msg}`);
  return pass;
}

function info(msg: string) {
  console.error(`${INFO} ${msg}`);
}

// ---------------------------------------------------------------------------
// Test 1: DNS Resolution
// ---------------------------------------------------------------------------

async function testDNS(host: string): Promise<string | null> {
  console.error('\n1. DNS Resolution');
  try {
    // Use dns.lookup (getaddrinfo) instead of dns.resolve4 (DNS query) because
    // resolve4 can fail with ECONNREFUSED on some Windows DNS configurations
    // while lookup still works (uses system resolver cache / getaddrinfo).
    const result = await new Promise<{ address: string }>((resolve, reject) => {
      dns.lookup(host, { all: false }, (err: Error | null, address: string) => {
        if (err) reject(err);
        else resolve({ address });
      });
    });
    status(true, 'DNS resolves', `${host} → ${result.address}`);
    return result.address;
  } catch (err) {
    status(false, 'DNS resolution', err instanceof Error ? err.message : 'unknown error');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test 2: Raw TCP Connection
// ---------------------------------------------------------------------------

async function testTCP(host: string, port: number, timeout: number = 5000): Promise<boolean> {
  console.error('\n2. Raw TCP Connection');
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }, () => {
      status(true, 'TCP connection', `${host}:${port}`);
      sock.destroy();
      resolve(true);
    });
    sock.on('error', (err: Error) => {
      status(false, 'TCP connection', `${host}:${port} — ${err.message}`);
      resolve(false);
    });
    sock.setTimeout(timeout, () => {
      status(false, 'TCP connection', `${host}:${port} — timeout (${timeout}ms)`);
      sock.destroy();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Test 3: WebSocket Connection
// ---------------------------------------------------------------------------

async function testWebSocket(host: string, port: number): Promise<boolean> {
  console.error('\n3. WebSocket Connection');
  try {
    const { default: WebSocket } = await import('ws');
    const url = `ws://${host}:${port}`;
    const ws = new WebSocket(url);

    return new Promise((resolve) => {
      ws.on('open', () => {
        status(true, 'WebSocket connection', url);
        ws.close();
        resolve(true);
      });
      ws.on('error', (err: Error) => {
        status(false, 'WebSocket connection', `${url} — ${err.message}`);
        resolve(false);
      });
      setTimeout(() => {
        status(false, 'WebSocket connection', `${url} — timeout`);
        ws.close();
        resolve(false);
      }, 5000);
    });
  } catch (_err) {
    status(false, 'WebSocket module', 'ws package not installed — skip WebSocket test');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test 4: libp2p Dial + Peer ID Verification
// ---------------------------------------------------------------------------

async function testLibp2pDial(host: string, tcpPort: number, _wsPort: number, expectedPeerId: string): Promise<{ success: boolean; actualPeerId?: string; error?: string }> {
  console.error('\n4. libp2p Dial (peer ID verification)');

  const privateKey = await keys.generateKeyPair('Ed25519');

  // Use /dns/ for hostnames, /ip4/ for IP addresses
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const proto = isIp ? 'ip4' : 'dns';
  const tcpMultiaddr = `/${proto}/${host}/tcp/${tcpPort}/p2p/${expectedPeerId}`;
  info(`Dialing ${tcpMultiaddr}`);

  const node = await createLibp2p({
    privateKey,
    addresses: { listen: [] },
    transports: [tcp(), webSockets()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    services: { identify: identify() },
  } as any);

  try {
    // Attempt to open a raw TCP connection (without protocol) to trigger identify
    const conn = await (node as any).dial(multiaddr(tcpMultiaddr));
    const actualPeerId = conn.remotePeer.toString();

    if (actualPeerId === expectedPeerId) {
      status(true, 'Peer ID matches', `Server identity verified: ${actualPeerId.slice(0, 16)}…`);
      await conn.close();
      await node.stop();
      return { success: true, actualPeerId };
    } else {
      status(false, 'Peer ID MISMATCH',
        `Expected: ${expectedPeerId}\n  Actual:   ${actualPeerId}`);
      info('This means the server was started with a DIFFERENT seed (or no seed).');
      info('Start the server with: npm run bootstrap -- --seed <hex_seed>');
      await conn.close();
      await node.stop();
      return { success: false, actualPeerId, error: 'peer_id_mismatch' };
    }
  } catch (err: any) {
    const msg = err.message || String(err);
    status(false, 'libp2p dial', msg);

    // Check if it's a peer ID verification failure
    if (msg.includes('peerId') || msg.includes('match') || msg.includes('verif') || msg.includes('peer')) {
      info('Connection rejected due to peer ID verification failure.');
      info('The server is using a different peer ID than the client expects.');
      await node.stop();
      return { success: false, error: 'peer_id_verification_failed' };
    }

    await node.stop();
    return { success: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Test 5: Full Bootstrap Protocol Exchange
// ---------------------------------------------------------------------------

async function testBootstrapProtocol(host: string, tcpPort: number, wsPort: number, expectedPeerId: string): Promise<boolean> {
  console.error('\n5. Bootstrap Protocol Exchange');

  const { BootstrapClient } = await import('@p2p-trust-stack/core/transport/bootstrap-client.js');

  // Use /dns/ for hostnames, /ip4/ for IP addresses
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const proto = isIp ? 'ip4' : 'dns';
  const tcpUrl = `/${proto}/${host}/tcp/${tcpPort}/p2p/${expectedPeerId}`;
  const wsUrl = `/${proto}/${host}/tcp/${wsPort}/ws/p2p/${expectedPeerId}`;


  const client = new BootstrapClient(tcpUrl, wsUrl);

  // Create a minimal libp2p node for the client
  const privateKey = await keys.generateKeyPair('Ed25519');
  const node = await createLibp2p({
    privateKey,
    addresses: { listen: [] },
    transports: [tcp(), webSockets()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    services: { identify: identify() },
  } as any);

  try {
    const result = await client.query(node);
    status(true, 'Bootstrap query', `Server peerId: ${result.response.serverPeerId.slice(0, 16)}…, peers: ${result.response.peers.length}`);
    await node.stop();
    return true;
  } catch (err: any) {
    status(false, 'Bootstrap protocol', err.message || String(err));
    await node.stop();
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discover actual peer ID from a locally running server
// ---------------------------------------------------------------------------

async function discoverLocalPeerId(host: string, port: number): Promise<string | null> {
  info('Attempting to discover actual server peer ID via identify...');

  const privateKey = await keys.generateKeyPair('Ed25519');
  const node = await createLibp2p({
    privateKey,
    addresses: { listen: [] },
    transports: [tcp()],
    streamMuxers: [yamux()],
    connectionEncrypters: [noise()],
    services: { identify: identify() },
  } as any);

  // Try connecting without a peer ID to trigger identify
  const openMultiaddr = `/ip4/${host}/tcp/${port}`;

  try {
    const conn = await (node as any).dial(multiaddr(openMultiaddr));
    const actualPeerId = conn.remotePeer.toString();
    await conn.close();
    await node.stop();
    return actualPeerId;
  } catch (err: any) {
    // Identify might fail if the server doesn't support it on open connections
    try {
      await node.stop();
    } catch {}
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  console.error('╔═══════════════════════════════════════════════════════════╗');
  console.error('║   Bootstrap Server Connectivity Tester                    ║');
  console.error('╚═══════════════════════════════════════════════════════════╝');
  console.error('');
  info(`Target host: ${opts.host}`);
  info(`TCP port: ${opts.tcpPort}  |  WS port: ${opts.wsPort}`);
  info(`Expected peer ID: ${opts.peerId}`);
  if (opts.local) info('Local mode — testing localhost server');

  const results: Record<string, boolean> = {};
  let actualPeerId: string | null = null;

  // Step 1: DNS (skip for localhost)
  let ip: string | null;
  if (opts.local) {
    info('DNS check skipped (localhost mode)');
    ip = null;
    results.dns = true;
  } else {
    ip = await testDNS(opts.host);
    results.dns = !!ip;
    if (!ip) {
      info('DNS failed — remaining tests may also fail.');
    }
  }

  // Step 2: TCP
  const tcpOk = await testTCP(opts.host, opts.tcpPort);
  results.tcp = tcpOk;

  // Step 3: WebSocket
  const wsOk = await testWebSocket(opts.host, opts.wsPort);
  results.ws = wsOk;

  // If in local mode and we don't know the peer ID, try to discover it
  let peerIdToUse = opts.peerId;
  if (opts.local && opts.peerId === 'auto') {
    actualPeerId = await discoverLocalPeerId(opts.host, opts.tcpPort);
    if (actualPeerId) {
      peerIdToUse = actualPeerId;
      info(`Discovered actual server peer ID: ${actualPeerId}`);
      info(`Updating multiaddrs to use: /ip4/${opts.host}/tcp/${opts.tcpPort}/p2p/${actualPeerId}`);
    } else {
      status(false, 'Peer ID discovery', 'Could not auto-detect — use --seed on server side');
      console.error('\n╔═══════════════════════════════════════════════════════════╗');
      console.error('║  Summary: Could not discover peer ID. Server likely needs ║');
      console.error('║  a fixed seed. Run the server with:                       ║');
      console.error('║    npm run bootstrap -- --seed <64_hex_chars>             ║');
      console.error('╚═══════════════════════════════════════════════════════════╝');
      return;
    }
  }

  // Step 4: libp2p dial with peer ID verification
  if (tcpOk) {
    const dialResult = await testLibp2pDial(opts.host, opts.tcpPort, opts.wsPort, peerIdToUse);
    results.libp2p = dialResult.success;
    if (dialResult.actualPeerId && dialResult.actualPeerId !== peerIdToUse) {
      actualPeerId = dialResult.actualPeerId;
    }
  } else {
    info('Skipping libp2p dial (TCP connection failed)');
    results.libp2p = false;
  }

  // Step 5: Full bootstrap protocol
  if (results.libp2p) {
    const protoOk = await testBootstrapProtocol(opts.host, opts.tcpPort, opts.wsPort, peerIdToUse);
    results.protocol = protoOk;
  } else {
    info('Skipping bootstrap protocol test (libp2p dial failed)');
    results.protocol = false;
  }

  // Summary
  console.error('\n╔═══════════════════════════════════════════════════════════╗');
  console.error('║  Summary                                                  ║');
  console.error('╚═══════════════════════════════════════════════════════════╝');

  const checks = [
    { name: 'DNS Resolution', pass: results.dns },
    { name: 'TCP Connection', pass: results.tcp },
    { name: 'WebSocket', pass: results.ws },
    { name: 'libp2p Dial', pass: results.libp2p },
    { name: 'Bootstrap Protocol', pass: results.protocol },
  ];

  for (const c of checks) {
    const tag = c.pass ? PASS : FAIL;
    console.error(`  ${tag} ${c.name}`);
  }

  const allPass = checks.every(c => c.pass);

  if (!allPass) {
    console.error('');

    // Provide targeted troubleshooting
    if (!results.dns) {
      console.error('  FIX: Check that the hostname is correct and DNS is working.');
      console.error(`  Try: nslookup ${opts.host}`);
    }
    if (!results.tcp) {
      console.error('  FIX: TCP port is blocked. Check firewall rules, server binding,');
      console.error('  and port forwarding if the server is behind a NAT/router.');
      console.error(`  Try: nc -zv ${opts.host} ${opts.tcpPort}`);
    }
    if (!results.libp2p && results.tcp) {
      console.error('  FIX: Peer ID mismatch! The server may be running with a RANDOM');
      console.error('  peer ID (no seed in its .env). Ensure the server .env was created');
      console.error('  with `npm run init:bootstrap` and matches this client\'s .env.');
      if (actualPeerId) {
        console.error(`  Server's actual peer ID: ${actualPeerId}`);
        console.error('  Update BOOTSTRAP_PEER_ID in the .env (or re-run init:bootstrap)');
        console.error('  so it matches, then retry.');
      }
    }
  } else {
    console.error('');
    console.error('  Bootstrap server is fully accessible! 🎉');
  }

  console.error('');

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});