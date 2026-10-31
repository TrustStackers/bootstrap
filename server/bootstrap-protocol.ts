// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Bootstrap Protocol Handler — /bootstrap/2.0.0
 *
 * Handles incoming protocol streams from peers registering or querying the
 * bootstrap server. Uses length-prefixed framing (lpStream) for reliable
 * message boundaries.
 *
 * ## Message format (JSON over lpStream)
 *
 * **Register** (peer → server):
 *   { type: "register", peerId: string, multiaddrs: string[], relationships?: { peerId, method }[] }
 *
 * **Query** (peer → server):
 *   { type: "query" }
 *
 * **Response** (server → peer):
 *   {
 *     type: "registered" | "query_result",
 *     serverPeerId: string,
 *     serverAddrs: string[],
 *     relayAddr?: string,
 *     peers: { peerId, multiaddrs, connected, reachable }[]
 *   }
 *
 * ## Bootstrap Server URLs
 *
 * The bootstrap server's peer ID and address are NOT defined here. They live in
 * a gitignored `.env` (see `src/config/bootstrap-env.ts`), created by
 * `npm run init:bootstrap`. Clients load that same file, so there is one source
 * of truth and no hardcoded address to keep in sync.
 */

import type { Stream, Connection } from '@libp2p/interface';
import { lpStream } from '@libp2p/utils';
import { REACHABLE_SCOPE_RANK, type PeerDb } from '../db/peer-db.js';
import type { BootstrapAPI } from '../api/bootstrap-api.js';

/** The protocol identifier. */
export const BOOTSTRAP_PROTOCOL = '/bootstrap/2.0.0';

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type BootstrapMessage = RegisterMessage | QueryMessage;

interface RegisterMessage {
  type: 'register';
  peerId: string;
  multiaddrs: string[];
  relationships?: { peerId: string; method: 'direct' | 'relay' }[];
  /** Phase 3: Identity info announced by the agent during registration. */
  identity?: {
    vtaUuid?: string;
    realDid?: string;
    name?: string;
    subjectKind?: string;
  };
  /** Peer type for role-based discovery (agent vs utility_server). */
  peerType?: 'agent' | 'utility_server';
  /** CESR-encoded Ed25519 public key (VID) for OOBI construction. */
  vid?: string;
  /**
   * Network/group (namespace) the peer belongs to, e.g. 'p2pts'. The utility
   * server sends its own namespace; an agent sends the VTN it is joining.
   *
   * For BOTH roles this is the VTN **machine key** — the value an agent matches
   * on to find the utility server that serves the network it wants.
   */
  net?: string;
  /**
   * UTILITY SERVER ONLY (ignored for agents): the display name of the VTN this
   * server serves, e.g. 'Trust Stackers'. Optional, and deliberately its own
   * field: `net` is the machine key ('p2pts') that matching depends on, while
   * this is only a label — keeping them apart is what stops a VTN's display name
   * from being confused with, or colliding against, an agent's user name.
   */
  vtnName?: string;
  /**
   * The peer's USER name (bootstrap-facing). This is deliberately NOT the name
   * registered with the utility server — it is the locally-configured user name
   * and is resolvable as vta:<net>:<agentName>.
   */
  agentName?: string;
  /** Explicit vta:<net>:<name> URI; the server derives one from net+agentName if omitted. */
  nameUri?: string;
  /** True when this is a test-suite peer; the server TTL-prunes it. */
  test?: boolean;
}

interface QueryMessage {
  type: 'query';
}

