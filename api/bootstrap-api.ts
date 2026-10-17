// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * BootstrapAPI — Event-driven API layer for the bootstrap server.
 *
 * This is the ONLY interface the TUI dashboard uses to interact with the
 * bootstrap server. The UI subscribes to events and calls query methods;
 * it never touches the database or libp2p node directly.
 *
 * ## Events (UI subscribes via .on())
 *   - 'peer:connected'    — { peerId, multiaddrs }
 *   - 'peer:disconnected'  — { peerId }
 *   - 'peer:registered'    — { peerId, multiaddrs }
 *   - 'relationship:formed' — { peerA, peerB, method }
 *   - 'relay:active'       — { source, destination, bytes }
 *   - 'relay:circuits'     — RelayCircuit[] (fixed list of relay sessions)
 *   - 'activity'           — { type, message }  (human-readable summary)
 *
 * ## Queries (UI calls directly)
 *   - getPeers()
 *   - getPeerCount()
 *   - getServerInfo()
 *   - getActivityLog()
 *   - getRelayStats()
 *   - getRelayCircuits()
 *   - clearPeers()
 */

import { EventEmitter } from 'node:events';
import type { PeerDb, PeerRecord, RelationshipRecord } from '../db/peer-db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single activity log entry. */
export interface ActivityEntry {
  timestamp: Date;
  type: ActivityType;
  message: string;
}

export type ActivityType =
  | 'peer_connect'
  | 'peer_disconnect'
  | 'peer_register'
  | 'relationship'
  | 'relay'
  | 'relay_monitor'
  | 'info'
  | 'error';

/** Live snapshot of relay circuit usage (updated every 10s by the monitor). */
export interface RelayStats {
  relayConnCount: number;
  lastUpdated: Date;
}

/**
 * A single circuit-relay session tracked by the server's periodic monitor.
 *
 * The relay server does not emit circuit open/close events, so the monitor
 * polls connections every 10s and reconciles this list.
 *
 * On the relay server, an active circuit appears as two direct connections:
 *   - a connection to the SOURCE peer (the one dialing through the relay)
 *     carrying an open HOP stream (`/libp2p/circuit/relay/0.2.0/hop`)
 *   - a connection to the DESTINATION peer carrying an open STOP stream
 *     (`/libp2p/circuit/relay/0.2.0/stop`)
 *
 * We detect these via the stream protocols on each connection. The source and
 * destination of a single circuit cannot be reliably paired from the
 * connection manager, so each relay-active connection is tracked as its own
 * session with a role label.
 */
export interface RelayCircuit {
  /** Peer ID of the relay participant. */
  peerId: string;
  /** Whether this peer is the source (dialing through) or destination. */
  role: 'source' | 'destination';
  status: 'connected' | 'disconnected';
  connectedAt: Date;
  disconnectedAt?: Date;
  lastSeen: Date;
}

/** Server information exposed to the UI. */
export interface ServerInfo {
  peerId: string;
  addrs: string[];
  relayAddr?: string;
  dnsHostname?: string;
  localIp?: string;
}

/** Event payload types. */
export interface PeerConnectedEvent {
  peerId: string;
  multiaddrs: string[];
}

export interface PeerDisconnectedEvent {
  peerId: string;
}

export interface PeerRegisteredEvent {
  peerId: string;
  multiaddrs: string[];
}

export interface RelationshipFormedEvent {
  peerA: string;
  peerB: string;
  method: 'direct' | 'relay';
}

export interface RelayActiveEvent {
  source: string;
  destination: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Activity log (in-memory ring buffer)
// ---------------------------------------------------------------------------

const MAX_ACTIVITY_ENTRIES = 500;

// ---------------------------------------------------------------------------
// BootstrapAPI
// ---------------------------------------------------------------------------

export class BootstrapAPI extends EventEmitter {
  private peerDb: PeerDb;
  private serverInfo: ServerInfo = { peerId: '', addrs: [] };
  private activityLog: ActivityEntry[] = [];
  private relayStats: RelayStats = { relayConnCount: 0, lastUpdated: new Date(0) };
  private relayCircuits: RelayCircuit[] = [];

