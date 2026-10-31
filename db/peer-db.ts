// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * PeerDb — SQLite-backed peer and relationship store for the bootstrap server.
 *
 * Lives in ./data/bootstrapdb.db alongside other bootstrap data.
 *
 * ## Schema
 *
 * **peers** — every peer the bootstrap has encountered
 *   - peer_id (TEXT PK) — libp2p PeerID string
 *   - multiaddrs (TEXT) — JSON array of multiaddr strings
 *   - first_seen (INTEGER) — unix epoch seconds
 *   - last_seen (INTEGER) — unix epoch seconds
 *   - last_connected (INTEGER) — when last had an active connection
 *   - connected (INTEGER) — 1 = currently connected, 0 = not
 *   - reachable (INTEGER) — 1 = has dialable addresses even if asleep
 *   - registered (INTEGER) — 1 = explicitly registered via protocol
 *   - peer_type (TEXT) — 'agent' | 'utility_server' | 'unknown' (role)
 *   - net (TEXT) — network/group (namespace) the peer belongs to, e.g. 'p2pts'
 *   - agent_name (TEXT) — the peer's USER name (bootstrap-facing; NOT the
 *       name registered with the utility server). Resolvable as
 *       vta:<net>:<agent_name>.
 *   - vtn_name (TEXT) — UTILITY SERVER ONLY: the human-readable name of the VTN
 *       this server serves (e.g. 'Trust Stackers'), while `net` carries its
 *       machine key (e.g. 'p2pts'). Kept in its own column so a VTN's display
 *       name can never be mistaken for — or collide with — an agent's user name.
 *   - name_uri (TEXT) — derived vta:<net>:<agent_name> when both parts known.
 *       Deliberately NOT derived for a utility server: `vta:p2pts:utility-server`
 *       is indistinguishable from an agent named 'utility-server', and a server
 *       is not an agent name. Its identity is the VTN key in `net`.
 *   - is_test (INTEGER) — 1 = a test-suite peer, TTL-pruned via expires_at
 *   - expires_at (INTEGER) — unix epoch after which a test peer is pruned
 *   - reachable_scope (TEXT) — 'wan'|'dns'|'relay'|'lan'|'loopback'|'unknown'
 *   - relay_reserved (INTEGER) — 1 = currently holds a circuit-relay
 *       reservation on THIS relay (authoritative, reconciled every 10s)
 *   - relay_reserved_at / relay_expires_at (INTEGER) — reservation lifecycle
 *
 * **relationships** — peer pairs known to have formed a relationship
 *   - peer_a (TEXT) — first party PeerID (lexicographically lower)
 *   - peer_b (TEXT) — second party PeerID (lexicographically higher)
 *   - established_at (INTEGER) — unix epoch seconds
 *   - method (TEXT) — 'direct' or 'relay'
 *   - status (TEXT) — 'active' or 'inactive'
 *   - last_activity (INTEGER) — last known activity timestamp
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Connection state for a peer. */
export type PeerState = 'connected' | 'reachable' | 'unreachable';

/**
 * Reachability scope derived from a peer's multiaddrs, ordered by usefulness
 * for a cross-WAN rendezvous server (highest first):
 *   wan > dns > relay > lan > loopback > unknown
 *
 * This is what lets the bootstrap prefer internet-reachable peers over
 * LAN-only ones, which the old boolean `reachable` could not express.
 */
export type ReachableScope = 'wan' | 'dns' | 'relay' | 'lan' | 'loopback' | 'unknown';

