// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * BootstrapServer — libp2p node configured as a bootstrap + relay server.
 *
 * Responsibilities:
 *   - Create and manage the libp2p node
 *   - Enable TCP, WebSocket transports
 *   - Enable circuit relay (always on by default)
 *   - Wire peer:connect / peer:disconnect events to the API layer
 *   - Register the /bootstrap/2.0.0 protocol handler
 *
 * Note: mDNS was removed (Phase 9) as unreliable across networks.
 * Peer discovery relies on explicit bootstrap peer lists and incoming
 * agent registrations via the /bootstrap/2.0.0 protocol.
 */

import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { webSockets } from '@libp2p/websockets';
import { RELAY_V2_HOP_CODEC, RELAY_V2_STOP_CODEC } from '@libp2p/circuit-relay-v2';
import type { BootstrapAPI, RelayCircuit } from '../api/bootstrap-api.js';

import type { PeerDb } from '../db/peer-db.js';
import { BOOTSTRAP_PROTOCOL, BOOTSTRAP_KEEPALIVE_PROTOCOL } from './bootstrap-protocol.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BootstrapServerOptions {
  /** Bind address (default: 0.0.0.0). */
  host?: string;
  /** TCP listen port (default: 4001). */
  tcpPort?: number;
  /** WebSocket listen port (default: 4002). */
  wsPort?: number;
  /** Public DNS hostname for relay addresses. */
  dnsHostname?: string;
  /** Enable Kademlia DHT (default: false). */
  enableDht?: boolean;
  /** Enable circuit relay (default: true). */
  enableRelay?: boolean;
  /** Bootstrap peer addresses to join. */
  bootstrapPeers?: string[];
  /**
   * Hex-encoded 32-byte Ed25519 seed for a deterministic (fixed) peer ID.
   * When provided, the server uses the same peer ID across restarts, allowing
   * client peers to dial it without a prior identify exchange.
   */
  seedHex?: string;
  /**
   * Max duration (ms) a relayed connection may stay open.
   *
   * This is the RELAY SESSION GRANT: when it is exhausted the relay aborts the
   * HOP/STOP streams and both peers see `peer:disconnect`. `0` means unlimited
   * to the relay — prefer a finite grant (peers now refresh a relay session
   * before the limit is reached) over an unbounded session.
   *
   * Defaults to 1 hour (the value commit 3c2f1e4 hardcoded "for development
   * and test"); override with `--relay-duration` / `RELAY_DURATION_MS`.
   */
  relayMaxDuration?: number;
  /**
   * Max data (bytes) a relayed connection may transfer before the relay aborts
   * it. `0` means unlimited. Defaults to 10 MB; override with
   * `--relay-max-bytes` / `RELAY_MAX_DATA_BYTES`.
   */
  relayMaxData?: bigint;
}

// ---------------------------------------------------------------------------
// BootstrapServer
// ---------------------------------------------------------------------------

export class BootstrapServer {
  private node: Libp2p | null = null;
  private options: Required<BootstrapServerOptions>;
  private api: BootstrapAPI;
  private peerDb: PeerDb;

  constructor(api: BootstrapAPI, peerDb: PeerDb, options: BootstrapServerOptions = {}) {
    this.api = api;
    this.peerDb = peerDb;
    this.options = {
      host: options.host ?? '0.0.0.0',
      tcpPort: options.tcpPort ?? 4001,
      wsPort: options.wsPort ?? 4002,
      dnsHostname: options.dnsHostname ?? '',
      enableDht: options.enableDht ?? false,
      enableRelay: options.enableRelay ?? true,
      bootstrapPeers: options.bootstrapPeers ?? [],
      seedHex: options.seedHex ?? '',
      relayMaxDuration: options.relayMaxDuration ?? 1 * 60 * 60 * 1000, // 1 hours
      relayMaxData: options.relayMaxData ?? BigInt(10 * 1024 * 1024), // 10 MB
    };
  }