  constructor(peerDb: PeerDb) {
    super();
    this.peerDb = peerDb;
  }

  // ---------------------------------------------------------------------------
  // Server-side methods (called by BootstrapServer)
  // ---------------------------------------------------------------------------

  /**
   * Set the server info (peer ID, addresses, relay address) once the libp2p
   * node is started.
   */
  setServerInfo(info: ServerInfo): void {
    this.serverInfo = info;
    this.emitActivity('info', `Server ready — PeerID: ${this.truncatePeerId(info.peerId)}`);
    if (info.relayAddr) {
      this.emitActivity('relay', `Circuit relay active at ${info.relayAddr}`);
    }
    if (info.dnsHostname) {
      this.emitActivity('info', `Public address: ${info.dnsHostname}`);
    }
  }

  /**
   * Call this when a peer connects (peer:connect event from libp2p).
   *
   * Inspects the connection's multiaddrs to describe HOW the peer connected —
   * direct TCP, direct WebSocket, or via circuit relay (NAT traversal) — so the
   * activity log can show connection technique, not just a bare "connected".
   */
  onPeerConnected(peerId: string, multiaddrs: string[]): void {
    const peer = this.peerDb.getPeer(peerId);
    this.peerDb.markConnected(peerId);

    const event: PeerConnectedEvent = { peerId, multiaddrs };
    this.emit('peer:connected', event);

    const how = this.describeConnectionMethod(multiaddrs);
    const verb = peer?.registered ? 'reconnected' : 'connected';
    this.emitActivity('peer_connect', `Peer ${this.truncatePeerId(peerId)} ${verb} (inbound, ${how})`);
  }

  /**
   * Call this when a peer disconnects (peer:disconnect event from libp2p).
   */
  onPeerDisconnected(peerId: string): void {
    this.peerDb.markDisconnected(peerId);

    const event: PeerDisconnectedEvent = { peerId };
    this.emit('peer:disconnected', event);

    this.emitActivity('peer_disconnect', `Peer ${this.truncatePeerId(peerId)} disconnected`);
  }

  /**
   * Call this when a peer explicitly registers via the protocol.
   */
  onPeerRegistered(peerId: string, multiaddrs: string[]): void {
    const event: PeerRegisteredEvent = { peerId, multiaddrs };
    this.emit('peer:registered', event);
    const how = this.describeConnectionMethod(multiaddrs);
    this.emitActivity(
      'peer_register',
      `Peer ${this.truncatePeerId(peerId)} registered (${how}, ${multiaddrs.length} addr${multiaddrs.length === 1 ? '' : 's'})`,
    );
  }

  /**
   * Call this when a relationship is reported or detected.
   */
  onRelationshipFormed(peerA: string, peerB: string, method: 'direct' | 'relay'): void {
    this.peerDb.upsertRelationship(peerA, peerB, method);

    const event: RelationshipFormedEvent = { peerA, peerB, method };
    this.emit('relationship:formed', event);

    const icon = method === 'direct' ? '⇄' : '↱';
    const methodLabel = method === 'direct' ? 'direct P2P connection' : 'relayed via bootstrap circuit-relay';
    this.emitActivity(
      'relationship',
      `Connection established: ${this.truncatePeerId(peerA)} ${icon} ${this.truncatePeerId(peerB)} — ${methodLabel}`,
    );
  }

  /**
   * Describe how a peer connected/is reachable based on its multiaddrs.
   * Returns a short human-readable label: e.g. "direct TCP", "direct WebSocket",
   * "via circuit-relay", or "unknown transport".
   */
  private describeConnectionMethod(multiaddrs: string[]): string {
    if (multiaddrs.some(a => a.includes('/p2p-circuit'))) {
      return 'via circuit-relay (NAT traversal)';
    }
    if (multiaddrs.some(a => a.includes('/ws'))) {
      return 'direct WebSocket';
    }
    if (multiaddrs.some(a => a.includes('/tcp/'))) {
      return 'direct TCP';
    }
    return 'unknown transport';
  }