/** A peer record from the database. */
export interface PeerRecord {
  peerId: string;
  multiaddrs: string[];
  firstSeen: number;
  lastSeen: number;
  lastConnected?: number;
  state: PeerState;
  registered: boolean;
  peerType: string;
  vid: string | null;
  did: string | null;
  /** Network/group (namespace) the peer belongs to, e.g. 'p2pts'. */
  net: string | null;
  /** The peer's user name (bootstrap-facing; not the utility-registered name). */
  agentName: string | null;
  /**
   * UTILITY SERVER ONLY: the human-readable name of the VTN it serves
   * (e.g. 'Trust Stackers'). `net` holds the machine key ('p2pts') that agents
   * match on; this is display-only and null for every agent.
   */
  vtnName: string | null;
  /** Derived vta:<net>:<agent_name> URI when both parts are known. */
  nameUri: string | null;
  /** True for test-suite peers, which are TTL-pruned. */
  isTest: boolean;
  /** Unix epoch after which a test peer is pruned (null for non-test peers). */
  expiresAt: number | null;
  /** Reachability scope derived from multiaddrs (see {@link ReachableScope}). */
  reachableScope: ReachableScope;
  /** True when the peer currently holds a circuit-relay reservation here. */
  relayReserved: boolean;
}

/** How two peers connected. */
export type RelationshipMethod = 'direct' | 'relay';

/** Status of a relationship. */
export type RelationshipStatus = 'active' | 'inactive';

/** A relationship record from the database. */
export interface RelationshipRecord {
  peerA: string;
  peerB: string;
  establishedAt: number;
  method: RelationshipMethod;
  status: RelationshipStatus;
  lastActivity?: number;
}

/**
 * Optional designation carried by a peer registration. Every field is optional
 * so a peer that only connects (never registers) leaves them unset.
 */
export interface PeerDesignation {
  /** Role: 'agent' or 'utility_server'. */
  peerType?: 'agent' | 'utility_server';
  /** Network/group (namespace) the peer belongs to, e.g. 'p2pts'. */
  net?: string;
  /** The peer's USER name (bootstrap-facing; not the utility-registered name). */
  agentName?: string;
  /**
   * UTILITY SERVER ONLY: the display name of the VTN this server serves
   * (e.g. 'Trust Stackers'). Agents ignore it; `net` is what they match on.
   */
  vtnName?: string;
  /** Explicit vta:<net>:<name> URI; else derived from net + agentName. */
  nameUri?: string;
  /** True for a test-suite peer (TTL-pruned). */
  isTest?: boolean;
  /** Unix epoch after which a test peer is pruned (null for non-test). */
  expiresAt?: number | null;
}

// ---------------------------------------------------------------------------
// Reachability helpers
// ---------------------------------------------------------------------------

/** Rank of each scope, used to pick the best scope across a peer's addresses. */
const SCOPE_RANK: Record<ReachableScope, number> = {
  wan: 5,
  dns: 4,
  relay: 3,
  lan: 2,
  loopback: 1,
  unknown: 0,
};

/**
 * Public alias of the scope ranking, so discovery can order peers by
 * reachability (wan/dns first) without duplicating the table.
 */
export const REACHABLE_SCOPE_RANK: Record<ReachableScope, number> = SCOPE_RANK;