  /**
   * Start the libp2p node. Returns the node's peer ID string.
   * If seedHex is configured, uses a deterministic Ed25519 key pair
   * so the peer ID is stable across restarts.
   */
  async start(): Promise<string> {
    // Startup reconciliation. A freshly-started process has ZERO connections and
    // ZERO relay reservations, so any `connected = 1` / `relay_reserved = 1` left
    // over from a previous run is a stale lie — its `peer:disconnect` event
    // never fired because the process was killed (e.g. a test harness tearing
    // down). Clearing them here is the cheapest fix for the "dead connections
    // persist across restarts" class of bug. Test-suite peers from a prior run
    // are purged outright, since a fresh process never owns any.
    this.peerDb.resetConnectionState();
    const purgedTest = this.peerDb.purgeTestPeers();
    if (purgedTest > 0) {
      this.api.emitInfo(`Startup: purged ${purgedTest} stale test peer(s)`);
    }

    const { host, tcpPort, wsPort, dnsHostname, enableDht, enableRelay, bootstrapPeers, seedHex } = this.options;

    // Determine if WebSocket transport is needed
    const useWs = !!(wsPort && wsPort !== 0 || dnsHostname);

    // NOTE: 'ws' (code 477) and 'wss' (code 478) are already registered by
    // @multiformats/multiaddr's own protocol registry (see
    // node_modules/@multiformats/multiaddr/dist/src/registry.js). Do NOT call
    // registry.addProtocol() for these names here — doing so with an incorrect
    // code (e.g. the port number) overwrites the correct built-in definition
    // and breaks every WebSockets multiaddr matcher in the process, causing
    // libp2p's transport-manager to silently filter out the WS listen address
    // (transport.listenFilter() uses WebSocketsMatcher.exactMatch() internally).

    // Build listen addresses.
    // WebSocket multiaddrs use the shape /<host>/tcp/<port>/ws — the port is
    // carried by the 'tcp' component, and the valueless 'ws' component marks
    // the TCP connection as upgraded to WebSocket framing. (NOT /<host>/ws/<port>.)
    //
    // Bug fix: a `/dns/{dnsHostname}/tcp/{port}` entry must NEVER be added to
    // the LISTEN address list. libp2p's TCP transport resolves the hostname
    // and calls Node's `net.Server.listen()` on the RESOLVED IP — but that
    // resolved IP is the server's public WAN-facing address, which is almost
    // always reached via NAT/port-forwarding and is NOT an address bound to
    // any actual network interface on the host itself. Attempting to
    // `listen()` on it fails immediately with EADDRNOTAVAIL ("address not
    // available"), exactly as seen when this server was deployed behind a
    // router/NAT (Windows host, public IP 137.119.64.166, port-forwarded from
    // the router — the OS has no interface configured with that address).
    //
    // The DNS hostname is still useful — but only for the address we
    // ADVERTISE to peers (so they dial the stable hostname rather than a
    // changeable IP), not for what we actually bind(). See advertisedDnsAddrs
    // below, which is merged into the addrs sent to api.setServerInfo() but
    // is never passed to createLibp2p({ addresses: { listen } }).
    const listenAddrs: string[] = [`/ip4/${host}/tcp/${tcpPort}`];

    if (useWs) {
      listenAddrs.push(`/ip4/${host}/tcp/${wsPort}/ws`);
    }

    // DNS-hostname addresses to ADVERTISE (never to bind/listen on). Built
    // ahead of createLibp2p() so it's available once we assemble the final
    // addrs list below, after the node actually starts listening.
    const advertisedDnsAddrs: string[] = [];
    if (dnsHostname) {
      advertisedDnsAddrs.push(`/dns/${dnsHostname}/tcp/${tcpPort}`);
      if (useWs) {
        advertisedDnsAddrs.push(`/dns/${dnsHostname}/tcp/${wsPort}/ws`);
      }
    }



    // Build transport list
    const transports: any[] = [tcp()];
    if (useWs) {
      transports.push(webSockets());
    }

    // Build discovery list — mDNS removed (unreliable across networks).
    // The bootstrap server relies on explicit bootstrap peer lists and
    // incoming connections from agents registering via /bootstrap/2.0.0.
    const peerDiscovery: any[] = [];

    // Build privateKey: use seeded key pair if configured, otherwise random
    const { keys } = await import('@libp2p/crypto');
    let privateKey: any;
    if (seedHex && seedHex.length >= 64) {
      // Decode hex seed to 32 bytes
      const seedBytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        seedBytes[i] = parseInt(seedHex.substring(i * 2, i * 2 + 2), 16);
      }
      privateKey = await keys.generateKeyPairFromSeed('Ed25519', seedBytes);
      this.api.emitInfo(`Using fixed peer ID from seed: ${seedHex.slice(0, 8)}...`);
    } else {
      privateKey = await keys.generateKeyPair('Ed25519');
      this.api.emitInfo('Using random peer ID (no seed configured)');
    }
    if (bootstrapPeers.length > 0) {
      const { bootstrap } = await import('@libp2p/bootstrap');
      peerDiscovery.push(bootstrap({ list: bootstrapPeers }));
    }