  /**
   * Call this when data is relayed between two peers through this node.
   */
  onRelayActive(source: string, destination: string, bytes: number): void {
    this.peerDb.touchRelationship(source, destination);

    const event: RelayActiveEvent = { source, destination, bytes };
    this.emit('relay:active', event);

    this.emitActivity(
      'relay',
      `Relay: ${this.truncatePeerId(source)} → ${this.truncatePeerId(destination)} (${bytes}B)`
    );
  }

  /**
   * Called by the periodic relay monitor every 10s with a live snapshot of
   * circuit-relay usage. Updates the stored stats AND emits a relay_monitor
   * activity entry so the relay pane has a live header.
   */
  emitRelayMonitor(relayConnCount: number): void {
    this.relayStats = {
      relayConnCount,
      lastUpdated: new Date(),
    };

    this.emitActivity(
      'relay_monitor',
      `${relayConnCount} relay circuit(s) active`,
    );
  }

  /**
   * Called by the periodic relay monitor every 10s with the reconciled list of
   * relay sessions. Stores the list and emits a `relay:circuits` event so the
   * dashboard can render a fixed (non-scrolling) list of sessions.
   */
  setRelayCircuits(circuits: RelayCircuit[]): void {
    this.relayCircuits = circuits;
    this.emit('relay:circuits', circuits);
  }

  /**
   * Record a generic info message in the activity log.
   */
  emitInfo(message: string): void {
    this.emitActivity('info', message);
  }

  /**
   * Record an error message in the activity log.
   */
  emitError(message: string): void {
    this.emitActivity('error', message);
  }

  // ---------------------------------------------------------------------------
  // Query methods (called by the TUI dashboard)
  // ---------------------------------------------------------------------------

  /**
   * Get all peers, ordered by connection state then recency.
   */
  getPeers(): PeerRecord[] {
    return this.peerDb.listPeers();
  }

  /**
   * Get only connected peers.
   */
  getConnectedPeers(): PeerRecord[] {
    return this.peerDb.listConnected();
  }

  /**
   * Get peer counts by state.
   */
  getPeerCount(): { total: number; connected: number; reachable: number; unreachable: number } {
    return this.peerDb.getPeerCount();
  }

  /**
   * Get server info (peer ID, addresses, relay address).
   */
  getServerInfo(): ServerInfo {
    return this.serverInfo;
  }

  /**
   * Get all relationships.
   */
  getRelationships(): RelationshipRecord[] {
    return this.peerDb.listRelationships();
  }

  /**
   * Get the in-memory activity log (most recent entries first).
   */
  getActivityLog(): ActivityEntry[] {
    return [...this.activityLog].reverse();
  }

  /**
   * Get the current relay circuit usage snapshot (updated every 10s).
   */
  getRelayStats(): RelayStats {
    return { ...this.relayStats };
  }

  /**
   * Get the current list of relay sessions (connected + recently disconnected).
   * Maintained by the server's periodic relay monitor.
   */
  getRelayCircuits(): RelayCircuit[] {
    return this.relayCircuits.map(c => ({ ...c }));
  }

  /**
   * Clear peer and relationship records from the database — EXCEPT peers that
   * are currently connected (which stay visible). Records an activity log entry
   * describing the operation. Used by the bootstrap TUI's bottom command bar
   * [c] Clear Peers action.
   */
  clearPeers(): { peersDeleted: number; relationshipsDeleted: number; peersKept: number } {
    const result = this.peerDb.clearPeers();
    this.emitActivity(
      'info',
      `Peer records cleared: ${result.peersDeleted} peer(s), ${result.relationshipsDeleted} relationship(s) removed` +
        (result.peersKept > 0 ? `, ${result.peersKept} connected peer(s) kept` : ''),
    );
    this.emit('peers:cleared', result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private emitActivity(type: ActivityType, message: string): void {
    const entry: ActivityEntry = {
      timestamp: new Date(),
      type,
      message,
    };

    this.activityLog.push(entry);

    // Keep the ring buffer bounded
    if (this.activityLog.length > MAX_ACTIVITY_ENTRIES) {
      this.activityLog.shift();
    }

    this.emit('activity', entry);
  }

  private truncatePeerId(peerId: string): string {
    if (peerId.length <= 16) return peerId;
    return peerId.slice(0, 12) + '…' + peerId.slice(-4);
  }

}