interface BootstrapResponse {
  type: 'registered' | 'query_result';
  serverPeerId: string;
  serverAddrs: string[];
  relayAddr?: string;
  /** The client's source address as seen by the bootstrap server.
      Enables the client to learn its own WAN-facing IP for network detection. */
  clientSourceAddr?: string;
  peers: {
    peerId: string;
    multiaddrs: string[];
    connected: boolean;
    reachable: boolean;
    /** Phase 8: Per-peer relay address through this bootstrap server.
        Clients can use this to dial the peer via circuit relay when direct connection fails. */
    relayAddr?: string;
    /** Peer type for role-based discovery. */
    peerType?: string;
    /** CESR-encoded Ed25519 public key (VID) for OOBI construction. */
    vid?: string;
    /** Network/group (namespace) this peer belongs to, e.g. 'p2pts'. */
    net?: string;
    /** The peer's user name (bootstrap-facing), resolvable as vta:<net>:<agentName>. */
    agentName?: string;
    /**
     * UTILITY SERVER ONLY: the display name of the VTN this server serves
     * (e.g. 'Trust Stackers'). `net` carries its machine key ('p2pts'), which is
     * what an agent matches on; this is the human label beside it.
     */
    vtnName?: string;
    /**
     * True when the peer currently holds a circuit-relay reservation on this
     * relay — the authoritative "reachable via relay" signal, distinct from a
     * direct `reachable`.
     */
    reachableViaRelay?: boolean;
    /** Reachability scope derived from the peer's multiaddrs. */
    reachableScope?: string;
  }[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const MAX_MESSAGE_BYTES = 65536; // 64 KiB — bootstrap messages are small

/**
 * Default TTL (seconds) for test-suite peers (registration `test: true`).
 *
 * Test peers are killed without a clean disconnect, so a wall-clock TTL — not a
 * `peer:disconnect` event — is what reliably reaps them once a suite finishes.
 * Override with the `TEST_PEER_TTL_SECONDS` environment variable.
 */
const TEST_PEER_TTL_SECONDS = Number(process.env.TEST_PEER_TTL_SECONDS ?? '') || 300;

/**
 * Open-stream count on a SINGLE connection at which the keepalive handler warns.
 *
 * libp2p's per-protocol `maxInboundStreams` default is 32, and a codec that
 * reaches it resets every subsequent stream. This handler deliberately swallows
 * its own errors (a dropped keepalive stream is normal), so the wedge this file
 * exists to prevent is INVISIBLE on the server: the log stays clean while every
 * probe is being reset. Warn well before the limit so a climbing count — the
 * leak that used to wedge the codec for the life of the process — is visible in
 * the log BEFORE it becomes a flap.
 */
const KEEPALIVE_STREAM_WARN_THRESHOLD = 16;

/**
 * Handle an incoming keepalive stream on /bootstrap/keepalive/1.0.0.
 * Keeps the stream open to maintain an active connection for circuit relay.
 * The client sends periodic ping frames; we respond with pong.
 *
 * ## The stream MUST be closed before this handler returns
 *
 * A libp2p protocol handler owns its stream: nothing in the core closes it when
 * the handler resolves (`runMiddlewareChain()` in `libp2p/dist/src/connection.js`
 * simply returns). This handler used to fall out of its read loop without
 * closing, and that leaked exactly one stream per probe — measured: 10 probes ⇒
 * 10 streams, 30 ⇒ 30, on both ends of the connection.
 *
 * Why a leak is fatal rather than untidy. The client half-closes each probe
 * (`probeKeepalive` → `stream.close()`), so we see FIN and our readable end
 * closes — but `AbstractMessageStream.onRemoteCloseWrite()` only destroys a
 * stream once the LOCAL writable end is closed as well. Our writable end stayed
 * open forever, so the stream stayed in `connection.streams`, and
 * `Connection.newStream()` rejects once the per-protocol count exceeds the
 * protocol's stream limit — `maxInboundStreams`, 32 by default
 * (`libp2p/dist/src/registrar.js`). The codec therefore wedged permanently the
 * moment the 33rd keepalive stream arrived, which at the client's 25 s cadence
 * is ~13 minutes of uptime.
 *
 * The wedged codec is what the field saw as a flapping bootstrap connection:
 * every later probe is aborted just after negotiation completes, so the client's
 * already-negotiated stream is closed before it can write — the client logged
 * `Cannot write to a stream that is closed`, counted three of those as "bootstrap
 * connection lost", then re-registered successfully over the same healthy TCP
 * connection and repeated the cycle forever. Closing the stream here is what
 * un-wedges it: with `remoteWriteStatus === 'closed'` (the client's FIN) our
 * `close()` also tears the stream down locally, which reaps it on BOTH ends.
 */
export const BOOTSTRAP_KEEPALIVE_PROTOCOL = '/bootstrap/keepalive/1.0.0';

export async function handleKeepaliveStream(
  stream: Stream,
  connection: Connection,
  api: BootstrapAPI,
): Promise<void> {
  const lp = lpStream(stream, { maxDataLength: 1024 });
  const peerId = connection.remotePeer.toString();

  // Stream-pressure telemetry — see KEEPALIVE_STREAM_WARN_THRESHOLD. Reported on
  // ENTRY, because the interesting case is a count that keeps climbing across
  // probes, and this is the only place the connection object is in hand.
  const openStreams = (connection as unknown as { streams?: unknown[] }).streams?.length ?? 0;
  if (openStreams >= KEEPALIVE_STREAM_WARN_THRESHOLD) {
    api.emitError(
      `Keepalive stream pressure on ${peerId.slice(0, 12)}...: ${openStreams} open streams on this ` +
      'connection. libp2p resets this protocol once the count exceeds maxInboundStreams (32 by ' +
      'default) and then every keepalive probe fails until the connection is re-established.',
    );
  }

  try {
    while (true) {
      const data = await lp.read();
      if (data === null) break;

      // Echo back a pong response
      const pong = new TextEncoder().encode(JSON.stringify({ type: 'pong', ts: Date.now() }));
      await lp.write(pong);

      // Track relay activity
      api.onRelayActive(peerId, 'bootstrap', data.length);
    }
  } catch {
    // Stream closed — expected on disconnect
  } finally {
    // See the doc comment above: without this the keepalive codec leaks one
    // stream per probe and wedges itself for the lifetime of the process.
    try {
      await stream.close();
    } catch {
      // Already closed/reset by the failure path — nothing to do.
    }
  }
}

/**
 * Extract the client's source address from the connection for network detection.
 * Returns the connection's remote address as a string, e.g. "/ip4/1.2.3.4/tcp/54321".
 */
function getClientSourceAddr(connection: Connection): string | undefined {
  return connection.remoteAddr?.toString();
}

export async function handleBootstrapStream(
  stream: Stream,
  connection: Connection,
  peerId: string,
  multiaddrs: string[],
  peerDb: PeerDb,
  api: BootstrapAPI,
): Promise<void> {
  const lp = lpStream(stream, { maxDataLength: MAX_MESSAGE_BYTES });

  try {
    // Read the first (and usually only) frame
    const data = await lp.read();
    if (data === null) return;

    const raw = data.slice(0, data.length);
    const msg = JSON.parse(new TextDecoder().decode(raw)) as BootstrapMessage;

    let response: BootstrapResponse;

    const clientSourceAddr = getClientSourceAddr(connection);

    if (msg.type === 'register') {
      response = await buildRegisterResponse(msg, peerId, multiaddrs, peerDb, api, clientSourceAddr);
    } else if (msg.type === 'query') {
      response = buildQueryResponse(peerId, api, clientSourceAddr);
    } else {
      api.emitError(`Unknown bootstrap message type: ${(msg as any).type}`);
      return;
    }

    // Write the response using the same lpStream helper used to read the
    // request. The previous implementation tried to call a `stream.sink()`
    // method that does not exist on this libp2p version's Stream interface
    // (it uses `.send()` internally via lpStream/byteStream instead), which
    // caused every response write to throw and the stream to be reset before
    // any data was sent to the client. Using `lp.write()` here mirrors
    // exactly what the client does when it sends its request, ensuring both
    // sides speak the same length-prefixed framing.
    const encoder = new TextEncoder();
    const responseBytes = encoder.encode(JSON.stringify(response));
    await lp.write(responseBytes);

    // Close the write side of the stream to signal EOF to the client. This
    // lets the client's lp.read() complete after receiving the
    // length-prefixed frame.
    try {
      await stream.close();
    } catch {
      // Stream may already be closed
    }
  } catch (err) {
    api.emitError(`Bootstrap protocol error: ${err}`);
  }
}

/**
 * Build and process a registration message.
 */
async function buildRegisterResponse(
  msg: RegisterMessage,
  peerId: string,
  multiaddrs: string[],
  peerDb: PeerDb,
  api: BootstrapAPI,
  clientSourceAddr?: string,
): Promise<BootstrapResponse> {
  // Merge any additional multiaddrs from the registration message
  const allAddrs = mergeAddrs(multiaddrs, msg.multiaddrs);
  peerDb.upsertPeer(peerId, allAddrs, true, true);
  api.onPeerRegistered(peerId, allAddrs);

  // Apply the peer designation: role, network/group (net), user name, and — for
  // test peers — a TTL. The bootstrap-facing name is the USER name
  // (`agentName`), NOT the name registered with the utility server; it resolves
  // as vta:<net>:<agentName>. When the agent has not yet completed name
  // registration it simply sends its configured user name, and the URI is
  // derived here so it is available from first contact.
  const net = msg.net?.trim() || '';
  const agentName = msg.agentName?.trim() || '';
  const vtnName = msg.vtnName?.trim() || '';
  // A UTILITY SERVER is NOT an agent name, and its identity is the VTN key in
  // `net` — so `vta:<net>:<agentName>` is never derived for it. Deriving one
  // would mint `vta:p2pts:utility-server`, which is indistinguishable from a real
  // agent named 'utility-server' and would let a display name masquerade as a
  // resolvable agent URI.
  const isUtilityServer = msg.peerType === 'utility_server';
  const nameUri =
    msg.nameUri?.trim() ||
    (net && agentName && !isUtilityServer ? `vta:${net}:${agentName}` : undefined);
  const isTest = msg.test === true;
  const expiresAt = isTest
    ? Math.floor(Date.now() / 1000) + TEST_PEER_TTL_SECONDS
    : null;

  peerDb.setPeerDesignation(peerId, {
    peerType: msg.peerType,
    net: net || undefined,
    agentName: agentName || undefined,
    vtnName: vtnName || undefined,
    nameUri,
    isTest,
    expiresAt,
  });

  if (msg.peerType) {
    api.emitInfo(`Peer type set: ${peerId.slice(0, 12)}... → ${msg.peerType}`);
  }
  if (vtnName) {
    api.emitInfo(
      `VTN name: ${peerId.slice(0, 12)}... → ${vtnName}${net ? ` (${net})` : ''}`,
    );
  }
  if (nameUri) {
    api.emitInfo(`Peer name: ${peerId.slice(0, 12)}... → ${nameUri}`);
  }
  if (isTest) {
    api.emitInfo(`Test peer ${peerId.slice(0, 12)}... registered (TTL ${TEST_PEER_TTL_SECONDS}s)`);
  }

  // Store VID for OOBI construction.
  // If another peer already has this VID (e.g., utility server restarted
  // without a persistent seed and got a new peer ID), mark the old entry
  // as disconnected so agents don't try to connect to a dead peer.
  if (msg.vid) {
    // Find any existing peer with the same VID but different peer ID
    const existingVidPeer = peerDb.findPeerByVid(msg.vid);
    if (existingVidPeer && existingVidPeer.peerId !== peerId) {
      api.emitInfo(
        `VID collision: ${msg.vid.slice(0, 12)}... was ${existingVidPeer.peerId.slice(0, 12)}... → now ${peerId.slice(0, 12)}... (server restarted?)`,
      );
      // Mark the old peer as disconnected so agents don't try to dial it
      peerDb.markDisconnected(existingVidPeer.peerId);
      // Clear the VID from the old peer so it doesn't show up in discovery
      peerDb.setPeerVid(existingVidPeer.peerId, '');
    }
    peerDb.setPeerVid(peerId, msg.vid);
    api.emitInfo(`VID stored: ${peerId.slice(0, 12)}... → ${msg.vid.slice(0, 12)}...`);
  }

  // Phase 3: Associate identity info with this peer
  if (msg.identity?.vtaUuid) {
    peerDb.setPeerIdentity(peerId, {
      vtaUuid: msg.identity.vtaUuid,
      realDid: msg.identity.realDid ?? '',
      name: msg.identity.name,
      subjectKind: msg.identity.subjectKind,
    });
    api.emitInfo(`Identity linked: peer ${peerId.slice(0, 12)}... → ${msg.identity.name ?? msg.identity.vtaUuid.slice(0, 8)}...`);
  }

  // Process reported relationships
  if (msg.relationships) {
    for (const rel of msg.relationships) {
      api.onRelationshipFormed(peerId, rel.peerId, rel.method);
    }
  }

  return buildResponse(peerId, api, clientSourceAddr);
}

/**
 * Build a query response.
 */
function buildQueryResponse(peerId: string, api: BootstrapAPI, clientSourceAddr?: string): BootstrapResponse {
  return buildResponse(peerId, api, clientSourceAddr);
}

/**
 * Build the response object filtered by the requesting peer.
 *
 * Phase 8: Each peer entry includes a relayAddr so clients can dial through
 * the bootstrap server's circuit relay when direct connection fails.
 */
function buildResponse(requestPeerId: string, api: BootstrapAPI, clientSourceAddr?: string): BootstrapResponse {
  const info = api.getServerInfo();
  const allPeers = api.getPeers();

  // A running test suite must not pollute production discovery: hide test-suite
  // peers from real peers. A test peer still sees the full list (so suites can
  // discover each other).
  const requesterIsTest = allPeers.find(p => p.peerId === requestPeerId)?.isTest ?? false;

  // Compute the relay prefix for building per-peer relay addresses.
  // If the server has a DNS hostname, use /dns/{host}/p2p-circuit/p2p/{peerId}
  // Otherwise, append /p2p-circuit to a TCP address.
  const relayPrefix = computeRelayPrefix(info);

  const peerList = allPeers
    .filter(p => p.peerId !== requestPeerId)
    .filter(p => requesterIsTest || !p.isTest)
    .sort((a, b) => {
      // Connected first, then by reachability scope (wan/dns before lan/relay),
      // then most-recently-seen — so a cross-WAN dialer gets the most useful
      // candidates first.
      const ca = a.state === 'connected' ? 1 : 0;
      const cb = b.state === 'connected' ? 1 : 0;
      if (ca !== cb) return cb - ca;
      const sa = REACHABLE_SCOPE_RANK[a.reachableScope] ?? 0;
      const sb = REACHABLE_SCOPE_RANK[b.reachableScope] ?? 0;
      if (sa !== sb) return sb - sa;
      return b.lastSeen - a.lastSeen;
    })
    .map(p => ({
      peerId: p.peerId,
      multiaddrs: p.multiaddrs,
      connected: p.state === 'connected',
      reachable: p.state === 'connected' || p.state === 'reachable',
      relayAddr: relayPrefix ? `${relayPrefix}/p2p/${p.peerId}` : undefined,
      peerType: p.peerType,
      vid: p.vid ?? undefined,
      did: p.did ?? undefined,
      net: p.net ?? undefined,
      agentName: p.agentName ?? undefined,
      vtnName: p.vtnName ?? undefined,
      reachableViaRelay: p.relayReserved,
      reachableScope: p.reachableScope,
    }));

  const response: BootstrapResponse = {
    type: 'registered',
    serverPeerId: info.peerId,
    serverAddrs: info.addrs,
    relayAddr: info.relayAddr,
    peers: peerList,
  };

  // Include the client's source address so it can learn its WAN-facing IP
  if (clientSourceAddr) {
    response.clientSourceAddr = clientSourceAddr;
  }

  return response;
}

/**
 * Compute the relay address prefix from server info.
 * Returns the portion that identifies the relay itself, ready to have a
 * destination peer ID appended after /p2p-circuit, e.g.:
 *   /dns/relay.truststackers.com/tcp/4001/p2p/{serverPeerId}/p2p-circuit
 *   /ip4/1.2.3.4/tcp/4001/p2p/{serverPeerId}/p2p-circuit
 *
 * Bug fix: info.relayAddr previously had /p2p-circuit and /p2p/{serverPeerId}
 * in the WRONG order for DNS-hostname deployments (see bootstrap-server.ts),
 * which this function's old regex (`^(.*\/p2p-circuit)\/p2p\/[^/]+$`) actually
 * matched — silently extracting a prefix that discarded the TCP port and the
 * relay's own peer ID. That broken prefix was then sent to every client as
 * each peer's per-peer relayAddr, so relay-dial attempts across different
 * WANs always failed. Now that bootstrap-server.ts produces a correctly
 * ordered relayAddr ending in /p2p-circuit, using it directly (with no
 * trailing peer ID to strip) is correct.
 */
function computeRelayPrefix(info: { addrs: string[]; relayAddr?: string; dnsHostname?: string }): string | undefined {
  // Prefer the server's own relayAddr when available — it now already ends
  // in /p2p-circuit with no destination peer ID appended, so it IS the
  // prefix clients need.
  if (info.relayAddr) {
    if (info.relayAddr.endsWith('/p2p-circuit')) {
      return info.relayAddr;
    }
    // Backwards-compat: strip a trailing /p2p/{peerId} if present (in case
    // an old-format relayAddr is ever encountered, e.g. during a rolling
    // deploy against a stale client).
    const match = /^(.*\/p2p-circuit)\/p2p\/[^/]+$/.exec(info.relayAddr);
    if (match) return match[1];
    // Fallback: if relayAddr doesn't match any expected pattern, try to
    // derive from components.
    if (info.dnsHostname) {
      const tcpAddr = info.addrs.find(a => a.includes(`/dns/${info.dnsHostname}/tcp/`));
      if (tcpAddr) return `${tcpAddr}/p2p-circuit`;
    }
  }

  // Fallback: use the first TCP address + /p2p-circuit
  const tcpAddr = info.addrs.find(a => a.includes('/tcp/'));
  if (tcpAddr) {
    return `${tcpAddr}/p2p-circuit`;
  }

  return undefined;
}


/**
 * Merge two multiaddr arrays, removing duplicates.
 */
function mergeAddrs(existing: string[], incoming: string[]): string[] {
  const set = new Set(existing);
  for (const addr of incoming) {
    set.add(addr);
  }
  return Array.from(set);
}