    // Build services
    const services: Record<string, any> = {
      identify: identify(),
    };

    if (enableRelay) {
      const { circuitRelayServer } = await import('@libp2p/circuit-relay-v2');
      services.circuitRelayServer = circuitRelayServer({
        reservations: {
          defaultDurationLimit: this.options.relayMaxDuration,
          defaultDataLimit: this.options.relayMaxData,
        },
      });

      // Announce the effective relay-session grant. Without this the limit was
      // invisible: a peer-to-peer session would simply die an hour in with no
      // indication that a policy (rather than a fault) caused it, and the value
      // could only be changed by editing source.
      const durationLabel = this.options.relayMaxDuration === 0
        ? 'unlimited'
        : `${Math.round(this.options.relayMaxDuration / 1000)}s`;
      const dataLabel = this.options.relayMaxData === 0n
        ? 'unlimited'
        : `${this.options.relayMaxData.toString()} bytes`;
      this.api.emitInfo(
        `Relay session grant: duration=${durationLabel}, data=${dataLabel} ` +
        '(per relayed connection; peers refresh before the limit is reached)',
      );
      if (this.options.relayMaxDuration === 0 || this.options.relayMaxData === 0n) {
        this.api.emitInfo(
          'WARNING: an unlimited relay-session grant means a single relayed connection can consume ' +
          'relay resources indefinitely.',
        );
      }
    }

    if (enableDht) {
      const { kadDHT } = await import('@libp2p/kad-dht');
      peerDiscovery.push(kadDHT());
    }

    this.node = await createLibp2p({
      privateKey,
      addresses: { listen: listenAddrs },
      transports,
      streamMuxers: [yamux()],
      connectionEncrypters: [noise()],
      peerDiscovery,
      services,
    } as any);

    const peerId = this.node.peerId.toString();
    const boundAddrs = this.node.getMultiaddrs().map((a: any) => a.toString());

    // Merge the DNS-hostname addresses we advertise (but never bind/listen
    // on — see advertisedDnsAddrs above) ahead of the actually-bound
    // addresses, so clients prefer dialing the stable hostname. The bound
    // addresses are still included so LAN peers / fallback dialing keeps
    // working, and computeRelayPrefix()'s fallback path (bootstrap-protocol.ts)
    // still has a real bound address to fall back to if needed.
    const addrs = [
      ...advertisedDnsAddrs.map(a => `${a}/p2p/${peerId}`),
      ...boundAddrs,
    ];