/** True for RFC1918 / link-local IPv4 (dialable on a LAN, not across the WAN). */
function isPrivateIp4(ip: string): boolean {
  const parts = ip.split('.').map((n) => parseInt(n, 10));
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Classify a single multiaddr into a {@link ReachableScope}.
 * Returns null for addresses that carry no dialable location (e.g. a bare
 * `/ip4/0.0.0.0` listen-only wildcard).
 *
 * Order matters: a relay address is checked BEFORE dns/ip4 so a
 * `/dns/host/.../p2p-circuit/p2p/<peer>` is classified as 'relay', not 'dns'.
 */
function classifyAddr(addr: string): ReachableScope | null {
  if (!addr) return null;

  // Relay circuits first — a relay-only address is reachable via relay, not
  // directly, so it must not be mistaken for a dns/ip4 direct address.
  if (addr.includes('/p2p-circuit')) return 'relay';

  // DNS names resolve to a public address.
  if (
    addr.includes('/dns/') ||
    addr.includes('/dns4/') ||
    addr.includes('/dns6/') ||
    addr.includes('/dnsaddr/')
  ) {
    return 'dns';
  }

  const ip4 = addr.match(/\/ip4\/(\d+\.\d+\.\d+\.\d+)/);
  if (ip4) {
    const ip = ip4[1];
    if (ip === '0.0.0.0') return null; // listen-only wildcard
    if (ip.startsWith('127.')) return 'loopback';
    return isPrivateIp4(ip) ? 'lan' : 'wan';
  }

  const ip6 = addr.match(/\/ip6\/([0-9a-fA-F:]+)/);
  if (ip6) {
    const ip = ip6[1].toLowerCase();
    if (ip === '::1') return 'loopback';
    // fc00::/7 (ULA) and fe80::/10 (link-local) are LAN-scoped.
    if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return 'lan';
    return 'wan';
  }

  return null;
}

/**
 * Determine the best (most useful) reachability scope across a peer's
 * multiaddrs. A cross-WAN rendezvous server wants to surface wan/dns peers
 * ahead of lan-only ones; this is the classification that makes that possible.
 */
export function calculateReachableScope(multiaddrs: string[]): ReachableScope {
  let best: ReachableScope = 'unknown';
  for (const addr of multiaddrs) {
    const scope = classifyAddr(addr);
    if (!scope) continue;
    if (SCOPE_RANK[scope] > SCOPE_RANK[best]) best = scope;
  }
  return best;
}

/**
 * Determine if a peer with the given multiaddrs is dialable (reachable).
 *
 * A peer is reachable when it has at least one address whose scope is 'lan' or
 * better (lan/relay/dns/wan). Loopback and unknown-only peers are not reachable.
 *
 * Kept as a thin wrapper over {@link calculateReachableScope} so existing
 * callers are unaffected by the scope refinement.
 */
function calculateReachable(multiaddrs: string[]): boolean {
  return SCOPE_RANK[calculateReachableScope(multiaddrs)] >= SCOPE_RANK.lan;
}

// ---------------------------------------------------------------------------
// Row converters
// ---------------------------------------------------------------------------

interface PeerRow {
  peer_id: string;
  multiaddrs: string;
  first_seen: number;
  last_seen: number;
  last_connected: number | null;
  connected: number;
  reachable: number;
  registered: number;
  peer_type: string;
  vid: string | null;
  real_did: string | null;
  net: string | null;
  agent_name: string | null;
  vtn_name: string | null;
  name_uri: string | null;
  is_test: number;
  expires_at: number | null;
  reachable_scope: string | null;
  relay_reserved: number;
}

function rowToPeer(row: PeerRow): PeerRecord {
  const multiaddrs = row.multiaddrs ? JSON.parse(row.multiaddrs) as string[] : [];
  const scope: ReachableScope =
    (row.reachable_scope as ReachableScope | null) ?? calculateReachableScope(multiaddrs);
  const reachableFromScope = calculateReachable(multiaddrs);

  let state: PeerState;
  if (row.connected === 1) {
    state = 'connected';
  } else if (row.reachable === 1 || reachableFromScope) {
    state = 'reachable';
  } else {
    state = 'unreachable';
  }

  return {
    peerId: row.peer_id,
    multiaddrs,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    lastConnected: row.last_connected ?? undefined,
    state,
    registered: row.registered === 1,
    peerType: row.peer_type,
    vid: row.vid,
    did: row.real_did,
    net: row.net,
    agentName: row.agent_name,
    vtnName: row.vtn_name,
    nameUri: row.name_uri,
    isTest: row.is_test === 1,
    expiresAt: row.expires_at ?? null,
    reachableScope: scope,
    relayReserved: row.relay_reserved === 1,
  };
}

interface RelationshipRow {
  peer_a: string;
  peer_b: string;
  established_at: number;
  method: string;
  status: string;
  last_activity: number | null;
}

function rowToRelationship(row: RelationshipRow): RelationshipRecord {
  return {
    peerA: row.peer_a,
    peerB: row.peer_b,
    establishedAt: row.established_at,
    method: row.method as RelationshipMethod,
    status: row.status as RelationshipStatus,
    lastActivity: row.last_activity ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// PeerDb
// ---------------------------------------------------------------------------

export class PeerDb {
  private readonly db: DatabaseSync;

  /**
   * Create a new PeerDb backed by the given SQLite database file.
   * Creates the directory if it doesn't exist.
   */
  constructor(dbPath: string) {
    // Ensure the directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // Schema initialization
  // ---------------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peers (
        peer_id           TEXT PRIMARY KEY,
        multiaddrs        TEXT    NOT NULL DEFAULT '[]',
        first_seen        INTEGER NOT NULL,
        last_seen         INTEGER NOT NULL,
        last_connected    INTEGER,
        connected         INTEGER NOT NULL DEFAULT 0,
        reachable         INTEGER NOT NULL DEFAULT 0,
        registered        INTEGER NOT NULL DEFAULT 0,
        vta_uuid          TEXT,
        real_did          TEXT,
        vta_name          TEXT,
        subject_kind      TEXT,
        identity_verified INTEGER NOT NULL DEFAULT 0,
        peer_type         TEXT    NOT NULL DEFAULT 'unknown' CHECK(peer_type IN ('agent', 'utility_server', 'unknown')),
        vid               TEXT,
        net               TEXT,
        agent_name        TEXT,
        vtn_name          TEXT,
        name_uri          TEXT,
        is_test           INTEGER NOT NULL DEFAULT 0,
        expires_at        INTEGER,
        reachable_scope   TEXT,
        relay_reserved    INTEGER NOT NULL DEFAULT 0,
        relay_reserved_at INTEGER,
        relay_expires_at  INTEGER
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_cache (
        vta_uuid            TEXT PRIMARY KEY,
        real_did            TEXT NOT NULL,
        name                TEXT,
        subject_kind        TEXT,
        public_key_ed25519  BLOB,
        cached_at           INTEGER NOT NULL,
        utility_server      TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relationships (
        peer_a          TEXT NOT NULL,
        peer_b          TEXT NOT NULL,
        established_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        method          TEXT  NOT NULL CHECK(method IN ('direct', 'relay')),
        status          TEXT  NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
        last_activity   INTEGER,
        UNIQUE(peer_a, peer_b)
      )
    `);

    // Columns added after the first release. `CREATE TABLE IF NOT EXISTS` above
    // is a no-op on an existing database, so a new column has to be applied
    // separately or every read of it fails with "no such column".
    this.addColumnIfMissing('peers', 'vtn_name', 'TEXT');
  }

  /** Add a column when the table exists and does not already have it. */
  private addColumnIfMissing(table: string, column: string, type: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    if (cols.length === 0) return; // table not created yet — nothing to alter
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  // ---------------------------------------------------------------------------
  // Peer operations
  // ---------------------------------------------------------------------------

  /**
   * Upsert a peer record. Creates if not exists, updates if it does.
   * Automatically recalculates reachability from multiaddrs.
   */
  upsertPeer(peerId: string, multiaddrs: string[], connected: boolean, registered: boolean = false): void {
    const now = Math.floor(Date.now() / 1000);
    const scope = calculateReachableScope(multiaddrs);
    const reachable = SCOPE_RANK[scope] >= SCOPE_RANK.lan ? 1 : 0;
    const addrsJson = JSON.stringify(multiaddrs);

    const existing = this.db.prepare(`
      SELECT peer_id, first_seen, last_connected FROM peers WHERE peer_id = ?
    `).get(peerId) as { peer_id: string; first_seen: number; last_connected: number | null } | undefined;

    if (existing) {
      const lastConnected = connected ? now : (existing.last_connected ?? null);
      this.db.prepare(`
        UPDATE peers SET
          multiaddrs = ?,
          last_seen = ?,
          last_connected = ?,
          connected = ?,
          reachable = ?,
          reachable_scope = ?,
          registered = MAX(registered, ?)
        WHERE peer_id = ?
      `).run(addrsJson, now, lastConnected, connected ? 1 : 0, reachable, scope, registered ? 1 : 0, peerId);
    } else {
      this.db.prepare(`
        INSERT INTO peers (peer_id, multiaddrs, first_seen, last_seen, last_connected, connected, reachable, reachable_scope, registered)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        peerId,
        addrsJson,
        now,
        now,
        connected ? now : null,
        connected ? 1 : 0,
        reachable,
        scope,
        registered ? 1 : 0,
      );
    }
  }

  /**
   * Record a CONNECTION observation for a peer without discarding the addresses
   * it advertised at registration.
   *
   * `peer:connect` (and the protocol handler) only know the address the peer
   * connected FROM — `connection.remoteAddr`. For a NAT'd peer that is its
   * ephemeral source port, where nothing listens; writing it over the peer's
   * registered listen addresses is what makes every other node dial a dead port
   * (field bug 2026-09-25: `connect ECONNREFUSED …:60981` on a 5 s loop).
   *
   * The observed address is therefore used ONLY to seed a peer we have never
   * seen register (a relay-only or not-yet-registered peer has no advertised set
   * to keep). A peer that HAS advertised addresses keeps them verbatim and only
   * its liveness is updated — the registration message is the authoritative
   * source for where a peer can be dialled.
   */
  upsertConnectedPeer(peerId: string, observedAddrs: string[], registered = false): void {
    const existing = this.getPeer(peerId);
    if (existing && existing.multiaddrs.length > 0) {
      this.markConnected(peerId);
      // Mirror `upsertPeer`'s monotonic flag so a first registration that only
      // ever arrived as a connection observation still marks the peer registered.
      if (registered) {
        this.db.prepare(`UPDATE peers SET registered = 1 WHERE peer_id = ?`).run(peerId);
      }
      return;
    }
    this.upsertPeer(peerId, observedAddrs, true, registered);
  }

  /**
   * Mark a peer as connected (called on peer:connect).
   */
  markConnected(peerId: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE peers SET connected = 1, last_connected = ?, last_seen = ?
      WHERE peer_id = ?
    `).run(now, now, peerId);
  }

  /**
   * Mark a peer as disconnected (called on peer:disconnect).
   * Preserves reachable flag — peer may still be dialable.
   */
  markDisconnected(peerId: string): void {
    this.db.prepare(`
      UPDATE peers SET connected = 0, last_seen = ?
      WHERE peer_id = ?
    `).run(Math.floor(Date.now() / 1000), peerId);
  }

  /**
   * Apply a registration designation (role, net/group, user name, test flag) to
   * an existing peer row. Only the provided fields are written, so a partial
   * designation never clobbers previously-known values.
   */
  setPeerDesignation(peerId: string, d: PeerDesignation): void {
    const sets: string[] = [];
    const vals: any[] = [];
    if (d.peerType !== undefined) { sets.push('peer_type = ?'); vals.push(d.peerType); }
    if (d.net !== undefined) { sets.push('net = ?'); vals.push(d.net); }
    if (d.agentName !== undefined) { sets.push('agent_name = ?'); vals.push(d.agentName); }
    if (d.vtnName !== undefined) { sets.push('vtn_name = ?'); vals.push(d.vtnName); }
    if (d.nameUri !== undefined) { sets.push('name_uri = ?'); vals.push(d.nameUri); }
    if (d.isTest !== undefined) { sets.push('is_test = ?'); vals.push(d.isTest ? 1 : 0); }
    if (d.expiresAt !== undefined) { sets.push('expires_at = ?'); vals.push(d.expiresAt); }
    if (sets.length === 0) return;
    vals.push(peerId);
    this.db.prepare(`UPDATE peers SET ${sets.join(', ')} WHERE peer_id = ?`).run(...vals);
  }

  // ---------------------------------------------------------------------------
  // Liveness / reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Reset every peer's live state (connected, relay reservation) to "off".
   *
   * Called on server STARTUP: a fresh process has zero connections and zero
   * reservations, so any surviving `connected = 1` / `relay_reserved = 1` from a
   * previous run (whose `peer:disconnect` events never fired because the process
   * was killed) is a stale lie. This is the single cheapest fix for the
   * "dead connections persist across restarts" class of bug.
   */
  resetConnectionState(): void {
    this.db.exec(`UPDATE peers SET connected = 0, relay_reserved = 0`);
  }

  /**
   * Reconcile the `relay_reserved` flag against the relay's live reservation set.
   *
   * The relay server is the authority on who currently holds a circuit-relay
   * reservation (read from its `reservationStore.reservations`). This clears the
   * flag on every peer no longer reserved, then sets it for those that are — so
   * "reachable via relay" stops being an inferred by-product of `connected` and
   * becomes a measured, self-healing fact.
   */
  reconcileRelayReservations(reservedPeerIds: Iterable<string>): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.exec(`UPDATE peers SET relay_reserved = 0 WHERE relay_reserved = 1`);
    const stmt = this.db.prepare(`
      UPDATE peers SET relay_reserved = 1, relay_reserved_at = ? WHERE peer_id = ?
    `);
    for (const id of reservedPeerIds) {
      stmt.run(now, id);
    }
  }

  /**
   * Delete test-suite peers whose TTL has elapsed. Test peers die without a
   * clean disconnect, so a wall-clock TTL — not a disconnect event — is what
   * reliably reaps them after a suite finishes. Returns the number deleted.
   */
  pruneExpiredTestPeers(now: number = Math.floor(Date.now() / 1000)): number {
    const res = this.db.prepare(`
      DELETE FROM peers WHERE is_test = 1 AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now) as unknown as { changes?: number | bigint };
    return Number(res.changes ?? 0);
  }

  /**
   * Delete ALL test-suite peers, regardless of TTL. Called on server startup so
   * a fresh process never inherits test rows from a previous run. Returns the
   * number deleted.
   */
  purgeTestPeers(): number {
    const res = this.db.prepare(`DELETE FROM peers WHERE is_test = 1`).run() as unknown as { changes?: number | bigint };
    return Number(res.changes ?? 0);
  }

  /**
   * Get a single peer record by PeerID.
   */
  getPeer(peerId: string): PeerRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM peers WHERE peer_id = ?`).get(peerId) as unknown as PeerRow | undefined;
    return row ? rowToPeer(row) : undefined;
  }

  /**
   * List all peers, ordered by connection state (connected first) then last_seen (most recent first).
   */
  listPeers(): PeerRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM peers
      ORDER BY connected DESC, last_seen DESC
    `).all() as unknown as PeerRow[];
    return rows.map(rowToPeer);
  }

  /**
   * List only currently connected peers.
   */
  listConnected(): PeerRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM peers WHERE connected = 1 ORDER BY last_seen DESC
    `).all() as unknown as PeerRow[];
    return rows.map(rowToPeer);
  }

  /**
   * Get peer counts broken down by state.
   */
  getPeerCount(): { total: number; connected: number; reachable: number; unreachable: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN connected = 1 THEN 1 ELSE 0 END) as connected,
        SUM(CASE WHEN connected = 0 AND reachable = 1 THEN 1 ELSE 0 END) as reachable,
        SUM(CASE WHEN connected = 0 AND reachable = 0 THEN 1 ELSE 0 END) as unreachable
      FROM peers
    `).get() as unknown as { total: number; connected: number; reachable: number; unreachable: number };

    return {
      total: row.total ?? 0,
      connected: row.connected ?? 0,
      reachable: row.reachable ?? 0,
      unreachable: row.unreachable ?? 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Identity mapping operations (Phase 3: Bootstrap ↔ VTA bridge)
  // ---------------------------------------------------------------------------

  /**
   * Associate identity info with a peer. Called when an agent announces its
   * VTA identity during bootstrap registration.
   */
  setPeerIdentity(peerId: string, identity: { vtaUuid: string; realDid: string; name?: string; subjectKind?: string }): void {
    this.db.prepare(`
      UPDATE peers SET
        vta_uuid = ?, real_did = ?, vta_name = ?, subject_kind = ?, identity_verified = 1
      WHERE peer_id = ?
    `).run(identity.vtaUuid, identity.realDid, identity.name ?? null, identity.subjectKind ?? null, peerId);
  }

  /**
   * Resolve a VTA identity from a PeerID.
   */
  getPeerIdentity(peerId: string): { vtaUuid: string; realDid: string; name: string | null; subjectKind: string | null; verified: boolean } | undefined {
    const row = this.db.prepare(`
      SELECT vta_uuid, real_did, vta_name, subject_kind, identity_verified
      FROM peers WHERE peer_id = ?
    `).get(peerId) as { vta_uuid: string | null; real_did: string | null; vta_name: string | null; subject_kind: string | null; identity_verified: number } | undefined;
    if (!row?.vta_uuid) return undefined;
    return {
      vtaUuid: row.vta_uuid,
      realDid: row.real_did!,
      name: row.vta_name,
      subjectKind: row.subject_kind,
      verified: row.identity_verified === 1,
    };
  }

  /**
   * Cache identity info from a utility server query.
   */
  cacheIdentity(identity: { vtaUuid: string; realDid: string; name?: string; subjectKind?: string; publicKeyEd25519?: Buffer; utilityServer: string }): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT OR REPLACE INTO identity_cache (vta_uuid, real_did, name, subject_kind, public_key_ed25519, cached_at, utility_server)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      identity.vtaUuid,
      identity.realDid,
      identity.name ?? null,
      identity.subjectKind ?? null,
      identity.publicKeyEd25519 ?? null,
      now,
      identity.utilityServer,
    );
  }

  /**
   * Look up a cached identity by UUID.
   */
  getCachedIdentity(vtaUuid: string): { realDid: string; name: string | null; subjectKind: string | null; cachedAt: number } | undefined {
    const row = this.db.prepare(`
      SELECT real_did, name, subject_kind, cached_at
      FROM identity_cache WHERE vta_uuid = ?
    `).get(vtaUuid) as { real_did: string; name: string | null; subject_kind: string | null; cached_at: number } | undefined;
    if (!row) return undefined;
    return {
      realDid: row.real_did,
      name: row.name,
      subjectKind: row.subject_kind,
      cachedAt: row.cached_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Relationship operations
  // ---------------------------------------------------------------------------

  /**
   * Record a relationship between two peers.
   * Normalizes so peer_a < peer_b lexicographically to avoid duplicates.
   */
  upsertRelationship(peer1: string, peer2: string, method: RelationshipMethod): void {
    // Ensure consistent ordering
    const [peerA, peerB] = peer1 < peer2 ? [peer1, peer2] : [peer2, peer1];
    const now = Math.floor(Date.now() / 1000);

    this.db.prepare(`
      INSERT INTO relationships (peer_a, peer_b, established_at, method, status, last_activity)
      VALUES (?, ?, ?, ?, 'active', ?)
      ON CONFLICT(peer_a, peer_b) DO UPDATE SET
        method = ?,
        status = 'active',
        last_activity = ?
    `).run(peerA, peerB, now, method, now, method, now);
  }

  /**
   * Record activity on an existing relationship (e.g., data relayed).
   */
  touchRelationship(peer1: string, peer2: string): void {
    const [peerA, peerB] = peer1 < peer2 ? [peer1, peer2] : [peer2, peer1];
    const now = Math.floor(Date.now() / 1000);

    this.db.prepare(`
      UPDATE relationships SET last_activity = ?, status = 'active'
      WHERE peer_a = ? AND peer_b = ?
    `).run(now, peerA, peerB);
  }

  /**
   * List all relationships.
   */
  listRelationships(): RelationshipRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM relationships ORDER BY established_at DESC
    `).all() as unknown as RelationshipRow[];
    return rows.map(rowToRelationship);
  }

  /**
   * Get relationships for a specific peer.
   */
  getRelationshipsForPeer(peerId: string): RelationshipRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM relationships
      WHERE peer_a = ? OR peer_b = ?
      ORDER BY last_activity DESC
    `).all(peerId, peerId) as unknown as RelationshipRow[];
    return rows.map(rowToRelationship);
  }

  /**
   * Set the peer type for a registered peer.
   */
  setPeerType(peerId: string, peerType: 'agent' | 'utility_server'): void {
    this.db.prepare(`
      UPDATE peers SET peer_type = ? WHERE peer_id = ?
    `).run(peerType, peerId);
  }

  /**
   * Set the VID (CESR-encoded Ed25519 public key) for a registered peer.
   */
  setPeerVid(peerId: string, vid: string): void {
    this.db.prepare(`
      UPDATE peers SET vid = ? WHERE peer_id = ?
    `).run(vid, peerId);
  }

  /**
   * Find a peer by VID (CESR-encoded Ed25519 public key).
   * Returns the peer record if found, undefined otherwise.
   * Used to detect when a utility server restarts with a new peer ID
   * but the same VID — the old entry should be marked as disconnected.
   */
  findPeerByVid(vid: string): PeerRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM peers WHERE vid = ? AND vid != ''
    `).get(vid) as unknown as PeerRow | undefined;
    return row ? rowToPeer(row) : undefined;
  }

  /**
   * List peers filtered by type.
   */
  listPeersByType(peerType: 'agent' | 'utility_server'): PeerRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM peers WHERE peer_type = ? ORDER BY connected DESC, last_seen DESC
    `).all(peerType) as unknown as PeerRow[];
    return rows.map(rowToPeer);
  }

  // ---------------------------------------------------------------------------
  // Maintenance operations
  // ---------------------------------------------------------------------------

  /**
   * Clear peer and relationship records — EXCEPT peers that are currently
   * connected.
   *
   * Used by the bootstrap TUI's [c] Clear Peers command bar action.
   *
   * Why connected peers are kept: their live libp2p connections survive a
   * database wipe, so deleting their rows would make them vanish from the
   * display until they happen to reconnect — even though they are still active
   * and working (a peer:connect only re-adds them on a NEW connection). Keeping
   * the connected rows means a Clear Peers clears the stale/dead roster while
   * the still-connected agents and utility server remain visible.
   *
   * Returns the number of rows removed from each table, plus how many peers
   * were kept.
   */
  clearPeers(): { peersDeleted: number; relationshipsDeleted: number; peersKept: number } {
    // Snapshot the currently-connected peers — these are the ones to keep.
    const keep = (
      this.db.prepare(`SELECT peer_id FROM peers WHERE connected = 1`).all() as unknown as { peer_id: string }[]
    ).map((r) => r.peer_id);

    const count = (table: 'peers' | 'relationships') =>
      (this.db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as unknown as { c: number }).c;
    const peersBefore = count('peers');
    const relBefore = count('relationships');

    if (keep.length === 0) {
      // Nothing is connected — a full clear is safe.
      this.db.exec(`DELETE FROM relationships`);
      this.db.exec(`DELETE FROM peers`);
    } else {
      // Delete relationships that reference a peer we are about to remove.
      // Relationships between two kept (connected) peers are preserved.
      const ph = keep.map(() => '?').join(',');
      this.db
        .prepare(`DELETE FROM relationships WHERE peer_a NOT IN (${ph}) OR peer_b NOT IN (${ph})`)
        .run(...keep, ...keep);
      this.db.prepare(`DELETE FROM peers WHERE connected = 0`).run();
    }

    return {
      peersDeleted: peersBefore - count('peers'),
      relationshipsDeleted: relBefore - count('relationships'),
      peersKept: count('peers'),
    };
  }
}