    // Determine relay address.
    //
    // Bug fix: the DNS branch previously built
    //   /dns/{host}/p2p-circuit/p2p/{peerId}
    // which is malformed in two ways: (1) it omits the TCP port entirely,
    // and (2) it places /p2p-circuit BEFORE the relay's own /p2p/{peerId}
    // component. The correct circuit-relay-v2 convention (matching what the
    // non-DNS branch below already does correctly) is:
    //   <relay-multiaddr-ending-in-/p2p/{relayPeerId}>/p2p-circuit
    // i.e. the relay's dialable address (including port and its own peer
    // ID) FIRST, with /p2p-circuit appended last. Any peer ID appended
    // after /p2p-circuit denotes the *destination* peer being dialed
    // through the relay, not the relay itself — so a relayAddr that is
    // meant to identify "the relay, ready to have a destination appended"
    // must end in /p2p-circuit, not include a trailing peer ID.
    //
    // With the old malformed shape, every relay-dial attempt across
    // different WANs (see connectivity.ts reconnectPeer / dialViaRelay,
    // and bootstrap-protocol.ts computeRelayPrefix) failed silently because
    // CircuitRelayTransport.dial() cannot find a /p2p/{relayPeerId} segment
    // before /p2p-circuit and throws immediately.
    let relayAddr: string | undefined;
    if (enableRelay && dnsHostname) {
      relayAddr = `/dns/${dnsHostname}/tcp/${tcpPort}/p2p/${peerId}/p2p-circuit`;
    } else if (enableRelay) {
      const tcpAddr = addrs.find((a: string) => a.includes('/tcp/'));
      if (tcpAddr) {
        relayAddr = `${tcpAddr}/p2p-circuit`;
      }
    }


    // Get local IP for display
    const localIp = this.getLocalIp(addrs);

    // Notify API of server info
    this.api.setServerInfo({
      peerId,
      addrs,
      relayAddr,
      dnsHostname: dnsHostname || undefined,
      localIp,
    });

    // Wire connection events
    this.node.addEventListener('peer:connect', (event: any) => {
      const peerIdStr = event.detail.toString();
      // Get multiaddrs from the connection manager
      const conns = this.node?.getConnections(peerIdStr ? (event.detail as any) : undefined);
      const multiaddrs = conns?.flatMap((c: any) => c.remoteAddr ? [c.remoteAddr.toString()] : []) ?? [];

      // A connection observation, NOT a registration: `remoteAddr` is the address
      // the peer connected FROM, which for a NAT'd peer is an ephemeral source port
      // where nothing listens. Overwriting the peer's registered listen addresses
      // with it would publish a dead port to every other node (and did — see
      // `PeerDb.upsertConnectedPeer`). Existing advertised addresses are kept.
      this.peerDb.upsertConnectedPeer(peerIdStr, multiaddrs);
      this.api.onPeerConnected(peerIdStr, multiaddrs);
    });

    this.node.addEventListener('peer:disconnect', (event: any) => {
      const peerIdStr = event.detail.toString();
      this.api.onPeerDisconnected(peerIdStr);
    });

    // Register the bootstrap protocol handler
    await this.registerProtocol();

    this.api.emitInfo(`Bootstrap protocol ${BOOTSTRAP_PROTOCOL} registered`);
    this.api.emitInfo(`Keepalive protocol ${BOOTSTRAP_KEEPALIVE_PROTOCOL} registered`);
    this.api.emitInfo(`Listening on TCP:${tcpPort}, WS:${wsPort}`);

    // Start periodic relay activity monitor (scans active circuit relays every 10s)
    this.startRelayMonitor();

    return peerId;
  }

  /**
   * Periodic relay activity monitor.
   *
   * The circuit-relay-v2 server does not emit events when a circuit is
   * established (HOP CONNECT) or closed, so we poll the connection manager
   * every 10s and reconcile a fixed list of relay sessions.
   *
   * On the relay server, an active circuit appears as two direct connections:
   *   - a connection to the SOURCE peer carrying an open HOP stream
   *     (`/libp2p/circuit/relay/0.2.0/hop`)
   *   - a connection to the DESTINATION peer carrying an open STOP stream
   *     (`/libp2p/circuit/relay/0.2.0/stop`)
   *
   * We detect these by scanning each connection's open streams for the HOP and
   * STOP protocols. The source and destination of a single circuit cannot be
   * reliably paired from the connection manager, so each relay-active
   * connection is tracked as its own session with a role label.
   *
   * Per-circuit byte accounting is not reliably available: the relay's byte
   * limit is tracked in a local `dataLimit.remaining` inside createLimitedRelay
   * and is not exposed on connections, streams, or reservations. Streams do not
   * expose cumulative byte counters either. We keep a best-effort aggregate
   * byte total in the header only.
   */
  private relayCircuits = new Map<string, RelayCircuit>();
  /** Tracks how many consecutive polls a circuit has been missing. */
  private relayMissCount = new Map<string, number>();
  /** Number of consecutive misses before a circuit is marked disconnected. */
  private static readonly RELAY_DISCONNECT_GRACE = 2;
  /** Disconnected circuits older than this (ms) are removed from the list. */
  private static readonly RELAY_STALE_DISCONNECT_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * The set of peer IDs that currently hold a circuit-relay reservation on this
   * relay, read from the circuit-relay server's reservation store (the
   * authoritative source). Returns [] when the store is unavailable.
   *
   * On the relay server an active reservation is what makes a peer reachable
   * via /p2p-circuit, so this — not the raw `connected` flag — is the correct
   * signal for "reachable via relay".
   */
  private getRelayReservedPeerIds(): string[] {
    try {
      const reservations = (this.node as any)?.services?.circuitRelayServer
        ?.reservationStore?.reservations;
      if (!reservations || typeof reservations.keys !== 'function') return [];
      const ids: string[] = [];
      for (const peer of reservations.keys()) {
        const id = typeof peer === 'string' ? peer : peer?.toString?.();
        if (id) ids.push(id);
      }
      return ids;
    } catch {
      return [];
    }
  }

  private startRelayMonitor(): void {
    setInterval(() => {
      if (!this.node) return;
      try {
        const connections = (this.node as any).getConnections?.() ?? [];
        const now = new Date();
        const seen = new Set<string>();
        let relayConnCount = 0;

        for (const conn of connections) {
          const streams = conn.streams ?? [];
          const hasHop = streams.some((s: any) => s.protocol === RELAY_V2_HOP_CODEC);
          const hasStop = streams.some((s: any) => s.protocol === RELAY_V2_STOP_CODEC);

          // Fallback: also check connection tags for relay indicators when
          // streams don't show the protocol (transient state during circuit setup).
          const tags = conn.tags ?? [];
          const taggedRelay = Array.isArray(tags)
            ? tags.some((t: string) => t === 'relay-hop' || t === 'relay-stop')
            : false;

          if (!hasHop && !hasStop && !taggedRelay) continue;

          relayConnCount++;
          const peerId = conn.remotePeer?.toString() ?? '';
          if (peerId) {
            // A peer may be a source in one circuit and a destination in
            // another, so key by peerId + role.
            const roles: Array<'source' | 'destination'> = [];
            if (hasHop || (taggedRelay && !hasStop)) roles.push('source');
            if (hasStop || (taggedRelay && !hasHop)) roles.push('destination');

            for (const role of roles) {
              const key = `${peerId}:${role}`;
              seen.add(key);
              // Reset miss counter on every sighting
              this.relayMissCount.delete(key);
              const existing = this.relayCircuits.get(key);
              if (existing) {
                existing.status = 'connected';
                existing.lastSeen = now;
                // Clear disconnectedAt when reconnecting
                existing.disconnectedAt = undefined;
              } else {
                this.relayCircuits.set(key, {
                  peerId,
                  role,
                  status: 'connected',
                  connectedAt: now,
                  lastSeen: now,
                });
              }
            }
          }
        }

        // Mark circuits no longer present as disconnected only after
        // missing for RELAY_DISCONNECT_GRACE consecutive polls.
        for (const [key, circuit] of this.relayCircuits) {
          if (!seen.has(key) && circuit.status === 'connected') {
            const misses = (this.relayMissCount.get(key) ?? 0) + 1;
            this.relayMissCount.set(key, misses);
            if (misses >= BootstrapServer.RELAY_DISCONNECT_GRACE) {
              circuit.status = 'disconnected';
              circuit.disconnectedAt = now;
              circuit.lastSeen = now;
              this.relayMissCount.delete(key);
            }
          }
        }

        // Clean up disconnected circuits older than the stale threshold.
        for (const [key, circuit] of this.relayCircuits) {
          if (circuit.status === 'disconnected' && circuit.disconnectedAt) {
            const age = now.getTime() - circuit.disconnectedAt.getTime();
            if (age >= BootstrapServer.RELAY_STALE_DISCONNECT_MS) {
              this.relayCircuits.delete(key);
            }
          }
        }

        // Reconcile peer liveness against the relay's authoritative reservation
        // set (so "reachable via relay" is a measured fact, not inferred from
        // `connected`), and reap test-suite peers whose TTL has elapsed.
        this.peerDb.reconcileRelayReservations(this.getRelayReservedPeerIds());
        const prunedTest = this.peerDb.pruneExpiredTestPeers();
        if (prunedTest > 0) {
          this.api.emitInfo(`Pruned ${prunedTest} expired test peer(s)`);
        }

        // Always report so the relay pane shows a live readout (0 when idle).
        this.api.emitRelayMonitor(relayConnCount);
        this.api.setRelayCircuits([...this.relayCircuits.values()]);
      } catch {
        // Best-effort — relay monitor errors are non-fatal
      }
    }, 10_000);
  }

  /**
   * Register the /bootstrap/2.0.0 protocol handler.
   */
  private async registerProtocol(): Promise<void> {
    if (!this.node) return;

    const { handleBootstrapStream, handleKeepaliveStream } = await import('./bootstrap-protocol.js');

    // NOTE: libp2p's StreamHandler signature is
    // `(stream: Stream, connection: Connection) => void | Promise<void>` —
    // two separate positional arguments, NOT a single `{ stream, connection }`
    // object. The previous implementation destructured `data.stream` /
    // `data.connection` from a single parameter, so `connection` was always
    // `undefined` and `connection.remotePeer.toString()` threw a TypeError
    // synchronously inside the handler — before `handleBootstrapStream` was
    // ever reached. libp2p reacts to that throw by resetting the stream,
    // which is exactly the "stream has been reset" error the client saw.
    await (this.node as any).handle(BOOTSTRAP_PROTOCOL, async (stream: any, connection: any) => {
      try {
        const peerId = connection.remotePeer.toString();
        const multiaddrs = connection.remoteAddr
          ? [connection.remoteAddr.toString()]
          : [];

        // Pre-seed with the OBSERVED address only when the peer has none; a
        // registration message that follows is the authoritative advertised set
        // (`buildRegisterResponse` merges observed + advertised). A `query` message
        // gets no such follow-up, so without this a mere lookup would clobber a
        // registered peer's dialable addresses with the NAT source port.
        this.peerDb.upsertConnectedPeer(peerId, multiaddrs, true);
        await handleBootstrapStream(stream, connection, peerId, multiaddrs, this.peerDb, this.api);
      } catch (err) {
        this.api.emitError(`Bootstrap protocol handler error: ${err instanceof Error ? err.stack : err}`);
      }
    }, { runOnLimitedConnection: true });

    // Register the keepalive protocol handler — keeps connection alive for relay
    await (this.node as any).handle(BOOTSTRAP_KEEPALIVE_PROTOCOL, async (stream: any, connection: any) => {
      try {
        await handleKeepaliveStream(stream, connection, this.api);
      } catch (err) {
        this.api.emitError(`Keepalive handler error: ${err instanceof Error ? err.stack : err}`);
      }
    }, { runOnLimitedConnection: true });
  }

  /**
   * Stop the libp2p node and close all connections.
   */
  async stop(): Promise<void> {
    if (this.node) {
      await this.node.stop();
      this.node = null;
    }
    this.api.emitInfo('Server stopped');
  }

  /**
   * Get the underlying libp2p node.
   */
  getNode(): Libp2p | null {
    return this.node;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract a human-readable local IP from the listen addresses.
   */
  private getLocalIp(addrs: string[]): string | undefined {
    for (const addr of addrs) {
      const match = addr.match(/\/ip4\/(\d+\.\d+\.\d+\.\d+)/);
      if (match) {
        const ip = match[1];
        if (ip !== '0.0.0.0' && !ip.startsWith('127.')) {
          return ip;
        }
      }
    }
    // Fall back to the first IP found
    for (const addr of addrs) {
      const match = addr.match(/\/ip4\/(\d+\.\d+\.\d+\.\d+)/);
      if (match) return match[1];
    }
    return undefined;
  }
}